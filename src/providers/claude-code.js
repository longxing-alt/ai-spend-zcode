const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { getPricing, calculateCost } = require('../pricing');
const { generateInsights } = require('../insights');
const { wordCount, cleanPrompt } = require('../utils');

function getClaudeDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

async function parseSessionStream(filePath, projectName) {
  const queries = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let pendingPrompt = null;
  let firstUserPrompt = null;
  let continuations = 0;
  
  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    if (row.type === 'human') {
      let rawPrompt = "";
      if (typeof row.content === 'string') {
        rawPrompt = row.content;
      } else if (Array.isArray(row.content)) {
        rawPrompt = row.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      }
      
      pendingPrompt = cleanPrompt(rawPrompt);
      if (firstUserPrompt === null && pendingPrompt && pendingPrompt !== '(No Prompt)') {
        firstUserPrompt = pendingPrompt;
      }
      continuations = 0;
    }

    if (row.type === 'assistant' && row.usage) {
      if (pendingPrompt !== null) {
        const u = row.usage;
        const inputTokens = u.input_tokens || 0;
        const outputTokens = u.output_tokens || 0;
        const cachedTokens = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        
        let cost = Number(row.costUSD) || 0;
        const currentModel = row.model || 'unknown';

        if (cost === 0 && currentModel !== 'unknown') {
            cost = calculateCost(currentModel, inputTokens, cachedTokens, outputTokens, 0);
        }

        queries.push({
          userPrompt: pendingPrompt,
          model: currentModel,
          inputTokens,
          outputTokens,
          cachedTokens,
          reasoningTokens: 0,
          totalTokens: inputTokens + outputTokens,
          cost,
          continuations
        });
        
        pendingPrompt = null; // Wait for next human turn
      } else {
        continuations++;
      }
    }
  }

  return { queries, sessionCwd: projectName, firstUserPrompt };
}

async function parseAllSessions(options = {}) {
  const projectsDir = getClaudeDir();
  const threads = [];

  if (fs.existsSync(projectsDir)) {
    try {
      const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const pDir of projectDirs) {
        if (!pDir.isDirectory()) continue;
        const decodedName = decodeURIComponent(pDir.name);
        const sessionsDir = path.join(projectsDir, pDir.name, 'sessions');
        
        if (fs.existsSync(sessionsDir)) {
          const files = fs.readdirSync(sessionsDir);
          for (const f of files) {
            if (f.endsWith('.jsonl')) {
              const fullPath = path.join(sessionsDir, f);
              const stat = fs.statSync(fullPath);
              threads.push({
                id: f.replace('.jsonl', ''),
                rollout_path: fullPath,
                created_at: Math.floor(stat.mtimeMs / 1000),
                updated_at: Math.floor(stat.mtimeMs / 1000),
                cwd: decodedName
              });
            }
          }
        }
      }
    } catch(e) {}
  }

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const t of threads) {
    const result = await parseSessionStream(t.rollout_path, t.cwd);
    const queries = result.queries;
    if (queries.length === 0) continue;

    const totalCacheRead = queries.reduce((sum, q) => sum + (q.cachedTokens || 0), 0);
    const totalInput = queries.reduce((sum, q) => sum + (q.inputTokens || 0), 0);
    const totalOutput = queries.reduce((sum, q) => sum + (q.outputTokens || 0), 0);
    const totalTokens = totalInput + totalOutput;
    const sessionCost = queries.reduce((sum, q) => sum + (q.cost || 0), 0);

    const localDate = new Date(t.created_at * 1000);
    const date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;

    let model = "unknown";
    if (queries.length > 0) {
      model = queries[queries.length - 1].model;
    }

    sessions.push({
      sessionId: t.id,
      firstPrompt: result.firstUserPrompt || "Untitled",
      project: result.sessionCwd,
      createdAt: t.created_at * 1000,
      updatedAt: t.updated_at * 1000,
      date: date,
      duration: "N/A",
      model: model,
      reasoningLevel: "none",
      queryCount: queries.length,
      queries: queries,
      totalTokens: totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCacheRead,
      reasoningTokens: 0,
      cost: sessionCost
    });

    if (!dailyMap[date]) {
        dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
    }
    dailyMap[date].inputTokens += totalInput;
    dailyMap[date].outputTokens += totalOutput;
    dailyMap[date].cacheReadTokens += totalCacheRead;
    dailyMap[date].totalTokens += totalTokens;
    dailyMap[date].cost += sessionCost;
    dailyMap[date].sessions += 1;
    dailyMap[date].queries += queries.length;

    for (const q of queries) {
        const qModel = q.model || model;
        if (!modelMap[qModel]) {
            modelMap[qModel] = { model: qModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, queryCount: 0, unknownPricing: false };
        }
        
        modelMap[qModel].inputTokens += q.inputTokens;
        modelMap[qModel].outputTokens += q.outputTokens;
        modelMap[qModel].cacheReadTokens += q.cachedTokens;
        modelMap[qModel].totalTokens += q.totalTokens;
        modelMap[qModel].cost += q.cost;
        modelMap[qModel].queryCount += 1;

        if (q.totalTokens > 0) {
            allPrompts.push({
                prompt: q.userPrompt || "(No Prompt)",
                inputTokens: q.inputTokens,
                outputTokens: q.outputTokens,
                cacheReadTokens: q.cachedTokens,
                reasoningTokens: 0,
                totalTokens: q.totalTokens,
                cost: q.cost,
                date: date,
                sessionId: t.id,
                model: qModel,
            });
        }
    }
  }

  let dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  if (dailyUsage.length > 30) dailyUsage = dailyUsage.slice(-30);

  const modelBreakdown = Object.values(modelMap);
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project || 'unknown';
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0,
        sessionCount: 0, queryCount: 0, modelMap: {}, allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.cost += session.cost;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;
  }

  const projectBreakdown = Object.values(projectMap).sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: sessions.reduce((s, c) => s + c.totalTokens, 0),
    totalQueries: sessions.reduce((s, c) => s + c.queryCount, 0),
    totalCacheReadTokens: sessions.reduce((s, c) => s + c.cachedTokens, 0),
    totalInputTokens: sessions.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, c) => s + c.outputTokens, 0),
    totalReasoningTokens: 0,
    totalCost: sessions.reduce((s, c) => s + c.cost, 0),
    dateRange: dailyUsage.length > 0 ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null,
  };

  const insights = generateInsights(sessions, allPrompts, totals, 'Claude Code');

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts: allPrompts.slice(0, 20),
    topPromptsByTokens: [...allPrompts].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 20),
    topPromptsByCost: [...allPrompts].sort((a, b) => b.cost - a.cost).slice(0, 20),
    totals,
    projectBreakdown,
    insights
  };
}

module.exports = { parseAllSessions };

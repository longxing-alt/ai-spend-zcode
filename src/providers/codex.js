const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { MODEL_PRICING, getPricing, calculateCost } = require('../pricing');
const { getCodexDir, cleanPrompt, normalizeReasoningLevel } = require('../utils');
const { generateInsights } = require('../insights');



function getLatestStateDb(overridePath = null) {
  if (overridePath) return overridePath;
  const codexDir = getCodexDir();
  let latest = -1;
  try {
    if (fs.existsSync(codexDir)) {
      const files = fs.readdirSync(codexDir);
      for (const f of files) {
        const match = f.match(/^state_(\d+)\.sqlite$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > latest) latest = num;
        }
      }
      
      // Fallback for newer/different structures (e.g. sqlite/codex-dev.db)
      if (latest === -1) {
        const altPath = path.join(codexDir, 'sqlite', 'codex-dev.db');
        if (fs.existsSync(altPath)) return altPath;
      }
    }
  } catch(e) {}
  return path.join(codexDir, `state_${latest === -1 ? 0 : latest}.sqlite`);
}

function q(sql, dbPath) {
  try {
    const r = spawnSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
    if (r.error) {
      if (r.error.code === 'ENOENT') {
        throw new Error(
          'Missing required dependency: sqlite3 CLI was not found on your system. Install sqlite3 and retry. macOS: brew install sqlite; Ubuntu/Debian: sudo apt-get install sqlite3; Windows: choco install sqlite'
        );
      }
      throw r.error;
    }
    if (r.status !== 0) {
      const stderr = (r.stderr || '').trim();
      throw new Error(`Failed to read Codex state DB with sqlite3. ${stderr || 'Unknown sqlite3 error.'}`);
    }
    const out = r.stdout ? r.stdout.trim() : "";
    return out ? JSON.parse(out) : [];
  } catch (e) {
    throw e;
  }
}

function getStateDbOverride() {
  return process.env.CODEX_SPEND_STATE_DB || null;
}











async function parseSessionStream(filePath) {
  const queries = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let pendingPrompt = null;
  let continuations = 0;
  let maxRequestInputForPrompt = 0;
  
  let baselineTotalInput = 0;
  let baselineTotalOutput = 0;
  let baselineTotalCached = 0;
  let baselineReasoningOutput = 0;

  let currentTotalInput = 0;
  let currentTotalOutput = 0;
  let currentTotalCached = 0;
  let currentReasoningOutput = 0;

  let currentModel = null;
  let currentReasoningLevel = null;

  let lastSeenInput = 0;
  let lastSeenOutput = 0;

  // Metadata extracted from session_meta and first user message
  let sessionCwd = null;
  let firstUserPrompt = null;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract cwd from session_meta (available in all Codex CLI versions)
    if (row.type === "session_meta" && row.payload) {
      sessionCwd = row.payload.cwd || null;
    }

    if (row.type === "turn_context" && row.payload?.model) {
      currentModel = row.payload.model;
    }
    
    // Also extract cwd from turn_context as fallback (in case session_meta is missing)
    if (row.type === "turn_context" && row.payload?.cwd && !sessionCwd) {
      sessionCwd = row.payload.cwd;
    }

    if (row.type === "turn_context" && row.payload?.collaboration_mode?.settings?.reasoning_effort) {
      currentReasoningLevel = normalizeReasoningLevel(row.payload.collaboration_mode.settings.reasoning_effort);
    }

    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.total_token_usage) {
      const u = row.payload.info.total_token_usage;
      currentTotalInput = u.input_tokens || 0;
      currentTotalOutput = u.output_tokens || 0;
      currentTotalCached = u.cached_input_tokens || 0;
      currentReasoningOutput = u.reasoning_output_tokens || 0;
    }

    if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user") {
      if (pendingPrompt !== null) {
        const diffInput = currentTotalInput - baselineTotalInput;
        const diffOutput = currentTotalOutput - baselineTotalOutput;
        const diffCached = currentTotalCached - baselineTotalCached;
        const diffReasoning = currentReasoningOutput - baselineReasoningOutput;

        if (diffInput > 0 || diffOutput > 0) {
          queries.push({
            userPrompt: pendingPrompt,
            model: currentModel,
            reasoningLevel: currentReasoningLevel,
            inputTokens: diffInput,
            outputTokens: Math.max(0, diffOutput - diffReasoning), // don't double count
            cachedTokens: diffCached,
            reasoningTokens: diffReasoning,
            totalTokens: diffInput + diffOutput,
            requestInputTokens: maxRequestInputForPrompt,
            continuations: Math.max(0, continuations - 1)
          });
        }
      }

      const texts = (row.payload.content || []).filter(c => c.type === 'input_text' || c.type === 'text');
      const rawPrompt = texts.length > 0 ? texts.map(c => c.text).join('\n') : "";
      pendingPrompt = cleanPrompt(rawPrompt);
      
      // Capture first user prompt as potential title
      if (firstUserPrompt === null && pendingPrompt && pendingPrompt !== '(No Prompt)') {
        firstUserPrompt = pendingPrompt;
      }

      continuations = 0;
      maxRequestInputForPrompt = 0;
      baselineTotalInput = currentTotalInput;
      baselineTotalOutput = currentTotalOutput;
      baselineTotalCached = currentTotalCached;
      baselineReasoningOutput = currentReasoningOutput;
      
      lastSeenInput = 0;
      lastSeenOutput = 0;
    }
    
    // We still track last_token_usage deduplication just to count how many API calls were made ("continuations")
    if (row.type === "event_msg" && row.payload?.type === "token_count" && row.payload?.info?.last_token_usage) {
      const usage = row.payload.info.last_token_usage;
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      if (inTok > maxRequestInputForPrompt) {
        maxRequestInputForPrompt = inTok;
      }
      
      if (inTok !== lastSeenInput || outTok !== lastSeenOutput) {
         lastSeenInput = inTok;
         lastSeenOutput = outTok;
         continuations++;
      }
    }
  }

  if (pendingPrompt !== null) {
    const diffInput = currentTotalInput - baselineTotalInput;
    const diffOutput = currentTotalOutput - baselineTotalOutput;
    const diffCached = currentTotalCached - baselineTotalCached;
    const diffReasoning = currentReasoningOutput - baselineReasoningOutput;

    if (diffInput > 0 || diffOutput > 0) {
      queries.push({
        userPrompt: pendingPrompt,
        model: currentModel,
        reasoningLevel: currentReasoningLevel,
        inputTokens: diffInput,
        outputTokens: Math.max(0, diffOutput - diffReasoning), // don't double count
        cachedTokens: diffCached,
        reasoningTokens: diffReasoning,
        totalTokens: diffInput + diffOutput,
        requestInputTokens: maxRequestInputForPrompt,
        continuations: Math.max(0, continuations - 1)
      });
    }
  }

  return { queries, sessionCwd, firstUserPrompt };
}

// duplicate calculateCost removed

function getSessionsFromDirectory() {
  const sessionsDir = path.join(getCodexDir(), 'sessions');
  const threads = [];
  if (!fs.existsSync(sessionsDir)) return threads;
  function scanDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          // Extract timestamp + UUID from filename: rollout-2026-02-11T22-46-24-UUID.jsonl
          const match = entry.name.match(/^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-(.+)\.jsonl$/);
          let createdAt = null;
          let id = entry.name;
          if (match) {
            const tsStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
            createdAt = Math.floor(new Date(tsStr).getTime() / 1000);
            id = match[2];
          } else {
            createdAt = Math.floor(fs.statSync(fullPath).mtimeMs / 1000);
          }
          threads.push({ id, rollout_path: fullPath, created_at: createdAt, updated_at: createdAt, model_provider: null, title: null, tokens_used: 0, cwd: null });
        }
      }
    } catch(e) {}
  }
  scanDir(sessionsDir);
  return threads;
}

function dbHasTable(dbPath, tableName) {
  try {
    const tables = q("SELECT name FROM sqlite_master WHERE type='table'", dbPath);
    return tables.some(t => t.name === tableName);
  } catch(e) {
    return false;
  }
}

async function parseAllSessions(options = {}) {
  const dbPath = getLatestStateDb(options.stateDbPath || getStateDbOverride());
  let detectionSource = 'none';

  let threads = [];
  if (fs.existsSync(dbPath) && dbHasTable(dbPath, 'threads')) {
    // Primary path: DB with threads table (standard Codex CLI)
    threads = q(`
      SELECT id, rollout_path, created_at, updated_at, model_provider, title, tokens_used, cwd
      FROM threads
      WHERE archived = 0
      ORDER BY tokens_used DESC
    `, dbPath);
    detectionSource = 'sqlite';
  } else {
    // Fallback: scan ~/.codex/sessions/**/*.jsonl directly
    threads = getSessionsFromDirectory();
    detectionSource = threads.length > 0 ? 'directory' : 'none';
  }

  const sessions = [];
  
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  const validThreads = threads.filter(t => t.rollout_path && fs.existsSync(t.rollout_path));
  
  // Process in concurrent chunks of 10 to avoid EMFILE and sequential chokepoint
  for (let i = 0; i < validThreads.length; i += 10) {
    const chunk = validThreads.slice(i, i + 10);
    await Promise.all(chunk.map(async (t) => {
      const result = await parseSessionStream(t.rollout_path);
      const queries = result.queries;

      // Enrich directory-scanned threads with metadata extracted from JSONL
      if (!t.cwd && result.sessionCwd) t.cwd = result.sessionCwd;
      if (!t.title && result.firstUserPrompt) t.title = result.firstUserPrompt;

    const totalCacheRead = queries.reduce((sum, q) => sum + (q.cachedTokens || 0), 0);
    const totalInput = queries.reduce((sum, q) => sum + (q.inputTokens || 0), 0);
    const totalOutput = queries.reduce((sum, q) => sum + (q.outputTokens || 0), 0);
    const totalReasoning = queries.reduce((sum, q) => sum + (q.reasoningTokens || 0), 0);
    
    // Formatting local timezone date
    const localDate = new Date(t.created_at * 1000);
    const date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
    
    const durationOffset = (t.updated_at || t.created_at) - t.created_at;
    const durationStr = durationOffset > 0 ? `${(durationOffset / 60).toFixed(1)} mins` : "N/A";

    // Label sessions by majority model usage for display.
    let model = t.model_provider || "unknown";
    if (queries.length > 0) {
      const modelCounts = {};
      for (const q of queries) {
        if (!q.model) continue;
        modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
      }
      const ranked = Object.entries(modelCounts).sort((a, b) => b[1] - a[1]);
      if (ranked.length > 0) {
        model = ranked[0][0];
      } else if (queries[queries.length - 1].model) {
        model = queries[queries.length - 1].model;
      }
    }
    // Determine the predominant reasoning level for the session
    let reasoningLevel = "none";
    if (queries.length > 0) {
      const counts = {};
      let maxCount = 0;
      let maxPriority = -1;
      const priority = { low: 1, medium: 2, high: 3, very_high: 4 };
      for (const q of queries) {
        const normalized = normalizeReasoningLevel(q.reasoningLevel);
        if (!normalized) continue;
        counts[normalized] = (counts[normalized] || 0) + 1;
        const curCount = counts[normalized];
        const curPriority = priority[normalized] || 0;
        if (curCount > maxCount || (curCount === maxCount && curPriority > maxPriority)) {
          maxCount = curCount;
          maxPriority = curPriority;
          reasoningLevel = normalized;
        }
      }
    }
    const totalTokens = totalInput + totalOutput + totalReasoning;
    const sessionCost = queries.reduce((sum, q) => {
      const pricedModel = q.model || model;
      return sum + calculateCost(pricedModel, q.inputTokens || 0, q.cachedTokens || 0, q.outputTokens || 0, q.reasoningTokens || 0);
    }, 0);

    sessions.push({
      sessionId: t.id,
      firstPrompt: t.title || "Untitled",
      project: t.cwd,
      createdAt: t.created_at ? (t.created_at * 1000) : null,
      updatedAt: t.updated_at ? (t.updated_at * 1000) : null,
      date: date,
      duration: durationStr,
      model: model,
      reasoningLevel: reasoningLevel,
      queryCount: queries.length,
      queries: queries,
      totalTokens: totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCacheRead,
      reasoningTokens: totalReasoning,
      cost: sessionCost
    });
    
    // Process Daily Usage
    if (!dailyMap[date]) {
        dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
    }
    dailyMap[date].inputTokens += totalInput;
    dailyMap[date].outputTokens += totalOutput;
    dailyMap[date].cacheReadTokens += totalCacheRead;
    dailyMap[date].reasoningTokens += totalReasoning;
    dailyMap[date].totalTokens += totalTokens;
    dailyMap[date].cost += sessionCost;
    dailyMap[date].sessions += 1;
    dailyMap[date].queries += queries.length;

    // Process Model Stats and Top Prompts per-query accurately
    for (const q of queries) {
        const qModel = q.model || model; // fall back to session model
        if (!modelMap[qModel]) {
            modelMap[qModel] = { model: qModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, queryCount: 0, unknownPricing: false };
        }
        
        const qPricing = getPricing(qModel);
        if (qPricing.unknown) modelMap[qModel].unknownPricing = true;
        const qUncached = Math.max(0, q.inputTokens - q.cachedTokens);
        const qCost = qPricing.unknown ? 0 : (qUncached * qPricing.input) + (q.cachedTokens * qPricing.cacheRead) + (q.outputTokens * qPricing.output) + ((q.reasoningTokens || 0) * qPricing.reasoningResult);
        
        modelMap[qModel].inputTokens += q.inputTokens;
        modelMap[qModel].outputTokens += q.outputTokens;
        modelMap[qModel].cacheReadTokens += q.cachedTokens;
        modelMap[qModel].reasoningTokens += (q.reasoningTokens || 0);
        modelMap[qModel].totalTokens += q.totalTokens;
        modelMap[qModel].cost += qCost;
        modelMap[qModel].queryCount += 1;

        if (q.totalTokens > 0) {
            allPrompts.push({
                prompt: q.userPrompt || "(No Prompt)",
                inputTokens: q.inputTokens,
                outputTokens: q.outputTokens,
                cacheReadTokens: q.cachedTokens,
                reasoningTokens: q.reasoningTokens || 0,
                totalTokens: q.totalTokens,
                cost: qCost,
                date: date,
                sessionId: t.id,
                model: qModel,
            });
        }
    }
    }));
  }

  let dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  
  // Filter to last 30 days of usage maximum for the chart
  if (dailyUsage.length > 30) {
    dailyUsage = dailyUsage.slice(-30);
  }

  const modelBreakdown = Object.values(modelMap);
  
  allPrompts.sort((a, b) => b.totalTokens - a.totalTokens);
  const topPrompts = allPrompts.slice(0, 20);
  const topPromptsByTokens = [...allPrompts].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 20);
  const topPromptsByCost = [...allPrompts].sort((a, b) => b.cost - a.cost).slice(0, 20);

  // Build per-project aggregation
  const projectMap = {};
  for (const session of sessions) {
    const proj = session.project || 'unknown';
    if (!projectMap[proj]) {
      projectMap[proj] = {
        project: proj,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0,
        sessionCount: 0, queryCount: 0,
        modelMap: {},
        allPrompts: [],
      };
    }
    const p = projectMap[proj];
    p.inputTokens += session.inputTokens;
    p.outputTokens += session.outputTokens;
    p.totalTokens += session.totalTokens;
    p.cost += session.cost;
    p.sessionCount += 1;
    p.queryCount += session.queryCount;

    for (const q of session.queries) {
      if (q.model === '<synthetic>' || q.model === 'unknown') continue;
      if (!p.modelMap[q.model]) {
        p.modelMap[q.model] = { model: q.model, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, queryCount: 0 };
      }
      const m = p.modelMap[q.model];
      m.inputTokens += q.inputTokens;
      m.outputTokens += q.outputTokens;
      m.totalTokens += q.totalTokens;
      m.queryCount += 1;
    }

    let curPrompt = null, curInput = 0, curOutput = 0, curReasoning = 0, curConts = 0;
    let curModels = {};
    const flushProjectPrompt = () => {
      if (curPrompt && (curInput + curOutput + curReasoning) > 0) {
        const topModel = Object.entries(curModels).sort((a, b) => b[1] - a[1])[0]?.[0] || session.model;
        p.allPrompts.push({
          prompt: curPrompt.substring(0, 300),
          inputTokens: curInput,
          outputTokens: curOutput,
          totalTokens: curInput + curOutput + curReasoning,
          continuations: curConts,
          model: topModel,
          date: session.date,
          sessionId: session.sessionId,
        });
      }
    };
    for (const q of session.queries) {
      if (q.userPrompt && q.userPrompt !== curPrompt) {
        flushProjectPrompt();
        curPrompt = q.userPrompt;
        curInput = 0; curOutput = 0; curReasoning = 0; curConts = 0;
        curModels = {};
      } else if (!q.userPrompt) {
        curConts++;
      }
      curInput += q.inputTokens;
      curOutput += q.outputTokens;
      curReasoning += (q.reasoningTokens || 0);
      const m = q.model || session.model;
      curModels[m] = (curModels[m] || 0) + 1;
    }
    flushProjectPrompt();
  }

  const projectBreakdown = Object.values(projectMap).map(p => ({
    project: p.project,
    inputTokens: p.inputTokens,
    outputTokens: p.outputTokens,
    totalTokens: p.totalTokens,
    cost: p.cost,
    sessionCount: p.sessionCount,
    queryCount: p.queryCount,
    modelBreakdown: Object.values(p.modelMap).sort((a, b) => b.totalTokens - a.totalTokens),
    topPrompts: (p.allPrompts || []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
  })).sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: sessions.reduce((s, c) => s + c.totalTokens, 0),
    totalQueries: sessions.reduce((s, c) => s + c.queryCount, 0),
    totalCacheReadTokens: sessions.reduce((s, c) => s + c.cachedTokens, 0),
    totalInputTokens: sessions.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, c) => s + c.outputTokens, 0),
    totalReasoningTokens: sessions.reduce((s, c) => s + (c.reasoningTokens || 0), 0),
    dateRange: dailyUsage.length > 0
      ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
      : null,
  };
  
  const totalUncachedInput = Math.max(0, totals.totalInputTokens - totals.totalCacheReadTokens);
  totals.totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  totals.hasUnknownPricing = sessions.some(s => (s.queries || []).some(q => getPricing(q.model || s.model).unknown));
  totals.cacheHitRate = totals.totalInputTokens > 0 ? (totals.totalCacheReadTokens / totals.totalInputTokens) : 0;
  
  if (totals.dateRange && totals.dateRange.from && totals.dateRange.to) {
      const start = new Date(totals.dateRange.from).getTime();
      const end = new Date(totals.dateRange.to).getTime();
      const days = Math.max(1, (end - start) / (1000 * 60 * 60 * 24));
      
      const maxTime = Math.max(...sessions.map(s => s.createdAt || 0));
      // Anchor to current calendar month
      const refDate = new Date();
      
      const startOfCurrentMonth = new Date(refDate);
      startOfCurrentMonth.setDate(1);
      startOfCurrentMonth.setHours(0,0,0,0);
      
      const thisMonthSessions = sessions.filter(s => s.createdAt && new Date(s.createdAt) >= startOfCurrentMonth);
      totals.costThisMonth = thisMonthSessions.reduce((sum, s) => sum + s.cost, 0);
      
      const maxDaysInMonth = new Date(startOfCurrentMonth.getFullYear(), startOfCurrentMonth.getMonth() + 1, 0).getDate();
      const currentDayOfMonth = Math.max(1, refDate.getDate());
      totals.projectedMonthlyCost = (totals.costThisMonth / currentDayOfMonth) * maxDaysInMonth;

      // Calculate Week-over-week cost
      const weekMs = 7 * 24 * 60 * 60 * 1000;
      const lastWeekStart = maxTime - weekMs;
      const prevWeekStart = lastWeekStart - weekMs;

      const lastWeekCost = sessions.filter(s => s.createdAt > lastWeekStart).reduce((sum, s) => sum + s.cost, 0);
      const prevWeekCost = sessions.filter(s => {
        return s.createdAt > prevWeekStart && s.createdAt <= lastWeekStart;
      }).reduce((sum, s) => sum + s.cost, 0);

      if (prevWeekCost > 0) {
        const growth = ((lastWeekCost - prevWeekCost) / prevWeekCost) * 100;
        totals.weekOverWeek = (growth > 0 ? '+' : '') + growth.toFixed(0) + '%';
      } else if (lastWeekCost > 0) {
        totals.weekOverWeek = 'N/A';
      } else {
        totals.weekOverWeek = '0%';
      }
  } else {
      totals.costThisMonth = 0;
      totals.projectedMonthlyCost = 0;
      totals.weekOverWeek = 'N/A';
  }

  totals.avgTokensPerSession = totals.totalSessions > 0 ? Math.round(totals.totalTokens / totals.totalSessions) : 0;
  
  // Expose cache savings estimation for the UI
  totals.cacheSavings = sessions.reduce((sum, s) => {
    return sum + (s.queries || []).reduce((qSum, q) => {
      const p = getPricing(q.model || s.model);
      if (p.unknown) return qSum;
      return qSum + (q.cachedTokens || 0) * Math.max(0, p.input - p.cacheRead);
    }, 0);
  }, 0);

  const insights = generateInsights(sessions, allPrompts, totals, 'Codex');

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts,
    topPromptsByTokens,
    topPromptsByCost,
    totals,
    projectBreakdown,
    insights: insights
  };
}
module.exports = { parseAllSessions };

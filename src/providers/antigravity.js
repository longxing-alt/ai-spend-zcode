const fs = require('fs');
const path = require('path');
const os = require('os');
const { getPricing } = require('../pricing');
const { generateInsights } = require('../insights');

function getAntigravityDir() {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}

function parseDaemonLogs() {
  const daemonDir = path.join(getAntigravityDir(), 'daemon');
  let detectedModel = 'unknown';
  let apiCallCount = 0;
  
  if (fs.existsSync(daemonDir)) {
    try {
      const logFiles = fs.readdirSync(daemonDir).filter(f => f.endsWith('.log'));
      for (const logFile of logFiles) {
        const fullPath = path.join(daemonDir, logFile);
        const content = fs.readFileSync(fullPath, 'utf-8');
        
        // Match models in the log
        const modelMatches = [...content.matchAll(/model ([a-zA-Z0-9_.-]+)/g)];
        if (modelMatches.length > 0) {
          detectedModel = modelMatches[modelMatches.length - 1][1];
        }

        // Count API request density
        const requestMatches = [...content.matchAll(/Requesting planner with (\d+) chat messages/g)];
        apiCallCount += requestMatches.length;
      }
    } catch(e) {}
  }
  return { detectedModel, apiCallCount };
}

async function parseAllSessions(options = {}) {
  const agDir = getAntigravityDir();
  const sessionsDir = path.join(agDir, 'conversations');
  const sessions = [];
  const dailyMap = {};
  
  // Scrape daemon logs for active config
  const daemonData = parseDaemonLogs();
  // Fallback to commonly assumed Antigravity model if unknown
  const defaultModel = daemonData.detectedModel === 'unknown' ? 'claude-opus-4-6-thinking' : daemonData.detectedModel;

  if (fs.existsSync(sessionsDir)) {
    try {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.pb'));
      
      for (const file of files) {
        const fullPath = path.join(sessionsDir, file);
        const stat = fs.statSync(fullPath);
        const fileSizeMB = stat.size / (1024 * 1024);
        
        // Heuristic: 1MB of AES-encrypted PB roughly correlates to 65k tokens (prompt + output combined)
        const estimatedTokens = Math.round(fileSizeMB * 65000);
        
        const localDate = new Date(stat.mtimeMs);
        const date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
        
        const pricing = getPricing(defaultModel);
        // We lack input vs output split, assume 75% input, 25% output
        const estInput = Math.round(estimatedTokens * 0.75);
        const estOutput = estimatedTokens - estInput;
        const estCost = (estInput * pricing.input) + (estOutput * pricing.output);

        sessions.push({
          sessionId: file.replace('.pb', ''),
          firstPrompt: '[Encrypted Session]',
          project: 'Unknown',
          createdAt: stat.mtimeMs,
          updatedAt: stat.mtimeMs,
          date: date,
          duration: "N/A",
          model: defaultModel,
          reasoningLevel: "none",
          queryCount: 1, // Unknown
          queries: [{ userPrompt: '[Encrypted]', model: defaultModel, inputTokens: estInput, outputTokens: estOutput, cachedTokens: 0, reasoningTokens: 0, totalTokens: estimatedTokens }],
          totalTokens: estimatedTokens,
          inputTokens: estInput,
          outputTokens: estOutput,
          cachedTokens: 0,
          reasoningTokens: 0,
          cost: estCost,
          isEstimated: true // Custom flag for UI
        });
        
        if (!dailyMap[date]) {
            dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
        }
        dailyMap[date].inputTokens += estInput;
        dailyMap[date].outputTokens += estOutput;
        dailyMap[date].totalTokens += estimatedTokens;
        dailyMap[date].cost += estCost;
        dailyMap[date].sessions += 1;
        dailyMap[date].queries += 1;
      }
    } catch(e) {}
  }
  
  // Sort sessions newest first
  sessions.sort((a,b) => b.createdAt - a.createdAt);

  let dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  if (dailyUsage.length > 30) dailyUsage = dailyUsage.slice(-30);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: sessions.reduce((s, c) => s + c.totalTokens, 0),
    totalQueries: sessions.reduce((s, c) => s + c.queryCount, 0),
    totalCacheReadTokens: sessions.reduce((s, c) => s + c.cachedTokens, 0),
    totalInputTokens: sessions.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, c) => s + c.outputTokens, 0),
    totalReasoningTokens: 0,
    totalCost: sessions.reduce((s, c) => s + c.cost, 0),
    avgTokensPerSession: sessions.length > 0 ? Math.round(sessions.reduce((s, c) => s + c.totalTokens, 0) / sessions.length) : 0,
    cacheHitRate: 0,
    cacheSavings: 0,
    projectedMonthlyCost: 0,
    costThisMonth: 0,
    weekOverWeek: 'N/A',
    hasUnknownPricing: false,
    dateRange: dailyUsage.length > 0 ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null,
    logDensity: daemonData.apiCallCount
  };
  
  const modelBreakdown = [
    {
       model: defaultModel,
       inputTokens: totals.totalInputTokens,
       outputTokens: totals.totalOutputTokens,
       cacheReadTokens: 0,
       reasoningTokens: 0,
       totalTokens: totals.totalTokens,
       cost: totals.totalCost,
       queryCount: totals.totalQueries,
       unknownPricing: false
    }
  ];

  const insights = generateInsights(sessions, [], totals, 'Antigravity');

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts: [],
    topPromptsByTokens: [],
    topPromptsByCost: [],
    totals,
    projectBreakdown: [],
    insights
  };
}

module.exports = { parseAllSessions };

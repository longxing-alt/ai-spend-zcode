const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { generateInsights } = require('../insights');

function getCursorDbPath() {
  return path.join(os.homedir(), '.cursor', 'ai-tracking', 'ai-code-tracking.db');
}

function q(sql, dbPath) {
  try {
    const r = spawnSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
    if (r.error || r.status !== 0) return [];
    const out = r.stdout ? r.stdout.trim() : "";
    return out ? JSON.parse(out) : [];
  } catch (e) {
    return [];
  }
}

async function parseAllSessions(options = {}) {
  const dbPath = getCursorDbPath();
  const sessions = [];
  const dailyMap = {};
  const projectMap = {};

  if (!fs.existsSync(dbPath)) {
    return { sessions, dailyUsage: [], modelBreakdown: [], topPrompts: [], topPromptsByTokens: [], topPromptsByCost: [], totals: { totalSessions: 0, totalTokens: 0, totalCost: 0 }, projectBreakdown: [], insights: [] };
  }

  // Group events into "sessions" by conversationId
  const events = q(`
    SELECT conversationId, MIN(createdAt) as createdAt, MAX(createdAt) as updatedAt, source, model, COUNT(*) as queryCount
    FROM ai_code_hashes
    GROUP BY conversationId
    ORDER BY createdAt DESC
  `, dbPath);

  let totalQueries = 0;
  for (const row of events) {
    const ts = row.createdAt; // Already in MS
    const localDate = new Date(ts);
    const date = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
    const model = row.model || 'unknown';
    const source = row.source || 'composer';
    let duration = "N/A";
    
    if (row.updatedAt && row.createdAt && row.updatedAt > row.createdAt) {
      duration = `${((row.updatedAt - row.createdAt) / 60000).toFixed(1)} mins`;
    }

    sessions.push({
      sessionId: row.conversationId || 'unknown',
      firstPrompt: `[${source}] Session`,
      project: 'Unknown',
      createdAt: ts,
      updatedAt: row.updatedAt || ts,
      date: date,
      duration: duration,
      model: model,
      reasoningLevel: "none",
      queryCount: row.queryCount,
      queries: Array(row.queryCount).fill({ userPrompt: '[Code Event]', model, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTokens: 0 }),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      isEstimated: true // Cursor has no token data
    });

    totalQueries += row.queryCount;

    if (!dailyMap[date]) {
      dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, sessions: 0, queries: 0 };
    }
    dailyMap[date].sessions += 1;
    dailyMap[date].queries += row.queryCount;
  }

  let dailyUsage = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));
  if (dailyUsage.length > 30) dailyUsage = dailyUsage.slice(-30);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: 0,
    totalQueries: totalQueries,
    totalCacheReadTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    avgTokensPerSession: 0,
    cacheHitRate: 0,
    cacheSavings: 0,
    projectedMonthlyCost: 0,
    costThisMonth: 0,
    weekOverWeek: 'N/A',
    hasUnknownPricing: false,
    dateRange: dailyUsage.length > 0 ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date } : null,
    providerType: 'tracking', // Identifies this as an event-based provider
    eventLabel: 'Code Events'
  };

  const modelBreakdown = [
    {
       model: 'default',
       inputTokens: 0,
       outputTokens: 0,
       cacheReadTokens: 0,
       reasoningTokens: 0,
       totalTokens: 0,
       cost: 0,
       queryCount: totalQueries,
       unknownPricing: false
    }
  ];

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts: [],
    topPromptsByTokens: [],
    topPromptsByCost: [],
    totals,
    projectBreakdown: [],
    insights: generateInsights(sessions, [], totals, 'Cursor')
  };
}

module.exports = { parseAllSessions };

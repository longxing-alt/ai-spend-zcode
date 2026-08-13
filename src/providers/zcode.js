/**
 * ZCode provider — 读取 ZCode CLI 的用量数据库
 *
 * 数据源：~/.zcode/cli/db/db.sqlite 的 model_usage 表（每行 = 一次模型 API 请求）
 * 关键字段：
 *   input_tokens / output_tokens / reasoning_tokens
 *   cache_creation_input_tokens / cache_read_input_tokens   ← 缓存命中统计
 *   started_at / completed_at（毫秒）/ session_id / model_id / status
 *
 * 输出结构与 codex.js 完全同构（sessions / dailyUsage / modelBreakdown / totals），
 * 因此 dashboard 与 CLI 预览无需任何改动即可渲染。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const { getPricing, calculateCost } = require('../pricing');

function getDbPath() {
  return path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
}

function openDb() {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    try {
      return new DatabaseSync(dbPath);
    } catch {
      return null;
    }
  }
}

function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function parseAllSessions() {
  const db = openDb();
  if (!db) return { sessions: [], totals: emptyTotals() };

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT session_id, model_id, input_tokens, output_tokens, reasoning_tokens,
                cache_creation_input_tokens, cache_read_input_tokens,
                started_at, completed_at, status
         FROM model_usage
         WHERE status = 'completed'
         ORDER BY started_at ASC`
      )
      .all();
  } catch (err) {
    try { db.close(); } catch {}
    return { sessions: [], totals: emptyTotals(), error: err.message };
  }
  try { db.close(); } catch {}

  // 按会话聚合请求
  const groups = new Map();
  for (const r of rows) {
    const sid = r.session_id || 'orphan';
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(r);
  }

  const sessions = [];
  const dailyMap = {};
  const modelMap = {};
  const allPrompts = [];

  for (const [sid, reqs] of groups) {
    const queries = reqs.map((r) => ({
      inputTokens: r.input_tokens || 0,
      cachedTokens: r.cache_read_input_tokens || 0,
      cacheCreationTokens: r.cache_creation_input_tokens || 0,
      outputTokens: r.output_tokens || 0,
      reasoningTokens: r.reasoning_tokens || 0,
      model: r.model_id || 'unknown',
      reasoningLevel: 'none',
      createdAt: r.started_at ? new Date(r.started_at) : null,
    }));

    const totalInput = queries.reduce((s, q) => s + q.inputTokens, 0);
    const totalCacheRead = queries.reduce((s, q) => s + q.cachedTokens, 0);
    const totalCacheCreation = queries.reduce((s, q) => s + q.cacheCreationTokens, 0);
    const totalOutput = queries.reduce((s, q) => s + q.outputTokens, 0);
    const totalReasoning = queries.reduce((s, q) => s + q.reasoningTokens, 0);
    const totalTokens = totalInput + totalOutput + totalReasoning;

    // 会话模型 = 请求数最多的模型
    const modelCounts = {};
    for (const q of queries) modelCounts[q.model] = (modelCounts[q.model] || 0) + 1;
    const model = Object.entries(modelCounts).sort((a, b) => b[1] - a[1])[0][0];

    const createdAt = reqs[0].started_at;
    const updatedAt = reqs[reqs.length - 1].completed_at || reqs[reqs.length - 1].started_at;
    const durationSec = updatedAt && createdAt ? (updatedAt - createdAt) / 1000 : 0;
    const duration = durationSec > 0 ? `${(durationSec / 60).toFixed(1)} mins` : 'N/A';

    const sessionCost = queries.reduce(
      (sum, q) => sum + calculateCost(q.model, q.inputTokens, q.cachedTokens, q.outputTokens, q.reasoningTokens),
      0
    );

    const date = fmtDate(createdAt);
    sessions.push({
      sessionId: sid,
      firstPrompt: `ZCode 会话 ${String(sid).slice(0, 18)}`,
      project: null,
      createdAt,
      updatedAt,
      date,
      duration,
      model,
      reasoningLevel: 'none',
      queryCount: queries.length,
      queries,
      totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      reasoningTokens: totalReasoning,
      cost: sessionCost,
    });

    // 按日聚合
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

    // 按模型聚合
    for (const q of queries) {
      const qModel = q.model;
      if (!modelMap[qModel]) {
        modelMap[qModel] = { model: qModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, queryCount: 0, unknownPricing: false };
      }
      const p = getPricing(qModel);
      if (p.unknown) modelMap[qModel].unknownPricing = true;
      const qUncached = Math.max(0, q.inputTokens - q.cachedTokens);
      const qCost = p.unknown ? 0 : qUncached * p.input + q.cachedTokens * p.cacheRead + q.outputTokens * p.output + q.reasoningTokens * p.reasoningResult;
      modelMap[qModel].inputTokens += q.inputTokens;
      modelMap[qModel].outputTokens += q.outputTokens;
      modelMap[qModel].cacheReadTokens += q.cachedTokens;
      modelMap[qModel].reasoningTokens += q.reasoningTokens;
      modelMap[qModel].totalTokens += q.inputTokens + q.outputTokens + q.reasoningTokens;
      modelMap[qModel].cost += qCost;
      modelMap[qModel].queryCount += 1;
    }
  }

  const dailyUsage = Object.values(dailyMap).sort((a, b) => (a.date < b.date ? -1 : 1));
  const modelBreakdown = Object.values(modelMap).sort((a, b) => b.totalTokens - a.totalTokens);

  const totals = {
    totalSessions: sessions.length,
    totalTokens: sessions.reduce((s, c) => s + c.totalTokens, 0),
    totalQueries: sessions.reduce((s, c) => s + c.queryCount, 0),
    totalCacheReadTokens: sessions.reduce((s, c) => s + c.cachedTokens, 0),
    totalCacheCreationTokens: sessions.reduce((s, c) => s + (c.cacheCreationTokens || 0), 0),
    totalInputTokens: sessions.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: sessions.reduce((s, c) => s + c.outputTokens, 0),
    totalReasoningTokens: sessions.reduce((s, c) => s + c.reasoningTokens, 0),
    dateRange:
      dailyUsage.length > 0
        ? { from: dailyUsage[0].date, to: dailyUsage[dailyUsage.length - 1].date }
        : null,
  };

  totals.totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  totals.hasUnknownPricing = sessions.some((s) => (s.queries || []).some((q) => getPricing(q.model).unknown));
  // 缓存命中率 = 缓存读取 tokens / 总输入 tokens（含缓存读取）
  totals.cacheHitRate = totals.totalInputTokens > 0 ? totals.totalCacheReadTokens / totals.totalInputTokens : 0;
  totals.costThisMonth = 0;
  totals.projectedMonthlyCost = 0;
  totals.weekOverWeek = 'N/A';
  totals.avgTokensPerSession = totals.totalSessions > 0 ? Math.round(totals.totalTokens / totals.totalSessions) : 0;
  // 缓存节省估算：cache read 按输入价与缓存价的差价计算
  totals.cacheSavings = sessions.reduce((sum, s) => {
    return (
      sum +
      (s.queries || []).reduce((qSum, q) => {
        const p = getPricing(q.model || s.model);
        if (p.unknown) return qSum;
        return qSum + (q.cachedTokens || 0) * Math.max(0, p.input - p.cacheRead);
      }, 0)
    );
  }, 0);

  return {
    sessions,
    dailyUsage,
    modelBreakdown,
    topPrompts: allPrompts,
    topPromptsByTokens: [],
    topPromptsByCost: [],
    totals,
    insights: [],
  };
}

function emptyTotals() {
  return {
    totalSessions: 0,
    totalTokens: 0,
    totalQueries: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCost: 0,
    hasUnknownPricing: true,
    cacheHitRate: 0,
    costThisMonth: 0,
    projectedMonthlyCost: 0,
    weekOverWeek: 'N/A',
    avgTokensPerSession: 0,
    cacheSavings: 0,
    dateRange: null,
  };
}

module.exports = { parseAllSessions };

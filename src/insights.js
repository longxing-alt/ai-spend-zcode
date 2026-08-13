const { MODEL_PRICING, calculateCost } = require('./pricing');
const { getModelContextLimits, resolveContextLimit, normalizeReasoningLevel, wordCount } = require('./utils');
function generateInsights(sessions, allPrompts, totals, providerName = 'Codex') {
  const insights = [];

  function fmt(n) {
    if (n === undefined || n === null) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000) return (n / 1_000).toFixed(0) + 'k';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
    return n.toLocaleString();
  }

  function modelShort(m) {
    if (!m) return 'Unknown';
    
    // Generic model shortening for all providers
    // Matches gpt-X.X, claude-X.X, etc.
    let match = m.match(/^([a-z0-9-]+?)(?:-([\d\.]+))?(?:-(mini|max|sonnet|opus|haiku))?$/i);
    if (match) {
      const toolBase = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const version = match[2] || '';
      const modifier = match[3] ? (match[3].charAt(0).toUpperCase() + match[3].slice(1)) : '';
      return `${toolBase} ${version} ${modifier}`.trim();
    }
    return m;
  }

  function validateInsightCost(insightId, value) {
    if (!Number.isFinite(value)) {
      console.warn(`[ai-spend] Suppressing insight "${insightId}" due to invalid cost value: ${value}`);
      return null;
    }
    return value;
  }

  // 1. Long conversations getting more expensive over time
  const longSessions = sessions.filter(s => s.queries.length > 50);
  if (longSessions.length > 0) {
    const growthData = longSessions.map(s => {
      const first5 = s.queries.slice(0, 5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      const last5 = s.queries.slice(-5).reduce((sum, q) => sum + q.totalTokens, 0) / Math.min(5, s.queries.length);
      return { session: s, first5, last5, ratio: last5 / Math.max(first5, 1) };
    }).filter(g => g.ratio > 2);

    if (growthData.length > 0) {
      const avgGrowth = (growthData.reduce((s, g) => s + g.ratio, 0) / growthData.length).toFixed(1);
      const worstSession = growthData.sort((a, b) => b.ratio - a.ratio)[0];
      
      const first5Cost = worstSession.session.queries.slice(0, 5).reduce((sum, q) => sum + calculateCost(q.model, q.inputTokens, q.cachedTokens, q.outputTokens, q.reasoningTokens), 0) / Math.min(5, worstSession.session.queries.length);
      const last5Cost = worstSession.session.queries.slice(-5).reduce((sum, q) => sum + calculateCost(q.model, q.inputTokens, q.cachedTokens, q.outputTokens, q.reasoningTokens), 0) / Math.min(5, worstSession.session.queries.length);

      insights.push({
        id: 'context-growth',
        type: 'warning',
        title: `The longer you chat, the more each message costs ($${first5Cost.toFixed(2)} grew to $${last5Cost.toFixed(2)}/msg)`,
        description: `In ${growthData.length} of your conversations with ${providerName}, the messages near the end cost ${avgGrowth}x more than the ones at the start. Why? Every time you send a message, the AI re-reads the entire conversation from the beginning. So message #5 is cheap, but message #80 is expensive because it is re-reading 79 previous messages plus all the code it wrote. Your longest conversation ("${worstSession.session.firstPrompt.substring(0, 50)}...") grew to $${last5Cost.toFixed(2)} per message by the end, compared to $${first5Cost.toFixed(2)} at the start.`,
        action: `Start a fresh conversation when you move to a new task. If you need context from before, paste a short summary in your first message. This gives ${providerName} a clean slate instead of re-reading hundreds of old messages.`,
      });
    }
  }

  // 2. Output Optimization (The Stop Yapping Rule)
  if (sessions.length > 0) {
    const heavyWriters = sessions.filter(s => s.queryCount > 0 && (s.outputTokens / s.queryCount) > 2500);
    if (heavyWriters.length > 0) {
      const worst = heavyWriters.sort((a,b) => (b.outputTokens/b.queryCount) - (a.outputTokens/a.queryCount))[0];
      const avgOutput = Math.round(worst.outputTokens / worst.queryCount);
      const estCostPerTurn = (worst.cost / worst.queryCount);
      insights.push({
        id: 'output-optimization',
        type: 'warning',
        title: `${providerName} is rewriting entire files (${fmt(avgOutput)} output tokens / ~$${estCostPerTurn.toFixed(2)} per turn)`,
        description: `In the session "${worst.firstPrompt.substring(0, 50)}...", ${providerName} averaged ${fmt(avgOutput)} output tokens every time it replied. This usually means it is rewriting massive files from scratch just to change one or two lines, which drains your budget quickly.`,
        action: `Add a system rule like: "Only return the functions you changed, do not rewrite the entire file." This keeps the output tokens strictly focused on edits.`,
      });
    }
  }

  // 3. Token Burn Rate Insight
  const sessionsWithDuration = sessions.filter(s => s.duration !== "N/A" && parseFloat(s.duration) > 0);
  if (sessionsWithDuration.length > 0) {
    let topBurners = sessionsWithDuration.map(s => {
      const mins = parseFloat(s.duration);
      return { session: s, burnRate: Math.round(s.totalTokens / mins), costRate: s.cost / mins };
    }).sort((a, b) => b.burnRate - a.burnRate);
    
    topBurners = topBurners.filter(b => b.burnRate > 10000);

    if (topBurners.length > 0) {
      const top = topBurners[0];
      insights.push({
        id: 'token-burn-rate',
        type: 'warning',
        title: `Fastest Token Burn: ${fmt(top.burnRate)} tokens/min (~$${top.costRate.toFixed(2)}/min)`,
        description: `Your highest token burn rate was during the conversation "${top.session.firstPrompt.substring(0, 50)}...". Over roughly ${top.session.duration}, you consumed ${fmt(top.session.totalTokens)} tokens, which is ${fmt(top.burnRate)} tokens (or ~$${top.costRate.toFixed(2)}) per minute. High burn rates usually happen when you rapidly fire off messages in a conversation that already has a massive context history.`,
        action: 'When you are iteratively debugging (sending rapid short messages back and forth), consider starting a fresh conversation with just the relevant context. This resets the "baggage" that gets re-read every time you hit enter.',
      });
    }
  }

  // 4. Context Window Utilisation
  const modelContextLimits = getModelContextLimits();
  
  const nearLimitSessions = sessions.filter(s => {
    const limit = resolveContextLimit(s.model, modelContextLimits);
    if (!s.queries || s.queries.length === 0) return false;
    if (!limit) return false;
    const peakInput = Math.max(...s.queries.map(q => q.requestInputTokens || 0));
    return peakInput > (limit * 0.8);
  });

  if (nearLimitSessions.length > 0) {
    const s = nearLimitSessions[0];
    const peakInput = Math.max(...s.queries.map(q => q.requestInputTokens || 0));
    const limit = resolveContextLimit(s.model, modelContextLimits) || 128000;
    insights.push({
      id: 'context-window-limit',
      type: 'warning',
      title: `Approaching context window limits (${((peakInput/limit)*100).toFixed(0)}% full)`,
      description: `In ${nearLimitSessions.length === 1 ? 'one conversation' : nearLimitSessions.length + ' conversations'} (like "${s.firstPrompt.substring(0, 50)}..."), your context reached ${fmt(peakInput)} tokens in a single request. The absolute limit for ${modelShort(s.model)} is ${fmt(limit)}. As you approach the limit, the model may forget earlier instructions or begin ignoring files.`,
      action: `Close unused files in your IDE and aggressively start new conversations when tackling distinct sub-tasks. ${providerName} works best when its context window is focused only on what is strictly necessary.`,
    });
  } else {
    const highContextUnknownLimit = sessions
      .filter(s => s.queries && s.queries.length > 0 && !resolveContextLimit(s.model, modelContextLimits))
      .map(s => ({
        session: s,
        peakInput: Math.max(...s.queries.map(q => q.requestInputTokens || 0)),
      }))
      .filter(entry => entry.peakInput > 100000)
      .sort((a, b) => b.peakInput - a.peakInput);

    if (highContextUnknownLimit.length > 0) {
      const top = highContextUnknownLimit[0];
      insights.push({
        id: 'context-window-limit',
        type: 'warning',
        title: `High context usage detected (${fmt(top.peakInput)} tokens in one request)`,
        description: `In ${highContextUnknownLimit.length === 1 ? 'one conversation' : highContextUnknownLimit.length + ' conversations'} (like "${top.session.firstPrompt.substring(0, 50)}..."), single requests reached very high input token volume. We could not determine an exact context limit for this model, so this is an estimate rather than a precise saturation percentage.`,
        action: 'If responses become inconsistent, split work into smaller sessions and keep only the most relevant files in context.',
      });
    }
  }

  // 4. Reasoning ROI Analyzer (High Effort on Short Prompts)
  const allQueries = sessions.flatMap(s => s.queries || []);
  const highReasoningQueries = allQueries.filter(q => {
    const level = normalizeReasoningLevel(q.reasoningLevel);
    return level === 'high' || level === 'very_high';
  });
  
  if (highReasoningQueries.length > 0) {
    const lowROIPrompts = highReasoningQueries.filter(q => 
      q.userPrompt && !q.userPrompt.includes('<image>') && wordCount(q.userPrompt) < 20 && q.reasoningTokens > 2000
    );
    
    if (lowROIPrompts.length > 5) {
      const wastedTokens = lowROIPrompts.reduce((sum, q) => sum + q.reasoningTokens, 0);
      const wastedCost = lowROIPrompts.reduce((sum, q) => sum + calculateCost(q.model, 0, 0, 0, q.reasoningTokens), 0);
      insights.push({
        id: 'reasoning-roi',
        type: 'warning',
        title: `Low ROI on "High" Reasoning Effort (${fmt(wastedTokens)} tokens / wasted $${wastedCost.toFixed(2)})`,
        description: `You have ${lowROIPrompts.length} recent prompts that were very short (under 20 words) but generated over 2,000 hidden reasoning tokens each. For example, asking "${lowROIPrompts[0].userPrompt.substring(0, 30)}..." burned massive reasoning tokens. While it only cost $${wastedCost.toFixed(2)} here, this habit will scale up to drain your wallet over hundreds of queries. High reasoning effort is charged as expensive output tokens.`,
        action: `Switch to "Low" reasoning effort for quick formatting requests, simple questions, or small targeted edits. Only use "High" effort for complex architectural design or tough bug fixing.`,
      });
    }
  }

  // 5. The Tab Hoarder Warning (Massive baselines)
  const massiveBaselines = sessions.filter(s => s.queries && s.queries.length > 0 && s.queries[0].inputTokens > 50000);
  if (massiveBaselines.length > 3) {
    const avgStart = Math.round(massiveBaselines.reduce((sum, s) => sum + s.queries[0].inputTokens, 0) / massiveBaselines.length);
    const avgCost = massiveBaselines.reduce((sum, s) => sum + calculateCost(s.queries[0].model, s.queries[0].inputTokens, 0, 0, 0), 0) / massiveBaselines.length;
    const totalWasted = avgCost * massiveBaselines.length;
    insights.push({
      id: 'tab-hoarder',
      type: 'warning',
      title: `You might be a Tab Hoarder (Cost you ~$${totalWasted.toFixed(2)} across ${massiveBaselines.length} sessions)`,
      description: `In ${massiveBaselines.length} recent conversations, your very first message sent over ${fmt(avgStart)} input tokens to ${providerName}. This usually happens when you have dozens of unrelated files open in your IDE. The AI is forced to read all of them every time you ask a question. Charging ~$${avgCost.toFixed(2)} per session just to say hello quietly adds up ($${totalWasted.toFixed(2)} total here).`,
      action: `Close unused files and tabs before starting a new conversation. This dramatically reduces your base input token cost and speeds up response time by giving the AI less noise to sift through.`,
    });
  }

  // 6. Maximize Cache Hits
  if (totals.totalInputTokens > 0) {
    const cachePct = (totals.totalCacheReadTokens / totals.totalInputTokens) * 100;
    if (cachePct < 50) {
      insights.push({
        id: 'cache-optimization',
        type: 'info',
        title: `Your cache hit rate is only ${cachePct.toFixed(0)}%`,
        description: `Many modern AI tools offer a massive discount on "cached" input tokens. Currently, out of ${fmt(totals.totalInputTokens)} total input tokens, only ${fmt(totals.totalCacheReadTokens)} were served from cache. This means you are paying full price for heavily repetitive context.`,
        action: 'To maximize cache hits, keep your system prompts and large files at the beginning of the context, and only add new messages to the end. Modifying files that were included early in the conversation will invalidate the cache.',
      });
    }
  }

  // 7. Night Owl Habit
  if (totals.totalTokens > 0 && sessions.length > 5) {
    let lateNightTokens = 0;
    let lateNightCost = 0;
    let totalTimeTokens = 0;
    sessions.forEach(s => {
      const ts = s.createdAt || s.updatedAt;
      if (ts) {
        const dt = new Date(ts);
        const hour = dt.getHours();
        totalTimeTokens += s.totalTokens;
        if (hour >= 22 || hour < 4) {
          lateNightTokens += s.totalTokens;
          lateNightCost += s.cost;
        }
      }
    });
    
    if (totalTimeTokens > 0) {
      const nightPct = (lateNightTokens / totalTimeTokens) * 100;
      if (nightPct > 40) {
        insights.push({
          id: 'night-owl',
          type: 'info',
          title: `You are a Night Owl! (${nightPct.toFixed(0)}% late-night usage / $${lateNightCost.toFixed(2)})`,
          description: `Most of your heavy lifting happens when the sun goes down. Exactly ${nightPct.toFixed(0)}% of your total ${providerName} token usage (${fmt(lateNightTokens)} tokens, costing $${lateNightCost.toFixed(2)}) happens between 10:00 PM and 4:00 AM.`,
          action: `Late night coding sessions can lead to marathon context windows. Remember to start fresh conversations if you switch topics deep into the night to avoid dragging huge memory payloads.`,
        });
      }
    }
  }

  // 8. The "One-Word Reply" Trap
  const tinyPrompts = allQueries.filter(q => q.userPrompt && !q.userPrompt.includes('<image>') && wordCount(q.userPrompt) < 3 && q.inputTokens > 100000);
  if (tinyPrompts.length > 3) {
    const wastedCostRaw = tinyPrompts.reduce((sum, q) => sum + calculateCost(q.model, q.inputTokens, 0, 0, 0), 0);
    const wastedCost = validateInsightCost('one-word-reply', wastedCostRaw);
    if (wastedCost !== null) {
      insights.push({
        id: 'one-word-reply',
        type: 'warning',
        title: `The "One-Word Reply" Trap (wasted ~$${wastedCost.toFixed(2)})`,
        description: `In ${tinyPrompts.length} recent queries, you replied with less than 3 words (like "${tinyPrompts[0].userPrompt}"), which forced ${providerName} to re-read a massive context history of over 100k tokens each time.`,
        action: `Try to batch your feedback into a single descriptive message instead of rapid-fire short replies.`,
      });
    }
  }

  // 10. The Tool Loop Warning
  const heavyToolQueries = allQueries.filter(q => q.continuations > 10);
  if (heavyToolQueries.length > 0) {
    const worstToolQuery = heavyToolQueries.sort((a,b) => b.continuations - a.continuations)[0];
    const toolCost = calculateCost(worstToolQuery.model, worstToolQuery.inputTokens, worstToolQuery.cachedTokens, worstToolQuery.outputTokens, worstToolQuery.reasoningTokens);
    insights.push({
      id: 'tool-loop-warning',
      type: 'warning',
      title: `Extended tool interactions detected (estimated ~$${toolCost.toFixed(2)})`,
      description: `In a recent prompt ("${worstToolQuery.userPrompt.substring(0, 30)}..."), we estimated about ${worstToolQuery.continuations} continuation cycles before the response completed.`,
      action: `This can happen when requests are broad or workspace context is large. Try pointing the AI directly to relevant file paths and narrowing scope.`,
    });
  }

  // 11. Micro-Tasking with Heavy Baggage
  const microSessions = sessions.filter(s => s.queryCount === 1 && s.queries[0].inputTokens > 50000 && parseFloat(s.duration) < 2);
  if (microSessions.length > 5) {
    const microCostRaw = microSessions.reduce((sum, s) => sum + s.cost, 0);
    const microCost = validateInsightCost('micro-tasking', microCostRaw);
    if (microCost !== null) {
      insights.push({
        id: 'micro-tasking',
        type: 'warning',
        title: `You are carrying heavy luggage for short trips (wasted ~$${microCost.toFixed(2)})`,
        description: `You started ${microSessions.length} new conversations recently for a single quick question, but your IDE sent over massive background context payloads each time.`,
        action: `Close unused tabs before asking quick, one-off questions to drastically reduce your baseline token cost.`,
      });
    }
  }

  // 12. Weekend Warrior
  if (totals.totalTokens > 0 && sessions.length > 5) {
    let weekendTokens = 0;
    let weekendCost = 0;
    sessions.forEach(s => {
      const ts = s.createdAt || s.updatedAt;
      if (ts) {
        const dt = new Date(ts);
        const day = dt.getDay();
        if (day === 0 || day === 6) {
          weekendTokens += s.totalTokens;
          weekendCost += s.cost;
        }
      }
    });
    const weekendPct = (weekendTokens / totals.totalTokens) * 100;
    if (weekendPct > 30) {
      const safeWeekendCost = validateInsightCost('weekend-warrior', weekendCost);
      if (safeWeekendCost !== null) {
        insights.push({
          id: 'weekend-warrior',
          type: 'info',
          title: `You’re a Weekend Warrior! (${weekendPct.toFixed(0)}% weekend usage / $${safeWeekendCost.toFixed(2)})`,
          description: `Over ${weekendPct.toFixed(0)}% of your token spend ($${safeWeekendCost.toFixed(2)}) happened on Saturday or Sunday.`,
          action: `Make sure to take breaks! Continuous coding without rest can lead to burnout and less efficient prompting.`,
        });
      }
    }
  }

  // 13. The "Abandoned Context" Waste
  const abandonedSessions = sessions.filter(s => s.queries && s.queries.length === 1 && s.queries[0].inputTokens > 80000 && (!s.queries[0].outputTokens || s.queries[0].outputTokens < 50));
  if (abandonedSessions.length > 3) {
    const abndnCostRaw = abandonedSessions.reduce((sum, s) => sum + s.cost, 0);
    const abndnCost = validateInsightCost('abandoned-context', abndnCostRaw);
    if (abndnCost !== null) {
      insights.push({
        id: 'abandoned-context',
        type: 'warning',
        title: `You loaded the entire codebase but never followed up (wasted ~$${abndnCost.toFixed(2)})`,
        description: `You have ${abandonedSessions.length} recent sessions where you initialized a massive context window but abandoned the chat almost immediately after the first reply.`,
        action: `Be mindful of starting heavy sessions you don't intend to finish. It costs money just to initialize the context window!`,
      });
    }
  }

  // == EVENT-BASED INSIGHTS (For Cursor & Tracking Providers) ==

  // 14. High Turn Density (Deep Conversations)
  const deepConversations = sessions.filter(s => s.queryCount > 15);
  if (deepConversations.length > 3) {
    const avgTurns = Math.round(deepConversations.reduce((sum, s) => sum + s.queryCount, 0) / deepConversations.length);
    insights.push({
      id: 'high-turn-density',
      type: 'info',
      title: `Deep Conversations detected (Avg ${avgTurns} turns)`,
      description: `You have ${deepConversations.length} recent sessions with ${providerName} that exceeded 15 turns each. Deep conversations are great for complex logic, but be aware that every turn increases the background context size.`,
      action: `If you feel the AI is getting "confused" or slow near the end of these ${avgTurns}-turn marathons, try starting a fresh session with just the current code state.`,
    });
  }

  // 15. Rapid Succession (The Iteration Loop)
  const dailySessions = {};
  sessions.forEach(s => { if (s.date) dailySessions[s.date] = (dailySessions[s.date] || 0) + 1; });
  const hyperActiveDays = Object.entries(dailySessions).filter(([date, count]) => count > 10);
  if (hyperActiveDays.length > 0) {
    const [bestDate, bestCount] = hyperActiveDays.sort((a, b) => b[1] - a[1])[0];
    insights.push({
      id: 'rapid-succession',
      type: 'info',
      title: `High-frequency iteration loop (${bestCount} sessions on ${bestDate})`,
      description: `On ${bestDate}, you started ${bestCount} different conversation threads with ${providerName}. This indicates a very high-speed development cycle.`,
      action: `If these were for related tasks, try staying in one session longer to benefit from shared context, which can improve the AI's understanding of your project structure.`,
    });
  }

  // 16. The "Drafting" Habit (Short sessions)
  const shortSessions = sessions.filter(s => s.queryCount <= 2);
  if (shortSessions.length > 10 && sessions.length > 20) {
    const pct = ((shortSessions.length / sessions.length) * 100).toFixed(0);
    insights.push({
      id: 'drafting-habit',
      type: 'info',
      title: `The "Quick Draft" habit (${pct}% of sessions are < 2 turns)`,
      description: `In ${shortSessions.length} sessions (${pct}% of your total), you only asked 1 or 2 questions before ending the conversation with ${providerName}.`,
      action: `This is a very efficient way to use AI for targeted questions. Just ensure you aren't paying a "baseline cost" (heavy input) for every single one of these short trips!`,
    });
  }

  return insights;
}
module.exports = { generateInsights };

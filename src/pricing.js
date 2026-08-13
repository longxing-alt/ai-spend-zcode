const MODEL_PRICING = {
  // Codex Primary Models (Mapped to GPT-4o equivalent API costs)
  'gpt-5.3-codex': { input: 1.75 / 1e6, cacheRead: 0.175 / 1e6, output: 14.00 / 1e6, reasoningResult: 14.00 / 1e6 },
  'gpt-5.2-codex': { input: 1.75 / 1e6, cacheRead: 0.175 / 1e6, output: 14.00 / 1e6, reasoningResult: 14.00 / 1e6 },
  'gpt-5.1-codex-max': { input: 1.25 / 1e6, cacheRead: 0.125 / 1e6, output: 10.00 / 1e6, reasoningResult: 10.00 / 1e6 },
  'gpt-5.2': { input: 1.75 / 1e6, cacheRead: 0.175 / 1e6, output: 14.00 / 1e6, reasoningResult: 14.00 / 1e6 },
  
  // Codex Mini Model (Mapped to GPT-4o-Mini equivalent API costs)
  'gpt-5.1-codex-mini': { input: 0.25 / 1e6, cacheRead: 0.025 / 1e6, output: 2.00 / 1e6, reasoningResult: 2.00 / 1e6 },

  // Anthropic Claude Models
  'claude-opus-4-6-thinking': { input: 5.00 / 1e6, cacheRead: 0.50 / 1e6, output: 25.00 / 1e6, reasoningResult: 25.00 / 1e6 },
  'claude-sonnet-4-6': { input: 3.00 / 1e6, cacheRead: 0.30 / 1e6, output: 15.00 / 1e6, reasoningResult: 15.00 / 1e6 },
  'claude-haiku-4-5': { input: 1.00 / 1e6, cacheRead: 0.10 / 1e6, output: 5.00 / 1e6, reasoningResult: 5.00 / 1e6 },
  
  // Anthropic Claude Older Models (for legacy JSONL files)
  'claude-3-5-sonnet-20241022': { input: 3.00 / 1e6, cacheRead: 0.30 / 1e6, output: 15.00 / 1e6, reasoningResult: 15.00 / 1e6 },
  'claude-3-5-haiku-20241022': { input: 1.00 / 1e6, cacheRead: 0.10 / 1e6, output: 5.00 / 1e6, reasoningResult: 5.00 / 1e6 },
};

const DEFAULT_PRICING = { input: 0, cacheRead: 0, output: 0, reasoningResult: 0, unknown: true };

function getPricing(model) {
  if (!model) return DEFAULT_PRICING;
  const m = model.toLowerCase();
  
  if (m.includes('5.3')) return MODEL_PRICING['gpt-5.3-codex'];
  if (m.includes('codex-mini')) return MODEL_PRICING['gpt-5.1-codex-mini'];
  if (m.includes('codex-max')) return MODEL_PRICING['gpt-5.1-codex-max'];
  if (m.includes('5.2-codex')) return MODEL_PRICING['gpt-5.2-codex'];
  if (m.includes('5.2')) return MODEL_PRICING['gpt-5.2'];

  if (m.includes('opus')) return MODEL_PRICING['claude-opus-4-6-thinking'];
  if (m.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  if (m.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5'];
  
  return DEFAULT_PRICING;
}

function calculateCost(model, inputTokens, cachedTokens, outputTokens, reasoningTokens) {
  const pricing = getPricing(model);
  if (pricing.unknown) return 0;
  const uncached = Math.max(0, inputTokens - cachedTokens);
  return (uncached * pricing.input) + (cachedTokens * pricing.cacheRead) + (outputTokens * pricing.output) + ((reasoningTokens || 0) * pricing.reasoningResult);
}

module.exports = {
  getPricing,
  calculateCost,
  MODEL_PRICING,
  DEFAULT_PRICING
};

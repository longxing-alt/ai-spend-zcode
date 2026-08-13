
const path = require('path');
const fs = require('fs');
const os = require('os');

function getCodexDir() {
  return path.join(os.homedir(), '.codex');
}

const DEFAULT_CONTEXT_LIMITS = {
  // Codex
  'gpt-5.3-codex': 128000,
  'gpt-5.2-codex': 128000,
  'gpt-5.1-codex-max': 128000,
  'gpt-5.1-codex-mini': 128000,
  'gpt-5.2': 128000,
  // Claude
  'claude-3-5-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-3-haiku': 200000,
  // Antigravity
  'antigravity': 128000
};

let cachedContextLimits = null;

function getModelContextLimits() {
  if (cachedContextLimits) return cachedContextLimits;

  const limits = { ...DEFAULT_CONTEXT_LIMITS };
  try {
    const cachePath = path.join(getCodexDir(), 'models_cache.json');
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const models = Array.isArray(parsed?.models) ? parsed.models : [];
      for (const model of models) {
        const slug = String(model?.slug || '').toLowerCase().trim();
        const contextWindow = Number(model?.context_window || 0);
        if (slug && Number.isFinite(contextWindow) && contextWindow > 0) {
          limits[slug] = contextWindow;
        }
      }
    }
  } catch {
  }

  cachedContextLimits = limits;
  return limits;
}

function resolveContextLimit(model, limits) {
  if (!model) return null;
  const m = String(model).toLowerCase();
  if (limits[m]) return limits[m];
  
  // Fuzzy matching for various providers
  if (m.includes('5.3') && limits['gpt-5.3-codex']) return limits['gpt-5.3-codex'];
  if (m.includes('codex-mini') && limits['gpt-5.1-codex-mini']) return limits['gpt-5.1-codex-mini'];
  if (m.includes('codex-max') && limits['gpt-5.1-codex-max']) return limits['gpt-5.1-codex-max'];
  if (m.includes('sonnet') && limits['claude-3-5-sonnet']) return limits['claude-3-5-sonnet'];
  if (m.includes('opus') && limits['claude-3-opus']) return limits['claude-3-opus'];
  if (m.includes('antigravity')) return limits['antigravity'];
  
  if (m.includes('5.2')) return limits['gpt-5.2'] || 128000;
  return null;
}

function cleanPrompt(text) {
  if (!text) return "(No Prompt)";
  // Patterns used by different AI IDEs to append metadata
  const separators = [
    "## My request for Codex:",
    "## Request:",
    "--- Request ---"
  ];
  for (const sep of separators) {
    const idx = text.lastIndexOf(sep);
    if (idx !== -1) {
      const extracted = text.substring(idx + sep.length).trim();
      if (extracted) return extracted;
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("# AGENTS.md")) return "(No Prompt)";
  if (trimmed.startsWith("<environment_context>")) return "(No Prompt)";
  if (trimmed.startsWith("<INSTRUCTIONS>")) return "(No Prompt)";
  return trimmed;
}

function normalizeReasoningLevel(level) {
  if (level === null || level === undefined) return null;
  if (typeof level === 'number') {
    if (level <= 1) return 'low';
    if (level === 2) return 'medium';
    if (level === 3) return 'high';
    return 'very_high';
  }
  const raw = String(level).trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'low' || raw === '1') return 'low';
  if (raw === 'med' || raw === 'medium' || raw === '2') return 'medium';
  if (raw === 'high' || raw === '3') return 'high';
  if (raw === 'very high' || raw === 'very_high' || raw === 'veryhigh' || raw === '4') return 'very_high';
  return null;
}

function wordCount(text) {
  if (!text || typeof text !== 'string') return 0;
  const words = text.trim().split(/s+/).filter(Boolean);
  return words.length;
}

module.exports = {
  getCodexDir,
  getModelContextLimits,
  resolveContextLimit,
  cleanPrompt,
  normalizeReasoningLevel,
  wordCount
};

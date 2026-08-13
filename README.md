# 💸 Codex-Spend

<p align="center">
  <img src="src/public/logo.png" width="120" height="120" alt="codex-spend logo">
</p>

<p align="center">
  <a href="https://startupslab.site" target="_blank" rel="noopener">
    <img src="https://cdn.startupslab.site/site-images/badge-dark.png" alt="Featured on Startups Lab" width="200" height="54" />
  </a>
</p>

**See where your OpenAI Codex tokens go. One command.**

`codex-spend` is a local dashboard for analyzing OpenAI Codex CLI usage. It parses your local Codex session/state data and visualizes token usage, estimated cost, and patterns that can help reduce spend.

---

## ✨ Features

- **⚡️ Instant Terminal Summary:** Get a high-level breakdown of your recent sessions directly in your terminal on startup.
- **🛡️ Local Analyzer:** Your Codex usage data is read locally, and the dashboard runs on `127.0.0.1`.
- **📈 Usage Analytics:** Visualizations for daily token usage, model breakdowns, and token categories.
- **💡 Actionable Insights:** identify "One-Word Reply" traps, "Tab Hoarder" habits, and "Night Owl" patterns to save real money.
- **📂 Project Breakdown:** See exactly which repositories or directories are consuming the most tokens.
- **💰 Cost Estimates:** Includes **Prompt Caching (90% discount)** and **Reasoning Tokens** in estimated costs.
- **Model-Aware Pricing:** Known Codex models are priced directly; unknown models are surfaced with a pricing warning.

## 🚀 Quick Start

Run it instantly without installation using `npx`:

```bash
npx codex-spend
```

### CLI Options

| Flag | Description | Default |
| :--- | :--- | :--- |
| `--port <number>` | Change the local server port | `4321` |
| `--state-db <path>` | Override Codex state DB path (advanced) | auto-detect latest |
| `--no-open` | Skip automatic browser opening | |
| `--help` | Show usage instructions | |

## 🛠️ How it Works

When you run `codex-spend`, the tool:
1. Locates your Codex CLI state (usually `~/.codex`).
2. Parses your `state_n.sqlite` database and `sessions/` transaction logs.
3. Automatically opens a beautiful local dashboard at `http://localhost:4321`.

### Requirements

- Node.js `>=18`
- `sqlite3` CLI installed on your system (used to read Codex state database)

## 💰 Understanding Codex Pricing

The dashboard uses estimated cost calculations based on OpenAI API per-token pricing (Standard tier).

- **Prompt Caching:** Codex gives you a **90% discount** on input tokens when it re-reads context it has seen recently. The dashboard highlights your "Cache Hit Rate" and estimated savings.
- **Reasoning Tokens:** Reasoning tokens are billed at output-token rates; the dashboard tracks them separately.
- **Model Coverage:** Pricing is applied for known mapped models. If a model is unknown, the dashboard warns that total cost may be underestimated.

## 🔐 Privacy

`codex-spend` is strictly a local analyzer. 
- It **never** reads your API keys.
- It does not upload your Codex usage payloads.
- The source code is open for audit.

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.

---

## 👨‍💻 Author

**Rishet Mehra**
- **GitHub:** [@Rishet11](https://github.com/Rishet11)
- **LinkedIn:** [Rishet Mehra](https://www.linkedin.com/in/rishetmehra/)
- **Email:** rishetmehra11@gmail.com

---

## ✨ ZCode Support (this fork)

This fork adds a **ZCode** provider — analytics for [ZCode](https://github.com/zcode) CLI usage,
sourced from `~/.zcode/cli/db/db.sqlite` (the `model_usage` table, one row per model request).

### What's tracked

- **Tokens per request/session**: input / output / reasoning
- **Cache hit analytics**: `cache_read_input_tokens` and `cache_creation_input_tokens`
  → **Cache Hit Rate** displayed in both the CLI preview and the dashboard
- **Per-session / per-model / per-day aggregation**, same data shape as the Codex provider,
  so the dashboard renders it with zero changes

### Usage

```bash
ai-spend --provider zcode        # ZCode dashboard only
ai-spend                          # auto-detects ZCode first, falls back to Codex
```

> ⚠️ **Cost column shows N/A** for ZCode models: pricing for models like `deepseek-v4-flash`
> is not bundled (the original package only prices Codex/Claude models). Token and cache-hit
> statistics are exact regardless.

### Technical notes

- Database is opened **read-only** (`node:sqlite` `DatabaseSync`, `readOnly: true`)
- WAL-mode friendly: no locks, no writes to your ZCode data
- Requires Node.js ≥ 22.5 (built-in `node:sqlite`)

### Files changed vs upstream `ai-spend@2.0.2`

| File | Change |
|---|---|
| `src/providers/zcode.js` | **new** — ZCode `model_usage` parser |
| `src/providers/index.js` | register `zcode` provider |
| `index.js` | CLI preview prefers ZCode when data exists |
| `src/public/index.html` | add `zcode` to `providerMeta` (fixes tab rendering) |

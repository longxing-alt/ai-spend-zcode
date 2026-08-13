#!/usr/bin/env node

const { createServer } = require('./src/server');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
ai-spend - Universal local AI IDE spend tracker

Usage:
  ai-spend [options]

Options:
  --provider <name>  Show data for: codex, claude-code, antigravity, cursor (default: all)
  --port <port>      Port to run dashboard on (default: 4321)
  --no-open          Don't auto-open browser
  --help, -h         Show this help message

Examples:
  npx ai-spend                    Open dashboard for all providers
  ai-spend --provider antigravity View only Antigravity usage
  ai-spend --port 8080            Use custom port
`);
  process.exit(0);
}

const portIndex = args.indexOf('--port');
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : 4321;
const providerIndex = args.indexOf('--provider');
const providerSelection = providerIndex !== -1 ? args[providerIndex + 1] : 'all';
const noOpen = args.includes('--no-open');

if (isNaN(port)) {
  console.error('Error: --port must be a number');
  process.exit(1);
}

const app = createServer();

const server = app.listen(port, '127.0.0.1', async () => {
  const url = `http://localhost:${port}`;
  
  try {
    const providers = require('./src/providers');
    let data = null;
    let providerLabel = "Various Providers";
    
    if (providerSelection === 'all' || !providers[providerSelection]) {
        // 默认优先预览 ZCode（本机主力 AI 工具），无数据时回落 Codex
        try {
            const zcodeData = await providers['zcode'].parseAllSessions();
            if (zcodeData && zcodeData.sessions && zcodeData.sessions.length > 0) {
                data = zcodeData;
                providerLabel = 'ZCode';
            } else {
                data = await providers['codex'].parseAllSessions();
                providerLabel = 'Codex';
            }
        } catch {
            data = await providers['codex'].parseAllSessions();
            providerLabel = 'Codex';
        }
    } else {
        data = await providers[providerSelection].parseAllSessions();
        providerLabel = providerSelection.charAt(0).toUpperCase() + providerSelection.slice(1);
    }

    if (data && data.sessions && data.sessions.length > 0) {
      console.log('');
      console.log(' \x1b[38;2;0;113;227m  ____             _             \x1b[0m');
      console.log(' \x1b[38;2;0;113;227m / ___|  ___   __| |  ___ __  __\x1b[0m');
      console.log(' \x1b[38;2;0;113;227m| |     / _ \\ / _` | / _ \\\\ \\/ /\x1b[0m');
      console.log(' \x1b[38;2;0;113;227m| |___ | (_) | (_| ||  __/ >  < \x1b[0m');
      console.log(' \x1b[38;2;0;113;227m \\____| \\___/ \\__,_| \\___|/_/\\_\\\x1b[0m   \x1b[38;2;50;173;230m- ai-spend\x1b[0m');
      console.log('');
      console.log(` \x1b[37mUniversal local AI IDE spend tracker. Showing preview for: ${providerLabel}\x1b[0m`);
      console.log('');
      
      const colTitle = 28;
      const colDate = 10;
      const colModel = 15;
      const colReasoning = 9;
      const colTokens = 12;
      const colCost = 8;
      
      const headerSep = '='.repeat(87);

      const header = 
        'Title'.padEnd(colTitle) + ' | ' +
        'Date'.padEnd(colDate) + ' | ' +
        'Model'.padEnd(colModel) + ' | ' +
        'Reasoning'.padEnd(colReasoning) + ' | ' +
        'Tokens'.padEnd(colTokens) + ' | ' +
        'Cost'.padStart(colCost);
      
      console.log(header);
      console.log('-'.repeat(header.length));
      
      const recent = [...data.sessions].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 10).reverse(); // show last 10
      for (const s of recent) {
        const title = s.firstPrompt.length > colTitle ? s.firstPrompt.substring(0, colTitle - 3) + '...' : s.firstPrompt.padEnd(colTitle);
        // format date as DD-MM-YY
        const dparts = s.date.split('-');
        const dateStr = (dparts.length === 3 ? `${dparts[2]}-${dparts[1]}-${dparts[0].slice(2)}` : s.date).padEnd(colDate);
        
        const model = s.model.length > colModel ? s.model.substring(0, colModel) : s.model.padEnd(colModel);
        
        let rsn = s.reasoningLevel || "none";
        if (rsn === "very_high") rsn = "Very High";
        else rsn = rsn.charAt(0).toUpperCase() + rsn.slice(1);
        const reasoning = rsn.padEnd(colReasoning);
        
        const formatK = (n) => n >= 1_000_000 ? (n/1_000_000).toFixed(1) + 'm' : (n >= 1000 ? (n/1000).toFixed(0) + 'k' : n.toString());
        let tokensStr = formatK(s.totalTokens).padEnd(colTokens);
        if (s.isEstimated) tokensStr = ('~' + tokensStr.trim()).padEnd(colTokens);
        
        let costStr;
        if (s.cost === 0 && data.totals.hasUnknownPricing) {
          costStr = " N/A".padStart(colCost);
        } else if (s.cost === 0 && s.totalTokens === 0) {
          costStr = " N/A".padStart(colCost); // e.g. Cursor
        } else if (s.cost > 0 && s.cost < 0.01) {
          costStr = "< $0.01".padStart(colCost);
        } else {
          costStr = ('$' + s.cost.toFixed(2)).padStart(colCost);
          if (s.isEstimated) costStr = '~' + costStr.trim();
          costStr = costStr.padStart(colCost);
        }

        console.log(`${title} | ${dateStr} | ${model} | ${reasoning} | ${tokensStr} | ${costStr}`);
      }
      
      const t = data.totals;
      console.log(headerSep);
      
      const inM = (Math.max(0, t.totalInputTokens - (t.totalCacheReadTokens || 0)) / 1_000_000).toFixed(1);
      const cacheM = (t.totalCacheReadTokens / 1_000_000).toFixed(1);
      const rsnM = (t.totalReasoningTokens / 1_000_000).toFixed(1);
      const outM = (t.totalOutputTokens / 1_000_000).toFixed(1);
      
      const cIn = `\x1b[38;2;99;102;241m${inM}M uncached in\x1b[0m`;
      const cCache = `\x1b[38;2;245;158;11m${cacheM}M cache\x1b[0m`;
      const cRsn = `\x1b[38;2;168;85;247m${rsnM}M rsn\x1b[0m`;
      const cOut = `\x1b[38;2;20;184;166m${outM}M out\x1b[0m`;

      console.log(`Totals: ${(t.totalTokens / 1_000_000).toFixed(1)}M Tokens (${cIn} / ${cCache} / ${cRsn} / ${cOut}) | Cache Hit: ${((t.cacheHitRate || 0) * 100).toFixed(0)}% | Est. Cost: $${(t.totalCost || 0).toFixed(2)}`);
      if (t.hasUnknownPricing) {
        console.log('⚠️ WARNING: Some models have unknown pricing.');
      }
      console.log(headerSep);
      console.log('');
    }
  } catch (err) {
    // Ignore parsing errors on boot, the UI will surface them
  }

  console.log(`  🚀 Dashboard running at: ${url}\n`);

  if (!noOpen) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      console.log('  Could not auto-open browser. Open the URL manually.');
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try --port <other-port>`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log('  Shutting down...');
  server.close();
  process.exit(0);
});

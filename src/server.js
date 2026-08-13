const express = require('express');
const path = require('path');
const providers = require('./providers');

function createServer() {
  const app = express();

  // Cache parsed data per provider
  let cachedData = {};

  async function getProviderData(providerName) {
    if (!cachedData[providerName]) {
      const providerModule = providers[providerName];
      if (providerModule) {
        cachedData[providerName] = await providerModule.parseAllSessions();
      } else {
        throw new Error(`Unknown provider: ${providerName}`);
      }
    }
    return cachedData[providerName];
  }

  app.get('/api/providers', async (req, res) => {
    try {
      const summary = {};
      for (const [name, module] of Object.entries(providers)) {
        const data = await getProviderData(name);
        summary[name] = {
          sessionCount: data.sessions.length,
          totalTokens: data.totals.totalTokens,
          cost: data.totals.totalCost,
          isDetected: data.sessions.length > 0
        };
      }
      res.json(summary);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/data', async (req, res) => {
    try {
      const providerName = req.query.provider || 'codex';
      const data = await getProviderData(providerName);
      
      // Strip out raw queries to prevent massive frontend JSON payload
      const safeData = {
        ...data,
        sessions: data.sessions.map(s => ({ ...s, queries: [] }))
      };
      res.json(safeData);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/session/:id', async (req, res) => {
    try {
      const providerName = req.query.provider || 'codex';
      const data = await getProviderData(providerName);
      
      const session = data.sessions.find(s => s.sessionId === req.params.id);
      if (session) {
        res.json(session);
      } else {
        res.status(404).json({ error: 'Not found' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/refresh', async (req, res) => {
    try {
      const providerName = req.query.provider || 'codex';
      delete require.cache[require.resolve('./providers/index')];
      delete require.cache[require.resolve(`./providers/${providerName}`)];
      
      cachedData[providerName] = await providers[providerName].parseAllSessions();
      res.json({ ok: true, sessions: cachedData[providerName].sessions.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve static dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  return app;
}

module.exports = { createServer };

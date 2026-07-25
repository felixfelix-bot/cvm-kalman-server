/**
 * Dashboard API Bridge
 * 
 * Queries ContextVM Kalman Data Server via cvmi and serves JSON
 * for the browser-based dashboard. Runs at localhost:3001.
 */

import http from 'node:http';
import { execSync } from 'node:child_process';

const PORT = 3001;
const NPUB = 'npub18zvqh4qgjsqegclgymkj4mm4qcukt4tv9gw0l08e56qdh683ssuqmnalae';
const RELAYS = 'wss://relay2.contextvm.org,wss://nos.lol,wss://relay.nostr.band,wss://relay.primal.net';

// Cache results to avoid hammering the server
const cache = new Map();
const CACHE_TTL = 25000; // 25s

async function callTool(toolName, args = '') {
  const cacheKey = `${toolName}:${args}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  try {
    const cmd = `npx cvmi call ${NPUB} ${toolName} ${args} --relays "${RELAYS}" 2>/dev/null`;
    const output = execSync(cmd, {
      timeout: 30000,
      encoding: 'utf8',
      cwd: '/home/c03rad0r/repos/cvm-kalman-server',
    });
    const data = JSON.parse(output);
    cache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch (err) {
    console.error(`Error calling ${toolName}:`, err.message);
    // Return cached data if available, even if stale
    if (cached) return cached.data;
    return null;
  }
}

async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === '/api/all') {
    // Fetch all data in parallel
    const [usage, decisions, kalman, costs, quotas, transitions, system, balances] = await Promise.all([
      callTool('get_usage_summary', 'hours_back=168'),
      callTool('get_model_decisions', 'hours_back=168'),
      callTool('get_kalman_status'),
      callTool('get_cost_breakdown', 'hours_back=168'),
      callTool('get_quota_windows'),
      callTool('get_key_transitions', 'limit=50'),
      callTool('get_system_stats'),
      callTool('get_provider_balances'),
    ]);

    const payload = {
      timestamp: new Date().toISOString(),
      usage,
      decisions,
      kalman,
      costs,
      quotas,
      transitions,
      system,
      balances,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Dashboard API</h1><p>Visit <a href="/dashboard">/dashboard</a> for the dashboard</p></body></html>');
    return;
  }

  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

const server = http.createServer(handleRequest);
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Dashboard API] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard API] Data endpoint: http://localhost:${PORT}/api/all`);
});

// Warm up cache on startup
callTool('get_system_stats').then(() => console.log('[Dashboard API] Cache warmed: system_stats'));

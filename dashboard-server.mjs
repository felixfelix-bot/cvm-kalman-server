/**
 * Kalman Dashboard Server
 * 
 * Reads zai_usage.db directly (fast) + ContextVM for live system stats.
 * Serves both the API and the dashboard HTML.
 * Port 3001.
 */

import http from 'node:http';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import fs from 'node:fs';

const PORT = 3001;
const DB_PATH = '/home/c03rad0r/.hermes/bot/zai_usage.db';
const BURN_DB_PATH = '/home/c03rad0r/.hermes/bot/api_burn.db';

function getDb() {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  const rows = [];
  for (const row of stmt.iterate(...params)) rows.push(row);
  return rows;
}

// ── System stats from /proc ───────────────────────────────────────────────

function getSystemStats() {
  let cpuPercent = 0;
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    const idle = parseInt(stat[4]);
    const total = stat.slice(1).reduce((a, b) => a + parseInt(b), 0);
    cpuPercent = Math.round((1 - idle / total) * 100 * 10) / 10;
  } catch {}

  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let swapTotal = 0, swapUsed = 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const getVal = (key) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    swapTotal = getVal('SwapTotal');
    swapUsed = swapTotal - getVal('SwapFree');
  } catch {}

  return {
    cpu_percent: cpuPercent,
    cpu_count: os.cpus().length,
    memory: {
      total_bytes: totalMem,
      used_bytes: totalMem - freeMem,
      used_pct: Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10,
    },
    swap: {
      total_bytes: swapTotal,
      used_bytes: swapUsed,
      used_pct: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
    },
    load_avg: {
      '1m': Math.round(os.loadavg()[0] * 100) / 100,
      '5m': Math.round(os.loadavg()[1] * 100) / 100,
      '15m': Math.round(os.loadavg()[2] * 100) / 100,
    },
    uptime_seconds: os.uptime(),
    uptime_days: Math.floor(os.uptime() / 86400),
    hostname: os.hostname(),
  };
}

// ── Pricing ───────────────────────────────────────────────────────────────

function computePricing(db) {
  const OLLAMA_MONTHLY_USD = 100.0;
  const FRIEND_PREMIUM = 1.21;
  const SECONDS_PER_MONTH = 86400 * 30;

  const ollamaRow = queryAll(db, `
    SELECT MAX(ts) as max_ts FROM api_calls WHERE key_name = 'ollama_cloud'
  `)[0];
  const maxTs = ollamaRow?.max_ts || Math.floor(Date.now() / 1000);

  const ollama30d = queryAll(db, `
    SELECT sum(total_tokens) as tokens FROM api_calls
    WHERE key_name = 'ollama_cloud' AND ts > ?
  `, [maxTs - SECONDS_PER_MONTH])[0];

  const ollamaTokens = ollama30d?.tokens || 1;
  const ollamaUsdPerM = OLLAMA_MONTHLY_USD / (ollamaTokens / 1e6);
  const friendUsdPerM = ollamaUsdPerM * FRIEND_PREMIUM;

  return { ollamaUsdPerM, friendUsdPerM, ollamaTokens, OLLAMA_MONTHLY_USD, FRIEND_PREMIUM };
}

// ── Data fetchers ─────────────────────────────────────────────────────────

function getDashboardData() {
  const db = getDb();
  try {
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - 7 * 86400;

    // Usage by key (7d)
    const byKey = queryAll(db, `
      SELECT key_name, count(*) as calls, sum(total_tokens) as tokens,
        sum(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) as success,
        avg(duration_ms) as avg_ms
      FROM api_calls WHERE ts > ? AND key_name IS NOT NULL
      GROUP BY key_name ORDER BY calls DESC
    `, [weekAgo]);

    // Hourly time series (7d)
    const hourly = queryAll(db, `
      SELECT CAST(ts/3600 AS INTEGER)*3600 as hour_ts, key_name,
        sum(total_tokens) as tokens, count(*) as calls
      FROM api_calls WHERE ts > ? AND key_name IS NOT NULL
      GROUP BY hour_ts, key_name ORDER BY hour_ts ASC
    `, [weekAgo]);

    // Model decisions timeline (7d) — from key_decisions table
    let decisions = [];
    try {
      decisions = queryAll(db, `
        SELECT CAST(ts/3600 AS INTEGER)*3600 as hour_ts, chosen_key as key, reason,
          count(*) as count
        FROM key_decisions WHERE ts > ?
        GROUP BY hour_ts, chosen_key, reason ORDER BY hour_ts ASC
      `, [weekAgo]);
    } catch {}

    // Key decisions (recent transitions)
    let transitions = [];
    try {
      transitions = queryAll(db, `
        SELECT ts, chosen_key, reason FROM key_decisions
        WHERE ts > ? ORDER BY ts DESC LIMIT 100
      `, [weekAgo]);
    } catch {}

    // Kalman samples
    let kalman = [];
    try {
      kalman = queryAll(db, `
        SELECT ts, key, window, burn_rate_tph, projected_total_pct,
          used_pct_observed, exhausts_in_hours, will_exhaust
        FROM kalman_samples WHERE ts > ?
        ORDER BY ts DESC LIMIT 500
      `, [now - 10 * 3600]);
    } catch {}

    // Pricing + costs
    const pricing = computePricing(db);
    const costs = byKey.map(k => {
      let usdPerM = 0;
      if (k.key_name === 'ollama_cloud') usdPerM = pricing.ollamaUsdPerM;
      else if (k.key_name === 'friend') usdPerM = pricing.friendUsdPerM;
      else if (k.key_name === 'ours') usdPerM = 0;
      return {
        key: k.key_name,
        calls: k.calls,
        tokens: k.tokens,
        tokens_M: Math.round(k.tokens / 1e6 * 100) / 100,
        usd_per_M: Math.round(usdPerM * 100) / 100,
        total_usd: Math.round(k.tokens * usdPerM / 1e6 * 100) / 100,
      };
    });

    // Anomaly events
    let anomalies = [];
    try {
      anomalies = queryAll(db, `
        SELECT ts, type, message FROM anomaly_events
        WHERE ts > ? ORDER BY ts DESC LIMIT 50
      `, [weekAgo]);
    } catch {}

    // Daily spend
    let dailySpend = [];
    try {
      dailySpend = queryAll(db, `
        SELECT date, key, spend_usd, tokens FROM daily_spend
        ORDER BY date DESC LIMIT 30
      `);
    } catch {}

    return {
      timestamp: new Date().toISOString(),
      system: getSystemStats(),
      usage_by_key: byKey.map(k => ({
        key: k.key_name,
        calls: k.calls,
        tokens: k.tokens,
        tokens_M: Math.round(k.tokens / 1e6 * 100) / 100,
        success_rate: Math.round(k.success / k.calls * 1000) / 10,
        avg_duration_ms: Math.round(k.avg_ms),
      })),
      hourly: hourly.map(h => ({
        ts: h.hour_ts,
        iso: new Date(h.hour_ts * 1000).toISOString(),
        key: h.key_name,
        tokens: h.tokens,
        calls: h.calls,
      })),
      decisions: decisions.map(d => ({
        ts: d.hour_ts,
        iso: new Date(d.hour_ts * 1000).toISOString(),
        key: d.key,
        reason: d.reason,
        count: d.count,
      })),
      transitions: transitions.map(t => ({
        ts: t.ts,
        iso: new Date(t.ts * 1000).toISOString(),
        key: t.chosen_key,
        reason: t.reason,
      })),
      kalman: kalman.map(k => ({
        ts: k.ts,
        iso: new Date(k.ts * 1000).toISOString(),
        key: k.key,
        window: k.window,
        burn_rate_tph: Math.round(k.burn_rate_tph),
        projected_pct: Math.round(k.projected_total_pct * 10) / 10,
        used_pct: Math.round(k.used_pct_observed * 10) / 10,
        exhausts_in_hours: k.exhausts_in_hours ? Math.round(k.exhausts_in_hours * 10) / 10 : null,
        will_exhaust: k.will_exhaust === 1,
      })),
      costs: {
        ollama_usd_per_M: Math.round(pricing.ollamaUsdPerM * 100) / 100,
        friend_usd_per_M: Math.round(pricing.friendUsdPerM * 100) / 100,
        ollama_monthly_usd: pricing.OLLAMA_MONTHLY_USD,
        friend_premium: pricing.FRIEND_PREMIUM,
        by_key: costs,
        total_usd_7d: Math.round(costs.reduce((s, c) => s + c.total_usd, 0) * 100) / 100,
      },
      anomalies: anomalies.map(a => ({
        ts: a.ts,
        iso: new Date(a.ts * 1000).toISOString(),
        type: a.type,
        message: a.message,
      })),
      daily_spend: dailySpend,
    };
  } finally {
    db.close();
  }
}

// ── HTML Dashboard ────────────────────────────────────────────────────────

function getDashboardHTML() {
  return fs.readFileSync('/home/c03rad0r/repos/cvm-kalman-server/dashboard.html', 'utf8');
}

// ── Server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/all') {
    try {
      const data = getDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/dashboard.html') {
    try {
      const html = getDashboardHTML();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('dashboard.html not found: ' + err.message);
    }
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Dashboard] Running at http://localhost:${PORT}`);
  console.log(`[Dashboard] API: http://localhost:${PORT}/api/all`);
  console.log(`[Dashboard] UI:  http://localhost:${PORT}/dashboard`);
});

/**
 * ContextVM Kalman Data Server
 *
 * Exposes zai_usage.db data as MCP tools over the ContextVM (CVM) protocol.
 * Clients (dashboard, other agents, humans) connect via Nostr npub:
 *   npub18zvqh4qgjsqegclgymkj4mm4qcukt4tv9gw0l08e56qdh683ssuqmnalae
 *
 * Tools exposed:
 *   get_usage_summary   — token counts by key, model, time range
 *   get_model_decisions — model/tier/reason breakdown
 *   get_kalman_status   — live Kalman convergence verdict
 *   get_cost_breakdown  — effective cost per key (Ollama baseline + friend 21% premium)
 *   get_quota_windows   — 5h/weekly quota per key
 *   get_key_transitions — recent key switches with reasons
 *   get_system_stats    — CPU, memory, swap, uptime from /proc
 *   get_provider_balances — PPQ/OpenRouter balance + projections
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NostrServerTransport, PrivateKeySigner, ApplesauceRelayPool } from '@contextvm/sdk';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';

// ── Config ────────────────────────────────────────────────────────────────

const SERVER_PRIVATE_KEY = process.env.CVM_SERVER_NSEC
  ?? (() => {
    const fs = require('fs');
    const hex = fs.readFileSync(
      process.env.CVM_SERVER_KEY_FILE
        ?? '/home/c03rad0r/.hermes/state/cvm-kalman-server.key',
      'utf8'
    ).trim();
    // Convert hex to nsec using nostr-tools bech32 encoding
    // @contextvm/sdk PrivateKeySigner accepts nsec1... or hex
    return hex; // hex works directly
  })();

const DB_PATH = process.env.ZAI_USAGE_DB
  ?? '/home/c03rad0r/.hermes/bot/zai_usage.db';

const BURN_DB_PATH = process.env.API_BURN_DB
  ?? '/home/c03rad0r/.hermes/bot/api_burn.db';

const RELAYS = [
  'wss://relay2.contextvm.org',
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net',
];

// ── Pricing model ─────────────────────────────────────────────────────────

const OLLAMA_MONTHLY_USD = 100.0;        // $100/mo flat
const ZAI_MONTHLY_EUR = 144.0;           // €144/mo flat (cancelled, historical)
const FRIEND_PREMIUM = 1.21;             // 21% premium on friend's tokens
const SECONDS_PER_DAY = 86400;
const SECONDS_PER_MONTH = 86400 * 30;

// ── SQLite helpers ────────────────────────────────────────────────────────

function openDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function openBurnDb(): DatabaseSync {
  return new DatabaseSync(BURN_DB_PATH, { readOnly: true });
}

function queryAll(db: DatabaseSync, sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  const rows: any[] = [];
  for (const row of stmt.iterate(...params)) {
    rows.push(row as any);
  }
  return rows;
}

// ── System stats from /proc ───────────────────────────────────────────────

function getSystemStats(): any {
  const fs = require('fs');
  const os = require('os');

  // CPU usage from /proc/stat
  let cpuPercent = 0;
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].split(/\s+/);
    const idle = parseInt(stat[4]);
    const total = stat.slice(1).reduce((a: number, b: string) => a + parseInt(b), 0);
    cpuPercent = Math.round((1 - idle / total) * 100 * 10) / 10;
  } catch {}

  // Memory
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Swap from /proc/swaps or /proc/meminfo
  let swapTotal = 0, swapUsed = 0, swapFree = 0;
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const getVal = (key: string) => {
      const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
      return m ? parseInt(m[1]) * 1024 : 0; // kB to bytes
    };
    swapTotal = getVal('SwapTotal');
    swapFree = getVal('SwapFree');
    swapUsed = swapTotal - swapFree;
  } catch {}

  // Swap thrashing: read vmstat for pswpin/pswpout
  let swapIn = 0, swapOut = 0;
  try {
    const vmstat = fs.readFileSync('/proc/vmstat', 'utf8');
    const getVmstat = (key: string) => {
      const m = vmstat.match(new RegExp(`${key}\\s+(\\d+)`));
      return m ? parseInt(m[1]) : 0;
    };
    swapIn = getVmstat('pswpin');
    swapOut = getVmstat('pswpout');
  } catch {}

  // Load average
  const load = os.loadavg();

  // Uptime
  const uptimeSeconds = os.uptime();

  return {
    cpu_percent: cpuPercent,
    cpu_count: os.cpus().length,
    cpu_model: os.cpus()[0]?.model || 'unknown',
    memory: {
      total_bytes: totalMem,
      used_bytes: usedMem,
      free_bytes: freeMem,
      used_pct: Math.round((usedMem / totalMem) * 1000) / 10,
    },
    swap: {
      total_bytes: swapTotal,
      used_bytes: swapUsed,
      free_bytes: swapFree,
      used_pct: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 1000) / 10 : 0,
      pages_in: swapIn,
      pages_out: swapOut,
      thrashing: swapIn + swapOut > 0,
    },
    load_avg: {
      '1m': Math.round(load[0] * 100) / 100,
      '5m': Math.round(load[1] * 100) / 100,
      '15m': Math.round(load[2] * 100) / 100,
    },
    uptime_seconds: uptimeSeconds,
    uptime_days: Math.floor(uptimeSeconds / SECONDS_PER_DAY),
    hostname: os.hostname(),
    timestamp: Date.now(),
  };
}

// ── MCP Tools ─────────────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({
    name: 'kalman-data-server',
    version: '1.0.0',
  });

  // ── get_usage_summary ──────────────────────────────────────────────────
  server.registerTool(
    'get_usage_summary',
    {
      description: 'Get API token usage summary by key and model. Returns token counts, call counts, and average duration.',
      inputSchema: {
        hours_back: z.number().default(168).describe('Hours of history to include (default 168 = 7 days)'),
      },
    },
    async ({ hours_back }) => {
      const db = openDb();
      try {
        const cutoff = Math.floor(Date.now() / 1000) - hours_back * 3600;

        // By key
        const byKey = queryAll(db, `
          SELECT
            key_name as eff_key,
            count(*) as calls,
            sum(total_tokens) as total_tokens,
            sum(prompt_tokens) as prompt_tokens,
            sum(completion_tokens) as completion_tokens,
            avg(duration_ms) as avg_duration_ms,
            sum(CASE WHEN status_code = 200 THEN 1 ELSE 0 END) as success_count,
            sum(cache_hit) as cache_hits
          FROM api_calls
          WHERE ts > ? AND key_name IS NOT NULL
          GROUP BY eff_key
          ORDER BY calls DESC
        `, [cutoff]);

        // By model
        const byModel = queryAll(db, `
          SELECT
            model,
            key_name as eff_key,
            count(*) as calls,
            sum(total_tokens) as total_tokens,
            avg(total_tokens) as avg_tokens_per_call,
            avg(duration_ms) as avg_duration_ms
          FROM api_calls
          WHERE ts > ? AND model IS NOT NULL
          GROUP BY model, eff_key
          ORDER BY calls DESC
        `, [cutoff]);

        // Hourly time series for charts
        const hourly = queryAll(db, `
          SELECT
            CAST(ts/3600 AS INTEGER)*3600 as hour_ts,
            key_name as eff_key,
            sum(total_tokens) as tokens,
            count(*) as calls
          FROM api_calls
          WHERE ts > ?
          GROUP BY hour_ts, eff_key
          ORDER BY hour_ts ASC
        `, [cutoff]);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              hours_back,
              by_key: byKey.map(r => ({
                key: r.eff_key,
                calls: r.calls,
                total_tokens: r.total_tokens,
                tokens_millions: Math.round(r.total_tokens / 1e6 * 100) / 100,
                prompt_tokens: r.prompt_tokens,
                completion_tokens: r.completion_tokens,
                avg_duration_ms: Math.round(r.avg_duration_ms),
                success_rate: Math.round(r.success_count / r.calls * 1000) / 10,
                cache_hit_rate: r.calls > 0 ? Math.round(r.cache_hits / r.calls * 1000) / 10 : 0,
              })),
              by_model: byModel.map(r => ({
                model: r.model,
                key: r.eff_key,
                calls: r.calls,
                total_tokens: r.total_tokens,
                tokens_millions: Math.round(r.total_tokens / 1e6 * 100) / 100,
                avg_tokens_per_call: Math.round(r.avg_tokens_per_call),
                avg_duration_ms: Math.round(r.avg_duration_ms),
              })),
              hourly: hourly.map(r => ({
                ts: r.hour_ts,
                iso: new Date(r.hour_ts * 1000).toISOString(),
                key: r.eff_key,
                tokens: r.tokens,
                calls: r.calls,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_model_decisions ────────────────────────────────────────────────
  server.registerTool(
    'get_model_decisions',
    {
      description: 'Get model selection decisions: which model/tier was chosen, why, and when. Shows the routing logic over time.',
      inputSchema: {
        hours_back: z.number().default(168).describe('Hours of history (default 168 = 7 days)'),
      },
    },
    async ({ hours_back }) => {
      const db = openDb();
      try {
        const cutoff = Math.floor(Date.now() / 1000) - hours_back * 3600;

        // Decision breakdown
        const byReason = queryAll(db, `
          SELECT model, tier, reason, count(*) as count
          FROM model_decisions
          WHERE ts > ?
          GROUP BY model, tier, reason
          ORDER BY count DESC
        `, [cutoff]);

        // Decision timeline (hourly buckets)
        const timeline = queryAll(db, `
          SELECT
            CAST(ts/3600 AS INTEGER)*3600 as hour_ts,
            model,
            tier,
            reason,
            count(*) as count,
            sum(CASE WHEN peak = 1 THEN 1 ELSE 0 END) as peak_count
          FROM model_decisions
          WHERE ts > ?
          GROUP BY hour_ts, model, tier, reason
          ORDER BY hour_ts ASC
        `, [cutoff]);

        // Recent transitions (model changes)
        const transitions = queryAll(db, `
          WITH ranked AS (
            SELECT ts, model, tier, reason, peak,
              LAG(model) OVER (ORDER BY ts) as prev_model
            FROM model_decisions
            WHERE ts > ?
          )
          SELECT ts, prev_model, model, tier, reason, peak
          FROM ranked
          WHERE model != prev_model
          ORDER BY ts DESC
          LIMIT 100
        `, [cutoff]);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              hours_back,
              by_reason: byReason,
              timeline: timeline.map(r => ({
                ts: r.hour_ts,
                iso: new Date(r.hour_ts * 1000).toISOString(),
                model: r.model,
                tier: r.tier,
                reason: r.reason,
                count: r.count,
                peak_count: r.peak_count,
              })),
              recent_transitions: transitions.map(r => ({
                ts: r.ts,
                iso: new Date(r.ts * 1000).toISOString(),
                from_model: r.prev_model,
                to_model: r.model,
                tier: r.tier,
                reason: r.reason,
                peak: r.peak === 1,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_kalman_status ──────────────────────────────────────────────────
  server.registerTool(
    'get_kalman_status',
    {
      description: 'Get live Kalman filter convergence status for API key burn-rate predictions.',
      inputSchema: {},
    },
    async () => {
      const db = openDb();
      try {
        // Latest samples per key/window
        const latest = queryAll(db, `
          SELECT ts, key, window, burn_rate_tph, velocity_tph2,
            projected_total_pct, used_pct_observed, exhausts_in_hours, will_exhaust
          FROM kalman_samples
          WHERE ts > (SELECT MAX(ts) - 3600 FROM kalman_samples)
          ORDER BY ts DESC
        `);

        // Recent accuracy (last 100 samples per key)
        const recent = queryAll(db, `
          SELECT key, window,
            avg(used_pct_observed) as avg_used,
            avg(projected_total_pct) as avg_projected,
            count(*) as samples
          FROM kalman_samples
          WHERE ts > (SELECT MAX(ts) - 86400 FROM kalman_samples)
          GROUP BY key, window
        `);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              latest_samples: latest,
              recent_24h: recent,
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_cost_breakdown ─────────────────────────────────────────────────
  server.registerTool(
    'get_cost_breakdown',
    {
      description: 'Get effective cost breakdown per API key. Uses Ollama Cloud ($100/mo) as baseline, applies 21% premium to friend key tokens. Converts to SATs at current BTC price.',
      inputSchema: {
        hours_back: z.number().default(168).describe('Hours of history (default 168 = 7 days)'),
      },
    },
    async ({ hours_back }) => {
      const db = openDb();
      try {
        const cutoff = Math.floor(Date.now() / 1000) - hours_back * 3600;

        // Token counts by key for the period
        const byKey = queryAll(db, `
          SELECT
            CASE WHEN ollama_hit = 1 THEN 'ollama_cloud' ELSE key_name END as eff_key,
            sum(total_tokens) as total_tokens,
            count(*) as calls
          FROM api_calls
          WHERE ts > ? AND key_name IS NOT NULL
          GROUP BY eff_key
        `, [cutoff]);

        // Fetch BTC price (best effort)
        let btcUsd = 63000; // fallback
        try {
          const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
          const data = await resp.json() as any;
          if (data?.bitcoin?.usd) btcUsd = data.bitcoin.usd;
        } catch {}
        const satsPerUsd = 100_000_000 / btcUsd;

        // Ollama 30-day token count for per-token pricing
        const ollama30d = queryAll(db, `
          SELECT sum(total_tokens) as tokens
          FROM api_calls
          WHERE key_name = 'ollama_cloud'
            AND ts > (SELECT MAX(ts) - ? FROM api_calls WHERE key_name = 'ollama_cloud')
        `, [SECONDS_PER_MONTH]);

        const ollamaTokens30d = ollama30d[0]?.tokens || 1;
        const ollamaUsdPerToken = OLLAMA_MONTHLY_USD / ollamaTokens30d;

        // Friend key gets 21% premium over Ollama baseline
        const friendUsdPerToken = ollamaUsdPerToken * FRIEND_PREMIUM;

        // Compute costs per key
        const costs = byKey.map(r => {
          let usdPerToken = 0;
          let costModel = 'unknown';

          if (r.eff_key === 'ollama_cloud') {
            usdPerToken = ollamaUsdPerToken;
            costModel = 'ollama_flat_100mo';
          } else if (r.eff_key === 'friend') {
            usdPerToken = friendUsdPerToken;
            costModel = `friend_premium_21pct (${FRIEND_PREMIUM}x ollama baseline)`;
          } else if (r.eff_key === 'ours') {
            usdPerToken = 0; // cancelled subscription
            costModel = 'zai_cancelled_zero';
          } else if (r.eff_key === 'ppq' || r.eff_key === 'openrouter') {
            usdPerToken = 0; // pay-per-use, tracked separately
            costModel = 'pay_per_use_separate';
          }

          const totalUsd = r.total_tokens * usdPerToken;
          return {
            key: r.eff_key,
            calls: r.calls,
            total_tokens: r.total_tokens,
            tokens_millions: Math.round(r.total_tokens / 1e6 * 100) / 100,
            usd_per_million_tokens: Math.round(usdPerToken * 1e6 * 100) / 100,
            total_usd: Math.round(totalUsd * 100) / 100,
            total_sats: Math.round(totalUsd * satsPerUsd),
            cost_model: costModel,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              hours_back,
              btc_usd: btcUsd,
              sats_per_usd: Math.round(satsPerUsd),
              pricing: {
                ollama_monthly_usd: OLLAMA_MONTHLY_USD,
                ollama_tokens_30d: ollamaTokens30d,
                ollama_usd_per_million: Math.round(ollamaUsdPerToken * 1e6 * 100) / 100,
                friend_premium_multiplier: FRIEND_PREMIUM,
                friend_usd_per_million: Math.round(friendUsdPerToken * 1e6 * 100) / 100,
              },
              costs_by_key: costs,
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_quota_windows ──────────────────────────────────────────────────
  server.registerTool(
    'get_quota_windows',
    {
      description: 'Get z.ai quota window data: 5-hour and weekly quota usage per key, with Kalman projections.',
      inputSchema: {},
    },
    async () => {
      const db = openDb();
      try {
        const windows = queryAll(db, `
          SELECT ts, key, window, burn_rate_tph, velocity_tph2,
            projected_total_pct, used_pct_observed, exhausts_in_hours, will_exhaust
          FROM kalman_samples
          WHERE ts > (SELECT MAX(ts) - 36000 FROM kalman_samples)
            AND window IN ('5-hour', 'weekly')
          ORDER BY ts DESC
          LIMIT 500
        `);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              samples: windows.map(r => ({
                ts: r.ts,
                iso: new Date(r.ts * 1000).toISOString(),
                key: r.key,
                window: r.window,
                burn_rate_tph: Math.round(r.burn_rate_tph),
                velocity: Math.round(r.velocity_tph2),
                projected_pct: Math.round(r.projected_total_pct * 10) / 10,
                used_pct: Math.round(r.used_pct_observed * 10) / 10,
                exhausts_in_hours: r.exhausts_in_hours ? Math.round(r.exhausts_in_hours * 10) / 10 : null,
                will_exhaust: r.will_exhaust === 1,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_key_transitions ────────────────────────────────────────────────
  server.registerTool(
    'get_key_transitions',
    {
      description: 'Get recent API key/provider transitions with human-readable reasons. Shows when and why the proxy switched keys.',
      inputSchema: {
        limit: z.number().default(100).describe('Max transitions to return (default 100)'),
      },
    },
    async ({ limit }) => {
      const db = openDb();
      try {
        const transitions = queryAll(db, `
          WITH ranked AS (
            SELECT ts,
              key_name as eff_key,
              model,
              LAG(key_name) OVER (ORDER BY ts) as prev_key
            FROM api_calls
            WHERE ts > (SELECT MAX(ts) - 604800 FROM api_calls)
              AND key_name IS NOT NULL
          )
          SELECT ts, eff_key, prev_key, model
          FROM ranked
          WHERE eff_key != prev_key
          ORDER BY ts DESC
          LIMIT ?
        `, [limit]);

        // Also get key_decisions for reason context
        const decisions = queryAll(db, `
          SELECT ts, chosen_key, reason
          FROM key_decisions
          WHERE ts > (SELECT MAX(ts) - 604800 FROM key_decisions)
          ORDER BY ts DESC
          LIMIT ?
        `, [limit * 2]);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              transitions: transitions.map(r => ({
                ts: r.ts,
                iso: new Date(r.ts * 1000).toISOString(),
                from: r.prev_key,
                to: r.eff_key,
                model: r.model,
              })),
              decision_reasons: decisions.slice(0, 50).map(r => ({
                ts: r.ts,
                iso: new Date(r.ts * 1000).toISOString(),
                key: r.chosen_key,
                reason: r.reason,
              })),
            }),
          }],
        };
      } finally {
        db.close();
      }
    }
  );

  // ── get_system_stats ───────────────────────────────────────────────────
  server.registerTool(
    'get_system_stats',
    {
      description: 'Get live system resource stats: CPU usage, memory, swap (including thrashing), load average, and uptime. Read from /proc on this machine.',
      inputSchema: {},
    },
    async () => {
      const stats = getSystemStats();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(stats),
        }],
      };
    }
  );

  // ── get_provider_balances ──────────────────────────────────────────────
  server.registerTool(
    'get_provider_balances',
    {
      description: 'Get provider balance tracking: PPQ, OpenRouter balances and projections. Shows spend rate and estimated depletion.',
      inputSchema: {},
    },
    async () => {
      const burnDb = openBurnDb();
      try {
        const balances = queryAll(burnDb, `
          SELECT provider, balance_usd, total_credits, total_usage, ts, error
          FROM balance_snapshots
          WHERE ts > (SELECT MAX(ts) - 3600 FROM balance_snapshots)
            AND provider IS NOT NULL
          ORDER BY ts DESC
        `);

        // 7-day spend trend
        const spendTrend = queryAll(burnDb, `
          SELECT
            provider,
            CAST(ts/86400 AS INTEGER)*86400 as day_ts,
            max(total_usage) as max_usage,
            min(total_usage) as min_usage
          FROM balance_snapshots
          WHERE ts > (SELECT MAX(ts) - 604800 FROM balance_snapshots)
            AND provider IS NOT NULL
            AND total_usage IS NOT NULL
          GROUP BY provider, day_ts
          ORDER BY day_ts ASC
        `);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              generated_at: new Date().toISOString(),
              current_balances: balances.map(r => ({
                provider: r.provider,
                balance_usd: r.balance_usd,
                total_credits: r.total_credits,
                total_usage: r.total_usage,
                iso: new Date(r.ts * 1000).toISOString(),
                error: r.error,
              })),
              spend_trend_7d: spendTrend.map(r => ({
                provider: r.provider,
                day: new Date(r.day_ts * 1000).toISOString().split('T')[0],
                max_usage: r.max_usage,
                min_usage: r.min_usage,
                daily_spend: r.max_usage - r.min_usage,
              })),
            }),
          }],
        };
      } finally {
        burnDb.close();
      }
    }
  );

  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.error('[CVM-Kalman] Starting ContextVM Kalman Data Server...');

  const server = buildServer();

  const signer = new PrivateKeySigner(SERVER_PRIVATE_KEY);
  const relayPool = new ApplesauceRelayPool(RELAYS);

  const transport = new NostrServerTransport({
    signer,
    relayHandler: relayPool,
    isAnnouncedServer: true,
    serverInfo: {
      name: 'Kalman Data Server',
      about: 'Live API usage, cost tracking, Kalman predictions, and system stats. Reads from zai_usage.db.',
    },
  });

  await server.connect(transport);

  console.error('[CVM-Kalman] Server connected. Announced on relays:');
  for (const r of RELAYS) console.error(`  ${r}`);
  console.error('[CVM-Kalman] Server npub: npub18zvqh4qgjsqegclgymkj4mm4qcukt4tv9gw0l08e56qdh683ssuqmnalae');
  console.error('[CVM-Kalman] Tools: get_usage_summary, get_model_decisions, get_kalman_status, get_cost_breakdown, get_quota_windows, get_key_transitions, get_system_stats, get_provider_balances');

  // Keep alive
  process.on('SIGINT', () => {
    console.error('[CVM-Kalman] Shutting down...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[CVM-Kalman] FATAL:', err);
  process.exit(1);
});

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool } from '@contextvm/sdk';
import { getPublicKey } from 'nostr-tools/pure';
import fs from 'node:fs';

const key = new Uint8Array(Buffer.from(fs.readFileSync('/home/c03rad0r/.hermes/state/cvm-kalman-server.key', 'utf8').trim(), 'hex'));
const serverPubkey = getPublicKey(key);
const clientKey = crypto.getRandomValues(new Uint8Array(32));
const signer = new PrivateKeySigner(Array.from(clientKey).map(b => b.toString(16).padStart(2, '0')).join(''));
const relayPool = new ApplesauceRelayPool(['wss://relay2.contextvm.org','wss://nos.lol','wss://relay.nostr.band','wss://relay.primal.net']);
const transport = new NostrClientTransport({ signer, relayHandler: relayPool, serverPubkey, isStateless: true });
const client = new Client({ name: 'test-cli', version: '1.0.0' });

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return { raw: text };
  }
}

try {
  await client.connect(transport);
  for (const tool of ['get_usage_summary','get_model_decisions','get_kalman_status','get_cost_breakdown','get_quota_windows','get_key_transitions','get_system_stats','get_provider_balances']) {
    console.log('\n===', tool, '===');
    const r = await call(tool);
    console.log(JSON.stringify(Object.keys(r || {}), null, 2));
    if (Array.isArray(r?.costs_by_key)) {
      console.log('costs_by_key sample:', JSON.stringify(r.costs_by_key[0], null, 2));
    }
    if (Array.isArray(r?.hourly)) {
      console.log('hourly sample:', JSON.stringify(r.hourly[0], null, 2));
    }
    if (Array.isArray(r?.latest_samples)) {
      console.log('latest_samples sample:', JSON.stringify(r.latest_samples[0], null, 2));
    }
  }
  await client.close();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}

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
try {
  await client.connect(transport);
  console.log('connected');
  const res = await client.callTool({ name: 'get_system_stats', arguments: {} });
  console.log(JSON.stringify(res, null, 2));
  await client.close();
  process.exit(0);
} catch (e) {
  console.error(e);
  process.exit(1);
}

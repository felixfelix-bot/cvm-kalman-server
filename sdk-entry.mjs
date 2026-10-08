import { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool } from './node_modules/@contextvm/sdk/dist/esm/index.js';
const sdk = { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool };
if (typeof window !== 'undefined') window.ContextVM = sdk;
else if (typeof globalThis !== 'undefined') globalThis.ContextVM = sdk;
export { NostrClientTransport, PrivateKeySigner, ApplesauceRelayPool };

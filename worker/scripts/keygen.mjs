// Prints a fresh Ed25519 key pair; nothing is written to disk.
import { generateKeyPairSync } from 'node:crypto';

const kid = process.argv[2] || 'k1';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const x = publicKey.export({ format: 'jwk' }).x;

console.log('Private key (PKCS#8, base64). Paste it at the prompt of:');
console.log('  npx wrangler secret put HARBOR_SIGNING_KEY\n');
console.log(pkcs8, '\n');
console.log(`Public key for the Rust/env constant (kid:base64url):\n  ${kid}:${x}`);
console.log('\nKeep the private key out of git and chat.');

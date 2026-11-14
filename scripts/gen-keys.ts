/**
 * Optional helper to generate a device keypair into ~/.northstar/keys.
 * Prefer letting the server enroll on first boot.
 */
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToB64, generateKeyPair } from '@northstar/core';

const deviceId = process.argv[2] ?? 'DEV-VESSEL-001';
const dir = (process.env.NORTHSTAR_KEY_DIR ?? join(process.env.HOME ?? '', '.northstar/keys')).replace(
  /^~/,
  process.env.HOME ?? '',
);
mkdirSync(dir, { recursive: true });
const { publicKey, privateKey } = await generateKeyPair();
const privPath = join(dir, `${deviceId}.ed25519`);
const pubPath = join(dir, `${deviceId}.ed25519.pub`);
writeFileSync(privPath, bytesToB64(privateKey), { mode: 0o600 });
writeFileSync(pubPath, bytesToB64(publicKey));
try {
  chmodSync(privPath, 0o600);
} catch {
  /* */
}
console.log(`Wrote ${privPath} and ${pubPath}`);
console.log('Enroll public key with the server device registry if not auto-enrolled.');

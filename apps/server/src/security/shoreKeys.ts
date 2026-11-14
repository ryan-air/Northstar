/**
 * Shore-side Ed25519 key for audit checkpoints and revocation list signatures.
 * Separate from device keys — server role=shore signs tips; devices never hold this key.
 * Default path: NORTHSTAR_SHORE_KEY_DIR → `.northstar/shore` (outside data/fixtures / git).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  b64ToBytes,
  bytesToB64,
  generateKeyPair,
  canonicalBytes,
  type JsonValue,
} from '@northstar/core';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

const KEY_ID = 'shore-audit-1';

export class ShoreKeyring {
  // Default NORTHSTAR_SHORE_KEY_DIR is .northstar/shore, outside data/fixtures.
  readonly keyId = KEY_ID;
  private privateKey: Uint8Array;
  private publicKey: Uint8Array;
  readonly publicKeyB64: string;
  readonly shoreKeyDir: string;

  private constructor(
    shoreKeyDir: string,
    privateKey: Uint8Array,
    publicKey: Uint8Array,
  ) {
    this.shoreKeyDir = shoreKeyDir;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.publicKeyB64 = bytesToB64(publicKey);
  }

  static async loadOrCreate(shoreKeyDir: string): Promise<ShoreKeyring> {
    mkdirSync(shoreKeyDir, { recursive: true });
    const privPath = join(shoreKeyDir, 'shore.ed25519');
    const pubPath = join(shoreKeyDir, 'shore.ed25519.pub');
    if (existsSync(privPath) && existsSync(pubPath)) {
      const privateKey = b64ToBytes(readFileSync(privPath, 'utf8').trim());
      const publicKey = b64ToBytes(readFileSync(pubPath, 'utf8').trim());
      return new ShoreKeyring(shoreKeyDir, privateKey, publicKey);
    }
    const { privateKey, publicKey } = await generateKeyPair();
    writeFileSync(privPath, bytesToB64(privateKey), { mode: 0o600 });
    writeFileSync(pubPath, bytesToB64(publicKey), { mode: 0o644 });
    try {
      chmodSync(privPath, 0o600);
    } catch {
      /* ignore */
    }
    return new ShoreKeyring(shoreKeyDir, privateKey, publicKey);
  }

  async signJson(body: JsonValue): Promise<string> {
    const msg = canonicalBytes(body);
    const sig = await ed.sign(msg, this.privateKey);
    return bytesToB64(sig);
  }

  async verifyJson(body: JsonValue, signatureB64: string): Promise<boolean> {
    try {
      const msg = canonicalBytes(body);
      const sig = b64ToBytes(signatureB64);
      return await ed.verify(sig, msg, this.publicKey);
    } catch {
      return false;
    }
  }
}

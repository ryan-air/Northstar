/**
 * PayloadSigner — software Ed25519 file keys, or PKCS#11 P-256 (SoftHSM / YubiKey).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as ed from '@noble/ed25519';
import type { SignatureAlg, TelemetryPayload } from '@northstar/contracts';
import {
  b64ToBytes,
  bytesToB64,
  canonicalBytes,
  generateKeyPair,
  signPayload,
  type JsonValue,
} from '@northstar/core';
import { sha256 } from '@noble/hashes/sha256';

export interface PayloadSigner {
  assurance: 'software' | 'hardware';
  alg: SignatureAlg;
  keyId: string;
  publicKeyB64(): string;
  sign(payload: TelemetryPayload): Promise<string>;
  signJson(body: JsonValue): Promise<string>;
}

export class SoftwareEd25519Signer implements PayloadSigner {
  readonly assurance = 'software' as const;
  readonly alg = 'ed25519' as const;
  constructor(
    public keyId: string,
    private privateKey: Uint8Array,
    private publicKey?: Uint8Array,
  ) {}

  publicKeyB64(): string {
    if (!this.publicKey) throw new Error('public key not loaded');
    return bytesToB64(this.publicKey);
  }

  async sign(payload: TelemetryPayload): Promise<string> {
    return signPayload(payload, this.privateKey, 'ed25519');
  }

  async signJson(body: JsonValue): Promise<string> {
    return bytesToB64(await ed.sign(canonicalBytes(body), this.privateKey));
  }
}

/**
 * Signs via `pkcs11-tool` CLI (SoftHSM2 or YubiKey PIV module).
 * Falls back is not silent — constructor throws if module/tool missing.
 */
export class Pkcs11P256Signer implements PayloadSigner {
  readonly assurance = 'hardware' as const;
  readonly alg = 'ecdsa-p256' as const;
  private pubB64: string;

  constructor(
    public keyId: string,
    private modulePath: string,
    private pin: string,
    private keyLabel: string,
    publicKeyB64: string,
  ) {
    this.pubB64 = publicKeyB64;
  }

  static fromEnv(keyId: string): Pkcs11P256Signer {
    const modulePath = process.env.NORTHSTAR_PKCS11_MODULE;
    const pin = process.env.NORTHSTAR_PKCS11_PIN ?? '1234';
    const keyLabel = process.env.NORTHSTAR_PKCS11_KEY_LABEL ?? 'northstar-device';
    const pubPath = process.env.NORTHSTAR_PKCS11_PUBKEY;
    if (!modulePath || !existsSync(modulePath)) {
      throw new Error(
        'NORTHSTAR_PKCS11_MODULE not set or missing — run scripts/setup-softhsm.sh or point at YubiKey PKCS#11',
      );
    }
    if (!pubPath || !existsSync(pubPath)) {
      throw new Error(
        'NORTHSTAR_PKCS11_PUBKEY path required (raw uncompressed P-256 pubkey, base64) — see setup-softhsm.sh',
      );
    }
    try {
      execFileSync('pkcs11-tool', ['--help'], { stdio: 'ignore' });
    } catch {
      throw new Error('pkcs11-tool not found — install opensc (brew install opensc)');
    }
    const publicKeyB64 = readFileSync(pubPath, 'utf8').trim();
    return new Pkcs11P256Signer(keyId, modulePath, pin, keyLabel, publicKeyB64);
  }

  publicKeyB64(): string {
    return this.pubB64;
  }

  async sign(payload: TelemetryPayload): Promise<string> {
    return this.signJson(payload as unknown as JsonValue);
  }

  async signJson(body: JsonValue): Promise<string> {
    const msg = canonicalBytes(body);
    const digest = Buffer.from(sha256(msg));
    const dir = join(tmpdir(), 'northstar-pkcs11');
    mkdirSync(dir, { recursive: true });
    const inPath = join(dir, 'digest.bin');
    const outPath = join(dir, 'sig.bin');
    writeFileSync(inPath, digest);
    execFileSync(
      'pkcs11-tool',
      [
        '--module',
        this.modulePath,
        '--pin',
        this.pin,
        '--sign',
        '--mechanism',
        'ECDSA',
        '--label',
        this.keyLabel,
        '--input-file',
        inPath,
        '--output-file',
        outPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const sig = readFileSync(outPath);
    // pkcs11-tool may emit DER; convert to compact 64 if needed
    if (sig.length === 64) return bytesToB64(sig);
    return bytesToB64(derEcdsaToCompact(sig));
  }
}

/** Minimal DER SEQUENCE of two INTEGERs → r||s compact 64. */
function derEcdsaToCompact(der: Buffer): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Expected DER ECDSA signature');
  let i = 2;
  if (der[1]! & 0x80) i += der[1]! & 0x7f;
  if (der[i] !== 0x02) throw new Error('Expected INTEGER r');
  const rLen = der[i + 1]!;
  let r = der.subarray(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error('Expected INTEGER s');
  const sLen = der[i + 1]!;
  let s = der.subarray(i + 2, i + 2 + sLen);
  // strip leading zeros / pad to 32
  while (r.length > 32 && r[0] === 0) r = r.subarray(1);
  while (s.length > 32 && s[0] === 0) s = s.subarray(1);
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

export async function loadSoftwareSigner(
  keyDir: string,
  deviceId: string,
  keyId: string,
): Promise<SoftwareEd25519Signer> {
  const path = join(keyDir, `${deviceId}.ed25519`);
  let privateKey: Uint8Array;
  let publicKey: Uint8Array;
  if (existsSync(path)) {
    privateKey = b64ToBytes(readFileSync(path, 'utf8').trim());
    if (privateKey.length !== 32) {
      throw new Error(`Invalid Ed25519 private key at ${path}`);
    }
    publicKey = await ed.getPublicKey(privateKey);
  } else {
    const keyPair = await generateKeyPair();
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
    mkdirSync(keyDir, { recursive: true });
    writeFileSync(path, bytesToB64(privateKey), { mode: 0o600 });
  }
  return new SoftwareEd25519Signer(keyId, privateKey, publicKey);
}

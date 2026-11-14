import * as ed from '@noble/ed25519';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import type {
  SignatureAlg,
  SignedTelemetryEnvelope,
  TelemetryPayload,
} from '@northstar/contracts';
import { TelemetryPayloadSchema } from '@northstar/contracts';
import { canonicalBytes, type JsonValue } from './canonical.js';

// noble-ed25519 v2 requires sha512 sync hook in some environments
ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

export function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

export function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export async function generateKeyPair(): Promise<{
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function generateP256KeyPair(): {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
} {
  const privateKey = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(privateKey, false); // uncompressed 65 bytes
  return { publicKey, privateKey };
}

export async function signPayload(
  payload: TelemetryPayload,
  privateKey: Uint8Array,
  alg: SignatureAlg = 'ed25519',
): Promise<string> {
  const parsed = TelemetryPayloadSchema.parse(payload);
  const msg = canonicalBytes(parsed as unknown as JsonValue);
  if (alg === 'ecdsa-p256') {
    const digest = sha256(msg);
    const sig = p256.sign(digest, privateKey);
    return bytesToB64(sig.toCompactRawBytes());
  }
  const sig = await ed.sign(msg, privateKey);
  return bytesToB64(sig);
}

export async function verifyEnvelope(
  envelope: SignedTelemetryEnvelope,
  publicKey: Uint8Array,
): Promise<{ ok: true; payload: TelemetryPayload } | { ok: false; reason: string }> {
  let payload: TelemetryPayload;
  try {
    payload = TelemetryPayloadSchema.parse(envelope.payload);
  } catch (e) {
    return { ok: false, reason: `Invalid payload schema: ${(e as Error).message}` };
  }
  const msg = canonicalBytes(payload as unknown as JsonValue);
  let sig: Uint8Array;
  try {
    sig = b64ToBytes(envelope.signature);
  } catch {
    return { ok: false, reason: 'Invalid signature encoding' };
  }

  const alg = envelope.signature_alg ?? 'ed25519';

  if (alg === 'ecdsa-p256') {
    if (publicKey.length !== 65 && publicKey.length !== 33) {
      return { ok: false, reason: 'P-256 public key must be 33 or 65 bytes' };
    }
    if (sig.length !== 64) {
      return { ok: false, reason: 'ECDSA P-256 compact signature must be 64 bytes' };
    }
    try {
      const digest = sha256(msg);
      const ok = p256.verify(sig, digest, publicKey);
      if (!ok) return { ok: false, reason: 'ECDSA P-256 signature verification failed' };
      return { ok: true, payload };
    } catch (e) {
      return {
        ok: false,
        reason: `ECDSA P-256 verify error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (sig.length !== 64) {
    return { ok: false, reason: 'Signature must be 64 bytes' };
  }
  if (publicKey.length !== 32) {
    return { ok: false, reason: 'Public key must be 32 bytes' };
  }
  const ok = await ed.verify(sig, msg, publicKey);
  if (!ok) return { ok: false, reason: 'Ed25519 signature verification failed' };
  return { ok: true, payload };
}

/** Mutate a field for tamper tests — caller re-serializes without resigning. */
export function tamperPayload(
  payload: TelemetryPayload,
  patch: Partial<TelemetryPayload>,
): TelemetryPayload {
  return TelemetryPayloadSchema.parse({ ...payload, ...patch });
}

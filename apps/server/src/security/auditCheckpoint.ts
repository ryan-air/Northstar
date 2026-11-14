/**
 * Signed audit tip — defeats casual "rewrite entire JSONL from genesis" without
 * also forging the shore-signed checkpoint (and optional mirror copy).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../config.js';
import type { ShoreKeyring } from './shoreKeys.js';
import type { JsonValue } from '@northstar/core';

export interface AuditCheckpoint {
  seq: number;
  tip_hash: string;
  ts: string;
  entry_count: number;
  shore_key_id: string;
  shore_sig: string;
}

function checkpointPath(rel = 'data/fixtures/audit.checkpoint.json'): string {
  return join(REPO_ROOT, rel);
}

export async function writeAuditCheckpoint(
  shore: ShoreKeyring,
  input: { seq: number; tip_hash: string; entry_count: number },
  mirrorPath?: string,
): Promise<AuditCheckpoint> {
  const ts = new Date().toISOString();
  const unsigned = {
    seq: input.seq,
    tip_hash: input.tip_hash,
    ts,
    entry_count: input.entry_count,
    shore_key_id: shore.keyId,
  };
  const shore_sig = await shore.signJson(unsigned as unknown as JsonValue);
  const checkpoint: AuditCheckpoint = { ...unsigned, shore_sig };
  const path = checkpointPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(checkpoint, null, 2));
  if (mirrorPath) {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    writeFileSync(mirrorPath, JSON.stringify(checkpoint, null, 2));
  }
  return checkpoint;
}

export function readAuditCheckpoint(
  rel = 'data/fixtures/audit.checkpoint.json',
): AuditCheckpoint | null {
  const path = join(REPO_ROOT, rel);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuditCheckpoint;
  } catch {
    return null;
  }
}

export async function verifyCheckpoint(
  shore: ShoreKeyring,
  tipHash: string,
  seq: number,
  checkpoint: AuditCheckpoint | null,
): Promise<{ ok: boolean; reason: string | null }> {
  if (!checkpoint) {
    return { ok: false, reason: 'No audit checkpoint present' };
  }
  if (checkpoint.tip_hash !== tipHash) {
    return {
      ok: false,
      reason: `Checkpoint tip_hash mismatch (file tip ≠ checkpoint)`,
    };
  }
  if (checkpoint.seq !== seq) {
    return {
      ok: false,
      reason: `Checkpoint seq ${checkpoint.seq} ≠ chain tip seq ${seq}`,
    };
  }
  const { shore_sig, ...unsigned } = checkpoint;
  const ok = await shore.verifyJson(unsigned as unknown as JsonValue, shore_sig);
  if (!ok) {
    return { ok: false, reason: 'Shore signature on checkpoint failed' };
  }
  return { ok: true, reason: null };
}

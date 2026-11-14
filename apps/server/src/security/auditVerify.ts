import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../config.js';
import { hashAuditBody, type AuditEntry } from '../state/auditLog.js';
import { readAuditCheckpoint, verifyCheckpoint } from './auditCheckpoint.js';
import type { ShoreKeyring } from './shoreKeys.js';

export interface AuditVerifyResult {
  ok: boolean;
  chain_ok: boolean;
  checkpoint_ok: boolean | null;
  entries: number;
  broken_at: number | null;
  reason: string | null;
  tip: string;
  tip_hash: string;
  tip_seq: number;
}

let AUDIT_PATH = join(REPO_ROOT, 'data/fixtures/audit.jsonl');

/** P1.5: verify the audit log the app actually writes. */
export function setAuditLogPath(path: string): void {
  AUDIT_PATH = path;
}

export function verifyAuditChain(relPath?: string): AuditVerifyResult {
  const path = relPath ? (relPath.startsWith('/') ? relPath : join(REPO_ROOT, relPath)) : AUDIT_PATH;
  if (!existsSync(path)) {
    return {
      ok: true,
      chain_ok: true,
      checkpoint_ok: null,
      entries: 0,
      broken_at: null,
      reason: null,
      tip: 'Empty audit log',
      tip_hash: '0'.repeat(64),
      tip_seq: 0,
    };
  }
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  let prev = '0'.repeat(64);
  let tipHash = prev;
  let tipSeq = 0;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!) as AuditEntry;
    } catch {
      return {
        ok: false,
        chain_ok: false,
        checkpoint_ok: null,
        entries: lines.length,
        broken_at: i + 1,
        reason: `Unparseable JSON at line ${i + 1}`,
        tip: 'Hash chain broken — possible audit tampering',
        tip_hash: tipHash,
        tip_seq: tipSeq,
      };
    }
    if (entry.prev_hash !== prev) {
      return {
        ok: false,
        chain_ok: false,
        checkpoint_ok: null,
        entries: lines.length,
        broken_at: entry.seq,
        reason: `prev_hash mismatch at seq ${entry.seq}`,
        tip: 'Hash chain broken — possible audit tampering',
        tip_hash: tipHash,
        tip_seq: tipSeq,
      };
    }
    const hash = hashAuditBody(entry);
    if (hash !== entry.hash) {
      return {
        ok: false,
        chain_ok: false,
        checkpoint_ok: null,
        entries: lines.length,
        broken_at: entry.seq,
        reason: `content hash mismatch at seq ${entry.seq}`,
        tip: 'Entry body does not match stored hash',
        tip_hash: tipHash,
        tip_seq: tipSeq,
      };
    }
    prev = entry.hash;
    tipHash = entry.hash;
    tipSeq = entry.seq;
  }

  const checkpoint = readAuditCheckpoint();
  let checkpoint_ok: boolean | null = null;
  let reason: string | null = null;
  let tip = 'SHA-256 hash chain intact';

  if (lines.length === 0) {
    checkpoint_ok = null;
  } else if (!checkpoint) {
    checkpoint_ok = false;
    reason = 'Chain intact but no shore-signed checkpoint (rewrite-from-genesis still possible)';
    tip = 'Chain OK · checkpoint missing';
  } else if (checkpoint.tip_hash !== tipHash || checkpoint.seq !== tipSeq) {
    checkpoint_ok = false;
    reason = 'Checkpoint tip does not match chain tip — possible full rewrite of audit.jsonl';
    tip = 'Chain OK · checkpoint MISMATCH';
  } else {
    checkpoint_ok = true;
    tip = 'SHA-256 hash chain + shore checkpoint intact';
  }

  const ok = checkpoint_ok !== false;
  return {
    ok: lines.length === 0 ? true : ok && true,
    chain_ok: true,
    checkpoint_ok,
    entries: lines.length,
    broken_at: null,
    reason,
    tip,
    tip_hash: tipHash,
    tip_seq: tipSeq,
  };
}

/** Full verify including shore signature on checkpoint. */
export async function verifyAuditChainWithShore(
  shore: ShoreKeyring,
  relPath?: string,
): Promise<AuditVerifyResult> {
  const base = verifyAuditChain(relPath);
  if (!base.chain_ok) return base;
  if (base.entries === 0) return base;
  const checkpoint = readAuditCheckpoint();
  const cp = await verifyCheckpoint(shore, base.tip_hash, base.tip_seq, checkpoint);
  if (!cp.ok) {
    return {
      ...base,
      ok: false,
      checkpoint_ok: false,
      reason: cp.reason,
      tip: `Chain OK · checkpoint FAIL — ${cp.reason}`,
    };
  }
  return {
    ...base,
    ok: true,
    checkpoint_ok: true,
    reason: null,
    tip: 'SHA-256 hash chain + shore-signed checkpoint intact',
  };
}

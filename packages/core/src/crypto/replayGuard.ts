import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ReplayGuardConfig {
  freshnessWindowS: number;
  maxClockSkewS: number;
  duplicateCacheSize: number;
  /** Persist last sequence per device across restarts (not cleared on scenario reset). */
  persistPath?: string;
}

export type ReplayDecision =
  | { accept: true }
  | {
      accept: false;
      reason: 'duplicate' | 'replay_sequence' | 'stale' | 'future_skew' | 'out_of_order';
      detail: string;
    };

interface DeviceState {
  lastSequence: number;
  seenHashes: string[];
}

interface PersistedState {
  devices: Record<string, { lastSequence: number }>;
}

export class ReplayGuard {
  private devices = new Map<string, DeviceState>();
  private persistPath: string | undefined;

  constructor(private config: ReplayGuardConfig) {
    this.persistPath = config.persistPath;
    if (this.persistPath) this.load();
  }

  private load(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as PersistedState;
      for (const [id, row] of Object.entries(raw.devices ?? {})) {
        this.devices.set(id, {
          lastSequence: row.lastSequence ?? -1,
          seenHashes: [],
        });
      }
    } catch {
      /* ignore corrupt persist file */
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      const devices: PersistedState['devices'] = {};
      for (const [id, st] of this.devices) {
        devices[id] = { lastSequence: st.lastSequence };
      }
      writeFileSync(this.persistPath, JSON.stringify({ devices }, null, 2));
    } catch {
      /* ignore */
    }
  }

  check(input: {
    deviceId: string;
    sequence: number;
    timestamp: string;
    payloadHash: string;
    now?: Date;
  }): ReplayDecision {
    const now = input.now ?? new Date();
    const ts = Date.parse(input.timestamp);
    if (Number.isNaN(ts)) {
      return { accept: false, reason: 'stale', detail: 'Unparseable timestamp' };
    }
    const ageS = (now.getTime() - ts) / 1000;
    if (ageS > this.config.freshnessWindowS) {
      return {
        accept: false,
        reason: 'stale',
        detail: `Age ${ageS.toFixed(1)}s exceeds freshness window ${this.config.freshnessWindowS}s`,
      };
    }
    if (-ageS > this.config.maxClockSkewS) {
      return {
        accept: false,
        reason: 'future_skew',
        detail: `Timestamp ${(-ageS).toFixed(1)}s in the future`,
      };
    }

    let state = this.devices.get(input.deviceId);
    if (!state) {
      state = { lastSequence: -1, seenHashes: [] };
      this.devices.set(input.deviceId, state);
    }

    if (state.seenHashes.includes(input.payloadHash)) {
      return { accept: false, reason: 'duplicate', detail: 'Identical payload hash already seen' };
    }
    if (input.sequence < state.lastSequence) {
      return {
        accept: false,
        reason: 'replay_sequence',
        detail: `Sequence ${input.sequence} < last ${state.lastSequence}`,
      };
    }
    if (input.sequence === state.lastSequence) {
      return {
        accept: false,
        reason: 'out_of_order',
        detail: `Duplicate sequence number ${input.sequence}`,
      };
    }

    state.lastSequence = input.sequence;
    state.seenHashes.push(input.payloadHash);
    if (state.seenHashes.length > this.config.duplicateCacheSize) {
      state.seenHashes.shift();
    }
    this.save();
    return { accept: true };
  }

  /**
   * Clear in-memory duplicate hashes. Sequence counters are preserved when
   * persistPath is set (defence-in-depth across scenario reset / restart).
   */
  reset(deviceId?: string, opts?: { clearSequences?: boolean }): void {
    const clearSeq = opts?.clearSequences === true;
    if (deviceId) {
      if (clearSeq) this.devices.delete(deviceId);
      else {
        const st = this.devices.get(deviceId);
        if (st) st.seenHashes = [];
      }
    } else if (clearSeq) {
      this.devices.clear();
    } else {
      for (const st of this.devices.values()) st.seenHashes = [];
    }
    this.save();
  }
}

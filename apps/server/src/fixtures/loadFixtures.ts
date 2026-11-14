import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttestationEvidence, GnssDiagnostics, OsnmaResult } from '@northstar/contracts';
import { REPO_ROOT } from '../config.js';
import { SoftwareAttestationProvider } from '../adapters/attestation.js';

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'data/fixtures', name), 'utf8')) as T;
}

/** In-memory cache so snapshot/feedHealth do not hit disk every tick. */
let osnmaIcdCache: OsnmaResult | null | undefined;

/** Prefer OSNMAlib ICD verification cache when present (real TESLA/MAC run). */
export function loadOsnmaIcdCache(atIso?: string): OsnmaResult | null {
  if (osnmaIcdCache === undefined) {
    const path = join(REPO_ROOT, 'data/fixtures/osnma_icd_cache.json');
    if (!existsSync(path)) {
      osnmaIcdCache = null;
    } else {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as OsnmaResult & {
          crypto?: Record<string, unknown>;
        };
        if (!raw?.status || raw.mode === 'not_connected') osnmaIcdCache = null;
        else {
          osnmaIcdCache = {
            ...raw,
            mode: raw.mode ?? 'protocol_verification_demo',
          };
        }
      } catch {
        osnmaIcdCache = null;
      }
    }
  }
  if (!osnmaIcdCache) return null;
  return {
    ...osnmaIcdCache,
    observed_at: atIso ?? osnmaIcdCache.observed_at ?? new Date().toISOString(),
  };
}

/** Invalidate after sidecar verify writes a new cache file. */
export function clearOsnmaIcdCache(): void {
  osnmaIcdCache = undefined;
}

const osnmaDemo = loadJson<{
  authenticated: Omit<OsnmaResult, 'observed_at'>;
  failed: Omit<OsnmaResult, 'observed_at'>;
  pending: Omit<OsnmaResult, 'observed_at'>;
}>('osnma_demo.json');

const gnssNominal = loadJson<Omit<GnssDiagnostics, 'entity_id' | 'observed_at'>>('gnss_nominal.json');
const gnssJamming = loadJson<Omit<GnssDiagnostics, 'entity_id' | 'observed_at'>>('gnss_jamming.json');
const gnssSpoofish = loadJson<Omit<GnssDiagnostics, 'entity_id' | 'observed_at'>>('gnss_spoofish.json');

const softwareAttest = new SoftwareAttestationProvider();

export function osnmaFixture(
  kind: 'authenticated' | 'failed' | 'pending',
  atIso: string,
): OsnmaResult {
  return { ...osnmaDemo[kind], observed_at: atIso };
}

export function gnssFixture(
  kind: 'nominal' | 'jamming' | 'spoofish',
  entityId: string,
  atIso: string,
): GnssDiagnostics {
  const base =
    kind === 'jamming' ? gnssJamming : kind === 'spoofish' ? gnssSpoofish : gnssNominal;
  return {
    entity_id: entityId,
    observed_at: atIso,
    satellite_count: base.satellite_count,
    c_n0_dbhz: base.c_n0_dbhz,
    hdop: base.hdop,
    pdop: base.pdop,
    agc: base.agc,
    pseudorange_residual_m: base.pseudorange_residual_m,
    clock_drift_ns_s: base.clock_drift_ns_s,
    interference_indicator: base.interference_indicator,
    labels: base.labels,
    missing_inputs: base.missing_inputs ?? [],
  };
}

export async function softwareAttestation(deviceId: string): Promise<AttestationEvidence> {
  return softwareAttest.attest(deviceId);
}

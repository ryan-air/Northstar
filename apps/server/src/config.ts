import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FleetCoherenceV2Config,
  FusionConfig,
  IdentityConfig,
  KinematicsCusumConfig,
} from '@northstar/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, '../../..');

export function loadJson<T>(rel: string): T {
  const path = rel.startsWith('/') ? rel : join(REPO_ROOT, rel);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export interface ThresholdsConfig {
  version: string;
  vessel_class_limits: FusionConfig extends never ? never : Record<string, {
    max_sog_kn: number;
    max_accel_kn_s: number;
    max_rot_deg_min: number;
    max_jump_m: number;
  }>;
  kinematics: {
    min_dt_s: number;
    max_dt_s: number;
    uncertain_dt_skip: boolean;
    drift_cusum_threshold: number;
    drift_cusum_slack_m: number;
    min_cog_sog_kn?: number;
    prefer_rot_field?: boolean;
    cusum?: KinematicsCusumConfig;
  };
  geographic: {
    shore_buffer_m: number;
    port_buffer_m: number;
    warning_inland_m: number;
    fail_inland_m: number;
    distance_mode?: 'vertex' | 'edge';
    use_hull_tolerance?: boolean;
    default_hull_offset_m?: number;
    default_accuracy_m?: number;
    /** v2: geo dataset file names under data/geo (fallbacks used if missing). */
    land_file?: string;
    ports_file?: string;
    fallback_land_file?: string;
    fallback_ports_file?: string;
  };
  /** v2: time/speed-aware fleet coherence. Absent = v1 algorithm. */
  fleet_coherence?: FleetCoherenceV2Config;
  /** v2: identity check settings. Absent = identity check reported unavailable. */
  identity?: Omit<IdentityConfig, 'max_sog_kn'>;
  /** v2: signed-vs-AIS with interpolation. */
  signed_vs_ais?: { warn_m: number; fail_m: number; interp_window_s: number };
  /** v2: ingest validation windows. */
  validation?: {
    ais_stale_after_s: number;
    device_stale_after_s: number;
    max_future_skew_s: number;
    lab_stale_after_s: number;
  };
  /** v2: per-source kinematic state. */
  state?: { per_source: boolean; ais_history: number };
  neighbors: {
    radius_nm: number;
    max_age_s: number;
    conflict_distance_m: number;
    min_independent_sources: number;
  };
  crypto: {
    freshness_window_s: number;
    max_clock_skew_s: number;
    duplicate_cache_size: number;
  };
  imu: {
    accel_noise_mps2: number;
    gyro_noise_rads: number;
    bias_random_walk: number;
    residual_fail_sigma: number;
    residual_warn_sigma: number;
  };
  gnss_diagnostics: {
    min_satellites: number;
    min_c_n0_dbhz: number;
    max_hdop: number;
    jamming_agc_delta: number;
  };
  region: {
    name: string;
    bbox: { minLon: number; minLat: number; maxLon: number; maxLat: number };
  };
}

export interface EnvConfig {
  host: string;
  port: number;
  httpPort: number;
  tlsEnabled: boolean;
  mtlsEnabled: boolean;
  certDir: string;
  keyDir: string;
  shoreKeyDir: string;
  role: 'shore' | 'device';
  challengeRequired: boolean;
  osnmaScope: 'fullstack' | 'lab_fleet';
  auditMirrorPath: string | undefined;
  signerBackend: 'software' | 'pkcs11';
  pkcs11Module: string | undefined;
  pkcs11Pin: string | undefined;
  pkcs11KeyLabel: string | undefined;
  dataMode: 'live' | 'replay' | 'simulation';
  seed: number;
  aisstreamKey: string | undefined;
  osnmaEnabled: boolean;
  osnmaUrl: string;
}

/** Prefer NORTHSTAR_*; accept legacy FLAGSHIP_* so old .env files still work. */
function env(name: string, legacy: string): string | undefined {
  return process.env[name] ?? process.env[legacy];
}

export function loadEnv(): EnvConfig {
  const roleRaw = (env('NORTHSTAR_ROLE', 'FLAGSHIP_ROLE') ?? 'shore').toLowerCase();
  const scopeRaw = (process.env.NORTHSTAR_OSNMA_SCOPE ?? 'fullstack').toLowerCase();
  const signerRaw = (process.env.NORTHSTAR_SIGNER_BACKEND ?? 'software').toLowerCase();
  const challengeEnv = process.env.NORTHSTAR_CHALLENGE_REQUIRED;
  return {
    host: env('NORTHSTAR_HOST', 'FLAGSHIP_HOST') ?? '127.0.0.1',
    port: Number(env('NORTHSTAR_PORT', 'FLAGSHIP_PORT') ?? 8443),
    httpPort: Number(env('NORTHSTAR_HTTP_PORT', 'FLAGSHIP_HTTP_PORT') ?? 8080),
    tlsEnabled: env('NORTHSTAR_TLS_ENABLED', 'FLAGSHIP_TLS_ENABLED') === 'true',
    mtlsEnabled: env('NORTHSTAR_MTLS_ENABLED', 'FLAGSHIP_MTLS_ENABLED') === 'true',
    certDir: env('NORTHSTAR_CERT_DIR', 'FLAGSHIP_CERT_DIR') ?? join(REPO_ROOT, 'certs'),
    // Device private keys (device-sim). Shore must not use these for signing.
    keyDir: env('NORTHSTAR_KEY_DIR', 'FLAGSHIP_KEY_DIR') ?? join(REPO_ROOT, '.northstar/keys'),
    shoreKeyDir:
      process.env.NORTHSTAR_SHORE_KEY_DIR ?? join(REPO_ROOT, '.northstar/shore'),
    role: roleRaw === 'device' ? 'device' : 'shore',
    // Default true — set NORTHSTAR_CHALLENGE_REQUIRED=false for legacy compat
    challengeRequired: challengeEnv === undefined ? true : challengeEnv === 'true',
    osnmaScope: scopeRaw === 'lab_fleet' ? 'lab_fleet' : 'fullstack',
    auditMirrorPath: process.env.NORTHSTAR_AUDIT_MIRROR_PATH || undefined,
    signerBackend: signerRaw === 'pkcs11' ? 'pkcs11' : 'software',
    pkcs11Module: process.env.NORTHSTAR_PKCS11_MODULE || undefined,
    pkcs11Pin: process.env.NORTHSTAR_PKCS11_PIN || undefined,
    pkcs11KeyLabel: process.env.NORTHSTAR_PKCS11_KEY_LABEL || 'northstar-device',
    dataMode:
      (env('NORTHSTAR_DATA_MODE', 'FLAGSHIP_DATA_MODE') as EnvConfig['dataMode']) ?? 'simulation',
    seed: Number(env('NORTHSTAR_SEED', 'FLAGSHIP_SEED') ?? 42),
    aisstreamKey: process.env.AISSTREAM_API_KEY || undefined,
    osnmaEnabled: process.env.OSNMA_SIDECAR_ENABLED === 'true',
    osnmaUrl: process.env.OSNMA_SIDECAR_URL ?? 'http://127.0.0.1:8791',
  };
}

/**
 * Config selection. Default is v2; v1 stays selectable:
 *   NORTHSTAR_FUSION=v1|v2|<path>   NORTHSTAR_THRESHOLDS=v1|v2|<path>
 */
function resolveConfigPath(kind: 'fusion' | 'thresholds', value: string | undefined): string {
  const v = (value ?? 'v2').trim();
  if (v === 'v1' || v === 'v2') return `config/${kind}.${v}.json`;
  return v;
}

export function loadFusion(which = process.env.NORTHSTAR_FUSION): FusionConfig {
  return loadJson<FusionConfig>(resolveConfigPath('fusion', which));
}

export function loadThresholds(which = process.env.NORTHSTAR_THRESHOLDS): ThresholdsConfig {
  return loadJson<ThresholdsConfig>(resolveConfigPath('thresholds', which));
}

/** Runtime data dir (P1.5). Default .northstar/data; legacy mode keeps data/fixtures. */
export function runtimeDataDir(): string | null {
  if (process.env.NORTHSTAR_LEGACY_DATA_PATHS === 'true') return null;
  const raw = process.env.NORTHSTAR_DATA_DIR ?? '.northstar/data';
  const expanded = raw.replace(/^~/, process.env.HOME ?? '');
  return expanded.startsWith('/') ? expanded : join(REPO_ROOT, expanded);
}

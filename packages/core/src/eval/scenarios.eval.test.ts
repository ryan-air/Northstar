/**
 * Evaluation harness — detection / false-alert metrics for required scenarios.
 * Also runnable via: npm run eval (vitest this file)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkKinematics,
  buildLandIndex,
  checkGeographic,
  fuseTrust,
  createHardAlertState,
  type FusionConfig,
  type KinematicsConfig,
  type PolygonFeature,
} from '../index.js';
import type { PositionEvent } from '@northstar/contracts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const fusion = JSON.parse(readFileSync(join(root, 'config/fusion.v1.json'), 'utf8')) as FusionConfig;
const thresholds = JSON.parse(readFileSync(join(root, 'config/thresholds.v1.json'), 'utf8'));
const land = JSON.parse(readFileSync(join(root, 'data/geo/land.geojson'), 'utf8'));

const kinConfig: KinematicsConfig = {
  ...thresholds.kinematics,
  vessel_class_limits: thresholds.vessel_class_limits,
};

const landIndex = buildLandIndex(
  land.features.map((f: { id?: string; geometry: PolygonFeature }, i: number) => ({
    id: String(f.id ?? i),
    geometry: f.geometry,
  })),
);

function ev(t: string, lat: number, lon: number, sog = 12, cog = 90): PositionEvent {
  return {
    schema_version: 1,
    entity_id: 'VESSEL-001',
    entity_type: 'vessel',
    vessel_class: 'cargo',
    position: { lat, lon, crs: 'EPSG:4326' },
    speed_over_ground_knots: sog,
    course_over_ground_deg: cog,
    source: 'eval',
    source_timestamp: t,
    ingested_at: t,
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 15, signal_quality_available: false },
  };
}

describe('eval scenarios', () => {
  it('normal navigation does not false-alarm', () => {
    let state = { cusum: 0 };
    let prev: PositionEvent | null = null;
    let alerted = false;
    let lat = 59.85;
    let lon = 25.0;
    for (let i = 0; i < 30; i++) {
      // ~0.0005° lon / 5s ≈ 28 m ≈ 10.8 kn at this latitude — within cargo limits
      lon += 0.0005;
      const e = ev(
        new Date(Date.parse('2026-11-11T10:00:00Z') + i * 5000).toISOString(),
        lat,
        lon,
        11,
        90,
      );
      const kin = checkKinematics(e, prev, state, kinConfig, e.source_timestamp);
      state = kin.state;
      const geo = checkGeographic(
        e,
        { land: landIndex, ports: [], restricted: [] },
        thresholds.geographic,
        e.source_timestamp,
      );
      const { assessment } = fuseTrust(
        e.entity_id,
        [kin.result, geo],
        fusion,
        createHardAlertState(),
        e.source_timestamp,
      );
      if (assessment.trust_band === 'suspicious' || assessment.trust_band === 'critical') {
        alerted = true;
      }
      prev = e;
    }
    expect(alerted).toBe(false);
  });

  it('detects sudden jump', () => {
    const a = ev('2026-11-11T10:00:00.000Z', 59.85, 25.0);
    const b = ev('2026-11-11T10:00:05.000Z', 60.4, 25.0);
    const kin = checkKinematics(b, a, { cusum: 0 }, kinConfig, b.source_timestamp);
    const geo = checkGeographic(
      b,
      { land: landIndex, ports: [], restricted: [] },
      thresholds.geographic,
      b.source_timestamp,
    );
    const detected = kin.result.hard_alert || geo.hard_alert || kin.result.status === 'fail';
    expect(detected).toBe(true);
    expect(/jump|inland|impossible|speed/i.test(kin.result.explanation + geo.explanation)).toBe(
      true,
    );
  });

  it('detects gradual drift', () => {
    let state = { cusum: 0 };
    let prev = ev('2026-11-11T10:00:00.000Z', 59.85, 25.0, 12, 90);
    let detected = false;
    for (let i = 1; i <= 40; i++) {
      const e = ev(
        new Date(Date.parse('2026-11-11T10:00:00Z') + i * 10000).toISOString(),
        59.85 + i * 0.004,
        25.0 + i * 0.001,
        12,
        90,
      );
      const kin = checkKinematics(e, prev, state, kinConfig, e.source_timestamp);
      state = kin.state;
      if (kin.result.status === 'warning' || kin.result.status === 'fail') detected = true;
      prev = e;
    }
    expect(detected).toBe(true);
  });
});

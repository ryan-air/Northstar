import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLandIndex } from '../geo/landIndex.js';
import { checkGeographic } from './geo.js';
import type { PositionEvent } from '@northstar/contracts';
import type { PolygonFeature } from '../geo/pointInPolygon.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const land = JSON.parse(readFileSync(join(root, 'data/geo/land.geojson'), 'utf8'));
const ports = JSON.parse(readFileSync(join(root, 'data/geo/ports.geojson'), 'utf8'));
const restricted = JSON.parse(readFileSync(join(root, 'data/geo/restricted.geojson'), 'utf8'));

const landIndex = buildLandIndex(
  land.features.map((f: { id?: string; geometry: PolygonFeature }, i: number) => ({
    id: String(f.id ?? i),
    geometry: f.geometry,
  })),
);

const ctx = {
  land: landIndex,
  ports: ports.features.map((f: { id?: string; geometry: PolygonFeature }) => ({
    id: String(f.id),
    geometry: f.geometry,
  })),
  restricted: restricted.features.map(
    (f: { id?: string; properties?: { name?: string }; geometry: PolygonFeature }) => ({
      id: String(f.id),
      name: f.properties?.name,
      geometry: f.geometry,
    }),
  ),
};

function ev(lat: number, lon: number): PositionEvent {
  return {
    schema_version: 1,
    entity_id: 'VESSEL-001',
    entity_type: 'vessel',
    position: { lat, lon, crs: 'EPSG:4326' },
    source: 'test',
    source_timestamp: '2026-11-11T10:00:00.000Z',
    ingested_at: '2026-11-11T10:00:00.000Z',
    device_signature_status: 'missing',
    osnma_status: 'unavailable',
    quality: { position_accuracy_m: 20, signal_quality_available: false },
  };
}

describe('geographic', () => {
  it('passes open water in Gulf of Finland', () => {
    const r = checkGeographic(
      ev(59.85, 25.0),
      ctx,
      { shore_buffer_m: 150, port_buffer_m: 400, warning_inland_m: 80, fail_inland_m: 300 },
      '2026-11-11T10:00:00.000Z',
    );
    expect(r.status).toBe('pass');
    expect(r.hard_alert).toBe(false);
  });

  it('fails deep inland with good accuracy', () => {
    const r = checkGeographic(
      ev(60.5, 25.0),
      ctx,
      { shore_buffer_m: 150, port_buffer_m: 400, warning_inland_m: 80, fail_inland_m: 300 },
      '2026-11-11T10:00:00.000Z',
    );
    expect(r.status).toBe('fail');
    expect(r.hard_alert).toBe(true);
  });
});

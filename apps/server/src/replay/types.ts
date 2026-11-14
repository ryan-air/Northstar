export interface ReplayRecord {
  mmsi: number;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  navStat?: number | null;
  timestamp_external_ms: number | null;
  captured_at: string;
  source: string;
  provider_id: string;
  name?: string;
  shipType?: number;
}

export interface ReplayManifest {
  region: string;
  source: string;
  licence: string;
  captured_polls?: number;
  interval_s?: number;
  records: number;
  unique_mmsi: number;
  vessels_with_3plus_samples?: number;
  note: string;
  built_at: string;
  last_appended_at?: string;
}

export interface VesselTrack {
  mmsi: number;
  entity_id: string;
  name: string;
  vessel_class: string;
  samples: ReplayRecord[];
  /** duration of track in ms (last - first) */
  durationMs: number;
}

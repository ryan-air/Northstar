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
  /** P1.1 additive fields (absent in recordings made before this change). */
  rot?: number | null;
  posAcc?: boolean | null;
  raim?: boolean | null;
  /** AIS UTC second field (0–59; 60–63 = unavailable). */
  ais_timestamp_s?: number | null;
  callSign?: string;
  imo?: number;
  destination?: string;
  draught?: number;
  posType?: number;
  referencePointA?: number;
  referencePointB?: number;
  referencePointC?: number;
  referencePointD?: number;
  /** Secondary-feed rows (U6) carry a distinct source tag, e.g. 'aisstream'. */
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

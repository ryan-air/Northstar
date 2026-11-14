import type { VesselClass } from '@northstar/contracts';

export interface SimVesselDef {
  entity_id: string;
  name: string;
  vessel_class: VesselClass;
  /** Route waypoints [lon, lat] */
  route: Array<[number, number]>;
  sog_kn: number;
  device_id?: string;
  /** Signed telemetry vessel (primary demo target) */
  signed?: boolean;
}

/** ~12 vessels on Gulf of Finland routes (Helsinki–Tallinn + eastbound). */
export const FLEET: SimVesselDef[] = [
  {
    entity_id: 'VESSEL-001',
    name: 'MV Northstar',
    vessel_class: 'passenger',
    route: [
      [24.95, 60.15],
      [24.92, 59.95],
      [24.85, 59.75],
      [24.78, 59.55],
      [24.76, 59.48],
    ],
    sog_kn: 18,
    device_id: 'DEV-VESSEL-001',
    signed: true,
  },
  {
    entity_id: 'VESSEL-002',
    name: 'MT Baltic Star',
    vessel_class: 'tanker',
    route: [
      [24.5, 59.7],
      [25.5, 59.75],
      [26.5, 59.85],
      [27.5, 59.9],
      [28.4, 59.95],
    ],
    sog_kn: 12,
  },
  {
    entity_id: 'VESSEL-003',
    name: 'MV Suomenlinna',
    vessel_class: 'cargo',
    route: [
      [24.76, 59.48],
      [24.85, 59.75],
      [24.92, 59.95],
      [24.95, 60.15],
    ],
    sog_kn: 14,
  },
  {
    entity_id: 'VESSEL-004',
    name: 'FV Kotka Pearl',
    vessel_class: 'fishing',
    route: [
      [26.9, 60.2],
      [26.7, 60.1],
      [26.5, 60.0],
      [26.7, 60.1],
    ],
    sog_kn: 8,
  },
  {
    entity_id: 'VESSEL-005',
    name: 'Tug Hamina',
    vessel_class: 'tug',
    route: [
      [27.18, 60.48],
      [27.1, 60.4],
      [27.0, 60.35],
      [27.1, 60.4],
    ],
    sog_kn: 6,
  },
  {
    entity_id: 'VESSEL-006',
    name: 'MV Primorsk Express',
    vessel_class: 'tanker',
    route: [
      [28.6, 60.2],
      [28.3, 60.0],
      [27.8, 59.85],
      [27.2, 59.75],
    ],
    sog_kn: 11,
  },
  {
    entity_id: 'VESSEL-007',
    name: 'MV Tallink Echo',
    vessel_class: 'passenger',
    route: [
      [24.76, 59.46],
      [24.88, 59.7],
      [24.95, 59.95],
      [24.96, 60.14],
    ],
    sog_kn: 20,
  },
  {
    entity_id: 'VESSEL-008',
    name: 'MV Ust-Luga Carrier',
    vessel_class: 'cargo',
    route: [
      [28.4, 59.7],
      [27.5, 59.8],
      [26.5, 59.85],
      [25.5, 59.8],
    ],
    sog_kn: 13,
  },
  {
    entity_id: 'VESSEL-009',
    name: 'SY Seili',
    vessel_class: 'pleasure',
    route: [
      [25.0, 60.05],
      [25.2, 60.0],
      [25.4, 59.95],
      [25.2, 60.0],
    ],
    sog_kn: 7,
  },
  {
    entity_id: 'VESSEL-010',
    name: 'MV Sillamäe Runner',
    vessel_class: 'cargo',
    route: [
      [27.75, 59.42],
      [27.2, 59.55],
      [26.5, 59.65],
      [25.8, 59.7],
    ],
    sog_kn: 12,
  },
  {
    entity_id: 'VESSEL-011',
    name: 'MV Helsinki Feeder',
    vessel_class: 'cargo',
    route: [
      [24.92, 60.14],
      [25.3, 60.05],
      [25.8, 59.95],
      [26.2, 59.9],
    ],
    sog_kn: 10,
  },
  {
    entity_id: 'VESSEL-012',
    name: 'RV Kronstadt',
    vessel_class: 'other',
    route: [
      [29.5, 59.9],
      [29.0, 59.85],
      [28.5, 59.8],
      [28.0, 59.78],
    ],
    sog_kn: 9,
  },
];


import { useEffect, useRef, useState } from 'react';

import {
  Map as MapLibreMap,
  setWorkerUrl,
  type AddLayerObject,
  type GeoJSONSource,
  type Map,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';

import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

// Tell MapLibre where Vite bundles its worker.
setWorkerUrl(workerUrl);

import { useStore } from '../lib/store';
import type { TrustBand, VesselState } from '../lib/types';

const ONLINE_STYLE =
  import.meta.env.VITE_MAP_STYLE_URL ||
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

const BAND_COLOR: Record<TrustBand, string> = {
  high: '#3fd08f',
  caution: '#e6a73c',
  suspicious: '#e8833f',
  critical: '#ee5a5a',
};

/** Stable empty array — `?? []` inside a Zustand selector creates a new ref every call and infinite-loops React. */
const EMPTY_VESSELS: VesselState[] = [];

function offlineStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      land: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: { 'background-color': '#12355a' },
      },
    ],
  };
}

function vesselsToGeoJSON(vessels: VesselState[]) {
  return {
    type: 'FeatureCollection' as const,
    features: vessels.map((v) => {
      const live = v.origin === 'live' || v.entity_id.startsWith('LIVE-');
      return {
        type: 'Feature' as const,
        properties: {
          id: v.entity_id,
          name: live ? `${v.name ?? v.entity_id}` : (v.name ?? v.entity_id),
          band: v.trust.trust_band,
          // Live vessels: cyan ring via stroke; fill still trust color
          color: BAND_COLOR[v.trust.trust_band],
          stroke: live ? '#6fb3cc' : '#101820',
          strokeWidth: live ? 1.5 : 1.5,
          radius: live ? 5 : 6,
          origin: live ? 'live' : 'lab',
          heading: v.heading_deg ?? v.course_over_ground_deg ?? 0,
          score: v.trust.trust_score,
        },
        geometry: {
          type: 'Point' as const,
          coordinates: [v.position.lon, v.position.lat],
        },
      };
    }),
  };
}

function tracksToGeoJSON(vessels: VesselState[]) {
  return {
    type: 'FeatureCollection' as const,
    features: vessels.flatMap((v) => {
      if (v.track.length < 2) return [];
      return [
        {
          type: 'Feature' as const,
          properties: {
            id: v.entity_id,
            // Legitimate tracks in muted steel; only suspicious/critical tracks take colour.
            color:
              v.trust.trust_band === 'critical' || v.trust.trust_band === 'suspicious'
                ? BAND_COLOR[v.trust.trust_band]
                : '#5f8fae',
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: v.track.map((p) => [p.lon, p.lat]),
          },
        },
        ...v.track
          .filter((p) => p.anomalous)
          .map((p) => ({
            type: 'Feature' as const,
            properties: { id: v.entity_id, anomalous: true },
            geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
          })),
      ];
    }),
  };
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const vessels = useStore((s) => s.snapshot?.vessels ?? EMPTY_VESSELS);
  const simTime = useStore((s) => s.snapshot?.sim_time);
  const mapStatus = useStore((s) => s.mapStatus);
  const setMapStatus = useStore((s) => s.setMapStatus);
  const selectVessel = useStore((s) => s.selectVessel);
  const selectedId = useStore((s) => s.selectedId);
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;
    const container = containerRef.current;

    const init = async () => {
      setMapStatus('loading');
      // Prefer offline style first so the UI always paints; try online tiles as enhancement.
      let style: string | StyleSpecification = offlineStyle();
      let online = false;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(ONLINE_STYLE, { signal: ctrl.signal, mode: 'cors' });
        clearTimeout(t);
        if (res.ok) {
          style = ONLINE_STYLE;
          online = true;
        }
      } catch {
        online = false;
      }
      if (!cancelled) setMapStatus(online ? 'online' : 'offline');

      if (cancelled || !container.isConnected) return;
      const map = new MapLibreMap({
        container,
        style,
        center: [25.5, 59.9],
        zoom: 7.2,
        attributionControl: { compact: true },
      });
      mapRef.current = map;

      map.on('load', async () => {
        // Ocean navy water (the online CARTO dark basemap paints near-black water).
        try {
          for (const l of map.getStyle().layers ?? []) {
            if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#0d2742');
            else if (l.type === 'fill' && /water|ocean|sea/i.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#12355a');
          }
        } catch {
          /* style without those layers */
        }
        if (cancelled) return;
        const ensureSource = (id: string, data: GeoJSON.GeoJSON | GeoJSON.FeatureCollection) => {
          if (map.getSource(id)) {
            (map.getSource(id) as GeoJSONSource).setData(data);
          } else {
            map.addSource(id, { type: 'geojson', data });
          }
        };
        // Bundled geo overlays
        for (const layer of ['land', 'ports', 'lanes', 'restricted'] as const) {
          try {
            const data = await fetch(`/api/geo/${layer}`).then((r) => r.json());
            if (cancelled) return;
            ensureSource(layer, data);
          } catch {
            if (cancelled) return;
            ensureSource(layer, { type: 'FeatureCollection', features: [] });
          }
        }

        const addLayerOnce = (layer: AddLayerObject) => {
          if (!map.getLayer(layer.id)) map.addLayer(layer);
        };

        addLayerOnce({
          id: 'land-fill',
          type: 'fill',
          source: 'land',
          paint: { 'fill-color': '#1d3330', 'fill-opacity': 0.9 },
        });
        addLayerOnce({
          id: 'land-line',
          type: 'line',
          source: 'land',
          // The coastline GeoJSON is cut into 0.1° tiles; the faint outline doubles as a chart grid.
          paint: { 'line-color': '#2f8a63', 'line-width': 0.8, 'line-opacity': 0.7 },
        });
        addLayerOnce({
          id: 'ports-fill',
          type: 'fill',
          source: 'ports',
          paint: { 'fill-color': '#2c4a63', 'fill-opacity': 0.55 },
        });
        addLayerOnce({
          id: 'lanes-line',
          type: 'line',
          source: 'lanes',
          paint: { 'line-color': '#4f8fb8', 'line-width': 1, 'line-opacity': 0.75, 'line-dasharray': [3, 3] },
        });
        addLayerOnce({
          id: 'restricted-fill',
          type: 'fill',
          source: 'restricted',
          paint: { 'fill-color': '#9a3a3a', 'fill-opacity': 0.28 },
        });

        // OpenSeaMap seamarks when online
        if (online) {
          try {
            if (!map.getSource('seamark')) {
              map.addSource('seamark', {
                type: 'raster',
                tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '© OpenSeaMap',
              });
            }
            addLayerOnce({
              id: 'seamark',
              type: 'raster',
              source: 'seamark',
              paint: { 'raster-opacity': 0.6 },
            });
          } catch {
            /* optional */
          }
        }

        ensureSource('tracks', { type: 'FeatureCollection', features: [] });
        addLayerOnce({
          id: 'tracks-line',
          type: 'line',
          source: 'tracks',
          filter: ['==', ['geometry-type'], 'LineString'],
          paint: {
            'line-color': ['get', 'color'],
            'line-width': 1.6,
            'line-opacity': 0.75,
          },
        });
        addLayerOnce({
          id: 'anomaly-pts',
          type: 'circle',
          source: 'tracks',
          filter: ['==', ['get', 'anomalous'], true],
          paint: {
            'circle-radius': 3.5,
            'circle-color': '#dc5555',
            'circle-stroke-color': '#101820',
            'circle-stroke-width': 1,
          },
        });

        ensureSource('vessels', { type: 'FeatureCollection', features: [] });
        addLayerOnce({
          id: 'vessels-circle',
          type: 'circle',
          source: 'vessels',
          paint: {
            'circle-radius': ['coalesce', ['get', 'radius'], 7],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': ['coalesce', ['get', 'strokeWidth'], 1.5],
            'circle-stroke-color': ['coalesce', ['get', 'stroke'], '#101820'],
          },
        });
        addLayerOnce({
          id: 'vessels-label',
          type: 'symbol',
          source: 'vessels',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 10,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-optional': true,
          },
          paint: {
            'text-color': '#b9c8d3',
            'text-halo-color': '#101820',
            'text-halo-width': 1.2,
            // Labels fade in as you zoom; at fleet scale they would bury the map.
            'text-opacity': ['interpolate', ['linear'], ['zoom'], 7.5, 0, 8.5, 1],
          },
        });
        // Selected vessel: a thin accent ring, no glow.
        addLayerOnce({
          id: 'vessels-selected',
          type: 'circle',
          source: 'vessels',
          filter: ['==', ['get', 'id'], useStore.getState().selectedId ?? ''],
          paint: {
            'circle-radius': 11,
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': '#36bfc0',
            'circle-stroke-width': 1.5,
          },
        });

        map.on('click', 'vessels-circle', (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.id;
          if (id) selectVessel(String(id));
        });
        map.on('mouseenter', 'vessels-circle', () => {
          map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'vessels-circle', () => {
          map.getCanvas().style.cursor = '';
        });
      });

      map.on('error', () => {
        // Avoid hard crash; status already set if style failed
      });
    };

    void init().catch(() => {
      if (!cancelled) setMapStatus('error');
    });
    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [selectVessel, setMapStatus]);

  // Refresh vessel + track data every tick. Never moves the camera, so live
  // updates don't fight the user panning around the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const vs = map.getSource('vessels') as GeoJSONSource | undefined;
    const ts = map.getSource('tracks') as GeoJSONSource | undefined;
    vs?.setData(vesselsToGeoJSON(vessels));
    ts?.setData(tracksToGeoJSON(vessels));
  }, [vessels]);

  // Recenter only when the selection changes — a one-time fly-to on click,
  // not a per-tick pull. Reads latest positions from the store at fire time.
  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer('vessels-selected')) {
      map.setFilter('vessels-selected', ['==', ['get', 'id'], selectedId ?? '']);
    }
    if (!map || !selectedId) return;
    const selected = useStore
      .getState()
      .snapshot?.vessels?.find((v) => v.entity_id === selectedId);
    if (selected) {
      map.easeTo({
        center: [selected.position.lon, selected.position.lat],
        duration: 600,
      });
    }
  }, [selectedId]);

  return (
    <div className="map-pane">
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {mapStatus === 'offline' && (
        <div className="map-overlay map-status">Offline map — bundled GeoJSON coastline</div>
      )}
      {mapStatus === 'loading' && (
        <div className="map-overlay map-status">Loading chart…</div>
      )}
      <button
        type="button"
        className="map-overlay map-legend-toggle"
        onClick={() => setLegendOpen((o) => !o)}
      >
        {legendOpen ? '✕ Legend' : 'Legend'}
      </button>
      {legendOpen && (
        <div className="map-overlay map-legend">
          <div className="row">
            <span className="dot high" /> High 85–100
          </div>
          <div className="row">
            <span className="dot caution" /> Caution 65–84
          </div>
          <div className="row">
            <span className="dot suspicious" /> Suspicious 35–64
          </div>
          <div className="row">
            <span className="dot critical" /> Critical 0–34
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="dot live" /> Live AIS (Digitraffic)
          </div>
          <div className="row">
            <span className="dot lab" /> Lab (recorded + simulated)
          </div>
          <div className="row muted" style={{ marginTop: 4 }}>
            Cyan ring = live · amber = replay
          </div>
        </div>
      )}
      <div className="map-overlay map-ts mono">{simTime ?? '—'} · WGS-84</div>
    </div>
  );
}

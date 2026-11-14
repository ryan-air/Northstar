import { create } from 'zustand';
import type { AlertEvent, AppSnapshot, ScenarioId, VesselState, ViewMode } from './types';

interface NorthstarStore {
  connected: boolean;
  snapshot: AppSnapshot | null;
  selectedId: string | null;
  selectedEvent: AlertEvent | null;
  mapStatus: 'loading' | 'online' | 'offline' | 'error';
  setConnected: (v: boolean) => void;
  applySnapshot: (s: AppSnapshot) => void;
  applyVessel: (v: VesselState) => void;
  selectVessel: (id: string) => void;
  selectEvent: (e: AlertEvent | null) => void;
  setMapStatus: (s: NorthstarStore['mapStatus']) => void;
  runScenario: (id: ScenarioId) => Promise<void>;
  setViewMode: (mode: ViewMode) => Promise<void>;
}

export const useStore = create<NorthstarStore>((set, get) => ({
  connected: false,
  snapshot: null,
  selectedId: 'VESSEL-001',
  selectedEvent: null,
  mapStatus: 'loading',
  setConnected: (v) => set({ connected: v }),
  applySnapshot: (s) => {
    // Ignore non-snapshot payloads (e.g. 429 rate-limit JSON) that lack vessels[]
    if (!s || !Array.isArray(s.vessels)) return;
    set({
      snapshot: s,
      selectedId: get().selectedId ?? s.selected_entity_id ?? s.vessels[0]?.entity_id ?? null,
    });
  },
  applyVessel: (v) => {
    const snap = get().snapshot;
    if (!snap || !Array.isArray(snap.vessels)) return;
    const vessels = snap.vessels.some((x) => x.entity_id === v.entity_id)
      ? snap.vessels.map((x) => (x.entity_id === v.entity_id ? v : x))
      : [...snap.vessels, v];
    set({ snapshot: { ...snap, vessels } });
  },
  selectVessel: (id) => {
    set({ selectedId: id });
    fetch('/api/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity_id: id }),
    }).catch(() => undefined);
  },
  selectEvent: (e) => set({ selectedEvent: e }),
  setMapStatus: (s) => set({ mapStatus: s }),
  runScenario: async (id) => {
    const adminToken =
      (import.meta as { env?: { VITE_NORTHSTAR_ADMIN_TOKEN?: string } }).env
        ?.VITE_NORTHSTAR_ADMIN_TOKEN ?? 'northstar-demo-admin';
    await fetch('/api/scenario', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ scenario: id, entity_id: get().selectedId ?? 'VESSEL-001' }),
    });
  },
  setViewMode: async (mode) => {
    const res = await fetch('/api/view-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { snapshot?: AppSnapshot };
    if (body.snapshot) useStore.getState().applySnapshot(body.snapshot);
  },
}));

export function connectWs(): () => void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsToken = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_NORTHSTAR_WS_TOKEN;
  const url = `${proto}://${location.host}/ws${wsToken ? `?token=${encodeURIComponent(wsToken)}` : ''}`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(url);
    ws.onopen = () => useStore.getState().setConnected(true);
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      retry = setTimeout(connect, 1500);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type: string;
          payload: unknown;
        };
        if (msg.type === 'snapshot') {
          useStore.getState().applySnapshot(msg.payload as AppSnapshot);
        } else if (msg.type === 'vessel_update') {
          useStore.getState().applyVessel(msg.payload as VesselState);
        }
      } catch {
        /* ignore */
      }
    };
  };
  connect();

  // HTTP fallback poll
  const poll = setInterval(() => {
    if (useStore.getState().connected) return;
    fetch('/api/snapshot')
      .then(async (r) => {
        if (!r.ok) return;
        const s = (await r.json()) as AppSnapshot;
        useStore.getState().applySnapshot(s);
      })
      .catch(() => undefined);
  }, 2000);

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    clearInterval(poll);
    ws?.close();
  };
}

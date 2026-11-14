import { create } from 'zustand';
import type { AlertEvent, AppSnapshot, LabEvent, ScenarioId, ScenarioResult, VesselState, ViewMode } from './types';

const adminToken = () =>
  (import.meta as { env?: { VITE_NORTHSTAR_ADMIN_TOKEN?: string } }).env?.VITE_NORTHSTAR_ADMIN_TOKEN ??
  'northstar-demo-admin';

interface NorthstarStore {
  connected: boolean;
  snapshot: AppSnapshot | null;
  selectedId: string | null;
  selectionInitialized: boolean;
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
  /** Where the last scenario actually landed (attacks go to simulated ships only). */
  lastScenario: ScenarioResult | null;
  /** Lab-return events (receiver-flagged windows, RF captures) for jump-to controls. */
  labEvents: LabEvent[];
  labVesselName: string | null;
  loadLabEvents: () => Promise<void>;
  seekLab: (iso: string) => Promise<boolean>;
}

export const useStore = create<NorthstarStore>((set, get) => ({
  connected: false,
  snapshot: null,
  selectedId: null,
  selectionInitialized: false,
  selectedEvent: null,
  mapStatus: 'loading',
  lastScenario: null,
  labEvents: [],
  labVesselName: null,
  loadLabEvents: async () => {
    try {
      const r = await fetch('/api/lab/events');
      if (!r.ok) return;
      const b = (await r.json()) as { name?: string; events?: LabEvent[] };
      set({ labEvents: b.events ?? [], labVesselName: b.name ?? null });
    } catch {
      /* lab events are optional */
    }
  },
  seekLab: async (iso) => {
    const r = await fetch('/api/lab/seek', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken()}` },
      body: JSON.stringify({ t: iso }),
    });
    return r.ok;
  },
  setConnected: (v) => set({ connected: v }),
  applySnapshot: (s) => {
    // Ignore non-snapshot payloads (e.g. 429 rate-limit JSON) that lack vessels[]
    if (!s || !Array.isArray(s.vessels)) return;
    const st = get();
    // Pick a default on the first snapshot only. After that, respect the user's
    // choice — including an explicit deselect (null) — instead of refilling it.
    const selectedId = st.selectionInitialized
      ? st.selectedId
      : (s.selected_entity_id ?? s.vessels[0]?.entity_id ?? null);
    set({ snapshot: s, selectedId, selectionInitialized: true });
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
    const res = await fetch('/api/scenario', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${adminToken()}`,
      },
      body: JSON.stringify({ scenario: id, entity_id: get().selectedId ?? 'VESSEL-001' }),
    });
    if (!res.ok) return;
    const b = (await res.json().catch(() => ({}))) as { target?: string; retargeted_from?: string };
    set({ lastScenario: id === 'reset' || id === 'normal' ? null : { scenario: id, target: b.target, retargeted_from: b.retargeted_from } });
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

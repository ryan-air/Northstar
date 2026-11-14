# Dashboard UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Northstar dashboard for a cybersecurity audience — promote trust score visibility, separate controls from information, and remove all static disclaimer/hedging text from the UI.

**Architecture:** Seven focused component edits plus two new components (`BottomBar`, `CyberWindow`). The Timeline component is deleted entirely; its event log moves into the right panel and its scenario controls move into a new BottomBar. The app shell grid is updated to reflect the new bottom height. No store changes required.

**Tech Stack:** React 18, TypeScript, MapLibre GL, Zustand, Vite. Validation via `npm run typecheck -w @northstar/web` and `npm run build -w @northstar/web`.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Delete | `apps/web/src/components/Timeline.tsx` | Replaced by BottomBar + Events tab |
| Create | `apps/web/src/components/BottomBar.tsx` | Scenario buttons + Cyber window trigger |
| Create | `apps/web/src/components/CyberWindow.tsx` | Floating overlay wrapping CyberPanel |
| Modify | `apps/web/src/App.tsx` | Wire BottomBar + CyberWindow, remove Timeline |
| Modify | `apps/web/src/components/TopBar.tsx` | 3-zone grid layout, remove live pill/LEDs/WS |
| Modify | `apps/web/src/components/LeftPanel.tsx` | Fleet metrics + sorted vessel list + selected vessel detail |
| Modify | `apps/web/src/components/RightPanel.tsx` | Events (default) / Evidence / Sources tabs |
| Modify | `apps/web/src/components/CyberPanel.tsx` | Remove 3 static disclaimer strings |
| Modify | `apps/web/src/styles/global.css` | New layout vars, top-bar grid, bottom-bar, cyber-window, event-log styles |

---

## Task 1: Create BottomBar + wire App shell

**Files:**
- Create: `apps/web/src/components/BottomBar.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/styles/global.css` (bottom layout only)

- [ ] **Step 1: Create BottomBar.tsx**

```tsx
// apps/web/src/components/BottomBar.tsx
import { useStore } from '../lib/store';
import type { ScenarioId } from '../lib/types';

const SCENARIOS: Array<{ id: ScenarioId; label: string; hint: string }> = [
  { id: 'normal', label: 'Normal', hint: 'Healthy track, high trust' },
  { id: 'sudden_spoof', label: 'Sudden spoof', hint: 'Jump inland' },
  { id: 'gradual_drift', label: 'Gradual drift', hint: 'Slow divergence' },
  { id: 'ais_disagreement', label: 'AIS conflict', hint: 'Independent feed conflict' },
  { id: 'gnss_jamming', label: 'GNSS jam', hint: 'Simulated signal degradation' },
  { id: 'imu_disagreement', label: 'IMU disagree', hint: 'Simulated inertial residual' },
  { id: 'signed_tamper', label: 'Sig tamper', hint: 'Alter field after sign' },
  { id: 'signed_replay', label: 'Sig replay', hint: 'Old sequence resent' },
  { id: 'stale_clock_skew', label: 'Clock skew', hint: 'Provider B timestamps aged' },
  { id: 'osnma_auth', label: 'OSNMA auth', hint: 'Protocol verification demo — authenticated' },
  { id: 'osnma_failure', label: 'OSNMA fail', hint: 'Protocol verification demo — failed' },
  { id: 'rf_aoa_spoof_cluster', label: 'RF AoA spoof', hint: 'Synthetic spoof overlay on real 2-ant IQ' },
];

interface Props {
  onCyberOpen: () => void;
}

export function BottomBar({ onCyberOpen }: Props) {
  const runScenario = useStore((s) => s.runScenario);
  const snapshot = useStore((s) => s.snapshot);

  return (
    <div className="bottom-bar">
      <button type="button" className="cyber-trigger" onClick={onCyberOpen}>
        Cyber ↑
      </button>
      <div className="scenario-buttons">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`scenario-btn${snapshot?.active_scenario === s.id ? ' active' : ''}`}
            title={s.hint}
            onClick={() => void runScenario(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="scenario-btn reset"
        title="Clear state & restart"
        onClick={() => void runScenario('reset')}
      >
        Reset
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Update App.tsx — remove Timeline, add BottomBar + CyberWindow imports**

Replace the entire file:

```tsx
// apps/web/src/App.tsx
import { useState, useEffect } from 'react';
import { TopBar } from './components/TopBar';
import { LeftPanel } from './components/LeftPanel';
import { MapView } from './components/MapView';
import { RightPanel } from './components/RightPanel';
import { BottomBar } from './components/BottomBar';
import { CyberWindow } from './components/CyberWindow';
import { ErrorBoundary } from './components/ErrorBoundary';
import { connectWs } from './lib/store';

export function App() {
  const [cyberOpen, setCyberOpen] = useState(false);
  useEffect(() => connectWs(), []);

  return (
    <ErrorBoundary>
      <div className="app-shell">
        <TopBar />
        <div className="main-row">
          <LeftPanel />
          <ErrorBoundary>
            <MapView />
          </ErrorBoundary>
          <RightPanel />
        </div>
        <BottomBar onCyberOpen={() => setCyberOpen(true)} />
        <CyberWindow open={cyberOpen} onClose={() => setCyberOpen(false)} />
      </div>
    </ErrorBoundary>
  );
}
```

- [ ] **Step 3: Update CSS — bottom bar layout**

In `global.css`, replace the `:root` `--bottom-h` value and the `.bottom-strip` block. Find and replace:

Old `--bottom-h: 160px;` → `--bottom-h: 96px;`

Replace the entire `.bottom-strip` / `.timeline` / `.timeline-item` block (lines 443–488) with:

```css
/* Bottom bar */
.bottom-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
  min-height: 0;
}

.cyber-trigger {
  background: var(--accent-dim);
  border: 1px solid var(--accent);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 10px;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.cyber-trigger:hover {
  background: rgba(61, 214, 198, 0.2);
}

.scenario-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.scenario-btn {
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  color: var(--text-dim);
  font-size: 11px;
  padding: 4px 8px;
}
.scenario-btn:hover {
  border-color: var(--accent-dim);
  color: var(--text);
}
.scenario-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
.scenario-btn.reset {
  border-color: var(--warn);
  color: var(--warn);
  flex-shrink: 0;
  margin-left: 4px;
}
```

Also update the `@media (max-width: 1100px)` block: change `--bottom-h: 140px` to `--bottom-h: 96px`.

- [ ] **Step 4: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors. If CyberWindow import errors because the file doesn't exist yet, that's expected — fix by creating a stub:

```tsx
// apps/web/src/components/CyberWindow.tsx  (temporary stub)
export function CyberWindow(_props: { open: boolean; onClose: () => void }) {
  return null;
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/BottomBar.tsx apps/web/src/components/CyberWindow.tsx apps/web/src/App.tsx apps/web/src/styles/global.css
git commit -m "feat(web): add BottomBar with scenario controls, stub CyberWindow, remove Timeline from shell"
```

---

## Task 2: Implement CyberWindow floating overlay

**Files:**
- Modify: `apps/web/src/components/CyberWindow.tsx` (replace stub)
- Modify: `apps/web/src/styles/global.css` (add cyber-window styles)

- [ ] **Step 1: Replace CyberWindow stub with full implementation**

```tsx
// apps/web/src/components/CyberWindow.tsx
import { CyberPanel } from './CyberPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CyberWindow({ open, onClose }: Props) {
  if (!open) return null;

  return (
    <div className="cyber-window-overlay" onClick={onClose}>
      <div
        className="cyber-window"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cyber-window-header">
          <span className="mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            Cyber
          </span>
          <button type="button" className="cyber-window-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="cyber-window-body">
          <CyberPanel />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add cyber-window CSS**

Append to `global.css`:

```css
/* Cyber floating window */
.cyber-window-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 12px;
}

.cyber-window {
  width: min(640px, 90vw);
  max-height: 80vh;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  display: flex;
  flex-direction: column;
}

.cyber-window-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel-2);
  flex-shrink: 0;
}

.cyber-window-close {
  background: transparent;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  padding: 2px 6px;
}
.cyber-window-close:hover {
  color: var(--text);
}

.cyber-window-body {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/CyberWindow.tsx apps/web/src/styles/global.css
git commit -m "feat(web): implement CyberWindow floating overlay"
```

---

## Task 3: Remove static disclaimers from CyberPanel

**Files:**
- Modify: `apps/web/src/components/CyberPanel.tsx`

- [ ] **Step 1: Remove framing paragraph at top of CyberPanel**

In `CyberPanel.tsx`, delete the `<p>` element at line 134–137:

```tsx
// DELETE this block:
<p className="muted" style={{ marginTop: 0, fontSize: 11, lineHeight: 1.4 }}>
  {threats?.framing ??
    'Passwordless device identity + integrity: Ed25519 provenance, OSNMA ICD, audit chain.'}
</p>
```

- [ ] **Step 2: Remove OSNMA trailing disclaimer**

In the OSNMA section (around line 377), replace:

```tsx
{summary?.osnma.result?.reason ??
  'Data authentication only — not PVT proof. LIVE AIS stays unavailable.'}
```

With:

```tsx
{summary?.osnma.result?.reason ?? null}
```

- [ ] **Step 3: Remove RF trailing disclaimer**

In the RF lab section (around line 400), replace:

```tsx
{summary?.rf?.spoof_overlay
  ? `Overlay: ${summary.rf.spoof_overlay}`
  : summary?.rf?.reason ??
    'Dual-antenna lab IQ on full-stack Hist Lab vessel only — not LIVE AIS.'}
```

With:

```tsx
{summary?.rf?.spoof_overlay
  ? `Overlay: ${summary.rf.spoof_overlay}`
  : summary?.rf?.reason ?? null}
```

- [ ] **Step 4: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/CyberPanel.tsx
git commit -m "feat(web): remove static disclaimer text from CyberPanel"
```

---

## Task 4: Redesign TopBar — 3-zone grid layout

**Files:**
- Modify: `apps/web/src/components/TopBar.tsx`
- Modify: `apps/web/src/styles/global.css` (top-bar grid styles)

- [ ] **Step 1: Rewrite TopBar.tsx**

```tsx
// apps/web/src/components/TopBar.tsx
import { useStore } from '../lib/store';
import type { ViewMode } from '../lib/types';

const MODE_DESC: Record<ViewMode, string> = {
  live: 'LIVE AIS · Digitraffic',
  lab: 'HIST LAB · Recorded AIS',
  both: 'LIVE + HIST · Both feeds',
};

export function TopBar() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const setViewMode = useStore((s) => s.setViewMode);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);
  const alerts = snapshot?.alerts.filter((a) => a.severity !== 'info') ?? [];
  const mode = snapshot?.view_mode ?? 'both';

  return (
    <header className="top-bar">
      {/* Left zone */}
      <div className="top-left">
        <div className="brand">
          <div className="brand-mark">NORTHSTAR</div>
          <div className="brand-sub">Integrity</div>
        </div>
        <div className="mode-badge">{snapshot?.monitoring_label ?? 'CONNECTING'}</div>
      </div>

      {/* Center zone — anchored instruments */}
      <div className="instruments">
        <div className="instrument">
          <div className="label">HDG</div>
          <div className="value">
            {vessel?.heading_deg != null ? vessel.heading_deg.toFixed(1) : '—'}°
          </div>
          <div className="src">GYRO / DR</div>
        </div>
        <div className="instrument">
          <div className="label">COG</div>
          <div className="value">
            {vessel?.course_over_ground_deg != null
              ? vessel.course_over_ground_deg.toFixed(1)
              : '—'}
            °
          </div>
          <div className="src">GNSS</div>
        </div>
        <div className="instrument">
          <div className="label">SOG</div>
          <div className="value">
            {vessel?.speed_over_ground_knots != null
              ? vessel.speed_over_ground_knots.toFixed(1)
              : '—'}{' '}
            kn
          </div>
          <div className="src">GNSS</div>
        </div>
        <div className="instrument">
          <div className="label">TRUST</div>
          <div className="value">{vessel?.trust.trust_score ?? '—'}</div>
          <div className="src">{vessel?.trust.trust_band?.toUpperCase() ?? ''}</div>
        </div>
      </div>

      {/* Right zone */}
      <div className="top-right">
        <div className="view-toggle" title="Switch between live and historical lab feeds">
          {(['live', 'both', 'lab'] as ViewMode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? 'active' : ''}
              onClick={() => void setViewMode(m)}
            >
              {m === 'live' ? 'Live' : m === 'lab' ? 'Hist Lab' : 'Both'}
            </button>
          ))}
        </div>
        <div className="mode-desc">{MODE_DESC[mode]}</div>
        <div
          className={`alert-tri ${alerts.length ? '' : 'quiet'}`}
          title={`${alerts.length} alerts`}
        >
          ⚠
        </div>
        <div className="mono muted" style={{ fontSize: 11 }}>
          {snapshot?.sim_time?.slice(11, 19) ?? '--:--:--'} UTC
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Update top-bar CSS**

In `global.css`, replace the `.top-bar` rule and add `.top-left` / `.mode-desc`:

Replace:
```css
.top-bar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 14px;
  background: linear-gradient(180deg, #141d26 0%, #0e151c 100%);
}
```

With:
```css
.top-bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding: 0 14px;
  background: linear-gradient(180deg, #141d26 0%, #0e151c 100%);
}

.top-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
```

Replace the existing `.instruments` rule:
```css
.instruments {
  display: flex;
  gap: 16px;
}
```
(Remove `flex: 1` — it was stretching the instruments; now they're in the auto center column.)

Replace the existing `.top-right` rule:
```css
.top-right {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: flex-end;
}
```
(Remove `margin-left: auto` — no longer needed with grid layout.)

Add after `.top-right`:
```css
.mode-desc {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}
```

Also delete the `.live-pill` and `.feed-leds` / `.led` rules — they are no longer used in TopBar. (The `.led` rule will be reused in the Events tab feed-status row in Task 6, so keep `.led` and its variants, only delete `.live-pill`.)

- [ ] **Step 3: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/TopBar.tsx apps/web/src/styles/global.css
git commit -m "feat(web): redesign TopBar with 3-zone grid layout, remove live pill and feed LEDs"
```

---

## Task 5: Redesign LeftPanel — fleet overview + vessel detail

**Files:**
- Modify: `apps/web/src/components/LeftPanel.tsx`
- Modify: `apps/web/src/styles/global.css` (vessel-list, vessel-detail styles)

- [ ] **Step 1: Rewrite LeftPanel.tsx**

```tsx
// apps/web/src/components/LeftPanel.tsx
import { useStore } from '../lib/store';

export function LeftPanel() {
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const vessels = snapshot?.vessels ?? [];
  const m = snapshot?.metrics;
  const live = snapshot?.live;

  const vessel = vessels.find((v) => v.entity_id === selectedId);

  const sortedVessels = [...vessels].sort(
    (a, b) => (a.trust.trust_score ?? 100) - (b.trust.trust_score ?? 100),
  );

  const clearSelection = () => useStore.setState({ selectedId: null });

  return (
    <aside className="panel">
      <div className="panel-title">Fleet</div>
      <div className="metrics">
        <div className="metric-card">
          <div className="n">{m?.vessels_monitored ?? 0}</div>
          <div className="l">Monitored</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--suspicious)' }}>
            {m?.high_risk_vessels ?? 0}
          </div>
          <div className="l">High Risk</div>
        </div>
        <div className="metric-card">
          <div className="n" style={{ color: 'var(--danger)' }}>
            {m?.active_alerts ?? 0}
          </div>
          <div className="l">Alerts</div>
        </div>
        <div className="metric-card">
          <div className="n">{m?.average_evidence_coverage?.toFixed(0) ?? 0}%</div>
          <div className="l">Avg Coverage</div>
        </div>
        <div className="metric-card">
          <div className="n">{live?.vessel_count ?? 0}</div>
          <div className="l">Live Ships</div>
        </div>
      </div>

      <div className="vessel-list">
        {sortedVessels.map((v) => (
          <button
            key={v.entity_id}
            type="button"
            className={`live-row${selectedId === v.entity_id ? ' active' : ''}`}
            onClick={() => useStore.getState().selectVessel(v.entity_id)}
          >
            <span className="name">{v.name ?? v.entity_id}</span>
            <span className={`band ${v.trust.trust_band}`}>{v.trust.trust_score}</span>
          </button>
        ))}
      </div>

      {vessel && (
        <div className="vessel-detail">
          <div className="panel-title vessel-detail-header">
            <span>Selected vessel</span>
            <button type="button" className="clear-sel" onClick={clearSelection}>
              ✕
            </button>
          </div>
          <div className="gauge-wrap">
            <div className="trust-gauge">
              <div className={`trust-score ${vessel.trust.trust_band}`}>
                {vessel.trust.trust_score}
              </div>
              <div className="band-label">{vessel.trust.trust_band}</div>
            </div>
            {vessel.origin && (
              <div className={`origin-tag ${vessel.origin}`} style={{ marginTop: 8 }}>
                {vessel.origin === 'live' ? 'LIVE AIS' : 'HIST LAB'}
              </div>
            )}
            <div className="coverage-bar" style={{ marginTop: 8 }}>
              <span style={{ width: `${vessel.trust.evidence_coverage ?? 0}%` }} />
            </div>
            <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
              {vessel.trust.evidence_coverage.toFixed(0)}% ·{' '}
              {vessel.trust.available_checks}/{vessel.trust.expected_checks} checks
            </div>
          </div>
          <div className="kv" style={{ padding: '0 12px 10px' }}>
            <div className="k">Name</div>
            <div className="v">{vessel.name ?? '—'}</div>
            <div className="k">Class</div>
            <div className="v">{vessel.vessel_class ?? '—'}</div>
            <div className="k">Position</div>
            <div className="v">
              {vessel.position.lat.toFixed(5)} N, {vessel.position.lon.toFixed(5)} E
            </div>
            <div className="k">Updated</div>
            <div className="v">{vessel.last_update}</div>
          </div>
          {vessel.trust.explanation && (
            <div className="explain" style={{ margin: '0 12px 10px' }}>
              {vessel.trust.explanation}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Add vessel-list and vessel-detail CSS**

Append to `global.css`:

```css
/* Left panel vessel list */
.vessel-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 10px;
  max-height: 220px;
  overflow-y: auto;
}

/* Selected vessel detail section */
.vessel-detail {
  border-top: 1px solid var(--border);
}

.vessel-detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.clear-sel {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  padding: 0 4px;
  line-height: 1;
}
.clear-sel:hover {
  color: var(--text);
}
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/LeftPanel.tsx apps/web/src/styles/global.css
git commit -m "feat(web): redesign LeftPanel with fleet metrics, sorted vessel list, and vessel detail section"
```

---

## Task 6: Redesign RightPanel — Events / Evidence / Sources

**Files:**
- Modify: `apps/web/src/components/RightPanel.tsx`
- Modify: `apps/web/src/styles/global.css` (event-log styles)

- [ ] **Step 1: Rewrite RightPanel.tsx**

```tsx
// apps/web/src/components/RightPanel.tsx
import { useState } from 'react';
import { useStore } from '../lib/store';

export function RightPanel() {
  const [tab, setTab] = useState<'events' | 'evidence' | 'sources'>('events');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const snapshot = useStore((s) => s.snapshot);
  const selectedId = useStore((s) => s.selectedId);
  const vessel = snapshot?.vessels?.find((v) => v.entity_id === selectedId);
  const events = [...(snapshot?.timeline ?? [])].reverse();

  return (
    <aside className="panel right">
      <div className="tabs">
        <button
          className={tab === 'events' ? 'active' : ''}
          onClick={() => setTab('events')}
        >
          Events
        </button>
        <button
          className={tab === 'evidence' ? 'active' : ''}
          onClick={() => setTab('evidence')}
        >
          Evidence
        </button>
        <button
          className={tab === 'sources' ? 'active' : ''}
          onClick={() => setTab('sources')}
        >
          Sources
        </button>
      </div>

      {tab === 'events' && (
        <div className="tab-body" style={{ padding: 0 }}>
          {/* Feed health row */}
          {snapshot?.feed_health && Object.keys(snapshot.feed_health).length > 0 && (
            <div className="feed-status-row">
              {Object.entries(snapshot.feed_health).map(([k, v]) => (
                <div key={k} className="feed-status-item">
                  <span className={`led ${v}`} />
                  <span>{k}</span>
                </div>
              ))}
            </div>
          )}
          {/* Event log */}
          <div className="event-log">
            {events.length === 0 && (
              <div className="muted" style={{ padding: 12, fontSize: 12 }}>
                No events yet — run a scenario or wait for anomalies.
              </div>
            )}
            {events.map((e) => {
              const isExpanded = expandedEventId === e.id;
              return (
                <div
                  key={e.id}
                  className={`event-row ${e.severity}${isExpanded ? ' expanded' : ''}`}
                  onClick={() => setExpandedEventId(isExpanded ? null : e.id)}
                >
                  <div className="event-row-main">
                    <span className={`event-dot ${e.severity}`} />
                    <span className="event-time mono">{e.observed_at.slice(11, 19)}</span>
                    <span className="event-vessel">{e.entity_id}</span>
                    <span className="event-title">{e.title}</span>
                    {e.trust_score_before != null && e.trust_score_after != null && (
                      <span className="event-delta mono">
                        {e.trust_score_before}→{e.trust_score_after}
                      </span>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="event-row-detail">
                      <div style={{ fontSize: 12, lineHeight: 1.4 }}>{e.explanation}</div>
                      {e.check_ids.length > 0 && (
                        <div className="muted mono" style={{ fontSize: 10, marginTop: 4 }}>
                          checks: {e.check_ids.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {tab === 'evidence' && (
        <div className="tab-body">
          {(vessel?.trust.checks ?? []).map((c) => {
            const ev = (c.evidence ?? {}) as Record<string, unknown>;
            const scenarioInjected =
              !!ev.spoof_overlay ||
              ev.fixture === true ||
              (ev.labels as { fixture?: boolean } | undefined)?.fixture === true ||
              /spoof_overlay|scenario|fixture|Simulated|Protocol verification demo/i.test(
                c.explanation,
              );
            const dataBadge =
              c.status === 'unavailable' || c.status === 'unsupported'
                ? null
                : scenarioInjected
                  ? 'scenario-injected'
                  : 'detected from data';
            const mode =
              c.check_id === 'rf_lab' || c.check_id === 'spatial_aoa'
                ? c.status === 'unavailable'
                  ? 'No lab RF'
                  : 'Lab IQ / AoA'
                : (c.source_ids ?? []).some((s) => /simulat|fixture|demo/i.test(s)) ||
                    /\[Simulated|Protocol verification demo/i.test(c.explanation)
                  ? c.check_id === 'osnma'
                    ? 'Protocol demo'
                    : 'Simulated'
                  : c.status === 'unavailable' || c.status === 'unsupported'
                    ? 'No live input'
                    : 'Live path';
            const fcHz = typeof ev.center_freq_hz === 'number' ? ev.center_freq_hz : null;
            return (
              <div key={c.check_id} className="evidence-row">
                <div className="head">
                  <strong className="mono">{c.check_id}</strong>
                  <span className={`status-pill ${c.status}`}>{c.status}</span>
                </div>
                <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
                  mode: {mode}
                  {dataBadge ? (
                    <>
                      {' · '}
                      <span
                        style={{
                          color:
                            dataBadge === 'detected from data'
                              ? 'var(--ok)'
                              : 'var(--warn)',
                        }}
                      >
                        {dataBadge}
                      </span>
                    </>
                  ) : null}
                  {fcHz != null ? ` · fc ${(fcHz / 1e6).toFixed(3)} MHz` : ''}
                </div>
                <div style={{ fontSize: 12, lineHeight: 1.35 }}>{c.explanation}</div>
                <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                  anomaly={c.anomaly_score ?? 'n/a'} · q={(c.quality ?? 0).toFixed(2)} ·
                  fresh={(c.freshness ?? 0).toFixed(2)} ·
                  src={(c.source_ids ?? []).join(',') || '—'}
                  {c.missing_reason ? ` · missing: ${c.missing_reason}` : ''}
                  {c.hard_alert ? ' · HARD' : ''}
                </div>
              </div>
            );
          })}
          {!vessel && (
            <p className="muted" style={{ marginTop: 0 }}>
              Select a vessel to inspect evidence layers.
            </p>
          )}
        </div>
      )}

      {tab === 'sources' && (
        <div className="tab-body">
          {/* Full-stack Lab vessel */}
          {(() => {
            const fullstackId =
              snapshot?.lab?.fullstack_entity_id ?? snapshot?.lab?.signed_entity_id;
            const fullstackVessel = snapshot?.vessels?.find(
              (v) => v.entity_id === fullstackId,
            );
            return (
              <div className={`live-card${fullstackId ? ' ok' : ''}`}>
                <div className="live-card-head">
                  <strong>Full-stack Lab vessel</strong>
                  <span className="origin-tag lab">RF+AoA</span>
                </div>
                {fullstackId && fullstackVessel && (
                  <button
                    type="button"
                    className="live-row"
                    style={{ marginTop: 8, width: '100%' }}
                    onClick={() => useStore.getState().selectVessel(fullstackId)}
                  >
                    <span className="name">{fullstackVessel.name ?? fullstackId}</span>
                    <span className={`band ${fullstackVessel.trust.trust_band}`}>
                      {fullstackVessel.trust.trust_score}
                    </span>
                  </button>
                )}
              </div>
            );
          })()}

          {/* Hist Lab */}
          <div
            className={`live-card${snapshot?.lab?.mode === 'historical_replay' ? ' ok' : ''}`}
            style={{ marginTop: 8 }}
          >
            <div className="live-card-head">
              <strong>
                {snapshot?.lab?.mode === 'historical_replay'
                  ? 'Digitraffic replay'
                  : snapshot?.lab?.mode === 'synthetic_fallback'
                    ? 'Synthetic fallback'
                    : 'Lab starting…'}
              </strong>
              <span className="mono">{snapshot?.lab?.vessel_count ?? 0} ships</span>
            </div>
            {snapshot?.lab?.osnma_protocol_status && (
              <div
                className={`origin-tag${snapshot.lab.osnma_protocol_status === 'authenticated' ? ' live' : ' lab'}`}
                style={{ marginTop: 8 }}
              >
                OSNMA:{' '}
                {snapshot.lab.osnma_protocol_status === 'authenticated'
                  ? 'ICD demo'
                  : snapshot.lab.osnma_protocol_status}
              </div>
            )}
          </div>

          {/* Live AIS */}
          {(() => {
            const live = snapshot?.live;
            const liveOk =
              live?.digitraffic.status === 'ok' || live?.digitraffic.status === 'degraded';
            return (
              <div className={`live-card${liveOk ? ' ok' : ''}`} style={{ marginTop: 8 }}>
                <div className="live-card-head">
                  <strong>
                    {liveOk ? 'Live AIS' : live?.digitraffic.status ?? 'Starting…'}
                  </strong>
                  <span className="mono">{live?.vessel_count ?? 0} ships</span>
                </div>
                {live?.digitraffic.last_updated && (
                  <div className="mono muted" style={{ fontSize: 10, marginTop: 6 }}>
                    Updated {live.digitraffic.last_updated}
                  </div>
                )}
                {live?.digitraffic.last_error && (
                  <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                    {live.digitraffic.last_error}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 2: Add event-log and feed-status CSS**

Append to `global.css`:

```css
/* Event log (right panel Events tab) */
.event-log {
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  flex: 1;
}

.event-row {
  border-bottom: 1px solid var(--border-soft);
  padding: 6px 10px;
  cursor: pointer;
}
.event-row:hover {
  background: var(--bg-panel-2);
}
.event-row.expanded {
  background: var(--bg-elevated);
}

.event-row-main {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
}

.event-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.event-dot.critical { background: var(--danger); }
.event-dot.warning  { background: var(--warn); }
.event-dot.info     { background: var(--instrument); }

.event-time {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.event-vessel {
  font-size: 10px;
  color: var(--text-dim);
  flex-shrink: 0;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-delta {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.event-row-detail {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-soft);
}

/* Feed health status row */
.feed-status-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-panel-2);
}

.feed-status-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
```

- [ ] **Step 3: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/RightPanel.tsx apps/web/src/styles/global.css
git commit -m "feat(web): redesign RightPanel with Events/Evidence/Sources tabs and vertical event log"
```

---

## Task 7: Delete Timeline.tsx + CSS cleanup

**Files:**
- Delete: `apps/web/src/components/Timeline.tsx`
- Modify: `apps/web/src/styles/global.css` (remove dead `.disclaimer`, `.live-pill` rules)

- [ ] **Step 1: Delete Timeline.tsx**

```bash
git rm apps/web/src/components/Timeline.tsx
```

- [ ] **Step 2: Remove dead CSS rules from global.css**

Delete the following CSS blocks that are no longer referenced by any component:

- `.disclaimer { ... }` (the grey footer disclaimer style)
- `.live-pill { ... }` and `.live-pill.on` / `.live-pill.off` (removed from TopBar)
- `.timeline { ... }`, `.timeline-item { ... }` and all `.timeline-item.*` variants
- `.scenario-list { ... }`, `.scenario-list button { ... }` variants (replaced by `.scenario-btn`)

Leave `.led` and its variants (`.led.ok`, `.led.demo`, etc.) — still used by the feed-status-row in the Events tab.

- [ ] **Step 3: Full build**

```
npm run build -w @northstar/web
```

Expected: clean build, no unused import warnings for Timeline.

- [ ] **Step 4: Typecheck**

```
npm run typecheck -w @northstar/web
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/global.css
git commit -m "chore(web): delete Timeline component and remove dead CSS rules"
```

---

## Self-Review Checklist

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| Top bar 3-zone grid, remove live pill/feed LEDs/WS/POLL | Task 4 |
| Left panel: 5 fleet metrics (Monitored/High Risk/Alerts/Avg Coverage/Live Ships) | Task 5 |
| Left panel: vessel list sorted worst-first | Task 5 |
| Left panel: vessel detail on selection (trust gauge, coverage bar, KV, explanation) | Task 5 |
| Left panel: remove data-source cards + disclaimer | Task 5 |
| Right panel: Events tab default, feed health row, compact vertical event log | Task 6 |
| Right panel: Evidence tab, remove disclaimer paragraph | Task 6 |
| Right panel: Sources tab with data-source cards | Task 6 |
| Remove Vessel/Cyber/Scenarios tabs from right panel | Task 6 |
| Bottom bar: scenario buttons + Reset + Cyber trigger | Task 1 |
| Cyber floating window | Task 2 |
| CyberPanel: remove 3 static disclaimer strings | Task 3 |
| Timeline deleted | Task 7 |
| Timeline disclaimer removed | Task 7 (file deleted) |

All spec requirements covered. No gaps.

**Type consistency:** `useStore.setState({ selectedId: null })` is valid — `selectedId: string | null` in the store interface. `clearSelection` in LeftPanel uses this directly. Consistent across Tasks 1–7.

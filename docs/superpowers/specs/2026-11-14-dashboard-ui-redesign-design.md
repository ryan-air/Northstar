# Dashboard UI Redesign

**Date:** 2026-11-14  
**Scope:** Static UI components only — `apps/web/src`. Backend explanation-string cleanup is tracked separately.  
**Audience:** Cybersecurity professionals. Not naval navigation specialists.

---

## Goals

- Surface the trust score immediately without scrolling.
- Remove all static disclaimer/hedging text from the UI.
- Separate read (info) surfaces from write (control) surfaces.
- Eliminate layout instability caused by variable-length text in the top bar.

---

## Top Bar (`TopBar.tsx`)

### Layout

Replace the current single flex row with a **three-zone CSS grid** (`1fr auto 1fr`):

| Zone | Content |
|------|---------|
| Left (`1fr`) | NORTHSTAR brand + SIMULATION mode badge |
| Center (`auto`) | HDG / COG / SOG / TRUST instruments |
| Right (`1fr`) | View toggle (Live / Both / Hist Lab) → active-mode description → alert triangle → sim time UTC |

The center zone is anchored — instruments never shift regardless of text length in the left or right zones. The active-mode description is the only variable-length element and expands rightward into free space.

### Removals

- Live ship count pill (`LIVE 42` / `LIVE OFF`) — count moves to left panel fleet metrics; connection status moves to Sources tab.
- Feed health LEDs — move to Events tab as a small labeled status row.
- WS/POLL indicator — remove entirely.

---

## Left Panel (`LeftPanel.tsx`)

### Fleet section (always visible)

Five metric cards in a row:

| Card | Value |
|------|-------|
| Monitored | total vessel count |
| High Risk | vessels in suspicious/critical band |
| Active Alerts | active hard alerts |
| Avg Coverage | average evidence coverage % |
| Live Ships | count from `live.vessel_count` |

Below the metrics: vessel list, sorted worst-trust-first. Each row: vessel name + trust score badge, colored by trust band. Click to select.

### Vessel section (visible when a vessel is selected)

Appears below the fleet section on selection:

- Large trust score gauge + band label.
- Evidence coverage bar + `9/13 checks` qualifier (kept — factual, not a disclaimer).
- KV rows: Name, Class, Position, Last Updated.
- One-line trust explanation from the engine (static framing text around it removed — see Disclaimer Removals).
- Clear-selection affordance to collapse back to fleet-only.

### Removals

- "Full-stack Lab vessel" status card.
- "Hist Lab" status card.
- "Live AIS" status card (all three move to Sources tab in right panel).
- Static paragraph: *"Trust is a prototype integrity estimate (0–100), not a probability that the position is genuine. Live AIS still lacks RF/OSNMA/IMU evidence layers."*

---

## Right Panel (`RightPanel.tsx`)

Three tabs. **Events is the default tab.**

### Events tab (default)

- Small feed health status row at top: one labeled dot per feed key from `snapshot.feed_health`. Replaces the top bar LEDs.
- Vertical scrolling list of compact event rows:
  - Severity color dot
  - Timestamp (`HH:MM:SS`)
  - Vessel name
  - Event title
  - Trust delta (`87→42`)
  - No explanation text visible in the collapsed row.
- Clicking a row expands it inline to show explanation + triggered check IDs.

### Evidence tab

Current Evidence tab content, with one change:

- Remove static paragraph at top: *"Full-stack Lab vessel includes dual-ant lab AoA. LIVE ships stay RF-unavailable. Look for Simulated / Protocol demo / Lab IQ labels — never treat those as Digitraffic RF."*
- Show "Select a vessel to inspect evidence layers." prompt if nothing selected (already present, keep it).

### Sources tab

The three data-source status cards moved from the left panel:

- Full-stack Lab vessel card
- Hist Lab card
- Live AIS card (including connection status that was in the removed live pill)

### Removals

- Vessel tab — content moves to left panel vessel section.
- Cyber tab — moves to floating window.
- Scenarios tab — moves to bottom bar.

---

## Bottom Bar (replaces `Timeline.tsx` footer)

Full-width row of scenario controls + entry point for the cyber window.

### Layout

- Far left: **"Cyber ↑"** button — opens the cyber floating window.
- Center: scenario buttons, each showing a short label. One-line hint visible on hover. Grouped loosely: navigation scenarios, then attack scenarios.
- Far right: **Reset** button, visually separated (e.g. muted border or spacing gap).

### Event log

The event log moves to the Events tab in the right panel (see above). The bottom bar no longer contains a timeline strip.

### Removals

- Timeline strip and all its event cards.
- Static disclaimer: *"Northstar estimates position integrity from cryptographic provenance, physical consistency, and independent observations. It is not a sole basis for navigation or collision avoidance. OSNMA (when shown) authenticates navigation data, not the PVT solution. AIS is not end-to-end authenticated."*
- `selectedEvent` detail bar that rendered below the timeline.

---

## Cyber Floating Window (new component `CyberWindow.tsx`)

Triggered by the "Cyber ↑" button in the bottom bar. Renders as a fixed-position overlay panel (slides up from the bottom bar or appears as a centered modal — implementation detail). Closeable.

### Content (from current `CyberPanel.tsx`)

- Action buttons: OSNMA ICD verify, OSNMA MAC fail, Tamper demo, Replay demo, Rotate key, Revoke, Issue challenge, Send without challenge, Verify audit, Export JSON, RF AoA nominal, RF AoA spoof cluster.
- JCS payload hash display.
- Devices list.
- OSNMA status section.
- RF lab / AoA status section.
- Audit chain status.
- Forensics / recent events list.
- Threat model adversary cards.
- Real-AIS eval metrics (confusion matrix row).

### Removals

- Static framing paragraph at top: *"Passwordless device identity + integrity: Ed25519 provenance, OSNMA ICD, audit chain."*
- OSNMA trailing line: *"Data authentication only — not PVT proof. LIVE AIS stays unavailable."*
- RF trailing line: *"Dual-antenna lab IQ on full-stack Hist Lab vessel only — not LIVE AIS."*

---

## Disclaimer Removals — Complete List (static UI only)

| Location | Text removed |
|----------|--------------|
| `LeftPanel.tsx` | *"Trust is a prototype integrity estimate (0–100), not a probability that the position is genuine. Live AIS still lacks RF/OSNMA/IMU evidence layers."* |
| `Timeline.tsx` | *"Northstar estimates position integrity from cryptographic provenance, physical consistency, and independent observations…"* (full paragraph) |
| `RightPanel.tsx` — Evidence tab | *"Full-stack Lab vessel includes dual-ant lab AoA. LIVE ships stay RF-unavailable…"* |
| `RightPanel.tsx` — Scenarios tab | *"Attack overlays on Digitraffic historical AIS replay (or synthetic fallback)…"* |
| `CyberPanel.tsx` — top | *"Passwordless device identity + integrity: Ed25519 provenance, OSNMA ICD, audit chain."* (uses `threats.framing`) |
| `CyberPanel.tsx` — OSNMA | *"Data authentication only — not PVT proof. LIVE AIS stays unavailable."* |
| `CyberPanel.tsx` — RF | *"Dual-antenna lab IQ on full-stack Hist Lab vessel only — not LIVE AIS."* |

---

## Files Changed

| File | Change |
|------|--------|
| `apps/web/src/components/TopBar.tsx` | Grid layout, remove live pill + feed LEDs + WS/POLL |
| `apps/web/src/components/LeftPanel.tsx` | Fleet metrics (5 cards) + vessel section on selection, remove data-source cards + disclaimer |
| `apps/web/src/components/RightPanel.tsx` | Events default tab + Evidence + Sources; remove Vessel/Cyber/Scenarios tabs |
| `apps/web/src/components/Timeline.tsx` | Remove entirely (bottom bar + event log split across new locations) |
| `apps/web/src/components/CyberPanel.tsx` | Extract into `CyberWindow.tsx`, remove framing disclaimers |
| `apps/web/src/App.tsx` | Wire bottom bar + cyber window, remove `<Timeline />` |
| `apps/web/src/components/CyberWindow.tsx` | New file — floating overlay wrapping cyber panel content |

---

## Out of Scope

- Backend explanation-string cleanup (tracked separately).
- CSS/styling specifics beyond layout structure described here.
- Any changes to data fetching, WebSocket logic, or store shape.

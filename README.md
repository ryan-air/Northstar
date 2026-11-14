# Northstar

**One-line pitch:** Northstar is a real-time trust engine for navigation data. It combines cryptographic authentication, sensor and trajectory consistency, and independent observations to identify suspicious positions and explain exactly why they should not be trusted.

> Not a certified navigation, safety, or collision-avoidance system. Trust scores are heuristic integrity estimates — **not** probabilities that a position is genuine.

## Stack

- **Monorepo (npm workspaces):** TypeScript
- **Backend:** Fastify + WebSocket (`apps/server`)
- **Frontend:** React + Vite + MapLibre (`apps/web`) — ECDIS-inspired dark ops console
- **Device gateway sim:** Ed25519 signed telemetry (`apps/device-sim`)
- **Core:** detection, fusion, crypto (`packages/core`) + Zod contracts (`packages/contracts`)
- **OSNMA sidecar:** Python OSNMAlib protocol-verification demo (`sidecars/osnma`)

Demo region: **Gulf of Finland** (simulation-labelled fixtures).

## Quick start

```bash
npm install
npm run build -w @northstar/contracts && npm run build -w @northstar/core
npm run gen-certs   # optional TLS material into ./certs (gitignored)
cp .env.example .env

# optional — dual-ant lab IQ / AoA (requires local capture01.sink.gz)
python3 -m venv sidecars/rf/.venv && sidecars/rf/.venv/bin/pip install -r sidecars/rf/requirements.txt
python3 scripts/rf_extract_clip.py --seconds 0.5
sidecars/rf/.venv/bin/python sidecars/rf/analyze_aoa.py

# terminal 1 — API + simulator (creates local .northstar/shore keys on first run)
npm run dev -w @northstar/server

# terminal 2 — dashboard
npm run dev -w @northstar/web

# terminal 3 — signed device telemetry (generates .northstar/keys + enrols public key)
npm run dev -w @northstar/device-sim
```

Shore + device **private** keys live under `.northstar/` (gitignored). Committed fixtures ship empty so every clone can generate its own keys. If you see `Revocation shore_sig invalid` or `device_already_enrolled` after pulling someone else’s local state, reset:

```bash
printf '' > data/fixtures/revocation.jsonl
rm -f data/fixtures/revocation.jsonl.head.json data/fixtures/audit.checkpoint.json
printf '' > data/fixtures/audit.jsonl
echo '[]' > data/fixtures/devices.json
# optional: rm -rf .northstar   # only if you want brand-new local keys
```

**Both view:** live Digitraffic (partial coverage) + Hist Lab. One **FULL-STACK** Lab vessel carries crypto + OSNMA ICD + dual-antenna AoA. Raw `*.sink.gz` is gitignored.

Open http://127.0.0.1:5173

## Demo (≈3 minutes)

See [DEMO_SCRIPT.md](DEMO_SCRIPT.md). Short version:

1. Confirm **SIMULATION** badge and healthy fleet trust.
2. Run **Sudden spoof / teleport** — inland jump, trust drop, evidence on kinematics + geographic.
3. **Reset**, then **Gradual drift**.
4. **Signed telemetry tamper** and **Replayed signed message** (device-sim must be running).
5. Inspect OSNMA / IMU / GNSS rows — labelled demo/simulated/unavailable as appropriate.

## Tests

```bash
npm test
npm run eval
npm run typecheck
npm run build
npm run check-tiles   # optional map tile reachability
```

## Security posture

See [THREAT_MODEL.md](THREAT_MODEL.md) for adversaries, controls, and known limitations.

- Rejected / forged telemetry never updates vessel tracks (forensics only).
- Devices are bound to a single `entity_id` and key; challenge nonces require a signed request.
- Device-sim signs an independent onboard track, compared to AIS via `signed_vs_ais`.
- Admin routes require `Authorization: Bearer $NORTHSTAR_ADMIN_TOKEN` (demo default `northstar-demo-admin`).

```bash
npm run attacker          # live probes (PASS = attack rejected)
npm run eval:real         # FP/FN on recorded AIS → data/fixtures/eval_metrics.json
```

## Documentation

| Doc | Purpose |
|-----|---------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module boundaries & data flow |
| [SECURITY.md](SECURITY.md) | Threat model, keys, claims |
| [TESTING.md](TESTING.md) | Scenarios & evaluation |
| [DECISIONS.md](DECISIONS.md) | Confirmed choices |
| [BLOCKERS.md](BLOCKERS.md) | Missing hardware / credentials |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | Phase status |
| [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | Judge-facing demo |
| [COMPARISON.md](COMPARISON.md) | Vs AIM+/A-Shield/DIDI — honest capability matrix |
| [SECURITY_DESIGN.md](SECURITY_DESIGN.md) | Assets, adversaries, controls, residual risk |
| [HARDWARE_KEYS.md](HARDWARE_KEYS.md) | SoftHSM / YubiKey PKCS#11 device signing |

## Live + Hist Lab (Digitraffic)

On startup the server:

1. **Live** — polls Fintraffic Digitraffic AIS (`LIVE-*`)
2. **Hist Lab** — replays recorded Digitraffic AIS from `data/replay/gof_ais.jsonl` (`LAB-*`), and keeps appending new samples every 15s

Digitraffic’s REST `from`/`to` only returns the *latest* fix per ship, so multi-point history is built by recording. A seed capture is committed under `data/replay/`.

Top-bar toggle:

- **Live** — real-time Digitraffic only  
- **Hist Lab** — recorded Digitraffic replay + attack overlays  
- **Both** — cyan live rings + amber hist lab  

**Cyber tab** (right panel): OSNMAlib ICD verify, rotate/revoke + shore-signed CRL, **required** challenge nonce, audit chain + shore checkpoint, optional mTLS device plane, SoftHSM/YubiKey PKCS#11 (`HARDWARE_KEYS.md`).

```bash
npm run setup:osnma   # once — clones Algafix/OSNMA + venv
npm run dev           # starts server, web, device-sim, OSNMA sidecar
```

OSNMA = real ICD test-vector crypto (TESLA/MAC). GNSS/IMU still fixtures. Device Ed25519 is signed over the historical Digitraffic target.

Optional second live feed: `AISSTREAM_API_KEY` (aisstream.io).

## Correct claims

- Detects **evidence consistent with** spoofing / jamming-like degradation.
- Verifies **provenance and integrity** of signed device telemetry (Ed25519).
- Authenticates supported Galileo **navigation-message data** when OSNMA evidence exists (demo path is labelled; live = not connected).
- Estimates **position integrity** from multiple sources with separate **evidence coverage**.

Does **not** claim: every GNSS fix is cryptographically authenticated; OSNMA proves PVT; ordinary AIS is end-to-end authenticated; trust score is a calibrated probability.

## License / data

Simplified coastline and port polygons are for demo integrity checks only — not ENC-grade. OpenSeaMap / Carto tiles used when reachable; offline GeoJSON fallback otherwise. Attribution: OpenStreetMap / Natural Earth / OpenSeaMap / CARTO as applicable.

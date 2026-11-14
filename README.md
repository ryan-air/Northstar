# Northstar

**Northstar is a real-time trust engine for maritime navigation data.** It checks whether a ship's reported position can be believed by combining trajectory physics, geography, independent sensors, cryptographically signed onboard telemetry and Galileo OSNMA, and it explains exactly which evidence agrees and which does not.

> Not a certified navigation, safety or collision-avoidance system. Trust scores are heuristic integrity estimates, **not** probabilities that a position is genuine.

## What you see

The dashboard has two views (top-right toggle):

| View | Ships | Purpose |
|---|---|---|
| **Live** | Real AIS traffic in the Gulf of Finland from Fintraffic Digitraffic's real-time stream | Shows how Northstar behaves on real, current traffic with only public AIS evidence |
| **Lab** | Recorded AIS traffic, three **simulated** ships, and one **lab vessel** with independent sensor recordings | Shows the full evidence stack and lets you run attacks |

**Lab vessel.** Its independent sensor recordings were **received from a lab at UIUC after we reached out on Friday**. They include GNSS receiver diagnostics, heading and speed-log data for GNSS-free dead reckoning, multi-element RF captures, independent radar observations, a second AIS network and an independent onboard receiver. The data is private: it is **not in this repository** and is loaded from a local, gitignored folder when present. Attestation and OSNMA inputs for this vessel are synthetic and are labelled as such everywhere.

**Attacks only ever hit simulated ships.** Every attack button injects into one of the three simulated ships. Recorded and live ships never receive injected data, and the API redirects any attempt (`target` / `retargeted_from` in the response).

### Panels

- **Left:** fleet metrics, the selected vessel (trust score, origin tag, verified coverage), lab-vessel events with *Jump* buttons, and the vessel list.
- **Map:** trust-coloured markers, tracks (muted for normal traffic, coloured for suspicious or critical), and a ring on the selected vessel.
- **Right, Events:** trust changes and alerts, including clock-driven alerts that need no position report (receiver jamming, receiver spoofing flag, AIS silent while radar still tracks the vessel).
- **Right, Evidence:** every check for the selected vessel with its status and where its evidence comes from (`recorded`, `live`, `simulated`, `synthetic`). Layers a ship type can never have are hidden.
- **Right, Security:** verify the tamper-evident audit chain, inspect device identity, run a freshness test (a signed message without the one-time challenge must be rejected), and review recent security events and controls.
- **Bottom:** navigation attacks (spoof, drift, AIS conflict, GNSS jam, IMU disagreement), security attacks (signature tamper, replay, clock skew, OSNMA, RF spoof), *Normal* to stop an attack, and *Reset Lab* to rewind the Lab.

## Checks (evidence layers)

| Layer | What it compares |
|---|---|
| Kinematics | Reported motion vs physics (jumps, speed, turn rate, slow drift) |
| Geographic | Position vs coastline, ports and restricted areas |
| Independent observation | Position vs independent radar/SAR fixes of the same vessel, or nearby traffic |
| AIS cross-feed | Two AIS networks reporting the same vessel |
| GNSS receiver | Satellites, signal strength, AGC, receiver jamming/spoofing flags |
| Dead reckoning / IMU | Gyro heading + speed log (GNSS-free), anchored on independent fixes |
| Galileo OSNMA | Navigation-message authentication |
| Device signature | Ed25519 / ECDSA signature on onboard telemetry |
| Hardware attestation | Device key provenance |
| RF capture / Angle of arrival | Multi-antenna phase: real satellites arrive from many directions, a spoofer from one |
| Signed track vs AIS | Signed onboard position vs broadcast AIS |
| Fleet coherence | Area-wide unexplained displacement (many ships shifted at once) |
| Identity | MMSI format, country code, clones, static-data changes |

Each check carries an evidence class. **Verified coverage** counts only `live` and `recorded` evidence, so simulated or synthetic inputs never inflate it.

## Quick start

```bash
npm install
npm run build
npm run dev        # server, dashboard, signed-telemetry device simulator, OSNMA sidecar
```

Open http://127.0.0.1:5173 in your browser. Alternatively, run the components separately:

```bash
npm run dev -w @northstar/server
npm run dev -w @northstar/web
npm run dev -w @northstar/device-sim
```

**Without the private data** (any fresh clone), everything still runs: the Lab uses the built-in simulated fleet, Live uses real AIS, and the coastline falls back to simplified polygons (geographic alarms are then capped at *warning*). Team members with access place the private files in the same local, gitignored locations.

Private keys are generated locally under `.northstar/` (gitignored) on first run.

## Results

Measured numbers live in [EVALUATION.md](EVALUATION.md). In short:

- **Public AIS (held-out day):** 0.6% of ship reports flagged suspicious or worse; area spoofing ~98% detected; teleports 90–100%; the four hardest small attacks (100 m offsets, slow drift) remain weak from AIS alone.
- **Lab vessel:** during a real GNSS spoofing event in the recording, every spoofed report was flagged and independently confirmed by radar, GNSS-free dead reckoning, the receiver's own flags and an RF capture. A smooth fake track that AIS alone misses was caught on every report once the independent sensors were used. A second GNSS receiver on the same ship did **not** help: it was spoofed too.
- Single vessel, single recording window: a case study, not a statistical evaluation.

## Tests and tooling

```bash
npm test              # unit, integration and security tests
npm run typecheck
npm run fuzz          # seeded fuzzing of every untrusted-input boundary
npm run sbom          # CycloneDX software bill of materials
npm run attacker      # live probes against a running server (PASS = attack rejected)
npm run eval:pipeline # evaluation harness (needs the private evaluation snapshot)
npm run eval:gates    # fail if false-alarm or recall gates are crossed
```

CI runs build, typecheck, tests, fuzzing, `npm audit` and the SBOM; evaluation and lab-import steps run only where the private data is present.

## Configuration

| Variable | Purpose |
|---|---|
| `NORTHSTAR_ADMIN_TOKEN` | Admin bearer token (all scopes). Without it the demo token works only on a loopback bind; on a network address the server refuses to start. |
| `NORTHSTAR_ADMIN_TOKENS` | Scoped admin tokens: `name:scope+scope:token;…` (scenario, rf, osnma, audit, devices, demo) |
| `NORTHSTAR_WS_TOKEN` | Require a token on the dashboard WebSocket |
| `NORTHSTAR_TLS_ENABLED` / `NORTHSTAR_MTLS_ENABLED` | TLS / mutual-TLS device server; plain-HTTP telemetry is refused on network binds |
| `NORTHSTAR_LIVE_STREAM` | `false` to use the Digitraffic REST poll instead of the real-time stream |
| `NORTHSTAR_LAB_SIM_SHIPS` | Number of simulated attack-target ships in the Lab (default 3) |
| `NORTHSTAR_THRESHOLDS` / `NORTHSTAR_FUSION` | `v2` (default) or `v1` detection configs |
| `NORTHSTAR_DATA_DIR` | Runtime state (default `.northstar/data`) |
| `AISSTREAM_API_KEY` | Optional second live AIS feed |

## Documentation

| Doc | Purpose |
|---|---|
| [SECURITY.md](SECURITY.md) | Security controls, threat model, data handling |
| [EVALUATION.md](EVALUATION.md) | Measured false-alarm and detection rates |
| [THREAT_MODEL.md](THREAT_MODEL.md) | Adversaries, controls, limitations |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module boundaries and data flow |
| [DEMO_SCRIPT.md](DEMO_SCRIPT.md) | Judge-facing demo |
| [HARDWARE_KEYS.md](HARDWARE_KEYS.md) | SoftHSM / YubiKey PKCS#11 device signing |

## Stack

TypeScript monorepo (npm workspaces): Fastify + WebSocket server (`apps/server`), React + Vite + MapLibre dashboard (`apps/web`), signed-telemetry device simulator (`apps/device-sim`), detection/fusion/crypto core (`packages/core`), Zod contracts (`packages/contracts`), Python OSNMAlib sidecar (`sidecars/osnma`).

## What Northstar claims, and what it does not

- Detects **evidence consistent with** spoofing, jamming and data manipulation, and says which sources support it.
- Verifies **provenance and integrity** of signed device telemetry.
- Authenticates Galileo **navigation-message data** where OSNMA evidence exists (the lab vessel's OSNMA inputs are synthetic and labelled).

It does **not** claim that every GNSS fix is authenticated, that OSNMA proves the position, that public AIS is authenticated, or that the trust score is a calibrated probability.

## Data and attribution

Live AIS: Fintraffic / Digitraffic (CC BY 4.0). Map tiles: OpenStreetMap contributors, CARTO, OpenSeaMap. Lab vessel sensor data: received from a lab at UIUC; private and not redistributed.

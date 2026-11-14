# Northstar — Architecture

## Layout

```
packages/contracts   Zod schemas & shared types
packages/core        Pure detection, fusion, geo, crypto
apps/server          Fastify API, simulator, adapters, registry, audit log
apps/web             MapLibre ECDIS-style console
apps/device-sim      Onboard gateway: Ed25519 sign + POST /api/telemetry
sidecars/osnma       OSNMAlib protocol-verification HTTP sidecar
config/              Versioned fusion + thresholds
data/geo             Land, ports, lanes, restricted zones (Gulf of Finland)
```

## Data flow

```
ScenarioSimulator ──► AIS A/B adapters (fixtures)
                  ──► GNSS diagnostics (simulated)
                  ──► IMU samples (simulated)
Device gateway ──mTLS/HTTPS──► Ed25519 verify + ReplayGuard
OSNMAlib sidecar ──► OsnmaResult (protocol demo)
        │
        ▼
 Normalize/validate → Detection checks → Fusion → State/Audit
        │
        ▼
 REST + WebSocket ──► React console
```

Scenarios inject perturbations **upstream** of adapters so attacks exercise the same pipeline as normal data.

## Detection layers

| Check | Module |
|-------|--------|
| Kinematics (+ CUSUM drift) | `packages/core/src/checks/kinematics.ts` |
| Geographic | `checks/geo.ts` + `geo/landIndex.ts` |
| Neighbors | `checks/neighbors.ts` |
| AIS cross-feed | `checkAisCrossFeed` |
| GNSS diagnostics | `checks/gnssDiagnostics.ts` |
| IMU / DR | `checks/imu.ts` |
| OSNMA | `checks/osnma.ts` |
| Device signature | `checks/signature.ts` |
| Attestation | `checks/attestation.ts` |

## Fusion

`packages/core/src/fusion/fuse.ts` — weighted anomaly over checks that ran; correlation discount (kinematics↔IMU); hard-alert debounce/persist; separate evidence coverage. Config: `config/fusion.v1.json`.

## API (selected)

- `GET /api/snapshot` — full UI state
- `GET /api/vessels`, `/api/alerts`, `/api/timeline`, `/api/geo/:layer`
- `POST /api/scenario` — drive simulation
- `POST /api/telemetry` — signed envelope ingest (rate-limited)
- `WS /ws` — snapshot / vessel_update / tick

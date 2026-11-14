# Northstar — Decisions Log

Confirmed choices, assumptions, and unresolved questions.

## Confirmed

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D1 | TypeScript end-to-end monorepo (Fastify + React/Vite/MapLibre, Zod, Vitest, `@noble/ed25519`) | Empty repo; single language and shared typed contracts | 2026-11-11 |
| D2 | npm workspaces (no pnpm/bun installed) | Match available toolchain | 2026-11-11 |
| D3 | No physical hardware or live feeds; simulation-labelled fixtures | User confirmed none available | 2026-11-11 |
| D3b | Lab switched to Digitraffic historical AIS replay (`data/replay/`); recorder appends because REST from/to is latest-only; attack overlays remain synthetic; OSNMA/GNSS/IMU still fixtures | User asked to make Lab historical as much as possible | 2026-11-11 |
| D4 | Demo region: Gulf of Finland | User choice; GNSS interference relevance; near ECDIS reference | 2026-11-11 |
| D5 | Base map: online dark vector tiles (Carto dark-matter) + OpenSeaMap seamarks, with automatic offline GeoJSON fallback | User preference with reliability fallback | 2026-11-11 |
| D6 | OSNMA via OSNMAlib Python sidecar on official/test recordings; UI labelled "Protocol verification demo"; live = Not connected | No OSNMA receiver; genuine protocol verification preferred over adapter-only | 2026-11-11 |
| D7 | Device keys: software storage under `./.northstar/keys` (gitignored, mode 0600); assurance level `software`. Override with `NORTHSTAR_KEY_DIR` | No TPM/secure element; macOS Secure Enclave is P-256 only; workspace-local simplifies demo | 2026-11-11 |
| D11 | Online Carto + OpenSeaMap with automatic offline GeoJSON fallback when tiles unreachable | User preference; sandbox/offline demos still work | 2026-11-11 |
| D8 | Canonicalization: RFC 8785 JCS for signed telemetry | Standard, unambiguous, library-supported | 2026-11-11 |
| D9 | Trust fusion: weighted anomaly with correlation groups + hard-alert overrides; separate evidence coverage | Spec §5; avoid naive averaging | 2026-11-11 |
| D10 | TLS optional for local demo (`NORTHSTAR_TLS_ENABLED`); mTLS for device ingest when enabled | Hackathon practicality; production path documented | 2026-11-11 |

## Assumptions (reversible)

| ID | Assumption | Consequence if wrong |
|----|------------|----------------------|
| A1 | ~12 simulated vessels on Helsinki–Tallinn / Gulf of Finland routes is enough for demo | Scale routes/fleet in simulator |
| A2 | Natural Earth / OSM-derived land polygons at ~1:10m or simplified OSM are accurate enough for inland-jump demos | Swap for higher-resolution coastal data |
| A3 | OSNMAlib installs and runs with bundled/official recordings under Python 3.12 | Fall back to adapter-only; document in BLOCKERS |
| A4 | Carto dark-matter tiles are reachable without an API key for demos | Offline fallback activates |

## Unresolved

None at Phase 0. Stretch hardware remaining as blockers (see BLOCKERS.md).

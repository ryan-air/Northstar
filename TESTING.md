# Northstar — Testing

## Commands

```bash
npm test                 # Vitest unit + in-process e2e
npm run eval             # Detection / false-alarm harness
npm run typecheck
npm run build
npm run check-tiles      # Carto + OpenSeaMap reachability
```

## Automated coverage

| Area | Location |
|------|----------|
| Contracts / bands | `packages/contracts/src/events.test.ts` |
| JCS + Ed25519 + replay | `packages/core/src/crypto/*.test.ts` |
| Kinematics | `packages/core/src/checks/kinematics.test.ts` |
| Geographic | `packages/core/src/checks/geo.test.ts` |
| Validation | `packages/core/src/normalize/validate.test.ts` |
| Fusion / hard alerts / correlation | `packages/core/src/fusion/fuse.test.ts` |
| Scenario e2e + crypto path | `apps/server/src/scenario.e2e.test.ts` |

## Spec scenarios mapped

1. Normal track — eval + e2e (no unjustified critical flood)
2. Impossible jump — kinematics + eval
3. Gradual drift — CUSUM + eval
4. Stale AIS — validate + `stale_clock_skew` scenario
5. Neighbor inconsistency — neighbors / ais_disagreement scenario
6. Missing IMU — status `unavailable`
7. Missing/unsupported OSNMA — status handling
8. Altered signed field — verify test + e2e + signed_tamper
9. Replayed signed message — replay guard + e2e + signed_replay
10. Clock skew / OOO — validate + replay guard
11. Malformed coords/units — validate tests
12. Conflicting sources — ais_cross_feed
13. Hard-alert debounce — fusion test
14. Evidence coverage when missing — fusion test
15. No false alarm on normal — eval gate

## Evaluation metrics

`npm run eval` runs `packages/core/src/eval/scenarios.eval.test.ts`.

Latest local run (2026-11-11):

| Case | Result |
|------|--------|
| normal_navigation | no false alarm |
| sudden_jump | detected |
| gradual_drift | detected |

**Normal navigation must not false-alarm.**

## Smoke

```bash
# with server running:
npm run smoke
```

Playwright browser E2E was deferred; API smoke + Vitest cover scenario/control paths. Manual UI checks:

- SIMULATION badge visible
- Metrics update from live state (not hard-coded)
- Scenario buttons change map/trust/evidence
- Reset restores normal behaviour
- Map online tiles or offline GeoJSON fallback message

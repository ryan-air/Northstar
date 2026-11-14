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
| Fusion v2, debounce, evidence classes | `packages/core/src/fusion/fuse.v2.test.ts` |
| Kinematics v2 + realistic drift limits | `packages/core/src/checks/kinematics.v2.test.ts` |
| Geo v2 / fleet coherence v2 / identity | `packages/core/src/checks/v2checks.test.ts` |
| Ingest validation (stale/future/dup/OOO/sentinels) | `packages/core/src/normalize/ingest.test.ts` |
| Adapters, per-source state, signed-vs-AIS alignment | `apps/server/src/v2.test.ts` |
| Enrolment, alg binding, checkpoint ordering, 200-tick Lab, stale clock, wrap | `apps/server/src/security.v2.test.ts` |

## Spec scenarios mapped

1. Normal track — eval + e2e (no unjustified critical flood)
2. Impossible jump — kinematics + eval
3. Gradual drift — CUSUM + eval
4. Stale AIS — `IngestValidator` on every ingest path + `stale_clock_skew` (target timestamps shifted −10 min → rejected, counted, logged to forensics)
5. Neighbor inconsistency — neighbors / ais_disagreement scenario
6. Missing IMU — status `unavailable`
7. Missing/unsupported OSNMA — status handling
8. Altered signed field — verify test + e2e + signed_tamper
9. Replayed signed message — replay guard + e2e + signed_replay
10. Clock skew / OOO — `IngestValidator` (future / out_of_order / duplicate) + replay guard
11. Malformed coords/units — sentinel filters (lat 91, lon 181, (0,0), SOG 102.3, COG 360, heading 511, UTC sec 60–63)
12. Conflicting sources — ais_cross_feed
13. Hard-alert debounce — fusion test
14. Evidence coverage when missing — fusion test
15. No false alarm on normal — eval gate

## Evaluation metrics

`npm run eval` runs `packages/core/src/eval/scenarios.eval.test.ts`.

> **Superseded (2026-11-14):** the table below comes from synthetic scenarios only. Measured numbers on real recorded AIS now come from `npm run eval:pipeline` → `data/fixtures/eval_pipeline_metrics.json`, summarised in [EVALUATION.md](EVALUATION.md).

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

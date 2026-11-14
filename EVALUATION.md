# Northstar — Evaluation

Every number here comes from `data/fixtures/eval_pipeline_metrics.json`, produced by
`npm run eval:pipeline` (seed 7, 10 attack instances per variant per split) on the frozen
dataset `data/replay/snapshots/gof_ais.eval-v1.jsonl`. Gates: `config/eval_gates.json`,
checked by `npm run eval:gates` in CI.

## Dataset (eval-v1)

| | |
|---|---|
| Source | Digitraffic AIS recording, Gulf of Finland (CC BY 4.0) |
| Raw rows | 139,716 → **16,833 after dedup** on (MMSI, AIS timestamp) — 88% were re-polled duplicates |
| Vessels | 201 MMSIs (168 matched to `/vessels` metadata, 165 with antenna reference points) |
| Calibration split | 2026-11-12 (5,820 rows) — thresholds tuned here only |
| Held-out split | 2026-11-13/14 (11,003 rows; Nov 13 has only 4 rows, so effectively Nov 14) |

Caveats: report cadence in the recording is 1–20 min per vessel (polled snapshots, not the
raw AIS stream); vessel metadata is as of fetch time, not per report.

## Clean-data false-alarm rates (share of events)

| Run | Split | Suspicious or worse | Kinematics warn+ | Geographic warn+ | Fleet coh. warn+ | Vessels ever flagged |
|---|---|---|---|---|---|---|
| legacy v1, raw (dups kept, no validation) | all | 23.8% | 91.8% | 18.6% | 2.5% | 189 / 193 |
| v1 | calibration | 28.3% | 15.2% | 13.4% | 2.8% | 133 / 150 |
| v1 | held-out | 59.9% | 43.5% | 17.7% | 11.7% | 152 / 156 |
| v2, simplified land (before OSM) | held-out | 13.4% | 1.6% | 17.7% | 0 | 42 / 156 |
| **v2 + OSM land** | calibration | 1.6% | 0.0% | 1.6% | 0 | 3 / 150 |
| **v2 + OSM land** | **held-out** | **3.2%** | **1.6%** | **1.6%** | **0** | **27 / 156** |

- The audit baseline (39% suspicious, kinematics 27% warning) was **not reproduced exactly**;
  the raw-recording reproduction gives 23.8% / 91.8% warn+. The kinematics warnings are mostly
  dt = 0 duplicates.
- Installing the OSM coastline (`scripts/geo/build_osm_geo.py`, provenance in
  `data/geo/osm_provenance.json`) cut held-out false alarms from 13.4% to 3.2% and vessels
  critical while stationary from 25 to 7 (plan target 0).
- The remaining geographic flags on the held-out split are two **on-land test transponders**
  (FURUNOP, a static unit inland near Espoo; TESTSHIP 299999999 in Tallinn), not ships.
- OSM port coverage is thin: mostly quays/piers, few `landuse=port` areas, nothing found at
  Kunda. With edge distance + hull tolerance this matters less, but port polygons are still a
  data gap.
- Identity flags 0.5% of events — all TESTSHIP (MMSI 299999999, MID 299 unallocated).
- Plan target "held-out ≤2% suspicious or worse" is **not met** (3.2%). Excluding the two test
  transponders it is about 1.6%, but they are left in the numbers.

## Attack recall — v2, held-out split (unchanged by the OSM data except baselines)

Recall = share of attacked vessels whose trust reached suspicious/critical on an attacked
report (ingest attacks: share of attacked reports rejected). "Pre" = how often those vessels
were already flagged in the 30 min before the attack (v1's recall is inflated by this: pre ≈ 30%).

| Attack | Recall v2 | Median TTD | Caught by | Baseline: speed > max | Baseline: on land |
|---|---|---|---|---|---|
| Teleport inland | 100% | 0 s | kinematics, geographic | 100% | 100% |
| Teleport open sea (15 km) | 90% | 0 s | kinematics | 90% | 20% |
| Step offset 100 m | 20% | 222 s | kinematics | 0% | 0% |
| Step offset 300 / 500 / 1000 m | 90% / 90% / 90% | 0 s | kinematics | 0 / 10 / 50% | 0% |
| Drift 0.2 / 0.5 / 1 m/s | 20% / 20% / 30% | 222 s | kinematics | 0% | 0% |
| Drift 2 m/s | 90% | 178 s | kinematics | 0% | 0% |
| Area pull (≥4 vessels) | 98.9% | 76 s | kinematics, fleet_coherence | 97.2% | 28.2% |
| Coherent area offset (3 km) | 98.1% | 76 s | kinematics, fleet_coherence | 89% | 9% |
| Self-replay (1 h delay) | 100% (n=6) | 0 s | kinematics | 83% | 0% |
| MMSI clone | 88.9% (n=9) | 176 s | kinematics, identity | 89% | 33% |
| Kinematically consistent fake track | **0%** | — | — | 0% | 0% |
| Stale / future timestamps | 100% rejected | — | ingest | — | — |
| Duplicates | 100% rejected | — | ingest | — | — |

Honest reading:
- **Slow drift (<1 m/s) and small offsets (100 m) are largely undetectable from AIS alone**
  at this report cadence. The 20% hits are vessels with dense reports.
- A **kinematically consistent fake track is not detected** (known limit). Detecting it needs
  an independent position source (see "data needed" below).
- For area attacks the simple implied-speed baseline already gets 89–97%; fleet coherence v2
  adds attribution ("part of an area pattern") more than recall.
- Small n: 10 instances per variant, 5–9 for self-replay and clone.

## Evidence classes

Every check carries `evidence_class` ∈ live | recorded | simulated | demo.
`verified_evidence_coverage` counts only live + recorded. In the Lab, OSNMA (ICD test vector),
RF/AoA (fixed capture), attestation (server-asserted) are `demo`; IMU (rebuilt from AIS) and
signed-vs-AIS (onboard track copied from AIS) are `simulated`.

## Superseded numbers

- `eval_metrics.json` "FPR 0.29%" (pre-P5.1): only fail/hard counted, first 40 raw rows per
  vessel, duplicates kept, hard-coded config. P5.1 output on the snapshot with v2:
  kinematics warning 0.4%, fail 0.6%, warning-or-worse 1.0%.
- "Fusion of independent weak signals" (COMPARISON.md): v1 fusion reduced to max(); see
  `packages/core/src/fusion/fuse.v2.test.ts`.

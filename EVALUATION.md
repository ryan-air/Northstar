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
| **v2 + OSM, ships only** | calibration | 0.6% | 0.0% | 0.5% | 0 | 3 / 150 |
| v2 + OSM, ships only (before trapezoid drift prediction) | held-out | 1.6% | 1.6% | 0.0% | 0 | 25 / 153 |
| **v2 + OSM + trapezoid drift prediction** | **held-out** | **2.2%** | **0.6%** | **1.6%** | **0** | **20 / 156** |
| **…same, ships only** | **held-out** | **0.6%** | **0.6%** | **0.0%** | **0** | **18 / 153** |

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
- **Ships only: 0.6% held-out** after the v2 drift check switched to the average of the previous and
  current reported velocity (`cusum.prediction = trapezoid`); 1.6% before (plan target ≤2%, gated in CI).
  This removed false drift alarms in turns and speed changes between sparse reports. Cost: one
  fewer detection out of 10 on each of the four hardest attacks (100 m step 20→10%, drift 0.2/0.5
  m/s 20→10%, drift 1 m/s 30→20%) — inside the 95% ranges, but reported. Non-vessel transponders are
  labelled `transponder_kind = non_vessel_transponder` (non-ship MMSI type, or fixed within 100 m
  on land for ≥30 min) and reported separately; their alerts still fire. Totals including them
  stay in the table (3.2%).
- On the held-out split 4 units were labelled non-vessel: FURUNOP 230031000 and TESTSHIP
  299999999 (all their events flagged) plus 276675000 and 276799000 (stationary inside a Tallinn
  land/quay polygon, never flagged). The rule cannot tell a ship moored on a quay polygon from a
  fixed shore unit; because those two were never flagged, leaving them out makes the ships-only
  rate slightly *higher*, not lower.

## Attack recall — v2, held-out split (unchanged by the OSM data except baselines)

These attacks are injected into a **copy of the frozen recording, for measurement only**. The running app never injects attacks into recorded or live ships (simulated ships only) and never shows these results.

Recall = share of attacked vessels whose trust reached suspicious/critical on an attacked
report (ingest attacks: share of attacked reports rejected). "Pre" = how often those vessels
were already flagged in the 30 min before the attack (v1's recall is inflated by this: pre ≈ 30%).

95% range = Wilson interval. With n = 10 a 90% result means roughly 60–98%.

| Attack | Recall v2 (95% range) | Median TTD | Caught by | Baseline: speed > max | Baseline: on land |
|---|---|---|---|---|---|
| Teleport inland | 100% (72–100) | 0 s | kinematics, geographic | 100% | 100% |
| Teleport open sea (15 km) | 90% (60–98) | 0 s | kinematics | 90% | 20% |
| Step offset 100 m | 10% (2–40); was 20% before trapezoid | 222 s | kinematics | 0% | 0% |
| Step offset 300 / 500 / 1000 m | 90% / 90% / 90% | 0 s | kinematics | 0 / 10 / 50% | 0% |
| Drift 0.2 / 0.5 / 1 m/s | 10% / 10% / 20%; were 20 / 20 / 30% | 222 s | kinematics | 0% | 0% |
| Drift 2 m/s | 90% (60–98) | 178 s | kinematics | 0% | 0% |
| Area pull (≥4 vessels) | 98.9% (96–100, n=181) | 76 s | kinematics, fleet_coherence | 97.2% | 28.2% |
| Coherent area offset (3 km) | 98.1% (95–99, n=155) | 76 s | kinematics, fleet_coherence | 89% | 9% |
| Self-replay (1 h delay) | 100% (61–100, n=6) | 0 s | kinematics | 83% | 0% |
| MMSI clone | 88.9% (57–98, n=9) | 176 s | kinematics, identity | 89% | 33% |
| Kinematically consistent fake track | **0%** (0–28) | — | — | 0% | 0% |
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

## Denser data (in progress)

`npm run record:stream` records the Digitraffic real-time stream: first 25 min gave 22,772 positions
from 318 vessels, median 10 s between reports per vessel (eval-v1: 1–20 min). A frozen eval-v2
from this stream is the next step for slow-drift / 100 m-offset recall.

## Independent-sensor evidence (lab return; data kept private)

The lab return is not in this repository. With it present locally (`data_lab/`), its vessel
becomes the full-stack Hist Lab ship and `scripts/lab/case-study.ts` reports per-event detection
(AIS only vs with independent evidence) into the gitignored `.northstar/` folder. Checks it feeds:
independent radar/SAR observations (`neighbors`), GNSS-free dead reckoning from heading + speed
log with IMU gyro fallback, anchored on radar fixes (`imu`), receiver diagnostics, recorded
multi-element RF captures (`rf_lab`/`spatial_aoa`), a second AIS network, the independently signed
onboard receiver (`signed_vs_ais`), and clock-driven jamming / spoofing-flag / AIS-silence alerts.
Synthetic OSNMA and attestation inputs are classed `simulated`.

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

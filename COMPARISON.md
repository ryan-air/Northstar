# Northstar vs known GNSS spoofing / integrity approaches

This is a **capability comparison**, not a claim that Northstar beats commercial RF anti-spoof products on live Baltic interference. Northstar is currently a **simulation + signed-telemetry integrity layer** with fixture-backed stretch sensors.

## Problem we claim to solve

**Operators and downstream systems receive vessel positions that look valid but may be forged, degraded, or inconsistent.** Ordinary AIS/GNSS displays show the fix; they rarely show *why* it should or should not be trusted.

Northstar’s claimed value:
1. **Explainable position-integrity estimate** (trust score + evidence coverage + per-layer reasons).
2. **Cryptographic provenance** for onboard telemetry (Ed25519 sign / tamper / replay demos).
3. **Fusion of independent weak signals** (kinematics, geography, neighbors, optional OSNMA/IMU/GNSS diagnostics) without pretending any single check is proof.
   > **Superseded (2026-11-14):** in fusion v1 the noisy-OR term never exceeded the strongest single anomaly, so v1 was effectively `max()` — weak signals did not combine. Fusion v2 (`config/fusion.v2.json`, default) does combine them; see [EVALUATION.md](EVALUATION.md) and `packages/core/src/fusion/fuse.v2.test.ts`. Most "independent" signals in the Lab are also not independent (see EVALUATION.md → evidence classes).

What we do **not** claim: calibrated probability of authenticity; certified navigation; RF-front-end anti-spoof equal to Septentrio-class receivers.

## Value assessment (honest)

| Stakeholder | Value if live feeds exist | Value with simulation-only demo |
|-------------|---------------------------|----------------------------------|
| Hackathon judges | High if story + working UI + crypto | Medium–high if framed as integrity UX + provenance |
| Ship operator / OOW | Medium as ECDIS/VTS overlay; low as sole anti-spoof | Low (training/demo only) |
| Fleet / shore SOC | Medium for anomaly triage + audit trail | Low until live AIS/GNSS |
| Receiver OEM market | Low (they already embed AIM+/OSNMA) | N/A |

**Commercial context:** products such as Septentrio AIM+, ANavS A-Shield, Promarine OSNMA receivers, and Decorum DIDI GNSS (trust score on the bridge, deliveries ~2027) attack spoofing primarily **inside or beside the receiver**. Northstar is closer to a **shore/ops integrity & explanation layer**. That can still be valuable as middleware — but only once real feeds are connected.

## Capability matrix

| Capability | Northstar (now) | Septentrio AIM+ | ANavS A-Shield | DIDI GNSS (public claims) | AIS-only track monitors |
|------------|----------------|-----------------|----------------|---------------------------|-------------------------|
| RF / C/N0 / AGC heuristics | Simulated fixtures | Native | Native | Native (receiver) | No |
| Galileo OSNMA | Protocol-demo fixtures | Supported | Supported | Cryptographic anti-spoof (claimed) | No |
| IMU / multi-sensor fusion | Simulated DR residual | System-level optional | Tightly coupled | Receiver-centric | No |
| Kinematic / jump / drift | Yes (software) | Partial via PVT integrity | Yes via fusion | Trust score behavior | Often yes |
| Land / geo plausibility | Yes (demo polygons) | App-level | Map/SLAM variants | Bridge warning UX | Sometimes |
| AIS neighbor consistency | Fixture dual-feed | Not primary | Fleet/cloud optional | Shore dashboard optional | Core |
| Signed device telemetry | Yes (Ed25519 demo) | Unrelated | Unrelated | Unrelated | Rare |
| Explainable per-layer UI | Strong | OEM-dependent | Stronger on threat class | Trust score UX | Usually weak |
| Live contested-water proof | Not yet | Fielded | Fielded / trials | Sea trials claimed | Depends |

## Attack-class coverage (our eval vs typical detectors)

| Attack / condition | Northstar detection (sim) | Typical RF detector | Notes |
|--------------------|--------------------------|---------------------|-------|
| Sudden teleport / inland jump | Strong (kinematics + geo) | May miss if only RF looks healthy | Our sweet spot |
| Gradual drift spoof | Medium (CUSUM) | Stronger with IMU/RF | Need tuning |
| Jamming-like degradation | Fixture GNSS diagnostics | Strong | We only simulate |
| Spoof with plausible RF | Weak without real residuals | Strong | Do not overclaim |
| OSNMA MAC failure | Fixture protocol demo | Real in capable RX | Educational |
| AIS feed disagreement | Yes (dual fixture) | N/A | Useful ops signal |
| Tampered / replayed telemetry | Strong (crypto) | N/A | Differentiator vs RF products |
| Normal navigation false alarm | Eval gate: none on nominal track | Varies | Critical for credibility |

## How to read “performance”

Until we have:
- recorded real spoofing datasets (e.g. Jammertest-style), or
- a live receiver,

any “we outperform X” statement would be **dishonest**. What we *can* measure now (`npm run eval`):

- detection of scripted kinematic/geo attacks
- false-alarm behavior on normal tracks
- crypto tamper/replay rejection

Run also: `npm test` and scenario e2e in `apps/server/src/scenario.e2e.test.ts`.

## Recommended positioning for the hackathon

**Pitch:** ops-layer integrity + provenance + explanation.  
**Do not pitch:** drop-in replacement for AIM+/A-Shield/DIDI.

**Highest-value next upgrades (in order):**
1. Live AIS key → real ships on the map.
2. Recorded GNSS/OSNMA vectors with clear labels (in progress via fixtures).
3. Only then: any ML layer on real features.

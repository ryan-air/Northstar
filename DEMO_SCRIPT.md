# Northstar — Judge demo script

**Setup:** `npm run setup:osnma` (once) · extract RF once (`python3 scripts/rf_extract_clip.py && sidecars/rf/.venv/bin/python sidecars/rf/analyze_aoa.py`) · `npm run dev` · open dashboard · **Both** view.

**Pitch:** Live AIS proves the fleet concept with partial coverage. One full-stack historical vessel carries the complete pack — signed telemetry, OSNMA ICD, and dual-antenna lab AoA.

---

## 90-second path

1. **Both** map — live (cyan) + Hist Lab together. Hist Lab = recorded Digitraffic ships **plus three synthetic ships** (`VESSEL-00x`, labelled *simulated*).
2. Left panel → **Full-stack** ship → Evidence: `spatial_aoa` + `rf_lab` (demo capture), OSNMA (ICD test vector), device signature. Each row shows its evidence class.
3. Scenarios → **Sudden spoof** / **Gradual drift** / **RF AoA single-direction** → the attack lands on a **synthetic** ship (the API answers with `target` and, if you had a recorded ship selected, `retargeted_from`). Trust drops; kinematics / geographic / AoA fail.
4. **Tamper** / **Replay** → forensics fail-closed (attacks the simulated device channel, not the recorded AIS). Cyber → **Send without challenge** → reject.
5. Click a **non-fullstack Hist Lab** ship → OSNMA unavailable (“bound to full-stack only”). **LIVE** → RF/AoA/OSNMA unavailable.
6. Verify audit → CHAIN + CHECKPOINT OK. Shore signs tips; device-sim holds device keys (`role=shore`).

Say: “We never inject attacks into recorded or live ships — only into ships we simulate. AoA needs a receiver path; Digitraffic has none, so we don’t fake it.”

Injection policy: `NORTHSTAR_LAB_SIM_SHIPS` (default 3) sets how many synthetic ships join the Hist Lab; `NORTHSTAR_LEGACY_LAB_INJECTION=true` restores the old behaviour (attacks on the recorded full-stack ship) for comparison only.

---

## Fail-closed / RF checklist

| Step | Expect |
|------|--------|
| Full-stack selected | HIGH coverage vs live |
| AoA nominal | `spatial_aoa` pass, cluster score shown |
| AoA spoof cluster | fail + overlay label in Evidence/Cyber |
| LIVE contrast | rf_lab / spatial_aoa unavailable |
| Audit / export | JSON for judges |

---

## Residual risk (say out loud)

- Center freq 95.5 MHz as provided (likely IF).
- Spoof-cluster demo is a **labeled** single-direction overlay — raw capture has no spoof timestamps.
- Absolute AoA needs known baseline; we show relative phase / cluster.
- Default keys are software; SoftHSM/YubiKey PKCS#11 path optional (`HARDWARE_KEYS.md`) — SoftHSM ≠ silicon.
- Audit checkpoint stops casual genesis-rewrite; still needs shore key + mirror compromise for full forge.

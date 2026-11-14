# Northstar — Judge demo script

**Setup:** `npm run setup:osnma` (once) · extract RF once (`python3 scripts/rf_extract_clip.py && sidecars/rf/.venv/bin/python sidecars/rf/analyze_aoa.py`) · `npm run dev` · open dashboard · **Both** view.

**Pitch:** Live AIS proves the fleet concept with partial coverage. One full-stack historical vessel carries the complete pack — signed telemetry, OSNMA ICD, and dual-antenna lab AoA.

---

## 90-second path

1. **Both** map — live (cyan) + Hist Lab together.
2. Left panel → **Full-stack** ship → Evidence: `spatial_aoa` + `rf_lab` **pass**, OSNMA pass, device signature.
3. Scenarios → **RF AoA single-direction** → AoA **fail** (labeled synthetic overlay on real IQ).
4. **Tamper** / **Replay** → forensics fail-closed. Cyber → **Send without challenge** → reject.
5. Click a **non-fullstack Hist Lab** ship → OSNMA unavailable (“bound to full-stack only”). **LIVE** → RF/AoA/OSNMA unavailable.
6. Verify audit → CHAIN + CHECKPOINT OK. Shore signs tips; device-sim holds device keys (`role=shore`).

Say: “AoA needs a receiver path. Digitraffic has none — we don’t fake it.”

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

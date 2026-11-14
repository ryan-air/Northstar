#!/usr/bin/env python3
"""
Demux 2-antenna interleaved complex64 IQ and estimate AoA via phase interferometry.
Also writes a labeled synthetic single-direction fail overlay for demo.
"""
from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LAYOUT_PATH = ROOT / "data/rf/capture01.layout.json"
RESULTS = ROOT / "data/rf/results"


def load_iq(path: Path, layout: dict) -> tuple[np.ndarray, np.ndarray]:
    """Return (ant0, ant1) complex64 vectors."""
    raw = np.fromfile(path, dtype=np.float32)
    if raw.size < 8:
        raise SystemExit(f"clip too small: {path}")
    # I0 Q0 I1 Q1
    usable = (raw.size // 4) * 4
    raw = raw[:usable].reshape(-1, 4)
    ant0 = raw[:, 0] + 1j * raw[:, 1]
    ant1 = raw[:, 2] + 1j * raw[:, 3]
    return ant0.astype(np.complex64), ant1.astype(np.complex64)


def power_metrics(ant0: np.ndarray, ant1: np.ndarray) -> dict:
    p0 = float(np.mean(np.abs(ant0) ** 2))
    p1 = float(np.mean(np.abs(ant1) ** 2))
    return {
        "ant0_power": p0,
        "ant1_power": p1,
        "power_ratio_db": 10 * math.log10((p0 + 1e-20) / (p1 + 1e-20)),
        "ant0_rms": float(np.sqrt(p0)),
        "ant1_rms": float(np.sqrt(p1)),
        "n_samples": int(ant0.size),
    }


def aoa_phase_interferometry(ant0: np.ndarray, ant1: np.ndarray, max_points: int = 200_000) -> dict:
    """
    2-element relative AoA proxy from mean phase difference.
    Baseline geometry unknown → report phase_deg and a normalized direction index.
    Spatial diversity: phase variance across blocks (high = sky-like; low locked = single-direction).
    """
    n = min(ant0.size, ant1.size, max_points)
    a0 = ant0[:n]
    a1 = ant1[:n]
    # avoid zeros
    eps = 1e-12
    cross = a0 * np.conj(a1)
    phase = np.angle(cross)
    # block stats for cluster score
    block = max(1024, n // 64)
    phases = []
    for i in range(0, n - block, block):
        c = np.mean(cross[i : i + block])
        phases.append(float(np.angle(c)))
    phases_arr = np.array(phases) if phases else np.array([float(np.angle(np.mean(cross)))])
    mean_phase = float(np.angle(np.mean(cross)))
    phase_std = float(np.std(phases_arr))
    # cluster_score: 0 = tightly locked (spoof-like), 1 = diverse
    cluster_score = float(min(1.0, phase_std / (math.pi / 4)))
    # map phase [-pi,pi] → direction proxy degrees [-90,90] for 2-el display
    direction_deg = mean_phase * (90.0 / math.pi)
    corr = float(np.abs(np.mean(cross)) / (np.sqrt(np.mean(np.abs(a0) ** 2) * np.mean(np.abs(a1) ** 2)) + eps))
    return {
        "method": "two_element_phase_interferometry",
        "mean_phase_deg": mean_phase * 180.0 / math.pi,
        "phase_std_rad": phase_std,
        "cluster_score": cluster_score,
        "directions_deg": [direction_deg],
        "coherence": corr,
        "baseline_note": "Absolute angle needs known baseline/λ; relative phase used as AoA proxy",
    }


def classify(aoa: dict, spoof_overlay: bool) -> tuple[str, str]:
    overlay_note = (
        "Synthetic single-direction overlay (ant1 ← phase-locked ant0); "
        "status computed from overlay metrics. "
        if spoof_overlay
        else ""
    )
    # Real dual-ant: expect some spatial diversity / non-trivial coherence structure
    if aoa["coherence"] < 0.05:
        return "warning", overlay_note + "Very low inter-antenna coherence — check layout/demux."
    if aoa["cluster_score"] < 0.08 and aoa["coherence"] > 0.85:
        return "fail", overlay_note + "Phase tightly locked across blocks (single-direction-like)."
    return "pass", overlay_note + "Dual-antenna spatial diversity consistent with distributed energy."


def build_result(
    layout: dict,
    metrics: dict,
    aoa: dict,
    *,
    spoof_overlay: bool,
    entity_hint: str | None = None,
) -> dict:
    status, reason = classify(aoa, spoof_overlay)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "v": 1,
        "layout_id": layout["id"],
        "entity_id": entity_hint,
        "observed_at": now,
        "mode": "lab_iq_multichannel",
        "antennas": layout["antennas"],
        "sample_rate_hz": layout["fs_hz"],
        "center_freq_hz": layout["fc_hz"],
        "fc_note": layout.get("fc_note"),
        "status": status,
        "aoa_status": status,
        "reason": reason,
        "spoof_overlay": "synthetic_single_direction_on_real_capture" if spoof_overlay else None,
        "metrics": metrics,
        "aoa": aoa,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", type=Path, default=ROOT / "data/rf/clips/capture01_t0.bin")
    ap.add_argument("--layout", type=Path, default=LAYOUT_PATH)
    args = ap.parse_args()

    layout = json.loads(args.layout.read_text())
    if not args.clip.exists():
        raise SystemExit(f"missing clip {args.clip} — run scripts/rf_extract_clip.py first")

    ant0, ant1 = load_iq(args.clip, layout)
    metrics = power_metrics(ant0, ant1)
    aoa = aoa_phase_interferometry(ant0, ant1)
    nominal = build_result(layout, metrics, aoa, spoof_overlay=False)

    # Synthetic overlay: ant1 = phase-locked copy of ant0.
    # Verdict is computed by classify() from overlay metrics — not forced.
    phase_lock = np.exp(1j * 0.35)
    ant1_spoof = (ant0 * phase_lock).astype(np.complex64)
    metrics_s = power_metrics(ant0, ant1_spoof)
    aoa_s = aoa_phase_interferometry(ant0, ant1_spoof)
    spoof = build_result(layout, metrics_s, aoa_s, spoof_overlay=True)

    RESULTS.mkdir(parents=True, exist_ok=True)
    nom_path = RESULTS / "capture01_nominal.json"
    sp_path = RESULTS / "capture01_spoof_cluster.json"
    nom_path.write_text(json.dumps(nominal, indent=2))
    sp_path.write_text(json.dumps(spoof, indent=2))
    print(f"nominal → {nom_path} status={nominal['aoa_status']} cluster={aoa['cluster_score']:.3f}")
    print(f"spoof   → {sp_path} status={spoof['aoa_status']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

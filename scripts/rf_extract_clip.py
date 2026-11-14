#!/usr/bin/env python3
"""Stream-extract a short multi-antenna clip from capture01.sink.gz (no full unpack)."""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SRC = ROOT / "capture01.sink.gz"
LAYOUT_PATH = ROOT / "data/rf/capture01.layout.json"
OUT_DIR = ROOT / "data/rf/clips"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC)
    ap.add_argument("--seconds", type=float, default=0.5)
    ap.add_argument("--skip-seconds", type=float, default=0.0)
    ap.add_argument("--out", type=Path, default=OUT_DIR / "capture01_t0.bin")
    args = ap.parse_args()

    layout = json.loads(LAYOUT_PATH.read_text())
    bps = int(layout["bytes_per_sample"])
    fs = float(layout["fs_hz"])
    nbytes = int(args.seconds * fs * bps)
    skip = int(args.skip_seconds * fs * bps)

    if not args.src.exists():
        print(f"missing source {args.src}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    skipped = 0
    with gzip.open(args.src, "rb") as zin, open(args.out, "wb") as zout:
        while skipped < skip:
            chunk = zin.read(min(1024 * 1024, skip - skipped))
            if not chunk:
                break
            skipped += len(chunk)
        while written < nbytes:
            chunk = zin.read(min(1024 * 1024, nbytes - written))
            if not chunk:
                break
            zout.write(chunk)
            written += len(chunk)

    meta = {
        **layout,
        "clip_path": str(args.out.relative_to(ROOT)),
        "clip_seconds": args.seconds,
        "clip_skip_seconds": args.skip_seconds,
        "clip_bytes": written,
        "clip_samples": written // bps,
    }
    meta_path = args.out.with_suffix(".meta.json")
    meta_path.write_text(json.dumps(meta, indent=2))
    print(f"wrote {written} bytes ({written / bps / fs:.3f}s) → {args.out}")
    print(f"meta → {meta_path}")
    return 0 if written > 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())

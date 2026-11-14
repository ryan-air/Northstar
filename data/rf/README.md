# RF lab captures

- `capture01.layout.json` — Manavi dual-antenna sink layout (committed).
- `results/*.json` — AoA / RF lab evidence for Northstar boot (committed).
- Raw `*.sink.gz` and `clips/` are **local only** (gitignored).

Extract a short clip:

```bash
python3 scripts/rf_extract_clip.py --seconds 0.5
python3 sidecars/rf/analyze_aoa.py --clip data/rf/clips/capture01_t0.bin
```

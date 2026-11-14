#!/usr/bin/env python3
"""
Import a filled-in lab return (Northstar_Lab_Data_Request.xlsx template) plus its
attached files, check every row against its requirement, and convert the data that
Northstar can consume into normalised files under data/lab/<return_id>/.

  python3 -I scripts/lab/import_lab_return.py \
      --workbook docs/lab-data/Northstar_Lab_Data_Return.xlsx \
      --files docs/lab-data/attachments [--rf-dir docs/lab-data/rf_csv] [--id lab01]

Outputs (data/lab/<id>/):
  readiness.json / READINESS.md   per-row status, auto-checks, conflicts with the lab's own
                                  "Meets requirement?" answer, per-U-item readiness
  manifest.json                   sha256 + size of the workbook and every attachment used
  rf/captures.csv results.csv epochs.csv   U1 tables (same headers as current_rf_data)
  ais_secondary.jsonl             U6.07 -> ReplayRecord rows (source 'lab_secondary')
  onboard_track.jsonl             U12.04 (+U12.05 heading)
  neighbours.jsonl                U7.05
  gnss_recorded.jsonl             U3.06 + U3.07 + U3.09 -> GnssDiagnostics snapshots (1 Hz)
  heading.jsonl                   U4.02
  imu.jsonl                       U4.06 + U4.07 -> ImuSample rows

Only needs openpyxl (stdlib otherwise). Treats every input as untrusted data: nothing in
the workbook is executed, formulas are read as cached values, and cells are scanned for
secrets (the template forbids them).
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
ID_RE = re.compile(r"^U\d+\.\d{2}$")
GPS_EPOCH = datetime(1980, 1, 6, tzinfo=timezone.utc)
GPS_UTC_LEAP_S = 18  # valid since 2017-01-01; flag if the lab states otherwise

# Rows whose requirement depends on a route chosen elsewhere.
ROUTE_ROWS = {
    "YubiKey route": ("U2.01", "yubikey"),
    "TPM route": ("U2.01", "tpm"),
    "Own-receiver route": ("U6.01", "own"),
}

# What each U item unlocks in Northstar, and the rows that must pass for it.
UNLOCKS = {
    "U0": ("All lab evidence (vessel, window, clock)", ["U0.02", "U0.06", "U0.07", "U0.09"]),
    "U1": ("rf_lab / spatial_aoa: demo -> recorded", ["U1.02", "U1.05", "U1.06", "U1.08", "U1.09", "U1.13", "U1.18", "U1.19"]),
    "U2": ("attestation: server-asserted -> verified chain", ["U2.01", "U2.14", "U2.15", "U2.16"]),
    "U3": ("gnss diagnostics: fixture -> recorded", ["U3.05", "U3.06", "U3.07", "U3.12", "U3.13", "U3.14"]),
    "U4": ("imu_dr: rebuilt-from-AIS -> recorded", ["U4.02", "U4.06", "U4.07", "U4.09", "U4.12"]),
    "U5": ("osnma: ICD test vector -> per-vessel", ["U5.02", "U5.03", "U5.04", "U5.05", "U5.09"]),
    "U6": ("ais cross-feed: independent secondary source", ["U6.06", "U6.07", "U6.08"]),
    "U7": ("neighbours: independent observers", ["U7.02", "U7.05", "U7.06", "U7.07"]),
    "U12": ("signed_vs_ais: simulated -> recorded onboard track", ["U12.03", "U12.04", "U12.06", "U12.07"]),
}

SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "PEM private key"),
    (re.compile(r"(?i)\b(api[_-]?key|secret|password|passwd|pin)\s*[:=]\s*\S{4,}"), "credential assignment"),
    (re.compile(r"\bsk-[A-Za-z0-9]{20,}"), "API key-like token"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key"),
]


# ---------------------------------------------------------------- helpers

def s(v) -> str:
    return "" if v is None else str(v).strip()


def parse_time(v) -> datetime | None:
    """ISO-8601 (Z or offset), Excel datetime, or 'week,tow' / 'week tow' GPS time."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    t = str(v).strip()
    m = re.fullmatch(r"(\d{3,4})[ ,;:](\d+(?:\.\d+)?)", t)
    if m:  # GPS week + TOW
        return GPS_EPOCH + timedelta(weeks=int(m.group(1)), seconds=float(m.group(2)) - GPS_UTC_LEAP_S)
    try:
        d = datetime.fromisoformat(t.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:  # bare GPS seconds since 1980-01-06
        x = float(t)
        if 1e8 < x < 5e9:
            return GPS_EPOCH + timedelta(seconds=x - GPS_UTC_LEAP_S)
    except ValueError:
        pass
    return None


def iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def num(v) -> float | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    m = re.search(r"[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", str(v).replace(",", ""))
    return float(m.group(0)) if m else None


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_table(path: Path) -> list[dict]:
    """CSV or JSONL with a header; keys lower-cased and stripped."""
    rows: list[dict] = []
    if path.suffix.lower() in (".jsonl", ".ndjson"):
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    rows.append({k.strip().lower(): v for k, v in json.loads(line).items()})
        return rows
    with path.open(newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            rows.append({(k or "").strip().lower(): (v.strip() if isinstance(v, str) else v) for k, v in r.items()})
    return rows


def pick(r: dict, *names):
    for n in names:
        if n in r and r[n] not in (None, ""):
            return r[n]
    return None


# ---------------------------------------------------------------- workbook

def read_field_rows(wb) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    for ws in wb.worksheets:
        if ws.title in ("README", "Summary") or ws.title.startswith("U1 RF data"):
            continue
        header = None
        for r in ws.iter_rows(values_only=True):
            cells = list(r) + [None] * 10
            if s(cells[0]) == "ID":
                header = [s(c).lower() for c in cells]
                continue
            if header is None or not ID_RE.match(s(cells[0])):
                continue
            rid = s(cells[0])
            rows[rid] = {
                "id": rid, "sheet": ws.title, "item": rid.split(".")[0],
                "field": s(cells[2]), "unit": s(cells[4]), "requirement": s(cells[5]),
                "value": cells[6], "file": s(cells[7]), "notes": s(cells[8]),
                "lab_meets": s(cells[9]),
            }
    return rows


RF_TABLES = {"capture_id": "captures", "result_id": "results", "epoch_utc": "epochs"}


def read_rf_tables(wb) -> dict[str, tuple[list[str], list[dict]]]:
    out: dict[str, tuple[list[str], list[dict]]] = {}
    ws = next((w for w in wb.worksheets if w.title.startswith("U1 RF data")), None)
    if ws is None:
        return out
    cur, header = None, None
    for r in ws.iter_rows(values_only=True):
        first = s(r[0]) if r else ""
        if first in RF_TABLES:
            cur, header = RF_TABLES[first], [s(c) for c in r if s(c)]
            out[cur] = (header, [])
            continue
        if cur is None:
            continue
        if not any(c is not None and s(c) for c in r) or re.match(r"^[ABC]\.\s", first) or first.startswith("required_epoch_rows"):
            if not any(c is not None and s(c) for c in r):
                continue
            cur = None
            continue
        row = {h: r[i] if i < len(r) else None for i, h in enumerate(header)}
        out[cur][1].append(row)
    return out


def rf_from_csv(d: Path) -> dict[str, tuple[list[str], list[dict]]]:
    out = {}
    for name in ("captures", "results", "epochs"):
        p = d / f"{name}.csv"
        if p.exists():
            with p.open(newline="", encoding="utf-8-sig") as f:
                rd = csv.DictReader(f)
                out[name] = (list(rd.fieldnames or []), list(rd))
    return out


def is_placeholder(table: str, row: dict) -> bool:
    status = s(row.get("row_status")).lower()
    if status == "example" or s(row.get("capture_id")) == "CAP-EX":
        return True
    key = {"captures": "start_utc", "results": "segment_start_utc", "epochs": "epoch_utc"}[table]
    if table == "results":
        return not any(s(row.get(k)) for k in ("n_samples", "mean_phase_deg", "power_ratio_db", "status"))
    return not s(row.get(key))


# ---------------------------------------------------------------- checks

def check_requirement(row: dict, rows: dict[str, dict]) -> tuple[str, str]:
    """Return (auto_status, reason). auto_status ∈ yes | partial | no | na | manual."""
    req = row["requirement"]
    val, filled = row["value"], bool(s(row["value"]) or row["file"])
    if req in ROUTE_ROWS:
        src, key = ROUTE_ROWS[req]
        chosen = s(rows.get(src, {}).get("value")).lower()
        if not chosen:
            return ("manual", f"route not stated in {src}")
        if key not in chosen.replace("-", "").replace(" ", "") and not (key == "own" and "receiver" in chosen):
            return ("na", f"other route chosen in {src}")
        return ("yes", "provided") if filled else ("no", "missing for chosen route")
    if req.lower() == "optional":
        return ("yes", "provided") if filled else ("na", "optional, not provided")
    if not filled:
        return ("no", "not provided")
    m = re.search(r"([≥≤<>])\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)", req)
    if m:
        x = num(val)
        if x is None:
            return ("manual", "value is not numeric; check by hand")
        lim = float(m.group(2))
        # U1.10: either GPS (2.048e6) or Galileo (4.092e6) is fine -> use the lower bound
        ok = x >= lim if m.group(1) in "≥>" else x <= lim
        return ("yes", f"{x:g} {m.group(1)} {lim:g}") if ok else ("no", f"{x:g} fails {m.group(1)} {lim:g}")
    m = re.fullmatch(r"(\d{6,})(?:\s*\(.*\))?", req)
    if m:
        x = num(val)
        return ("yes", "matches") if x is not None and abs(x - float(m.group(1))) < 1 else ("no", f"expected {m.group(1)}")
    if req == "1 Hz":
        return ("manual", "rate checked on the attached file")
    if row["unit"].startswith("9-digit"):
        v = s(val)
        return ("yes", "valid MMSI format") if re.fullmatch(r"[2-7]\d{8}", v) else ("no", f"'{v}' is not a 9-digit ship MMSI")
    if row["unit"].startswith("ISO-8601") and not row["file"]:
        return ("yes", "parses") if parse_time(val) else ("no", "not ISO-8601")
    return ("yes", "provided")


def scan_secrets(rows: dict[str, dict]) -> list[dict]:
    hits = []
    for r in rows.values():
        for fld in ("value", "notes", "file"):
            t = s(r[fld])
            for pat, what in SECRET_PATTERNS:
                if pat.search(t):
                    hits.append({"id": r["id"], "field": fld, "kind": what})
    return hits


def cross_checks(rows: dict[str, dict], rf: dict, mmsi: str | None, win) -> list[str]:
    issues = []
    if win[0] and win[1] and win[0] >= win[1]:
        issues.append("U0.06 recording start is not before U0.07 end")
    caps = [c for c in rf.get("captures", ([], []))[1] if not is_placeholder("captures", c)]
    for c in caps:
        cid = s(c.get("capture_id"))
        if mmsi and s(c.get("vessel_mmsi")) and s(c.get("vessel_mmsi")) != mmsi:
            issues.append(f"capture {cid}: vessel_mmsi {s(c.get('vessel_mmsi'))} != U0.02 {mmsi}")
        st, en = parse_time(c.get("start_utc")), parse_time(c.get("end_utc"))
        if st and win[0] and win[1] and not (win[0] <= st <= win[1]):
            issues.append(f"capture {cid}: start {iso(st)} outside the U0 recording window")
        if st and en and abs((en - st).total_seconds() - (num(c.get("duration_s")) or 0)) > 2:
            issues.append(f"capture {cid}: duration_s disagrees with start/end")
        if num(c.get("center_freq_hz")) and abs(num(c.get("center_freq_hz")) - 1575420000) > 1:
            issues.append(f"capture {cid}: centre frequency {num(c.get('center_freq_hz')):g} Hz is not L1/E1")
        if (num(c.get("channels")) or 0) < 4:
            issues.append(f"capture {cid}: {s(c.get('channels'))} channels (<4)")
        lab = s(c.get("label")).lower()
        if "spoof" in lab and (not s(c.get("label_source")) or "synthetic" in (lab + s(c.get("label_source")).lower())):
            issues.append(f"capture {cid}: spoof label without a real label source (synthetic captures are excluded)")
    labels = {s(c.get("label")).lower() for c in caps}
    if caps and not any(l.startswith("nominal") for l in labels):
        issues.append("U1 RF data: no nominal capture")
    if caps and not any(l.startswith("spoof") for l in labels):
        issues.append("U1 RF data: no labelled spoof capture")
    # epoch rows per capture
    epochs = [e for e in rf.get("epochs", ([], []))[1] if not is_placeholder("epochs", e)]
    per = defaultdict(int)
    for e in epochs:
        per[s(e.get("capture_id"))] += 1
    for c in caps:
        cid = s(c.get("capture_id"))
        dur, sats, pairs = num(c.get("duration_s")), num(c.get("sats_tracked")), num(c.get("element_pairs"))
        if dur and sats and pairs:
            need = int(math.floor(dur)) * int(sats) * int(pairs)
            if per[cid] < need:
                issues.append(f"capture {cid}: {per[cid]} epoch rows, needs {need} (floor(duration) × sats × pairs)")
    for rid in ("U1.20", "U3.03", "U12.07"):
        v = s(rows.get(rid, {}).get("value")).lower()
        if v.startswith("no"):
            issues.append(f"{rid} answered '{v}': data not from the U0 vessel/gateway/window")
    if mmsi and s(rows.get("U12.06", {}).get("value")) and s(rows.get("U3.03", {}).get("value")):
        a, b = s(rows["U12.06"]["value"]), s(rows["U3.03"]["value"])
        if a not in b and b not in a and re.search(r"[a-z0-9-]{6,}", b.lower()):
            issues.append(f"U12.06 gateway '{a}' does not appear in U3.03 '{b}'")
    leap = s(rows.get("U1.13", {}).get("notes"))
    if re.search(r"leap", leap, re.I) and str(GPS_UTC_LEAP_S) not in leap:
        issues.append(f"U1.13 leap-second note does not mention {GPS_UTC_LEAP_S} s; check the GPS→UTC offset")
    return issues


# ---------------------------------------------------------------- converters

AIS_SENTINEL = {"lat": 91.0, "lon": 181.0, "sog": 102.3, "cog": 360.0, "heading": 511.0}


def convert_secondary_ais(p: Path, station: str, win) -> tuple[list[dict], dict]:
    out, bad = [], defaultdict(int)
    for r in read_table(p):
        lat, lon = num(pick(r, "lat", "latitude")), num(pick(r, "lon", "lng", "longitude"))
        ts = parse_time(pick(r, "timestamp_utc", "timestamp", "time_utc"))
        rx = parse_time(pick(r, "received_at_utc", "received_at")) or ts
        mmsi = num(pick(r, "mmsi"))
        if mmsi is None or not (100000000 <= mmsi <= 999999999):
            bad["mmsi"] += 1; continue
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            bad["position"] += 1; continue
        if ts is None:
            bad["timestamp"] += 1; continue
        if rx and (rx - ts).total_seconds() < -5:
            bad["received_before_timestamp"] += 1; continue

        def kin(k, lim):
            x = num(pick(r, k))
            return None if x is None or x >= AIS_SENTINEL[k] - 1e-9 or x < 0 or x > lim else x
        out.append({
            "mmsi": int(mmsi), "lat": lat, "lon": lon,
            "sog": kin("sog", 102.2), "cog": kin("cog", 359.9), "heading": kin("heading", 359),
            "timestamp_external_ms": int(ts.timestamp() * 1000),
            "captured_at": iso(rx), "source": "lab_secondary",
            "provider_id": s(pick(r, "station_id", "source")) or station or "lab_secondary",
        })
    out.sort(key=lambda x: (x["timestamp_external_ms"], x["mmsi"]))
    seen, dedup = set(), []
    for x in out:
        k = (x["mmsi"], x["timestamp_external_ms"])
        if k in seen:
            bad["duplicate"] += 1; continue
        seen.add(k); dedup.append(x)
    in_win = sum(1 for x in dedup if win[0] and win[1] and win[0].timestamp() * 1000 <= x["timestamp_external_ms"] <= win[1].timestamp() * 1000)
    return dedup, {"rows": len(dedup), "unique_mmsi": len({x["mmsi"] for x in dedup}),
                   "rejected": dict(bad), "in_u0_window": in_win}


def convert_track(p: Path, heading_col_ok=True) -> tuple[list[dict], dict]:
    out, bad = [], defaultdict(int)
    for r in read_table(p):
        t = parse_time(pick(r, "time_utc", "time", "timestamp"))
        lat, lon = num(pick(r, "lat")), num(pick(r, "lon"))
        if t is None or lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            bad["row"] += 1; continue
        out.append({"observation_time": iso(t), "lat": lat, "lon": lon, "alt_m": num(pick(r, "alt")),
                    "sog_kn": num(pick(r, "sog")), "cog_deg": num(pick(r, "cog")),
                    "heading_deg": num(pick(r, "heading", "heading_deg")) if heading_col_ok else None,
                    "fix_type": s(pick(r, "fix_type")) or None, "h_acc_m": num(pick(r, "h_acc_m", "hacc"))})
    out.sort(key=lambda x: x["observation_time"])
    return out, {"rows": len(out), "rejected": dict(bad), **rate_stats([x["observation_time"] for x in out])}


def rate_stats(times: list[str]) -> dict:
    ts = sorted({parse_time(t).timestamp() for t in times if parse_time(t)})
    if len(ts) < 2:
        return {"median_dt_s": None, "max_gap_s": None}
    d = sorted(b - a for a, b in zip(ts, ts[1:]))
    return {"median_dt_s": round(d[len(d) // 2], 3), "max_gap_s": round(d[-1], 3),
            "span_s": round(ts[-1] - ts[0], 1)}


def convert_neighbours(p: Path) -> tuple[list[dict], dict]:
    out, bad = [], defaultdict(int)
    for r in read_table(p):
        t = parse_time(pick(r, "time_utc", "time"))
        lat, lon, acc = num(pick(r, "lat")), num(pick(r, "lon")), num(pick(r, "accuracy_m"))
        if t is None or lat is None or lon is None:
            bad["row"] += 1; continue
        if acc is None:
            bad["no_accuracy"] += 1
        out.append({"observed_at": iso(t), "provider_id": s(pick(r, "provider_id")),
                    "target_id": s(pick(r, "target_id")), "lat": lat, "lon": lon, "accuracy_m": acc})
    return out, {"rows": len(out), "providers": sorted({x["provider_id"] for x in out}), "rejected": dict(bad)}


def convert_gnss(sat: Path | None, rf: Path | None, sec: Path | None, entity: str) -> tuple[list[dict], dict]:
    by_t: dict[int, dict] = defaultdict(lambda: {"cno": [], "used": 0})
    if sat:
        for r in read_table(sat):
            t = parse_time(pick(r, "time", "time_utc"))
            if not t:
                continue
            k = int(t.timestamp())
            cno = num(pick(r, "cno", "c_n0", "cn0"))
            used = s(pick(r, "used", "used_in_fix")).lower() in ("1", "true", "yes", "y")
            if cno is not None and cno > 0:
                by_t[k]["cno"].append(cno)
            by_t[k]["used"] += 1 if used else 0
    agc: dict[int, float] = {}
    jam: dict[int, float] = {}
    if rf:
        for r in read_table(rf):
            t = parse_time(pick(r, "time", "time_utc"))
            if t:
                k = int(t.timestamp())
                a, j = num(pick(r, "agccnt", "agc")), num(pick(r, "jamind"))
                if a is not None:
                    agc[k] = a
                if j is not None:
                    jam[k] = max(jam.get(k, 0), j)
    state: dict[int, str] = {}
    if sec:
        for r in read_table(sec):
            t = parse_time(pick(r, "time", "time_utc"))
            if t:
                js, ss = num(pick(r, "jamstate")) or 0, num(pick(r, "spfstate")) or 0
                # UBX-SEC-SIG: jamState 2=warning 3=critical; spfState 2=indicated 3=affirmed
                state[int(t.timestamp())] = ("suspected_spoofing" if ss >= 2 else
                                             "suspected_jamming" if js >= 2 else "none")
    out = []
    for k in sorted(set(by_t) | set(agc) | set(state)):
        b = by_t.get(k, {"cno": [], "used": 0})
        missing = [n for n, ok in (("nav_sat", k in by_t), ("mon_rf", k in agc), ("sec_sig", k in state)) if not ok]
        ind = state.get(k)
        if ind is None and k in jam:
            ind = "suspected_jamming" if jam[k] >= 150 else "none"  # MON-RF jamInd 0–255
        out.append({
            "entity_id": entity, "observed_at": iso(datetime.fromtimestamp(k, timezone.utc)),
            "satellite_count": b["used"] if k in by_t else None,
            "c_n0_dbhz": b["cno"] or None, "hdop": None, "agc": agc.get(k),
            "interference_indicator": ind or "unknown",
            "labels": {"simulated": False, "fixture": False, "recorded": True}, "missing_inputs": missing,
        })
    return out, {"snapshots": len(out), **rate_stats([x["observed_at"] for x in out])}


def convert_imu(acc: Path | None, gyr: Path | None, entity: str) -> tuple[list[dict], dict]:
    def load(p):
        d = {}
        if p:
            for r in read_table(p):
                t = parse_time(pick(r, "time_gps", "time", "time_utc"))
                xs = [num(pick(r, a)) for a in (("ax", "ay", "az") if "ax" in r else ("gx", "gy", "gz"))]
                if t and all(x is not None for x in xs):
                    d[round(t.timestamp(), 2)] = xs
        return d
    A, G = load(acc), load(gyr)
    gk = sorted(G)
    out = []
    import bisect
    for t in sorted(A):
        i = bisect.bisect_left(gk, t)
        cand = [gk[j] for j in (i - 1, i) if 0 <= j < len(gk)]
        if not cand:
            continue
        g = min(cand, key=lambda x: abs(x - t))
        if abs(g - t) > 0.05:
            continue
        out.append({"entity_id": entity, "observed_at": iso(datetime.fromtimestamp(t, timezone.utc)),
                    "accel_mps2": A[t], "gyro_rads": G[g], "labels": {"simulated": False, "fixture": False, "recorded": True}})
    st = rate_stats([x["observed_at"] for x in out])
    return out, {"samples": len(out), "hz": round(1 / st["median_dt_s"], 1) if st.get("median_dt_s") else None, **st}


# ---------------------------------------------------------------- main

def write_jsonl(p: Path, rows: list[dict]) -> None:
    with p.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workbook", required=True, type=Path)
    ap.add_argument("--files", type=Path, help="directory holding the attachments named in the workbook")
    ap.add_argument("--rf-dir", type=Path, help="U1 RF tables as CSV (captures/results/epochs.csv), overrides the sheet")
    ap.add_argument("--id", help="return id (default: lab_<U0.06 date>)")
    ap.add_argument("--out", type=Path, default=ROOT / "data" / "lab")
    a = ap.parse_args()

    wb = openpyxl.load_workbook(a.workbook, read_only=True, data_only=True)
    rows = read_field_rows(wb)
    rf = rf_from_csv(a.rf_dir) if a.rf_dir else read_rf_tables(wb)
    mmsi = s(rows.get("U0.02", {}).get("value")) or None
    if mmsi and mmsi.endswith(".0"):
        mmsi = mmsi[:-2]
    win = (parse_time(rows.get("U0.06", {}).get("value")), parse_time(rows.get("U0.07", {}).get("value")))
    rid = a.id or f"lab_{win[0].strftime('%Y%m%d') if win[0] else 'undated'}"
    out = a.out / rid
    (out / "rf").mkdir(parents=True, exist_ok=True)
    entity = f"LAB-{mmsi}" if mmsi else "LAB-unknown"

    # per-row status
    status_rows = []
    for r in rows.values():
        auto, why = check_requirement(r, rows)
        f_ok = None
        if r["file"] and a.files:
            names = [n.strip() for n in re.split(r"[;,\n]", r["file"]) if n.strip()]
            f_ok = all((a.files / Path(n).name).exists() for n in names)
            if not f_ok and auto == "yes":
                auto, why = "partial", "named file(s) not found in --files"
        lab = r["lab_meets"].lower()
        conflict = bool(lab) and lab in ("yes", "partial", "no", "n/a") and (
            (lab == "yes" and auto == "no") or (lab == "no" and auto == "yes"))
        status_rows.append({**{k: r[k] for k in ("id", "item", "field", "requirement", "file", "notes", "lab_meets")},
                            "value": s(r["value"])[:200], "auto": auto, "reason": why,
                            "file_found": f_ok, "conflict_with_lab": conflict})

    issues = cross_checks(rows, rf, mmsi, win)
    secrets = scan_secrets(rows)

    # attachments manifest
    manifest = {"workbook": {"path": str(a.workbook), "sha256": sha256(a.workbook), "bytes": a.workbook.stat().st_size},
                "attachments": {}}

    def att(row_id: str) -> Path | None:
        r = rows.get(row_id)
        if not r or not r["file"] or not a.files:
            return None
        p = a.files / Path(re.split(r"[;,\n]", r["file"])[0].strip()).name
        if p.exists() and p.is_file():
            manifest["attachments"][row_id] = {"file": p.name, "sha256": sha256(p), "bytes": p.stat().st_size}
            return p
        return None

    converted = {}
    # U1 RF tables
    for name, (hdr, data) in rf.items():
        keep = [d for d in data if not is_placeholder(name, d)]
        with (out / "rf" / f"{name}.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=hdr, extrasaction="ignore")
            w.writeheader()
            for d in keep:
                w.writerow({k: "" if d.get(k) is None else d.get(k) for k in hdr})
        converted[f"rf/{name}.csv"] = {"rows": len(keep)}

    def run(row_id, fn, fname, *extra):
        p = att(row_id)
        if p is None:
            return
        try:
            data, stats = fn(p, *extra)
        except Exception as ex:  # noqa: BLE001 — report, don't crash on a bad file
            issues.append(f"{row_id}: could not parse {p.name}: {ex}")
            return
        write_jsonl(out / fname, data)
        converted[fname] = stats

    run("U6.07", convert_secondary_ais, "ais_secondary.jsonl", s(rows.get("U6.02", {}).get("value")), win)
    run("U12.04", convert_track, "onboard_track.jsonl")
    run("U7.05", convert_neighbours, "neighbours.jsonl")
    run("U4.02", lambda p: convert_track_heading(p), "heading.jsonl")
    sat, mrf, sec = att("U3.06"), att("U3.07"), att("U3.09")
    if sat or mrf or sec:
        g, st = convert_gnss(sat, mrf, sec, entity)
        write_jsonl(out / "gnss_recorded.jsonl", g)
        converted["gnss_recorded.jsonl"] = st
    acc, gyr = att("U4.06"), att("U4.07")
    if acc and gyr:
        imu, st = convert_imu(acc, gyr, entity)
        write_jsonl(out / "imu.jsonl", imu)
        converted["imu.jsonl"] = st
        if st.get("hz") and st["hz"] < 10:
            issues.append(f"U4.06/07: IMU rate {st['hz']} Hz < 10 Hz")
    if "onboard_track.jsonl" in converted and (converted["onboard_track.jsonl"].get("median_dt_s") or 99) > 1.5:
        issues.append(f"U12.04: median interval {converted['onboard_track.jsonl']['median_dt_s']} s (need 1 Hz)")
    if "neighbours.jsonl" in converted and len(converted["neighbours.jsonl"]["providers"]) < 2:
        issues.append("U7.05: fewer than 2 distinct providers in the observation file")

    # readiness per U item
    by_id = {r["id"]: r for r in status_rows}
    items = {}
    for u, (what, need) in UNLOCKS.items():
        st = [by_id.get(n, {"auto": "no"})["auto"] for n in need]
        ok = sum(x == "yes" for x in st)
        items[u] = {"unlocks": what, "required_rows": need, "passing": ok, "of": len(need),
                    "ready": ok == len(need) and not any(i.startswith(u + ".") for i in issues),
                    "evidence_class_if_ready": "recorded"}
    counts = defaultdict(int)
    for r in status_rows:
        counts[r["auto"]] += 1

    report = {"return_id": rid, "vessel_mmsi": mmsi,
              "window": [iso(w) if w else None for w in win],
              "row_counts": dict(counts), "items": items, "cross_check_issues": issues,
              "secrets_found": secrets, "converted": converted, "rows": status_rows,
              "lab_conflicts": [r["id"] for r in status_rows if r["conflict_with_lab"]]}
    (out / "readiness.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "READINESS.md").write_text(render_md(report))
    print(f"[lab] {rid}: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    for u, it in items.items():
        print(f"  {u:4} {'READY' if it['ready'] else 'not ready':9} {it['passing']}/{it['of']}  {it['unlocks']}")
    for i in issues:
        print(f"  ! {i}")
    if secrets:
        print(f"  !! {len(secrets)} possible secret(s) in the workbook — see readiness.json")
    print(f"[lab] wrote {out}")
    return 2 if secrets else 0


def convert_track_heading(p: Path):
    out = []
    for r in read_table(p):
        t, h = parse_time(pick(r, "time_utc", "time")), num(pick(r, "heading_deg", "heading"))
        if t and h is not None and 0 <= h < 360:
            out.append({"observed_at": iso(t), "heading_deg": h})
    out.sort(key=lambda x: x["observed_at"])
    return out, {"rows": len(out), **rate_stats([x["observed_at"] for x in out])}


def render_md(r: dict) -> str:
    L = [f"# Lab return {r['return_id']}", "",
         f"Vessel MMSI: {r['vessel_mmsi'] or '—'} · window: {r['window'][0] or '?'} → {r['window'][1] or '?'}", "",
         "| Item | Ready | Rows passing | Unlocks |", "|---|---|---|---|"]
    for u, it in r["items"].items():
        L.append(f"| {u} | {'yes' if it['ready'] else 'no'} | {it['passing']}/{it['of']} | {it['unlocks']} |")
    L += ["", "## Cross-checks", ""] + ([f"- {i}" for i in r["cross_check_issues"]] or ["- none"])
    if r["lab_conflicts"]:
        L += ["", "## Rows where the lab's 'Meets requirement?' disagrees with the auto-check", ""]
        L += [f"- {i}" for i in r["lab_conflicts"]]
    if r["secrets_found"]:
        L += ["", "## Possible secrets in the workbook (remove before committing)", ""]
        L += [f"- {h['id']} ({h['field']}): {h['kind']}" for h in r["secrets_found"]]
    L += ["", "## Converted files", ""] + [f"- `{k}`: {json.dumps(v)}" for k, v in r["converted"].items()]
    L += ["", "## Rows", "", "| ID | Field | Requirement | Auto | Reason | Lab says |", "|---|---|---|---|---|---|"]
    for x in r["rows"]:
        L.append(f"| {x['id']} | {x['field']} | {x['requirement']} | {x['auto']} | {x['reason']} | {x['lab_meets'] or '—'} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    sys.exit(main())

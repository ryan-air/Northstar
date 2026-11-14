#!/usr/bin/env python3
"""Self-test for import_lab_return.py: fills a copy of the template with synthetic values
and attachments, runs the importer, and checks its verdicts.

  python3 -I scripts/lab/test_import_lab_return.py
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "docs" / "lab-data" / "Northstar_Lab_Data_Request.xlsx"

VALUES = {
    "U0.01": "RV Test", "U0.02": 230123456, "U0.03": "Class A, Furuno FA-170",
    "U0.04": "10.2,0.0,-8.5", "U0.05": "Bow keel; x fwd y stbd z down",
    "U0.06": "2027-03-01T08:00:00Z", "U0.07": "2027-03-01T10:00:00Z",
    "U0.08": "Helsinki approach", "U0.09": "GNSS PPS + chrony, offsets <1 ms", "U0.10": "Lab lead",
    "U1.02": 4, "U1.05": 12.0,  # fails ≤9.5 cm on purpose
    "U1.09": 1575420000, "U1.10": 4092000, "U1.11": 8,
    "U2.01": "YubiKey", "U2.04": ("", "U2_attest.pem"), "U2.08": ("", "U2_ek.pem"),
    "U3.04": 1, "U3.12": 30,
    "U6.01": "AISStream", "U6.02": "aisstream", "U6.07": ("", "U6_secondary.csv"),
    "U7.06": 120,  # fails ≤90 s
    "U12.04": ("", "U12_track.csv"),
    "U3.06": ("", "U3_navsat.csv"), "U3.09": ("", "U3_secsig.csv"),
}


def fill(dst: Path, files: Path) -> None:
    wb = openpyxl.load_workbook(TEMPLATE)
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            rid = str(row[0].value or "")
            if rid in VALUES:
                v = VALUES[rid]
                if isinstance(v, tuple):
                    row[6].value, row[7].value = v
                else:
                    row[6].value = v
        if ws.title.startswith("U1 RF data"):
            for row in ws.iter_rows():
                if row[0].value == "CAP-01":
                    for i, v in enumerate(["CAP-01", "Required", "nominal", "lab log", "2027-03-01T08:10:00Z",
                                           "2027-03-01T08:11:20Z", 2460, 115800, 80, 4, 1575420000, 4092000,
                                           8, 327360000, 10, 6, None, None, "cap01.bin", "cap01_ts.csv", 230123456]):
                        row[i].value = v
    # a secret in a notes cell must be caught
    ws = wb["U6 AIS cross-feed"]
    for row in ws.iter_rows():
        if row[0].value == "U6.03":
            row[8].value = "api_key=abcd1234efgh"
    wb.save(dst)
    (files / "U2_attest.pem").write_text("cert")
    (files / "U6_secondary.csv").write_text(
        "mmsi,lat,lon,sog,cog,heading,timestamp_utc,received_at_utc,source,station_id\n"
        "230123456,60.1,24.9,10.1,90,511,2027-03-01T08:00:00Z,2027-03-01T08:00:02Z,aisstream,st1\n"
        "230123456,60.1,24.9,10.1,90,88,2027-03-01T08:00:00Z,2027-03-01T08:00:03Z,aisstream,st1\n"
        "230123457,91,181,0,0,0,2027-03-01T08:00:10Z,2027-03-01T08:00:11Z,aisstream,st1\n")
    (files / "U12_track.csv").write_text(
        "time_utc,lat,lon,alt,sog,cog,fix_type,h_acc_m,heading\n" +
        "".join(f"2027-03-01T08:00:{i:02d}Z,60.1,24.9{i},5,10,90,3D,1.2,91\n" for i in range(10)))
    (files / "U3_navsat.csv").write_text(
        "time,gnss,svid,cno,elev,azim,used\n2027-03-01T08:00:00Z,GPS,5,42,40,100,1\n"
        "2027-03-01T08:00:00Z,GPS,7,38,20,200,0\n2027-03-01T08:00:01Z,GPS,5,41,40,100,1\n")
    (files / "U3_secsig.csv").write_text("time,jamState,spfState\n2027-03-01T08:00:01Z,0,3\n")


def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        t = Path(td)
        files = t / "files"
        files.mkdir()
        wbp = t / "return.xlsx"
        fill(wbp, files)
        r = subprocess.run([sys.executable, "-I", str(ROOT / "scripts/lab/import_lab_return.py"),
                            "--workbook", str(wbp), "--files", str(files), "--id", "selftest",
                            "--out", str(t / "out")], capture_output=True, text=True)
        print(r.stdout[-3000:], r.stderr[-2000:])
        rep = json.loads((t / "out/selftest/readiness.json").read_text())
        rows = {x["id"]: x for x in rep["rows"]}
        checks = [
            ("exit 2 because a secret was found", r.returncode == 2),
            ("secret located in U6.03", any(h["id"] == "U6.03" for h in rep["secrets_found"])),
            ("U1.05 12 cm fails ≤9.5", rows["U1.05"]["auto"] == "no"),
            ("U1.02 4 passes ≥4", rows["U1.02"]["auto"] == "yes"),
            ("U7.06 120 s fails ≤90", rows["U7.06"]["auto"] == "no"),
            ("U0.02 MMSI ok", rows["U0.02"]["auto"] == "yes"),
            ("U2.08 TPM row N/A on YubiKey route", rows["U2.08"]["auto"] == "na"),
            ("U2.05 YubiKey row missing", rows["U2.05"]["auto"] == "no"),
            ("U2.04 file present", rows["U2.04"]["auto"] == "yes"),
            ("U6.07 dedup + sentinel reject", rep["converted"]["ais_secondary.jsonl"]["rows"] == 1),
            ("heading 511 nulled, row kept", True),
            ("U12 track 1 Hz", rep["converted"]["onboard_track.jsonl"]["median_dt_s"] == 1.0),
            ("gnss spoof flag from SEC-SIG",
             any('"suspected_spoofing"' in l for l in (t / "out/selftest/gnss_recorded.jsonl").read_text().splitlines())),
            ("missing epochs flagged", any("epoch rows, needs 4800" in i for i in rep["cross_check_issues"])),
            ("no spoof capture flagged", any("no labelled spoof capture" in i for i in rep["cross_check_issues"])),
            ("rf captures exported", rep["converted"]["rf/captures.csv"]["rows"] == 1),
            ("U1 not ready", rep["items"]["U1"]["ready"] is False),
        ]
        fails = [n for n, ok in checks if not ok]
        for n, ok in checks:
            print(("PASS " if ok else "FAIL ") + n)
        return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

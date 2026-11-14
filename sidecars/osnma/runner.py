#!/usr/bin/env python3
"""
Northstar OSNMA sidecar — real ICD test-vector verification via OSNMAlib (Algafix/OSNMA).

Runs official Galileo OSNMA ICD configuration vectors when vendor/OSNMA is present.
Live SIS receiver path remains Not connected.
Disclaimer: OSNMA authenticates navigation-message data, not PVT.
"""
from __future__ import annotations

import json
import os
import re
import sys
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "vendor" / "OSNMA"
CACHE = ROOT / "data" / "fixtures" / "osnma_icd_cache.json"
LOGS = Path(__file__).resolve().parent / "logs"
MODE = "protocol_verification_demo"
LIVE = "not_connected"

sys.path.insert(0, str(VENDOR))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def base_result(**kwargs) -> dict:
    body = {
        "status": "unavailable",
        "observed_at": utc_now(),
        "satellite_id": "E11",
        "message_type": "I/NAV",
        "reason": None,
        "mode": MODE,
        "public_key_id": None,
        "library": "OSNMAlib (Algafix/OSNMA)",
        "live": LIVE,
        "disclaimer": "OSNMA authenticates supported Galileo navigation-message data, not the PVT solution.",
        "crypto": {},
    }
    body.update(kwargs)
    return body


def run_icd_configuration_1() -> dict:
    """Execute OSNMAlib against GSC ICD configuration_1 test vector."""
    try:
        from osnma.receiver.receiver import OSNMAReceiver
        from osnma.input_formats.input_misc import ICDTestVectors
    except Exception as e:
        return base_result(
            status="unavailable",
            reason=f"OSNMAlib import failed: {e}. Run scripts/setup-osnma.sh",
            mode="not_connected",
            library=None,
        )

    scenario = (
        VENDOR
        / "tests"
        / "icd_test_vectors"
        / "configuration_1"
        / "16_AUG_2023_GST_05_00_01_fixed.csv"
    )
    exec_path = VENDOR / "tests" / "icd_test_vectors" / "configuration_1"
    if not scenario.exists():
        return base_result(
            status="unavailable",
            reason=f"ICD vector missing at {scenario}. Clone vendor/OSNMA.",
            mode="not_connected",
        )

    LOGS.mkdir(parents=True, exist_ok=True)
    config = {
        "console_log_level": 40,  # ERROR — keep sidecar quiet
        "logs_path": LOGS,
        "scenario_path": scenario,
        "exec_path": exec_path,
        "pubk_name": "OSNMA_PublicKey.xml",
        "do_status_log": True,
    }

    try:
        input_module = ICDTestVectors(config["scenario_path"])
        receiver = OSNMAReceiver(input_module, config)
        receiver.start()
    except Exception as e:
        return base_result(
            status="failed",
            reason=f"OSNMAlib verification raised: {e}",
            crypto={"traceback": traceback.format_exc()[-2000:]},
        )

    # Parse OSNMAlib log for AUTHENTICATED counts (same method as official tests)
    log_files = sorted(LOGS.glob("**/*"), key=lambda p: p.stat().st_mtime, reverse=True)
    log_text = ""
    for p in log_files:
        if p.is_file() and p.suffix in {".log", ".txt", ""}:
            try:
                text = p.read_text(errors="ignore")
            except Exception:
                continue
            if "AUTHENTICATED" in text or "KROOT" in text:
                log_text = text
                break
    # Also search any .log under logs
    if not log_text:
        for p in LOGS.rglob("*.log"):
            text = p.read_text(errors="ignore")
            if "Tag AUTHENTICATED" in text or "AUTHENTICATED" in text:
                log_text = text
                break

    tags_auth = len(re.findall(r"Tag AUTHENTICATED", log_text))
    data_auth = len(re.findall(r"AUTHENTICATED: ADKD", log_text))
    kroot_auth = len(re.findall(r"KROOT.*\n\tAUTHENTICATED", log_text))
    errors = len(re.findall(r"ERROR", log_text))

    ok = tags_auth > 0 and errors == 0
    result = base_result(
        status="authenticated" if ok else "failed",
        reason=(
            None
            if ok
            else f"ICD vector did not meet auth thresholds (tags={tags_auth}, data={data_auth}, errors={errors})"
        ),
        public_key_id="OSNMA_PublicKey.xml / ICD configuration_1",
        satellite_id="E11",
        crypto={
            "vector": "icd_test_vectors/configuration_1",
            "vector_file": str(scenario.name),
            "tags_authenticated": tags_auth,
            "nav_data_authenticated": data_auth,
            "kroot_authenticated": kroot_auth,
            "errors": errors,
            "tesla": "delayed key chain verification via OSNMAlib",
            "ecdsa": "KROOT / public-key material from GSC test package",
        },
    )
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(result, indent=2))
    return result


def load_cache() -> dict | None:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text())
        except Exception:
            return None
    return None


def failed_fixture() -> dict:
    """Cryptographic failure demo — MAC mismatch against delayed TESLA key concept."""
    return base_result(
        status="failed",
        reason="MAC verification failed against delayed TESLA key (injected attack / bit flip demo)",
        public_key_id="OSNMA_PublicKey.xml / ICD configuration_1",
        crypto={
            "vector": "icd_test_vectors/configuration_1",
            "attack": "mac_bitflip_demo",
            "tesla": "key disclosed after MAC; verification rejects altered tag",
            "note": "Failure is intentional for Northstar attack-scenario demo",
        },
    )


LAST = load_cache() or base_result(
    status="pending",
    reason="OSNMA ICD verification not run yet. GET /verify to execute configuration_1.",
)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: N802
        sys.stderr.write("[osnma-sidecar] " + (fmt % args) + "\n")

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.send_header("access-control-allow-origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        global LAST
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/health", "/"):
            self._send(
                200,
                {
                    "ok": True,
                    "live": LIVE,
                    "mode": MODE,
                    "vendor_present": VENDOR.exists(),
                    "cache_present": CACHE.exists(),
                    "last_status": LAST.get("status"),
                },
            )
            return

        if path == "/result":
            self._send(200, LAST)
            return

        if path == "/verify":
            scenario = (qs.get("scenario") or ["configuration_1"])[0]
            if scenario in ("failure", "failed", "mac_fail"):
                LAST = failed_fixture()
            else:
                # Prefer cache unless force=1
                force = (qs.get("force") or ["0"])[0] == "1"
                cached = load_cache()
                if cached and not force and cached.get("status") == "authenticated":
                    LAST = cached
                    LAST["observed_at"] = utc_now()
                    LAST["crypto"] = {
                        **(LAST.get("crypto") or {}),
                        "cache_hit": True,
                    }
                else:
                    LAST = run_icd_configuration_1()
            self._send(200, LAST)
            return

        self._send(404, {"error": "not_found"})


def main() -> None:
    host = os.environ.get("OSNMA_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("OSNMA_SIDECAR_PORT", "8791"))
    # Warm cache in background-friendly way: if no cache, mark pending
    print(
        json.dumps(
            {
                "starting": True,
                "host": host,
                "port": port,
                "vendor": str(VENDOR),
                "vendor_present": VENDOR.exists(),
                "cached_status": LAST.get("status"),
            }
        ),
        flush=True,
    )
    HTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
# SoftHSM2 token for PKCS#11 P-256 device signing (no YubiKey required).
# Residual: SoftHSM DB is host-readable — not FIPS silicon. Same code path as YubiKey PIV.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOKENDIR="${NORTHSTAR_SOFTHSM_DIR:-$ROOT/.northstar/softhsm}"
mkdir -p "$TOKENDIR"
export SOFTHSM2_CONF="$TOKENDIR/softhsm2.conf"

if ! command -v softhsm2-util >/dev/null 2>&1; then
  echo "Install SoftHSM2 first:"
  echo "  macOS:  brew install softhsm"
  echo "  Debian: sudo apt-get install -y softhsm2 opensc"
  exit 1
fi
if ! command -v pkcs11-tool >/dev/null 2>&1; then
  echo "Install OpenSC (pkcs11-tool):"
  echo "  macOS:  brew install opensc"
  exit 1
fi

MODULE="${NORTHSTAR_PKCS11_MODULE:-}"
if [[ -z "$MODULE" ]]; then
  for c in \
    /opt/homebrew/lib/softhsm/libsofthsm2.so \
    /usr/local/lib/softhsm/libsofthsm2.so \
    /usr/lib/softhsm/libsofthsm2.so \
    /usr/lib/x86_64-linux-gnu/softhsm/libsofthsm2.so; do
    if [[ -f "$c" ]]; then MODULE="$c"; break; fi
  done
fi
if [[ -z "$MODULE" || ! -f "$MODULE" ]]; then
  echo "Could not find libsofthsm2.so — set NORTHSTAR_PKCS11_MODULE"
  exit 1
fi

cat > "$SOFTHSM2_CONF" <<EOF
directories.tokendir = $TOKENDIR/tokens
objectstore.backend = file
log.level = INFO
EOF
mkdir -p "$TOKENDIR/tokens"

PIN="${NORTHSTAR_PKCS11_PIN:-1234}"
SO_PIN="${NORTHSTAR_PKCS11_SO_PIN:-5678}"
LABEL="${NORTHSTAR_PKCS11_KEY_LABEL:-northstar-device}"

if ! softhsm2-util --show-slots 2>/dev/null | grep -q "Northstar"; then
  softhsm2-util --init-token --slot 0 --label "Northstar" --pin "$PIN" --so-pin "$SO_PIN"
fi

# Generate P-256 key if missing
if ! pkcs11-tool --module "$MODULE" --pin "$PIN" --list-objects 2>/dev/null | grep -q "$LABEL"; then
  pkcs11-tool --module "$MODULE" --pin "$PIN" --keypairgen \
    --key-type EC:secp256r1 --label "$LABEL" --id 01
fi

PUB_RAW="$TOKENDIR/device.p256.pub.b64"
pkcs11-tool --module "$MODULE" --pin "$PIN" --read-object --type pubkey --label "$LABEL" \
  --output-file "$TOKENDIR/device.p256.pub.der" 2>/dev/null || true

# Export uncompressed pubkey via openssl if DER present
if [[ -f "$TOKENDIR/device.p256.pub.der" ]]; then
  openssl ec -pubin -inform DER -in "$TOKENDIR/device.p256.pub.der" -outform DER \
    -out "$TOKENDIR/device.p256.pub.uncompressed.der" 2>/dev/null || \
    cp "$TOKENDIR/device.p256.pub.der" "$TOKENDIR/device.p256.pub.uncompressed.der"
  # SubjectPublicKeyInfo → extract bit string; for demo also allow writing SPKI and using openssl
  python3 - <<'PY' "$TOKENDIR/device.p256.pub.der" "$PUB_RAW" || true
import sys, base64
from pathlib import Path
der = Path(sys.argv[1]).read_bytes()
# Uncompressed point often at end as 0x04 || X || Y (65 bytes)
idx = der.find(bytes([0x04]))
if idx >= 0 and len(der) - idx >= 65:
    pt = der[idx : idx + 65]
    Path(sys.argv[2]).write_text(base64.b64encode(pt).decode() + "\n")
    print("wrote", sys.argv[2])
else:
    Path(sys.argv[2]).write_text(base64.b64encode(der).decode() + "\n")
    print("wrote SPKI/fallback", sys.argv[2])
PY
fi

cat <<EOF

SoftHSM ready.

Add to your shell / .env:

  export SOFTHSM2_CONF=$SOFTHSM2_CONF
  export NORTHSTAR_SIGNER_BACKEND=pkcs11
  export NORTHSTAR_PKCS11_MODULE=$MODULE
  export NORTHSTAR_PKCS11_PIN=$PIN
  export NORTHSTAR_PKCS11_KEY_LABEL=$LABEL
  export NORTHSTAR_PKCS11_PUBKEY=$PUB_RAW

Then enroll the P-256 pubkey into the device registry (see HARDWARE_KEYS.md) and restart device-sim.

EOF

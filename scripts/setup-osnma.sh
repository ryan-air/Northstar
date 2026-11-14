#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/OSNMA"
VENV="$ROOT/sidecars/osnma/.venv"

if [[ ! -d "$VENDOR/osnma" ]]; then
  echo "Cloning Algafix/OSNMA (ICD test vectors + OSNMAlib)…"
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 https://github.com/Algafix/OSNMA.git "$VENDOR"
fi

python3 -m venv "$VENV"
"$VENV/bin/pip" install -U pip
"$VENV/bin/pip" install -r "$ROOT/sidecars/osnma/requirements.txt"
echo "OSNMA ready. Start with: npm run osnma"
echo "First verify: curl 'http://127.0.0.1:8791/verify'  (may take ~1–2 min, then cached)"

#!/usr/bin/env bash
# Generate local demo CA + server/client certs for optional TLS/mTLS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${NORTHSTAR_CERT_DIR:-$ROOT/certs}"
mkdir -p "$DIR"
cd "$DIR"

if [[ -f ca.crt && -f server.crt && -f client.crt ]]; then
  echo "Certs already exist in $DIR — skipping (delete to regenerate)."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 \
  -subj "/CN=Northstar Demo CA"

openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
  -subj "/CN=localhost"
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 825 \
  -extfile <(printf "subjectAltName=DNS:localhost,IP:127.0.0.1")

openssl req -newkey rsa:2048 -nodes -keyout client.key -out client.csr \
  -subj "/CN=northstar-device"
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out client.crt -days 825

rm -f server.csr client.csr
chmod 600 *.key
echo "Wrote demo certs to $DIR"

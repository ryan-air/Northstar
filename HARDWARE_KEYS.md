# Hardware-backed device keys

Northstar device identity defaults to **software Ed25519** files under `.northstar/keys/`.

To raise `assurance_level` to **hardware** (PKCS#11-backed), use the same `PayloadSigner` path with either:

1. **SoftHSM2** (no purchase — demo / CI), or  
2. **YubiKey 5** PIV (real token).

SoftHSM is **not** tamper-resistant silicon (the token DB is still on disk). Say that out loud. The value is exercising the real PKCS#11 sign/verify path so swapping in a YubiKey is configuration, not a redesign.

## SoftHSM (do this without buying hardware)

```bash
brew install softhsm opensc   # macOS
# or: sudo apt-get install -y softhsm2 opensc

bash scripts/setup-softhsm.sh
# follow printed env exports
```

Enroll the printed pubkey (base64 uncompressed P-256) into the registry — e.g. temporary API or replace `DEV-VESSEL-001` enrollment with `signature_alg: ecdsa-p256`, `assurance_level: hardware`.

```bash
export NORTHSTAR_SIGNER_BACKEND=pkcs11
export NORTHSTAR_TELEMETRY_URL=http://127.0.0.1:8080/api/telemetry   # or https://…:8443 with mTLS
npm run dev
```

Cyber summary should show `assurance_level: hardware` and `signature_alg: ecdsa-p256` for that device.

## YubiKey 5 (when you buy one)

Approx. cost: YubiKey 5 NFC / 5C (~$50–75).

1. Install Yubico PIV tool / OpenSC: `brew install yubico-piv-tool opensc`
2. Find module, typically:
   - `/usr/local/lib/libykcs11.dylib` or  
   - `/opt/homebrew/lib/libykcs11.dylib` or  
   - OpenSC `opensc-pkcs11.so`
3. Generate a P-256 key in PIV slot 9c (Digital Signature):

```bash
yubico-piv-tool -a generate -s 9c -A ECCP256 -o pubkey.pem
yubico-piv-tool -a selfsign-certificate -s 9c -S '/CN=northstar-device/' -i pubkey.pem -o cert.pem
yubico-piv-tool -a import-certificate -s 9c -i cert.pem
```

4. Export uncompressed public key bytes (65-byte `04||X||Y`) to a base64 file and set:

```bash
export NORTHSTAR_SIGNER_BACKEND=pkcs11
export NORTHSTAR_PKCS11_MODULE=/opt/homebrew/lib/libykcs11.dylib
export NORTHSTAR_PKCS11_PIN=123456          # your PIV PIN
export NORTHSTAR_PKCS11_KEY_LABEL=...       # match pkcs11-tool --list-objects
export NORTHSTAR_PKCS11_PUBKEY=/path/to/pub.b64
```

5. Same enroll + device-sim flow as SoftHSM. **No code change** if `pkcs11-tool --sign --mechanism ECDSA` works with your module.

## mTLS (channel identity)

Orthogonal to payload signatures:

```bash
npm run gen-certs
export NORTHSTAR_TLS_ENABLED=true
export NORTHSTAR_MTLS_ENABLED=true
# device-sim:
export NORTHSTAR_DEVICE_MTLS=true
export NORTHSTAR_TELEMETRY_URL=https://127.0.0.1:8443/api/telemetry
export NORTHSTAR_API_URL=http://127.0.0.1:8080   # web/challenge via HTTP still OK for pending; prefer HTTPS challenge on :8443
```

Prefer pointing device-sim challenge + telemetry both at the HTTPS device port.

## Why not macOS Secure Enclave?

Secure Enclave is **P-256 only** and does not hold the demo’s default Ed25519 device keys. The PKCS#11 P-256 path is the intentional hardware alignment.

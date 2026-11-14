# Northstar — Demo script

**Setup:** `npm install && npm run build && npm run dev`, open http://127.0.0.1:5173.

**Pitch:** Public AIS can be spoofed and GNSS can be jammed or faked. Northstar checks every reported position against physics, geography and independent sensors, verifies signed onboard telemetry, and explains which evidence agrees.

---

## 3-minute path

1. **Live view.** Real ships in the Gulf of Finland, moving in real time. Click one: the Evidence tab shows what public AIS alone can support (kinematics, geography, nearby traffic, identity). Layers live ships can never have are hidden.
2. **Lab view → the lab vessel.** Its independent sensor recordings were received from a lab at UIUC. Evidence shows recorded radar, GNSS-free dead reckoning, receiver diagnostics, a second AIS network and a verified device signature; synthetic inputs are labelled.
3. **Lab vessel events → Jump** to the receiver-flagged spoofing event. The vessel's AIS jumps to a fake position; it goes critical and the evidence shows independent confirmation (radar disagrees, dead reckoning disagrees, receiver flags spoofing, RF capture shows a single-direction signal). Events show the clock-driven jamming / spoofing alerts.
4. **Attack a simulated ship.** *Sudden spoof*, *Gradual drift*, *AIS conflict*, *GNSS jam*, *IMU disagree*: the notice shows which simulated ship was hit. Attacks never touch recorded or live ships. *Normal* stops the attack.
5. **Security tab.** *Verify audit chain* (✓ intact), *Send without challenge* (✓ rejected), device identity, recent security events, controls in place.
6. **Reset Lab** to rewind.

Say: "We never inject attacks into real ships, and we label every piece of evidence by where it came from."

---

## Honest limits (say out loud)

- Strong independent evidence exists for one instrumented vessel; other ships rely on AIS-based checks.
- The lab vessel's attestation and OSNMA inputs are synthetic.
- A second GNSS receiver on the same ship was spoofed too: independence has to come from non-GNSS sensors.
- Trust scores are integrity estimates, not probabilities.

# Digitraffic historical replay cache

- `gof_ais.jsonl` — recorded AIS position samples (one JSON object per line)
- `manifest.json` — capture metadata

**Why record?** Digitraffic `GET /api/ais/v1/locations?from=&to=` returns the latest position per MMSI in the window, not a full track. Multi-point Lab history is built by polling and appending.

Licence: Fintraffic Digitraffic open data (CC BY 4.0). Attribute Fintraffic / Digitraffic.

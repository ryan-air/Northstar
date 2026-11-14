#!/usr/bin/env python3
"""
P2.1 — build data/geo/land_osm_gof.geojson and data/geo/ports_v2.geojson from OSM
without GDAL (pure-Python pyshp + shapely; reads the shapefile straight from the zip).

  python3 -m venv .venv-geo && .venv-geo/bin/pip install pyshp shapely
  .venv-geo/bin/python -I scripts/geo/build_osm_geo.py --zip /path/land-polygons-split-4326.zip

Land: OSM land polygons (osmdata.openstreetmap.de, ODbL), clipped to lon 22–31 E,
lat 59–61 N, tiles merged, simplified at 0.00008° (≈9 m at 60 N; topology preserved,
islands kept), then re-cut on a 0.1° grid so point-in-polygon stays fast. The grid
size is stored as `seam_grid_deg` so the land index ignores grid seams when measuring
distance to shore.
Ports: Overpass API — landuse=port, harbour=*, man_made=pier|quay (ways and relations
with geometry) in the same bbox.
Writes data/geo/osm_provenance.json.
"""
from __future__ import annotations

import argparse
import io
import json
import sys
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import shapefile  # pyshp
from shapely.geometry import box, mapping, shape, Polygon, MultiPolygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
BBOX = (22.0, 59.0, 31.0, 61.0)  # minLon, minLat, maxLon, maxLat
TOL_DEG = 0.00008
GRID = 0.1
REQUIRED_PORTS = [
    "Helsinki", "Tallinn", "Kotka", "Hamina", "Primorsk", "Ust-Luga", "Sillamäe",
    "Vuosaari", "Sköldvik", "Kilpilahti", "Mussalo", "Hanko", "Inkoo", "Loviisa",
    "Muuga", "Paldiski", "Kunda", "Vysotsk", "Petersburg", "Kronstadt",
]


def polys(g):
    if isinstance(g, Polygon):
        return [g] if not g.is_empty else []
    if isinstance(g, MultiPolygon):
        return [p for p in g.geoms if not p.is_empty]
    if hasattr(g, "geoms"):
        out = []
        for x in g.geoms:
            out.extend(polys(x))
        return out
    return []


def round_coords(geom_json, nd=6):
    def r(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [r(x) for x in c]
    geom_json["coordinates"] = r(geom_json["coordinates"])
    return geom_json


def build_land(zip_path: Path) -> tuple[dict, dict]:
    zf = zipfile.ZipFile(zip_path)
    names = zf.namelist()
    stem = next(n[:-4] for n in names if n.endswith(".shp"))
    rdr = shapefile.Reader(
        shp=io.BufferedReader(zf.open(stem + ".shp")),
        shx=io.BufferedReader(zf.open(stem + ".shx")),
        dbf=io.BufferedReader(zf.open(stem + ".dbf")),
    )
    clip = box(*BBOX)
    pieces = []
    n_in = 0
    for i, shp in enumerate(rdr.iterShapes(bbox=list(BBOX))):
        g = shape(shp.__geo_interface__)
        if not g.intersects(clip):
            continue
        n_in += 1
        g = g.intersection(clip)
        pieces.extend(polys(g))
    print(f"[land] {n_in} source tiles intersect the bbox; merging {len(pieces)} pieces…", flush=True)
    merged = unary_union(pieces)
    simplified = merged.simplify(TOL_DEG, preserve_topology=True)
    print("[land] simplified; cutting on grid…", flush=True)
    feats = []
    x = BBOX[0]
    k = 0
    while x < BBOX[2] - 1e-9:
        y = BBOX[1]
        while y < BBOX[3] - 1e-9:
            cell = box(round(x, 6), round(y, 6), round(x + GRID, 6), round(y + GRID, 6))
            if simplified.intersects(cell):
                part = simplified.intersection(cell)
                for p in polys(part):
                    if p.area <= 0:
                        continue
                    feats.append({
                        "type": "Feature",
                        "id": f"osm_land_{k}",
                        "properties": {"cell": f"{x:.1f},{y:.1f}"},
                        "geometry": round_coords(mapping(p)),
                    })
                    k += 1
            y += GRID
        x += GRID
    fc = {
        "type": "FeatureCollection",
        "seam_grid_deg": GRID,
        "features": feats,
    }
    stats = {"source_tiles": n_in, "features": len(feats),
             "vertices": sum(len(r) for f in feats for r in f["geometry"]["coordinates"])}
    return fc, stats


def build_ports() -> tuple[dict, list[str], str]:
    s, w, n, e = BBOX[1], BBOX[0], BBOX[3], BBOX[2]
    q = f"""[out:json][timeout:180];
(
  way["landuse"="port"]({s},{w},{n},{e});
  relation["landuse"="port"]({s},{w},{n},{e});
  way["harbour"]({s},{w},{n},{e});
  way["man_made"~"^(pier|quay)$"]({s},{w},{n},{e});
);
out geom;"""
    req = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": q}).encode(),
        headers={"User-Agent": "northstar-geo-build/1.0"},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=240) as r:
                osm = json.load(r)
            break
        except Exception as ex:  # noqa: BLE001
            print(f"[ports] overpass attempt {attempt + 1} failed: {ex}", flush=True)
            time.sleep(20)
    else:
        raise SystemExit("Overpass unavailable")
    feats = []
    for el in osm.get("elements", []):
        tags = el.get("tags", {})
        rings = []
        if el["type"] == "way" and el.get("geometry"):
            rings = [[[g["lon"], g["lat"]] for g in el["geometry"]]]
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry"):
                    rings.append([[g["lon"], g["lat"]] for g in m["geometry"]])
        for ring in rings:
            if len(ring) < 4:
                continue
            if ring[0] != ring[-1]:
                # Open piers/quays are lines; buffer them slightly (≈15 m) into areas.
                from shapely.geometry import LineString
                poly = LineString(ring).buffer(0.00015)
            else:
                poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            for p in polys(poly):
                feats.append({
                    "type": "Feature",
                    "id": f"osm_{el['type']}_{el['id']}_{len(feats)}",
                    "properties": {"name": tags.get("name") or tags.get("name:en") or "",
                                   **{k: v for k, v in tags.items() if k in (
                                       "landuse", "harbour", "man_made", "name:en", "operator")}},
                    "geometry": round_coords(mapping(p)),
                })
    blob = " | ".join(json.dumps(f["properties"], ensure_ascii=False).lower() for f in feats)
    missing = [p for p in REQUIRED_PORTS if p.lower() not in blob]
    return {"type": "FeatureCollection", "features": feats}, missing, q


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True, type=Path)
    ap.add_argument("--skip-ports", action="store_true")
    a = ap.parse_args()
    out_dir = ROOT / "data" / "geo"
    land, stats = build_land(a.zip)
    (out_dir / "land_osm_gof.geojson").write_text(json.dumps(land, separators=(",", ":")))
    print(f"[land] wrote {stats}", flush=True)
    prov = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "licence": "ODbL 1.0 — © OpenStreetMap contributors",
        "bbox": {"minLon": BBOX[0], "minLat": BBOX[1], "maxLon": BBOX[2], "maxLat": BBOX[3]},
        "land": {
            "source_url": "https://osmdata.openstreetmap.de/download/land-polygons-split-4326.zip",
            "source_file": a.zip.name,
            "source_last_modified": datetime.fromtimestamp(a.zip.stat().st_mtime, timezone.utc).isoformat(),
            "simplify_tolerance_deg": TOL_DEG,
            "simplify_tolerance_m_approx": 9,
            "grid_cut_deg": GRID,
            **stats,
        },
    }
    if not a.skip_ports:
        ports, missing, q = build_ports()
        (out_dir / "ports_v2.geojson").write_text(json.dumps(ports, separators=(",", ":"), ensure_ascii=False))
        prov["ports"] = {"source": "https://overpass-api.de (OSM)", "query": q,
                         "features": len(ports["features"]), "required_names_not_found": missing}
        print(f"[ports] wrote {len(ports['features'])} features; names not found: {missing}", flush=True)
    (out_dir / "osm_provenance.json").write_text(json.dumps(prov, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    sys.exit(main())

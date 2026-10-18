"""Build the zone set used for precomputed crossings and the map.

- Sovereign airspace (approx.): every Natural Earth 10m country, land + 12 nm, buffered per
  polygon part in a local azimuthal-equidistant projection. Coastline-based, so it under-states
  territorial seas drawn from straight baselines.
- Iceland is the exception: its sovereign airspace is the official 12 nm territorial-sea line
  published by the Icelandic Coast Guard (ref/lhg_landhelgi_12nm_line.geojson, law 41/1979
  art. 1), 13% larger than the coastline buffer (it encloses the bays behind the straight
  baselines and Kolbeinsey's own 12 nm circle).
- FIRs: VATSpy community boundaries (approximate, top-level FIR ids only), except where an
  official boundary is supplied (Iceland BIRD FIR / CTA from the Icelandic eAIP).

Output: data/zones/zones.geojson (simplified for the browser) + data/zones/zones_full.geojson.
"""
import os, json, re
import pyproj
import shapely
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, LineString
from shapely.ops import transform, unary_union, polygonize

HERE = os.path.dirname(os.path.abspath(__file__))
OAM = os.path.dirname(HERE)
REF, OUT = f'{OAM}/ref', f'{OAM}/data/zones'
NM12 = 22224.0
ICELAND_OFFICIAL = f'{REF}/iceland_airspace.geojson'   # BIRD FIR and CTA (eAIP); feature 0 is the old coastline buffer, unused
ICELAND_12NM = f'{REF}/lhg_landhelgi_12nm_line.geojson'   # Coast Guard WFS LHG:landhelgi_12_milur_lina


def buffer_geodesic(geom, dist):
    parts = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in parts:
        c = p.representative_point()
        proj = pyproj.CRS.from_proj4(f'+proj=aeqd +lat_0={c.y} +lon_0={c.x} +datum=WGS84')
        fw = pyproj.Transformer.from_crs(4326, proj, always_xy=True).transform
        bw = pyproj.Transformer.from_crs(proj, 4326, always_xy=True).transform
        b = shapely.make_valid(transform(bw, transform(fw, p).buffer(dist, 16)))
        minx, _, maxx, _ = b.bounds
        # parts touching the antimeridian wrap around after back-projection: keep them unbuffered
        out.append(shapely.make_valid(p) if maxx - minx > 180 else b)
    g = unary_union([shapely.make_valid(x) for x in out])
    return g.intersection(Polygon([(-180, -90), (180, -90), (180, 90), (-180, 90)]))


def main():
    os.makedirs(OUT, exist_ok=True)
    feats = []
    ne = json.load(open(f'{REF}/ne_10m_countries.geojson'))
    for f in ne['features']:
        p = f['properties']
        iso = p.get('ISO_A3') if p.get('ISO_A3') not in (None, '-99') else p.get('ADM0_A3')
        if iso == 'ISL':
            continue  # replaced by the official Iceland set below
        g = buffer_geodesic(shape(f['geometry']).buffer(0), NM12)
        feats.append({'id': f'sov:{iso}', 'kind': 'sovereign', 'name': f"{p['ADMIN']}: sovereign airspace (approx.)",
                      'country': p['ADMIN'], 'iso': iso, 'source': 'Natural Earth 10m + 12 nm buffer', 'geom': g})
    vat = json.load(open(f'{REF}/vatspy_boundaries.geojson'))
    for f in vat['features']:
        fid = f['properties']['id']
        if not re.fullmatch(r'[A-Z]{4}', fid) or fid == 'BIRD':
            continue
        g = shape(f['geometry']).buffer(0)
        feats.append({'id': f'fir:{fid}', 'kind': 'fir', 'name': f'{fid} FIR' + (' (oceanic)' if f['properties'].get('oceanic') == '1' else ''),
                      'country': '', 'iso': '', 'source': 'VATSpy community boundaries (approximate)', 'geom': g})
    ice = json.load(open(ICELAND_OFFICIAL))['features']
    # the territorial-sea limit is published as closed lines (mainland + Kolbeinsey): make them polygons
    lhg = json.load(open(ICELAND_12NM))['features']
    sov_isl = unary_union(list(polygonize(unary_union([LineString(p) for f in lhg for p in f['geometry']['coordinates']]))))
    assert sov_isl.is_valid and 30 < sov_isl.area < 40, sov_isl.area   # ~33.7 deg²
    feats += [
        {'id': 'sov:ISL', 'kind': 'sovereign', 'name': 'Iceland: sovereign airspace (official)', 'country': 'Iceland', 'iso': 'ISL',
         'source': 'Landhelgisgæslan (Icelandic Coast Guard) 12 nm territorial-sea line, law 41/1979 art. 1 (official)', 'geom': sov_isl},
        {'id': 'fir:BIRD', 'kind': 'fir', 'name': 'BIRD Reykjavík FIR', 'country': 'Iceland', 'iso': 'ISL',
         'source': 'Iceland eAIP ENR 2.1, AIRAC 09/2026 (official)', 'geom': shape(ice[1]['geometry'])},
        {'id': 'cta:BIRD-GL', 'kind': 'cta', 'name': 'Reykjavík CTA over Greenland (FL195+)', 'country': 'Iceland', 'iso': 'ISL',
         'source': 'Iceland eAIP ENR 2.1, AIRAC 09/2026 (official)', 'geom': shape(ice[2]['geometry'])},
    ]
    def fc(tol):
        return {'type': 'FeatureCollection', 'features': [
            {'type': 'Feature', 'id': i, 'properties': {k: v for k, v in z.items() if k != 'geom'},
             'geometry': mapping(shapely.set_precision(z['geom'].simplify(tol), 0.0001) if tol else z['geom'])}
            for i, z in enumerate(feats)]}
    json.dump(fc(0), open(f'{OUT}/zones_full.geojson', 'w'))
    json.dump(fc(0.01), open(f'{OUT}/zones.geojson', 'w'), separators=(',', ':'))
    print(len(feats), 'zones;', sum(z['kind'] == 'sovereign' for z in feats), 'sovereign,',
          sum(z['kind'] == 'fir' for z in feats), 'FIR')


if __name__ == '__main__':
    main()

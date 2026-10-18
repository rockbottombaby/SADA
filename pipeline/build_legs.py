"""Stitch daily segments into flight legs and write the query-first tables + manifest.

Usage: python -I build_legs.py

Reads  data/{segments,crossings,callsigns,aircraft}/DATE.parquet
Writes data/legs.parquet, data/leg_zones.parquet, data/aircraft.parquet, data/airports.parquet, data/manifest.json
"""
import os, json, glob, math, csv, datetime as dt
from collections import defaultdict
import pyarrow as pa, pyarrow.parquet as pq
import shapely
from shapely.geometry import shape

OAM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA, REF = f'{OAM}/data', f'{OAM}/ref'
# Airports at the two GNSS-spoofing hotspots (see SPOOF_HOTSPOTS in ingest_day.py): spoofed receivers report positions at
# exactly these airports, so an end here cannot be told apart from a real landing. Such ends are marked, not trusted.
SPOOF_AIRPORTS = {'OJAI', 'OLBA'}
MIL_WORDS = ('air base', 'afb', 'air force', 'naval air', 'raf ', 'air station', 'army airfield', 'military', 'airbase', 'ab ', 'nas ')


def load(sub):
    rows = []
    for f in sorted(glob.glob(f'{DATA}/{sub}/*.parquet')):
        rows += pq.read_table(f).to_pylist()
    return rows


class Airports:
    def __init__(self):
        self.grid = defaultdict(list)
        self.rows = []
        self.by_ident = {}
        for r in csv.DictReader(open(f'{REF}/airports.csv', encoding='utf-8')):
            if r['type'] not in ('large_airport', 'medium_airport', 'small_airport'):
                continue
            lat, lon = float(r['latitude_deg']), float(r['longitude_deg'])
            nm = r['name']
            mil = any(w in (nm + ' ').lower() for w in MIL_WORDS) or 'military' in r.get('keywords', '').lower()
            a = {'ident': r['icao_code'] or r['gps_code'] or r['ident'], 'iata': r['iata_code'], 'name': nm, 'type': r['type'],
                 'military': mil, 'country': r['iso_country'], 'lat': lat, 'lon': lon,
                 'tier': {'large_airport': 0, 'medium_airport': 1, 'small_airport': 2}[r['type']],
                 'rank': {'large_airport': 0, 'medium_airport': 1, 'small_airport': 2}[r['type']] + (0 if r['icao_code'] else 1)}
            self.rows.append(a)
            self.by_ident.setdefault(a['ident'], a)
            self.grid[(math.floor(lat), math.floor(lon))].append(a)

    def match(self, lat, lon, km_max):
        """Airport for a takeoff/landing point: large/medium/military first; small strips only if very close
        and nothing bigger is in range (airliners otherwise snap to nearby strips and bases)."""
        big = self.nearest(lat, lon, km_max, max_type=1)
        if big:
            return big
        small = self.nearest(lat, lon, min(km_max, 5), max_type=2)
        return small

    def nearest(self, lat, lon, km_max, max_type=2):
        best, bd = None, 1e9
        span = max(1, int(km_max / 100) + 1)
        for dy in range(-span, span + 1):
            for dx in range(-span, span + 1):
                for a in self.grid.get((math.floor(lat) + dy, math.floor(lon) + dx), ()):
                    if a['tier'] > max_type:
                        continue
                    d = hav(lat, lon, a['lat'], a['lon'])
                    d_eff = d + a['rank'] * 6  # prefer bigger / ICAO-coded airports when several are close
                    if d <= km_max and d_eff < bd:
                        best, bd = a, d_eff
        return best


def hav(la1, lo1, la2, lo2):
    p = math.radians
    return 2 * 6371 * math.asin(math.sqrt(math.sin(p(la2 - la1) / 2) ** 2 + math.cos(p(la1)) * math.cos(p(la2)) * math.sin(p(lo2 - lo1) / 2) ** 2))


def joinable(a, b):
    """Same flight continuing across a day boundary or an unreceived stretch (e.g. mid-Atlantic at midnight)."""
    if a['end'] not in ('cut', 'lost') or b['start'] not in ('cut', 'appear'):
        return False
    gap = b['t0'] - a['t1']
    if a['end'] == 'cut' and b['start'] == 'cut' and 0 <= gap <= 1800:
        return True
    if not (0 <= gap <= 12 * 3600) or a['alt1'] < 10000 or b['alt0'] < 10000:
        return False
    km = hav(a['lat1'], a['lon1'], b['lat0'], b['lon0'])
    return gap - km / 850 * 3600 < 60 * 60   # no time for a hidden landing


def endpoint(ap, kind, lat, lon, alt=None, desc=False):
    """Describe a leg end: (code, name, lat, lon, certainty, military, country)."""
    if lat is None:
        return None, 'unknown', None, None, 'unknown', False, ''
    if kind == 'ground':
        a = ap.match(lat, lon, 10 if alt == -1 else 15)
        if a:
            return a['ident'], a['name'], a['lat'], a['lon'], 'recorded', a['military'], a['country']
        return None, f'no known airport (low point at {lat:.2f}, {lon:.2f})', lat, lon, 'unmatched low point', False, ''
    if kind == 'lost' and desc and alt is not None and 0 <= alt < 15000:
        a = ap.match(lat, lon, 120)
        if a:
            return a['ident'], a['name'], a['lat'], a['lon'], 'probable (coverage lost descending)', False, a['country']
    if kind == 'hidden':
        a = ap.match(lat, lon, 250) if (alt is not None and 0 <= alt < 20000) else None
        nm = f'unrecorded stop (probably {a["name"]})' if a else f'unrecorded stop near {lat:.1f}, {lon:.1f}'
        return (a['ident'] if a else None), nm, lat, lon, 'unrecorded stop', False, (a['country'] if a else '')
    return None, f'unknown (coverage {"starts" if kind in ("appear", "cut") else "ends"} near {lat:.1f}, {lon:.1f})', lat, lon, 'unknown', False, ''


class SovZones:
    def __init__(self):
        fs = [f for f in json.load(open(f'{DATA}/zones/zones_full.geojson'))['features'] if f['properties']['kind'] == 'sovereign']
        self.ids = [f['properties']['id'] for f in fs]
        self.tree = shapely.STRtree([shape(f['geometry']) for f in fs])

    def at(self, lat, lon):
        hits = self.tree.query(shapely.Point(lon, lat), predicate='within')
        return self.ids[hits[0]] if len(hits) else None


def build(ap, sz, segments, crossings, callsigns, aircraft):
    """Core stitching: rows (dicts) of the daily tiers -> (legs, leg_zones, aircraft dict). Shared by main() and build_month.py."""
    segs = sorted(segments, key=lambda s: (s['hex'], s['t0']))
    cross = defaultdict(list)
    for c in crossings:
        cross[c['seg_id']].append(c)
    cs_by = defaultdict(list)
    for c in callsigns:
        cs_by[c['hex']].append((c['t'], c['cs']))
    for v in cs_by.values():
        v.sort()
    ac = {}
    for a in aircraft:
        cur = ac.setdefault(a['hex'], dict(a))
        for k, v in a.items():
            if v and not cur.get(k):
                cur[k] = v
    # stitch segments cut at midnight
    legs, cur = [], None
    for s in segs:
        if cur and cur['hex'] == s['hex'] and joinable(cur['segs'][-1], s):
            cur['segs'].append(s)
            continue
        cur = {'hex': s['hex'], 'segs': [s]}
        legs.append(cur)
    L, LZ = [], []
    for i, g in enumerate(legs):
        a, b = g['segs'][0], g['segs'][-1]
        nxt = legs[i + 1]['segs'][0] if i + 1 < len(legs) and legs[i + 1]['hex'] == g['hex'] else None
        prv = legs[i - 1]['segs'][-1] if i > 0 and legs[i - 1]['hex'] == g['hex'] else None
        t0, t1 = a['t0'], b['t1']
        if t1 - t0 < 15 * 60:
            continue
        lid = a['seg_id']
        if a['start'] == 'ground':
            o = endpoint(ap, 'ground', a['o_lat'], a['o_lon'], a.get('o_alt'))
        elif a['start'] == 'hidden' and prv:
            la, lo, al = min([(a['lat0'], a['lon0'], a['alt0']), (prv['lat1'], prv['lon1'], prv['alt1'])], key=lambda x: x[2] if x[2] >= 0 else 1e9)
            o = endpoint(ap, 'hidden', la, lo, al)
        else:
            o = endpoint(ap, a['start'], a['lat0'], a['lon0'], a['alt0'])
        if b['end'] == 'ground':
            d = endpoint(ap, 'ground', b['d_lat'], b['d_lon'], b.get('d_alt'))
        elif b['end'] == 'hidden' and nxt:
            la, lo, al = min([(b['lat1'], b['lon1'], b['alt1']), (nxt['lat0'], nxt['lon0'], nxt['alt0'])], key=lambda x: x[2] if x[2] >= 0 else 1e9)
            d = endpoint(ap, 'hidden', la, lo, al)
        else:
            d = endpoint(ap, b['end'], b['lat1'], b['lon1'], b['alt1'], b['descending_end'])
        o, d = (tuple(e) if e[0] not in SPOOF_AIRPORTS else
                (e[0], f'{e[1]} (GNSS-spoofing hotspot: may be a spoofed position)', e[2], e[3], 'possible GNSS spoofing', e[5], e[6])
                for e in (o, d))
        cl = cs_by.get(g['hex'], [])
        css = list(dict.fromkeys(c for t, c in cl if t0 - 3600 <= t <= t1))
        if not css:  # callsign is set at the gate: carry the last one set before departure
            prev = [c for t, c in cl if t0 - 18 * 3600 <= t < t0]
            css = prev[-1:]
        meta = ac.get(g['hex'], {})
        zones = defaultdict(lambda: [1e18, 0, 0, 0])
        for s in g['segs']:
            for c in cross.get(s['seg_id'], []):
                z = zones[c['zone_id']]
                z[0] = min(z[0], c['t_in']); z[1] = max(z[1], c['t_out']); z[2] += c['n_obs']; z[3] += c['n_inf']
        # the airport at each end lies in a country's sovereign airspace even when the takeoff/landing itself was not
        # received (aircraft first seen offshore): add it as observed if the end was recorded, inferred otherwise
        for end, t_end in ((o, t0), (d, t1)):
            apt = ap.by_ident.get(end[0]) if end[0] and end[4] != 'possible GNSS spoofing' else None
            if apt:
                zid = sz.at(apt['lat'], apt['lon'])   # the airport's own position, not the first received point
                if zid and zid not in zones:
                    rec = end[4] == 'recorded'
                    zones[zid] = [t_end, t_end, 1 if rec else 0, 0 if rec else 1]
        for zid, z in zones.items():
            LZ.append({'zone_id': zid, 'leg_id': lid, 'hex': g['hex'], 't_in': int(z[0]), 't_out': int(z[1]), 'n_obs': z[2], 'n_inf': z[3],
                       'evidence': 'observed' if z[2] else 'inferred'})
        L.append({'leg_id': lid, 'hex': g['hex'], 'reg': meta.get('reg'), 'type': meta.get('type'), 'desc': meta.get('desc'),
                  'operator': meta.get('own'), 'mil': int(meta.get('mil') or 0), 'callsigns': ' '.join(css),
                  't0': t0, 't1': t1, 'date': dt.datetime.fromtimestamp(t0, dt.UTC).strftime('%Y-%m-%d'),
                  'from_code': o[0], 'from_name': o[1], 'from_lat': o[2], 'from_lon': o[3], 'from_cert': o[4], 'from_mil': int(o[5]), 'from_country': o[6],
                  'to_code': d[0], 'to_name': d[1], 'to_lat': d[2], 'to_lon': d[3], 'to_cert': d[4], 'to_mil': int(d[5]), 'to_country': d[6],
                  'maxlat': max(s['maxlat'] for s in g['segs']), 'n_zones': len(zones),
                  'days': ' '.join(sorted({s['date'] for s in g['segs']}))})
    return L, LZ, ac


def main():
    ap = Airports()
    sz = SovZones()
    L, LZ, ac = build(ap, sz, load('segments'), load('crossings'), load('callsigns'), load('aircraft'))
    L.sort(key=lambda r: r['t0'])
    LZ.sort(key=lambda r: (r['zone_id'], r['t_in']))
    pq.write_table(pa.Table.from_pylist(L), f'{DATA}/legs.parquet', compression='zstd', row_group_size=50_000)
    pq.write_table(pa.Table.from_pylist(LZ), f'{DATA}/leg_zones.parquet', compression='zstd', row_group_size=100_000)
    pq.write_table(pa.Table.from_pylist(list(ac.values())), f'{DATA}/aircraft.parquet', compression='zstd')
    pq.write_table(pa.Table.from_pylist([{k: v for k, v in a.items() if k not in ('rank', 'tier')} for a in ap.rows if a['tier'] < 2 or a['military']]),
                   f'{DATA}/airports.parquet', compression='zstd')
    dates = sorted(os.path.basename(f)[:-8] for f in glob.glob(f'{DATA}/positions/*.parquet'))
    manifest = {'name': 'SADA: prototype dataset', 'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds'),
                'dates': dates, 'legs': len(L), 'leg_zones': len(LZ), 'aircraft': len(ac),
                'files': {'legs': 'legs.parquet', 'leg_zones': 'leg_zones.parquet', 'aircraft': 'aircraft.parquet', 'airports': 'airports.parquet',
                          'zones': 'zones/zones.geojson', 'positions': 'positions/{date}.parquet', 'callsigns': 'callsigns/{date}.parquet',
                          'h3': 'h3/{date}.parquet'},
                'h3_resolution': 3,
                'attribution': ['ADS-B positions: ADSB.lol globe_history, Open Database License (ODbL) 1.0. Derived database also ODbL.',
                                'Countries: Natural Earth (public domain). Sovereign airspace = land + 12 nm, approximate.',
                                'FIRs: VATSpy community boundaries (approximate); Iceland BIRD from the Icelandic eAIP.',
                                'Airports: OurAirports (public domain).']}
    json.dump(manifest, open(f'{DATA}/manifest.json', 'w'), indent=1)
    print(len(L), 'legs', len(LZ), 'leg-zone rows', len(ac), 'aircraft', 'dates', dates)


if __name__ == '__main__':
    main()

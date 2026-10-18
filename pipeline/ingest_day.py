"""Convert one ADSB.lol globe_history day (tar stream on stdin, or the downloaded parts) into the query tiers.

Usage: <tar stream> | python -I ingest_day.py YYYY-MM-DD
       python -I ingest_day.py YYYY-MM-DD part00 part01 …   (preferred: handles releases holding several archives)

Some releases are two archives back to back (an upload that restarted) and repeat thousands of trace files; with the
parts on disk a first pass lists every member and only the largest copy of each trace is read. Exit code 3 = the
release holds no traces (an upstream gap, recorded as an empty day).

Writes under oam/data/:
  positions/DATE.parquet   1-minute positions, sorted by (hex, t)
  callsigns/DATE.parquet   callsign changes (hex, t, cs)
  aircraft/DATE.parquet    registry fields seen that day
  segments/DATE.parquet    airborne segments between ground/low points (stitched into legs later)
  crossings/DATE.parquet   segment x zone crossings, observed and gap-inferred
  h3/DATE.parquet          (cell res 3, hour, hex) spatial index, sorted by cell
"""
import io, os, sys, json, gzip, tarfile, datetime as dt
import numpy as np
import orjson, h3, shapely
import pyarrow as pa, pyarrow.parquet as pq
from shapely.geometry import shape

OAM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = f'{OAM}/data'
LOW_FT = 1500           # at/below this (or 'ground') = on or near an airport
GAP_INF = 300           # gaps longer than this (s) at altitude get great-circle interpolation for zone tests
H3_RES = 3
# known GNSS-spoofing destinations (positions get "teleported" there): Beirut OLBA, Amman Queen Alia OJAI
SPOOF_HOTSPOTS = [(33.82, 35.49), (31.72, 35.99)]

ZF = json.load(open(f'{DATA}/zones/zones_full.geojson'))['features']
ZID = [f['properties']['id'] for f in ZF]
ZKIND = [f['properties']['kind'] for f in ZF]
ZGEOM = [shape(f['geometry']) for f in ZF]
TREE = shapely.STRtree(ZGEOM)
R = 6371.0


def slerp(lat1, lon1, lat2, lon2, n):
    la1, lo1, la2, lo2 = np.radians([lat1, lon1, lat2, lon2])
    a = np.array([np.cos(la1) * np.cos(lo1), np.cos(la1) * np.sin(lo1), np.sin(la1)])
    b = np.array([np.cos(la2) * np.cos(lo2), np.cos(la2) * np.sin(lo2), np.sin(la2)])
    om = np.arccos(np.clip(a @ b, -1, 1))
    if om < 1e-9:
        return np.empty((0, 2)), 0.0
    f = np.linspace(0, 1, n + 2)[1:-1]
    p = (np.sin((1 - f) * om)[:, None] * a + np.sin(f * om)[:, None] * b) / np.sin(om)
    return np.column_stack([np.degrees(np.arcsin(p[:, 2])), np.degrees(np.arctan2(p[:, 1], p[:, 0]))]), om * R


class Day:
    def __init__(self, date):
        self.date = date
        self.d0 = dt.datetime.fromisoformat(date).replace(tzinfo=dt.UTC).timestamp()
        self.pos = {k: [] for k in ('hex', 't', 'lat', 'lon', 'alt', 'gs')}
        self.cs, self.ac, self.seg = [], [], []
        self.h3rows = set()
        self.zbuf = {k: [] for k in ('seg', 't', 'lat', 'lon', 'alt', 'obs')}
        self.cross = {}
        self.spoof_dropped = 0

    # ---------- per trace ----------
    def trace(self, d):
        tr = d.get('trace') or []
        if len(tr) < 2:
            return
        hx = d.get('icao', '').lower()
        t = np.fromiter((p[0] for p in tr), float, len(tr)) + d['timestamp']
        lat = np.fromiter((p[1] for p in tr), float, len(tr))
        lon = np.fromiter((p[2] for p in tr), float, len(tr))
        alt = np.fromiter((-1 if p[3] == 'ground' else (-2 if p[3] is None else p[3]) for p in tr), float, len(tr))
        gs = np.fromiter(((p[4] or 0) for p in tr), float, len(tr))
        keep = despoof(t, lat, lon)
        if keep.sum() < 2:
            return
        t, lat, lon, alt, gs = t[keep], lat[keep], lon[keep], alt[keep], gs[keep]
        self.spoof_dropped += int((~keep).sum())
        self.ac.append((hx, d.get('r'), d.get('t'), d.get('desc'), d.get('ownOp'), int(bool((d.get('dbFlags') or 0) & 1))))
        last = None
        for p in tr:
            if p[8] and p[8].get('flight'):
                c = p[8]['flight'].strip()
                if c and c != last:
                    self.cs.append((hx, int(d['timestamp'] + p[0]), c)); last = c
        # 1-minute positions
        m = np.unique((t // 60).astype(np.int64), return_index=True)[1]
        m = np.union1d(m, [len(t) - 1])
        for k, v in (('t', t[m].astype(np.int64)), ('lat', lat[m]), ('lon', lon[m]), ('alt', alt[m]), ('gs', gs[m])):
            self.pos[k].append(v)
        self.pos['hex'].append(np.full(len(m), hx, dtype=object))
        hours = (t[m] // 3600).astype(np.int64)
        for la, lo, hr in zip(lat[m], lon[m], hours):
            self.h3rows.add((h3.latlng_to_cell(la, lo, H3_RES), int(hr), hx))
        self.segments(hx, t, lat, lon, alt, m)

    def segments(self, hx, t, lat, lon, alt, m):
        low = (alt == -1) | ((alt >= 0) & (alt <= LOW_FT))
        air = np.nonzero(~low)[0]
        if not len(air):
            return
        # airborne runs: consecutive airborne indices, split at hidden stops (silence >> flight time)
        runs, start = [], air[0]
        for a, b in zip(air, air[1:]):
            if b != a + 1:
                runs.append((start, a, 'ground', 'ground')); start = b; continue
            gap = t[b] - t[a]
            if gap > 2.5 * 3600:
                _, km = slerp(lat[a], lon[a], lat[b], lon[b], 1)
                if gap - km / 850 * 3600 > 100 * 60:
                    runs.append((start, a, None, 'hidden')); start = b
        runs.append((start, air[-1], None, None))
        n = len(t)
        for i, (a, b, _, endst) in enumerate(runs):
            if t[b] - t[a] < 600 and not (t[a] - self.d0 < 900 or self.d0 + 86400 - t[b] < 900):
                continue
            seg_alt = alt[a:b + 1]
            if seg_alt.max() < 3000:
                continue
            o = best_low(a - 1, -1, t, alt, low) if a > 0 and low[a - 1] else None
            de = best_low(b + 1, 1, t, alt, low) if b + 1 < n and low[b + 1] else None
            st = 'ground' if o is not None else ('hidden' if i > 0 and runs[i - 1][3] == 'hidden' else
                                                 ('cut' if t[a] - self.d0 < 900 else 'appear'))
            en = 'ground' if de is not None else (endst or ('cut' if self.d0 + 86400 - t[b] < 900 else 'lost'))
            sid = f'{hx}-{int(t[a])}'
            k = 3 if b - a > 6 else 1
            desc = bool(alt[b] >= 0 and alt[max(a, b - k)] > alt[b])
            self.seg.append({'seg_id': sid, 'hex': hx, 'date': self.date, 't0': int(t[a]), 't1': int(t[b]),
                             'lat0': float(lat[a]), 'lon0': float(lon[a]), 'alt0': int(alt[a]),
                             'lat1': float(lat[b]), 'lon1': float(lon[b]), 'alt1': int(alt[b]), 'descending_end': desc,
                             'start': st, 'end': en,
                             'o_lat': float(lat[o]) if o is not None else None, 'o_lon': float(lon[o]) if o is not None else None,
                             'd_lat': float(lat[de]) if de is not None else None, 'd_lon': float(lon[de]) if de is not None else None,
                             'maxlat': float(lat[a:b + 1].max()), 'minlat': float(lat[a:b + 1].min()), 'n': int(b - a + 1)})
            # zone test points: 1-minute observed points + interpolated points across coverage gaps
            lo_i = o if o is not None else a
            hi_i = de if de is not None else b
            idx = np.union1d(m[(m >= lo_i) & (m <= hi_i)], [i for i in (o, de) if i is not None]).astype(int)
            zb = self.zbuf
            zb['seg'].append(np.full(len(idx), sid, dtype=object)); zb['t'].append(t[idx]); zb['lat'].append(lat[idx])
            zb['lon'].append(lon[idx]); zb['alt'].append(alt[idx]); zb['obs'].append(np.ones(len(idx), bool))
            for j in range(a, b):
                if t[j + 1] - t[j] > GAP_INF:
                    pts, km = slerp(lat[j], lon[j], lat[j + 1], lon[j + 1], max(2, int(_km(lat[j], lon[j], lat[j + 1], lon[j + 1]) / 40)))
                    if len(pts):
                        tt = np.linspace(t[j], t[j + 1], len(pts) + 2)[1:-1]
                        zb['seg'].append(np.full(len(pts), sid, dtype=object)); zb['t'].append(tt)
                        zb['lat'].append(pts[:, 0]); zb['lon'].append(pts[:, 1])
                        zb['alt'].append(np.full(len(pts), max(alt[j], alt[j + 1]))); zb['obs'].append(np.zeros(len(pts), bool))
        if sum(len(x) for x in self.zbuf['t']) > 400_000:
            self.flush_zones()

    def flush_zones(self):
        zb = {k: np.concatenate(v) if v else np.array([]) for k, v in self.zbuf.items()}
        self.zbuf = {k: [] for k in self.zbuf}
        if not len(zb['t']):
            return
        pi, zi = TREE.query(shapely.points(zb['lon'], zb['lat']), predicate='within')
        for p, z in zip(pi, zi):
            if ZKIND[z] == 'cta' and zb['alt'][p] < 19500:
                continue
            key = (zb['seg'][p], ZID[z])
            tt, ob = float(zb['t'][p]), bool(zb['obs'][p])
            c = self.cross.get(key)
            if c is None:
                self.cross[key] = [tt, tt, int(ob), int(not ob)]
            else:
                c[0] = min(c[0], tt); c[1] = max(c[1], tt); c[2] += ob; c[3] += (not ob)

    # ---------- output ----------
    def write(self):
        self.flush_zones()
        for sub in ('positions', 'callsigns', 'aircraft', 'segments', 'crossings', 'h3'):
            os.makedirs(f'{DATA}/{sub}', exist_ok=True)
        P = self.pos
        tbl = pa.table({'hex': pa.array(np.concatenate(P['hex']), pa.string()),
                        't': pa.array(np.concatenate(P['t']), pa.int64()),
                        'lat': pa.array(np.concatenate(P['lat']), pa.float32()), 'lon': pa.array(np.concatenate(P['lon']), pa.float32()),
                        'alt': pa.array(np.concatenate(P['alt']).astype(np.int32)), 'gs': pa.array(np.concatenate(P['gs']), pa.float32())})
        tbl = tbl.sort_by([('hex', 'ascending'), ('t', 'ascending')])
        pq.write_table(tbl, f'{DATA}/positions/{self.date}.parquet', compression='zstd', row_group_size=60_000)
        pq.write_table(pa.table({'hex': [c[0] for c in self.cs], 't': pa.array([c[1] for c in self.cs], pa.int64()), 'cs': [c[2] for c in self.cs]})
                       .sort_by([('hex', 'ascending'), ('t', 'ascending')]), f'{DATA}/callsigns/{self.date}.parquet', compression='zstd')
        ac = {}
        for a in self.ac:
            ac.setdefault(a[0], a)
        A = list(ac.values())
        pq.write_table(pa.table({'hex': [a[0] for a in A], 'reg': [a[1] for a in A], 'type': [a[2] for a in A], 'desc': [a[3] for a in A],
                                 'own': [a[4] for a in A], 'mil': pa.array([a[5] for a in A], pa.int8())}),
                       f'{DATA}/aircraft/{self.date}.parquet', compression='zstd')
        pq.write_table(pa.Table.from_pylist(self.seg), f'{DATA}/segments/{self.date}.parquet', compression='zstd')
        C = [{'seg_id': k[0], 'zone_id': k[1], 't_in': int(v[0]), 't_out': int(v[1]), 'n_obs': v[2], 'n_inf': v[3]} for k, v in self.cross.items()]
        pq.write_table(pa.Table.from_pylist(C, schema=pa.schema([('seg_id', pa.string()), ('zone_id', pa.string()), ('t_in', pa.int64()),
                                                                ('t_out', pa.int64()), ('n_obs', pa.int32()), ('n_inf', pa.int32())])),
                       f'{DATA}/crossings/{self.date}.parquet', compression='zstd')
        H = sorted(self.h3rows)
        pq.write_table(pa.table({'cell': [h[0] for h in H], 'hour': pa.array([h[1] for h in H], pa.int64()), 'hex': [h[2] for h in H]}),
                       f'{DATA}/h3/{self.date}.parquet', compression='zstd', row_group_size=100_000)
        return tbl.num_rows, len(self.seg), len(C), len(H)


def best_low(start, step, t, alt, low):
    """Walk the low run next to a takeoff/landing (max 30 min) and return the index of the best airport point:
    an on-ground point if any, else the lowest altitude."""
    i, best = start, start
    while 0 <= i < len(t) and low[i] and abs(t[i] - t[start]) <= 1800:
        if alt[i] == -1:
            return i
        if alt[i] < alt[best]:
            best = i
        i += step
    return best


def despoof(t, lat, lon, vmax_kmh=1100.0):
    """Drop GNSS-spoofed / teleporting positions (e.g. aircraft shown at Beirut or Amman airport).
    Vectorised: mark jumps whose implied speed is impossible (> vmax and > 30 km), split the trace at jumps,
    and drop short stretches (< 45 min) that are boxed in by jumps, or end stretches (< 10 min) after/before one."""
    n = len(t)
    if n < 3:
        return np.ones(n, bool)
    d = _km(lat[:-1], lon[:-1], lat[1:], lon[1:])
    dt = np.maximum(np.diff(t), 1.0)
    jump = (d > 30) & (d / dt * 3600 > vmax_kmh)
    if not jump.any():
        return np.ones(n, bool)
    seg = np.concatenate([[0], np.cumsum(jump)])
    keep = np.ones(n, bool)
    nseg = seg[-1] + 1
    starts = np.searchsorted(seg, np.arange(nseg), 'left')
    ends = np.searchsorted(seg, np.arange(nseg), 'right') - 1
    dur = t[ends] - t[starts]
    longest = int(np.argmax(ends - starts))
    for k in range(nseg):
        if k == longest:
            continue
        a, b = starts[k], ends[k] + 1
        inner = 0 < k < nseg - 1
        at_hotspot = any(((np.abs(lat[a:b] - hy) < 0.05) & (np.abs(lon[a:b] - hx) < 0.05)).any() for hy, hx in SPOOF_HOTSPOTS)
        if (inner and dur[k] < 45 * 60) or (not inner and (dur[k] < 3 * 60 or (at_hotspot and dur[k] < 45 * 60))):
            keep[a:b] = False
    return keep


def _km(la1, lo1, la2, lo2):
    p = np.radians
    return 2 * R * np.arcsin(np.sqrt(np.sin(p(la2 - la1) / 2) ** 2 + np.cos(p(la1)) * np.cos(p(la2)) * np.sin(p(lo2 - lo1) / 2) ** 2))


class Parts(io.RawIOBase):
    """the downloaded parts read as one stream (cat without a pipe)"""
    def __init__(self, paths):
        self.paths, self.f = list(paths), None
    def readable(self):
        return True
    def readinto(self, b):
        while True:
            if self.f is None:
                if not self.paths:
                    return 0
                self.f = open(self.paths.pop(0), 'rb')
            n = self.f.readinto(b)
            if n:
                return n
            self.f.close(); self.f = None


def members(src):
    # ignore_zeros: carry on past an archive's end marker into the next archive of the release
    with tarfile.open(fileobj=src, mode='r|', ignore_zeros=True) as tf:
        for i, m in enumerate(tf):
            yield i, m, tf


def main():
    date, parts = sys.argv[1], sys.argv[2:]
    day, n = Day(date), 0
    keep = None
    if parts:   # first pass (headers only): the largest copy of every trace file
        best = {}
        for i, m, _ in members(io.BufferedReader(Parts(parts), 1 << 20)):
            if m.isfile() and '/traces/' in m.name and m.size >= best.get(m.name, (0, -1))[1]:
                best[m.name] = (i, m.size)
        keep = {i for i, _ in best.values()}
    src = io.BufferedReader(Parts(parts), 1 << 20) if parts else sys.stdin.buffer
    for i, m, tf in members(src):
        if not m.isfile() or '/traces/' not in m.name or (keep is not None and i not in keep):
            continue
        b = tf.extractfile(m).read()
        try:
            if b[:2] == b'\x1f\x8b':
                b = gzip.decompress(b)
            d = orjson.loads(b)
        except Exception:
            continue
        n += 1
        day.trace(d)
    if not n:
        print(f'{date}: no traces in the release', file=sys.stderr)
        sys.exit(3)
    rows, segs, cross, h3n = day.write()
    print(f'{date}: {n} traces -> {rows} positions, {segs} segments, {cross} crossings, {h3n} h3 rows, '
          f'{day.spoof_dropped} spoofed/teleport positions dropped', file=sys.stderr)


if __name__ == '__main__':
    main()

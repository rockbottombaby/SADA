"""Recompute one zone's crossings from the stored 1-minute positions and replace that zone's rows in the daily
crossings files — for when a zone's boundary changes (for example, an official territorial-sea line replacing the approximation). Nothing is
re-ingested: the day files keep every aircraft's positions, so a boundary change is a recompute, not a backfill.

Candidates are the day's segments with a crossing of a parent zone the new boundary lies within (Iceland: fir:BIRD),
plus the zone's old crossings. The zone test mirrors ingest_day: the segment's 1-minute observed points (plus its
recorded origin/destination point) and great-circle points interpolated across silences longer than GAP_INF (inferred).
Afterwards build_month.py --all (VERSION bumped) rebuilds the month tables and build_index.py the airspace index.

Usage: python -I recompute_zone.py --zone sov:ISL --parent fir:BIRD [--days 2025-06-01,…] [--workers 6]
           [--check] [--local DIR] [--zones-file PATH]
  --check        compute only and compare with the stored rows (no upload); with --zones-file pointing at the OLD zone
                 set this validates the mirror itself (the recompute should reproduce the stored crossings)
  --local DIR    read DIR/{positions,segments,crossings}/DATE.parquet instead of R2 (testing)
Each day's replaced rows are backed up to R2 v1/meta/backup/crossings_<zone>_<UTC stamp>/DATE.parquet before that day is overwritten.
"""
import os, sys, io, json, time, argparse
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
import shapely
from shapely.geometry import shape

HERE = os.path.dirname(os.path.abspath(__file__))
OAM = os.path.dirname(HERE)
DATA = f'{OAM}/data'
sys.path.insert(0, HERE)
from ingest_day import slerp, _km, GAP_INF, LOW_FT   # the same interpolation as the ingest (ingest_day loads the zone set once)

SCHEMA = pa.schema([('seg_id', pa.string()), ('zone_id', pa.string()), ('t_in', pa.int64()), ('t_out', pa.int64()),
                    ('n_obs', pa.int32()), ('n_inf', pa.int32())])


def s3():
    import boto3
    return boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])


def zone_geom(zones_file, zid):
    for f in json.load(open(zones_file))['features']:
        if f['properties']['id'] == zid:
            return shape(f['geometry'])
    raise SystemExit(f'{zid} not in {zones_file}')


def low_end(t, alt, start, step):
    """ingest_day.best_low on the minute samples: walk the low run next to a take-off/landing (max 30 min) and return the
    index of the best airport point (on the ground if any, else the lowest), or None when the run does not start low."""
    low = (alt == -1) | ((alt >= 0) & (alt <= LOW_FT))
    if not (0 <= start < len(t)) or not low[start]:
        return None
    i, best = start, start
    while 0 <= i < len(t) and low[i] and abs(t[i] - t[start]) <= 1800:
        if alt[i] == -1:
            return i
        if alt[i] < alt[best]:
            best = i
        i += step
    return best


def crossings_of(geom, segs, pos):
    """{seg_id: [t_in, t_out, n_obs, n_inf]} for the candidate segments from their positions (hex -> (t, lat, lon, alt))."""
    out = {}
    for sg in segs:
        P = pos.get(sg['hex'])
        if P is None:
            continue
        t, lat, lon, alt = P
        i0, i1 = np.searchsorted(t, sg['t0']), np.searchsorted(t, sg['t1'], side='right')
        # like the ingest, the test points run from the origin's airport point to the destination's (the low run next to
        # the segment); when the recorded end is not among the minute samples, its stored coordinates stand in
        o = low_end(t, alt, i0 - 1, -1) if sg.get('o_lat') is not None else None
        d = low_end(t, alt, i1, 1) if sg.get('d_lat') is not None else None
        lo_i, hi_i = (o if o is not None else i0), (d + 1 if d is not None else i1)
        tt, la, lo = [t[lo_i:hi_i].astype(float)], [lat[lo_i:hi_i].astype(float)], [lon[lo_i:hi_i].astype(float)]
        obs = [np.ones(hi_i - lo_i, bool)]
        for idx, (plat, plon, pt) in ((o, (sg.get('o_lat'), sg.get('o_lon'), sg['t0'])), (d, (sg.get('d_lat'), sg.get('d_lon'), sg['t1']))):
            if idx is None and plat is not None and plon is not None:
                tt.append(np.array([float(pt)])); la.append(np.array([float(plat)])); lo.append(np.array([float(plon)])); obs.append(np.array([True]))
        t_, la_, lo_ = tt[0], la[0], lo[0]
        for j in range(len(t_) - 1):
            if t_[j + 1] - t_[j] > GAP_INF:
                pts, _ = slerp(la_[j], lo_[j], la_[j + 1], lo_[j + 1], max(2, int(_km(la_[j], lo_[j], la_[j + 1], lo_[j + 1]) / 40)))
                if len(pts):
                    tt.append(np.linspace(t_[j], t_[j + 1], len(pts) + 2)[1:-1]); la.append(pts[:, 0]); lo.append(pts[:, 1]); obs.append(np.zeros(len(pts), bool))
        T, LA, LO, OB = (np.concatenate(x) for x in (tt, la, lo, obs))
        if not len(T):
            continue
        inside = shapely.contains_xy(geom, LO, LA)
        if inside.any():
            out[sg['seg_id']] = [int(T[inside].min()), int(T[inside].max()), int((inside & OB).sum()), int((inside & ~OB).sum())]
    return out


def day_inputs(date, local, client, bucket):
    files = {}
    for tier in ('segments', 'crossings', 'positions'):
        if local:
            files[tier] = f'{local}/{tier}/{date}.parquet'
        else:
            p = f'{DATA}/rezone/{tier}/{date}.parquet'
            os.makedirs(os.path.dirname(p), exist_ok=True)
            client.download_file(bucket, f'v1/days/{tier}/{date}.parquet', p)
            files[tier] = p
    return files


def process_day(date, geom, zone, parent, local, check, client, bucket):
    t0 = time.time()
    files = day_inputs(date, local, client, bucket)
    cross = pq.read_table(files['crossings'])
    old = cross.filter(pc.equal(cross['zone_id'], zone))
    cand = set(cross.filter(pc.is_in(cross['zone_id'], pa.array([parent, zone])))['seg_id'].to_pylist())
    segs = pq.read_table(files['segments'], columns=['seg_id', 'hex', 't0', 't1', 'o_lat', 'o_lon', 'd_lat', 'd_lon'])
    segs = segs.filter(pc.is_in(segs['seg_id'], pa.array(list(cand)))).to_pylist() if cand else []
    pos = {}
    if segs:
        hexes = sorted({s['hex'] for s in segs})
        P = pq.read_table(files['positions'], columns=['hex', 't', 'lat', 'lon', 'alt'], filters=[('hex', 'in', hexes)])
        h, t, la, lo, al = (P[c].to_numpy() for c in ('hex', 't', 'lat', 'lon', 'alt'))
        order = np.lexsort((t, h)); h, t, la, lo, al = h[order], t[order], la[order], lo[order], al[order]
        starts = np.r_[0, np.nonzero(h[1:] != h[:-1])[0] + 1, len(h)]
        for a, b in zip(starts, starts[1:]):
            pos[h[a]] = (t[a:b], la[a:b], lo[a:b], al[a:b])
    new = crossings_of(geom, segs, pos)
    rows = [{'seg_id': k, 'zone_id': zone, 't_in': v[0], 't_out': v[1], 'n_obs': v[2], 'n_inf': v[3]} for k, v in sorted(new.items())]
    stat = {'date': date, 'candidates': len(segs), 'old': old.num_rows, 'new': len(rows), 's': round(time.time() - t0, 1)}
    if check:
        o = {r['seg_id']: r for r in old.to_pylist()}
        both = set(o) & set(new)
        stat.update(both=len(both), only_old=len(set(o) - set(new)), only_new=len(set(new) - set(o)),
                    t_in_err_max=max([abs(o[k]['t_in'] - new[k][0]) for k in both] or [0]),
                    t_in_err_gt60=sum(abs(o[k]['t_in'] - new[k][0]) > 60 for k in both))
        return stat, None, old
    keep = cross.filter(pc.not_equal(cross['zone_id'], zone))
    table = pa.concat_tables([keep.cast(SCHEMA), pa.Table.from_pylist(rows, schema=SCHEMA)]) if rows else keep.cast(SCHEMA)
    out = f'{DATA}/rezone/out/{date}.parquet'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    pq.write_table(table, out, compression='zstd')
    if not local:
        for tier in ('positions', 'segments', 'crossings'):
            os.remove(files[tier])
    return stat, out, old


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--zone', required=True); ap.add_argument('--parent', required=True)
    ap.add_argument('--days'); ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--check', action='store_true'); ap.add_argument('--local'); ap.add_argument('--zones-file', default=f'{DATA}/zones/zones_full.geojson')
    a = ap.parse_args()
    geom = zone_geom(a.zones_file, a.zone)
    parent = zone_geom(a.zones_file, a.parent) if a.parent != a.zone else geom
    assert parent.buffer(1e-6).contains(geom), f'{a.zone} is not within {a.parent}: the parent must enclose the new boundary'
    client = bucket = None
    if not a.local:
        client, bucket = s3(), os.environ['R2_BUCKET']
    if a.days:
        days = a.days.split(',')
    elif a.local:
        days = sorted(f[:-8] for f in os.listdir(f'{a.local}/crossings') if f.endswith('.parquet'))
    else:
        days = sorted(o['Key'].split('/')[-1][:-8] for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='v1/days/crossings/')
                      for o in page.get('Contents', []))
    print(f'{a.zone}: {len(days)} days, {a.workers} workers, {"check only" if a.check else "replace"}', flush=True)
    stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
    bdir = f'v1/meta/backup/crossings_{a.zone.replace(":", "_")}_{stamp}'
    stats, t0 = [], time.time()
    with ThreadPoolExecutor(a.workers) as ex:
        for stat, out, old in ex.map(lambda d: process_day(d, geom, a.zone, a.parent, a.local, a.check, client, bucket), days):
            stats.append(stat)
            if out and not a.local:
                # the old rows go up first, so a crash between the two leaves nothing unrecoverable
                buf = io.BytesIO(); pq.write_table(old.cast(SCHEMA), buf, compression='zstd')
                client.put_object(Bucket=bucket, Key=f'{bdir}/{stat["date"]}.parquet', Body=buf.getvalue())
                client.upload_file(out, bucket, f'v1/days/crossings/{stat["date"]}.parquet'); os.remove(out)
            print(json.dumps(stat), flush=True)
    tot = lambda k: sum(s[k] for s in stats)
    print(f'done in {(time.time() - t0) / 60:.1f} min: {tot("old"):,} old rows -> {tot("new"):,} new rows over {len(days)} days')
    if a.check:
        print(f'  matched {tot("both"):,}, only old {tot("only_old"):,}, only new {tot("only_new"):,}, entry-time off by >60 s: {tot("t_in_err_gt60"):,}')
    elif not a.local:
        print(f'replaced rows backed up under {bdir}/')


if __name__ == '__main__':
    main()

"""Validate our Iceland sovereign-airspace crossings against ADS-B Exchange's free samples (the 1st of each month).

ADSB.lol had no receivers over Iceland from 2023-03 to 2024-10, so every crossing there is "inferred" (the path estimated
across the coverage gap). ADS-B Exchange did have Icelandic receivers then and publishes complete trace files for the 1st of
every month free of charge (samples.adsbexchange.com, no stated licence: used here only to check our data, never
redistributed). For each sample day in the gap this script fetches the ADSBx trace of every aircraft our archive had near
Iceland (any crossing of the Reykjavik FIR that day), computes the true crossings of sov:ISL from those positions, and
compares them with ours: precision (our inferred crossings that were real), recall (real crossings we had), entry-time error.

Usage: python -I validate_iceland.py [--days 2023-06-01,…] [--concurrency 4] [--out ../data/validation]
Writes <out>/iceland_sov_adsbx.json (per day and overall) and uploads it to R2 v1/meta/validation/iceland_sov_adsbx.json.
"""
import os, sys, json, gzip, time, datetime as dt
from concurrent.futures import ThreadPoolExecutor
import urllib.request, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_month as bm
import duckdb
from shapely.geometry import shape, Point
from shapely.prepared import prep

OAM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADSBX = 'https://samples.adsbexchange.com/traces/{y}/{m}/{d}/{xx}/trace_full_{hex}.json'
UA = 'SADA airwatch validation (open-source investigative flight monitor; checking inferred airspace crossings)'


def sov_isl():
    for f in json.load(open(f'{OAM}/data/zones/zones_full.geojson'))['features']:
        if f['properties']['id'] == 'sov:ISL':
            return prep(shape(f['geometry']))
    raise SystemExit('sov:ISL not in zones_full.geojson')


def fetch_trace(day, hx):
    y, m, d = day.split('-')
    req = urllib.request.Request(ADSBX.format(y=y, m=m, d=d, xx=hx[-2:], hex=hx), headers={'User-Agent': UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            return json.loads(gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            time.sleep(2 * (attempt + 1))
        except Exception:
            time.sleep(2 * (attempt + 1))
    return None


def true_crossing(trace, poly):
    """first and last epoch second of positions inside the polygon, or None"""
    if not trace or not trace.get('trace'):
        return None
    t0 = trace['timestamp']
    inside = [t0 + p[0] for p in trace['trace'] if p[1] is not None and poly.contains(Point(p[2], p[1]))]
    return (min(inside), max(inside), len(inside)) if inside else None


ICELAND = (64.9, -18.9)   # roughly the island's centre
def near_iceland_when(trace, t_in, t_out, km=300, slack=3600):
    """did ADSBx see this aircraft within `km` of Iceland around our inferred crossing window? (else we cannot judge it)"""
    if not trace or not trace.get('trace'):
        return False
    t0 = trace['timestamp']
    import math
    for p in trace['trace']:
        if p[1] is None or not (t_in - slack <= t0 + p[0] <= t_out + slack):
            continue
        dlat = (p[1] - ICELAND[0]) * 111.2, (p[2] - ICELAND[1]) * 111.2 * math.cos(math.radians(ICELAND[0]))
        if math.hypot(*dlat) <= km:
            return True
    return False


def main():
    args = sys.argv[1:]
    out_dir = args[args.index('--out') + 1] if '--out' in args else f'{OAM}/data/validation'
    conc = int(args[args.index('--concurrency') + 1]) if '--concurrency' in args else 4
    if '--days' in args:
        days = args[args.index('--days') + 1].split(',')
    else:   # the 1st of every month inside the gap (ADSB.lol saw nothing over Iceland 2023-03-11 .. 2024-10-20)
        days = [f'{y}-{m:02d}-01' for y in (2023, 2024) for m in range(1, 13) if '2023-04-01' <= f'{y}-{m:02d}-01' <= '2024-11-01']
    poly = sov_isl()
    acct = bm.env['R2_ENDPOINT'].split('//')[1].split('.')[0]
    con = duckdb.connect()
    con.execute(f"CREATE SECRET r2 (TYPE r2, KEY_ID '{bm.env['R2_ACCESS_KEY_ID']}', SECRET '{bm.env['R2_SECRET_ACCESS_KEY']}', ACCOUNT_ID '{acct}')")
    R = f'r2://{bm.B}/v1'
    results = {'days': {}, 'source': 'ADS-B Exchange samples (1st of each month), compared with SADA/ADSB.lol-derived crossings of sov:ISL',
               'run_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}
    for day in days:
        t = time.time()
        # candidates: every aircraft our archive had in the Reykjavik FIR that day; ours: our sov:ISL crossings that day
        # from the monthly crossings table (the source of truth), by crossing time within the day; flights that crossed
        # just after midnight departed the day before, so the departure date is not the right filter
        t0 = int(dt.datetime.fromisoformat(day + 'T00:00:00+00:00').timestamp()); t1 = t0 + 86400
        prev = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()[:7]
        lz = sorted({f"'{R}/flights/leg_zones/{m}.parquet'" for m in (day[:7], prev)})
        cand = {r[0] for r in con.sql(f"SELECT DISTINCT hex FROM read_parquet([{','.join(lz)}]) WHERE zone_id = 'fir:BIRD' AND t_in >= {t0} AND t_in < {t1}").fetchall()}
        ours = {r[0]: (r[1], r[2], r[3]) for r in con.sql(f"SELECT hex, min(t_in), max(t_out), any_value(evidence) FROM read_parquet([{','.join(lz)}]) WHERE zone_id = 'sov:ISL' AND t_in >= {t0} AND t_in < {t1} GROUP BY hex").fetchall()}
        cand |= set(ours)
        with ThreadPoolExecutor(conc) as ex:
            traces = dict(zip(cand, ex.map(lambda h: fetch_trace(day, h), cand)))
        got = {h: tr for h, tr in traces.items() if tr}
        true = {h: c for h, tr in got.items() if (c := true_crossing(tr, poly))}
        hit = {h for h in ours if h in true}
        # ours that ADSBx can judge: it saw the aircraft near Iceland around our window; the rest is unverifiable, not wrong
        contradicted = sorted(h for h in ours if h not in true and h in got and near_iceland_when(got[h], ours[h][0], ours[h][1]))
        unverifiable = sorted(h for h in ours if h not in true and h not in contradicted)
        checked = len(hit) + len(contradicted)
        errs = [abs(ours[h][0] - true[h][0]) for h in hit]
        r = {'candidates': len(cand), 'adsbx_traces': len(got), 'true_crossings': len(true), 'ours': len(ours), 'ours_checked': checked,
             'ours_confirmed': len(hit), 'ours_contradicted': contradicted, 'ours_unverifiable': unverifiable, 'missed': sorted(set(true) - set(ours)),
             'precision': round(len(hit) / checked, 3) if checked else None, 'recall': round(len(hit) / len(true), 3) if true else None,
             'entry_time_error_s_median': sorted(errs)[len(errs) // 2] if errs else None, 'entry_time_error_s_p90': sorted(errs)[int(len(errs) * 0.9)] if errs else None,
             'seconds': round(time.time() - t)}
        results['days'][day] = r
        print(f"{day}: candidates {r['candidates']}, ADSBx traces {r['adsbx_traces']}, true crossings {r['true_crossings']}, ours {r['ours']} "
              f"(confirmed {r['ours_confirmed']}, contradicted {len(contradicted)}, unverifiable {len(unverifiable)}) → precision {r['precision']} recall {r['recall']} "
              f"entry error median {r['entry_time_error_s_median']} s · {r['seconds']} s", flush=True)
    ds = results['days']
    tot = lambda k: sum(v[k] for v in ds.values())
    results['overall'] = {'days': len(ds), 'ours_checked': tot('ours_checked'), 'ours_confirmed': tot('ours_confirmed'), 'true_crossings': tot('true_crossings'),
                          'precision': round(tot('ours_confirmed') / tot('ours_checked'), 3) if tot('ours_checked') else None,
                          'recall': round(tot('ours_confirmed') / tot('true_crossings'), 3) if tot('true_crossings') else None}
    os.makedirs(out_dir, exist_ok=True)
    path = f'{out_dir}/iceland_sov_adsbx.json'
    json.dump(results, open(path, 'w'), indent=1)
    bm.s3.put_object(Bucket=bm.B, Key='v1/meta/validation/iceland_sov_adsbx.json', Body=json.dumps(results).encode(), ContentType='application/json')
    print('overall:', results['overall'])


if __name__ == '__main__':
    main()

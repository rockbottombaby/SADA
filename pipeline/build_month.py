"""Build one month of flight legs from the daily tiers in R2 and publish them, plus the manifest (M2).

Usage: python -I build_month.py 2024-06 [2024-07 ...]     build + upload these months, then rewrite the manifest
       python -I build_month.py --all [--jobs 5] [--keep-meta]   months that are new, built with older logic, or whose days changed
       python -I build_month.py --manifest                 only rewrite the manifest

Reads  R2 v1/days/{segments,crossings,callsigns,aircraft}/DATE.parquet for the month plus one day either side
       (flights crossing midnight at a month boundary are stitched; a leg belongs to the month of its departure).
Writes R2 v1/flights/{legs,leg_zones,aircraft}/YYYY-MM.parquet, v1/meta/{airports.parquet,zones.geojson}, v1/manifest.json
Memory: the month is processed in 16 slices by the first hex digit of the aircraft address, so a month fits in a few GB.
"""
import os, sys, io, json, calendar, datetime as dt
import pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
import boto3
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # run with python -I: import the sibling module explicitly
from build_legs import Airports, SovZones, build, OAM, DATA

env = dict(l.strip().split('=', 1) for l in open(f'{OAM}/../.env') if '=' in l and not l.startswith('#'))
s3 = boto3.client('s3', endpoint_url=env['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
B = env['R2_BUCKET']
CACHE = f'{OAM}/cache'          # local copies of the small daily tiers (gitignored)
TIERS = ['segments', 'crossings', 'callsigns', 'aircraft']
ZONE_CELLS = f'{CACHE}/zone_cells_res3.parquet'
VERSION = 4   # bump when the leg or zone logic changes: --all rebuilds months built with an older version


def listing(prefix):
    out, tok = [], None
    while True:
        r = s3.list_objects_v2(Bucket=B, Prefix=prefix, **({'ContinuationToken': tok} if tok else {}))
        out += r.get('Contents', [])
        if not r.get('IsTruncated'):
            return out
        tok = r['NextContinuationToken']


def zone_cells():
    """(zone_id, cell) for every zone at H3 res 3, cells overlapping the zone (small countries get at least one cell)."""
    if not os.path.exists(ZONE_CELLS):
        import h3
        rows = []
        for f in json.load(open(f'{DATA}/zones/zones_full.geojson'))['features']:
            shp = h3.geo_to_h3shape(f['geometry'])
            try: cells = h3.h3shape_to_cells_experimental(shp, 3, contain='overlap')
            except Exception: cells = h3.h3shape_to_cells(shp, 3)
            rows += [{'zone_id': f['properties']['id'], 'cell': c} for c in cells]
        os.makedirs(CACHE, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(rows), ZONE_CELLS)
    return ZONE_CELLS


def coverage_month(m, have_days):
    """Receiver coverage per zone and day: distinct aircraft and hours with positions inside the zone's H3 cells.
    Zero aircraft over a zone on a day means no receiver coverage there, not "no flights"."""
    import duckdb
    files = [fetch('h3', d) for d in have_days]
    con = duckdb.connect()
    con.execute('SET memory_limit = \'3GB\'')
    tb = con.sql(f"""SELECT z.zone_id, strftime(make_timestamp(h.hour * 3600 * 1000000), '%Y-%m-%d') AS date,
            count(DISTINCT h.hex) AS aircraft, count(DISTINCT h.hour) AS hours
        FROM read_parquet({files!r}) h JOIN read_parquet('{zone_cells()}') z USING (cell)
        GROUP BY ALL ORDER BY zone_id, date""").to_arrow_table()
    buf = io.BytesIO()
    pq.write_table(tb, buf, compression='zstd')
    s3.put_object(Bucket=B, Key=f'v1/flights/coverage/{m}.parquet', Body=buf.getvalue())


def done_days():
    """{date: marker} for days finished in R2 (empty upstream releases have 'empty': True and no tiers)."""
    out = {}
    for o in listing('v1/done/'):
        d = o['Key'][8:-5]
        out[d] = o
    return out


def fetch(tier, date):
    path = f'{CACHE}/{tier}/{date}.parquet'
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        s3.download_file(B, f'v1/days/{tier}/{date}.parquet', path + '.tmp')
        os.replace(path + '.tmp', path)
    return path


def month_days(m):
    y, mo = map(int, m.split('-'))
    return [f'{m}-{d:02d}' for d in range(1, calendar.monthrange(y, mo)[1] + 1)]


def shift(date, n):
    return (dt.date.fromisoformat(date) + dt.timedelta(days=n)).isoformat()


def build_month(m, done, empty, ap, sz):
    days = month_days(m)
    ctx = [shift(days[0], -1)] + days + [shift(days[-1], 1)]
    have = [d for d in ctx if d in done and d not in empty]
    if not any(d in have for d in days):
        print(m, 'no days yet'); return None
    tables = {t: pa.concat_tables([pq.read_table(fetch(t, d)) for d in have], promote_options='permissive') for t in TIERS}
    # results go into Arrow tables per slice: a month has ~10M leg-zone rows, far too many to keep as Python dicts
    LT, ZT, AC = [], [], {}
    # slice by the first two characters of the address (256+ slices): no slice holds more than a few % of the traffic
    for h in sorted(set(pc.utf8_slice_codeunits(tables['segments']['hex'], 0, 2).to_pylist())):
        part = {t: tb.filter(pc.starts_with(tb['hex'], h)).to_pylist() for t, tb in tables.items() if 'hex' in tb.column_names}
        # crossings carry seg_id, not hex: keep those of this slice's segments
        seg_ids = pa.array([s['seg_id'] for s in part['segments']])
        cr = tables['crossings'].filter(pc.is_in(tables['crossings']['seg_id'], seg_ids)).to_pylist()
        l, lz, ac = build(ap, sz, part['segments'], cr, part['callsigns'], part['aircraft'])
        del part, cr
        keep = {r['leg_id'] for r in l if r['date'].startswith(m)}
        if keep:
            LT.append(pa.Table.from_pylist([r for r in l if r['leg_id'] in keep]))
            ZT.append(pa.Table.from_pylist([r for r in lz if r['leg_id'] in keep]))
        del l, lz
        AC.update(ac)
        print(f'  {m} slice {h}: {len(keep):,} legs', end='\r', flush=True)
    del tables
    L = pa.concat_tables(LT, promote_options='permissive'); del LT
    LZ = pa.concat_tables(ZT, promote_options='permissive'); del ZT
    # one row per leg: some ADSB.lol days (2025-04..12) repeat an aircraft's earlier trace, so the same flight was stitched
    # from several day files with different ends (~0.01% of legs); keep the most complete version (latest end, recorded
    # end, the flight's own day first) and only its crossings
    import duckdb as _ddb
    _c = _ddb.connect()
    _c.execute("SET memory_limit = '3GB'; SET threads = 2")   # several months build in parallel: DuckDB must not claim the machine
    L = _c.sql("""SELECT * EXCLUDE (rn) FROM (SELECT *, row_number() OVER (PARTITION BY leg_id ORDER BY t1 DESC, (to_cert = 'recorded') DESC, (days = date) DESC, days ASC) AS rn FROM L) WHERE rn = 1 ORDER BY t0""").to_arrow_table()
    LZ = _c.sql("""SELECT DISTINCT ON (leg_id, zone_id, t_in) * FROM LZ WHERE leg_id IN (SELECT leg_id FROM L) ORDER BY zone_id, t_in""").to_arrow_table()
    _c.close()
    seen = set(L['hex'].to_pylist())
    ACL = pa.Table.from_pylist([v for k, v in AC.items() if k in seen])
    # one schema for every month: a column that happens to be all-empty in a month would otherwise get type "null",
    # and the browser would need slow schema unification across all month files
    fix = lambda tb: tb.cast(pa.schema([pa.field(f.name, pa.string() if pa.types.is_null(f.type) else f.type) for f in tb.schema]))
    L, LZ, ACL = fix(L), fix(LZ), fix(ACL)
    for name, tb, rg in (('legs', L, 50_000), ('leg_zones', LZ, 100_000), ('aircraft', ACL, 100_000)):
        buf = io.BytesIO()
        pq.write_table(tb, buf, compression='zstd', row_group_size=rg)
        s3.put_object(Bucket=B, Key=f'v1/flights/{name}/{m}.parquet', Body=buf.getvalue())
    days_in = [d for d in days if d in done]
    coverage_month(m, [d for d in days if d in have])
    complete = len(days_in) == len(days) and shift(days[-1], 1) in done
    info = {'month': m, 'version': VERSION, 'legs': L.num_rows, 'leg_zones': LZ.num_rows, 'aircraft': ACL.num_rows, 'days': len(days_in), 'complete': complete,
            'missing_days': [d for d in days if d not in done], 'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}
    s3.put_object(Bucket=B, Key=f'v1/flights/info/{m}.json', Body=json.dumps(info).encode())
    import resource
    print(f'{m}: {L.num_rows:,} legs, {LZ.num_rows:,} leg-zone rows, {len(days_in)}/{len(days)} days{"" if complete else " (incomplete, rebuild later)"}'
          f' · peak RAM {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (1e9 if sys.platform == "darwin" else 1e6):.1f} GB', flush=True)
    return info


def _build_one(m, done, empty):
    return build_month(m, done, empty, Airports(), SovZones())


def write_manifest(done, empty):
    infos = {}
    for o in listing('v1/flights/info/'):
        i = json.loads(s3.get_object(Bucket=B, Key=o['Key'])['Body'].read())
        infos[i['month']] = i
    # flight coverage = days that are INSIDE the built flight tables: a month built before all its days were processed
    # leaves the later days out (they come in when the month is rebuilt). Listing them would make an incomplete month
    # look complete ("24 departures from Keflavik in two weeks").
    def included(d):
        i = infos.get(d[:7])
        return bool(i) and d not in empty and d not in set(i.get('missing_days', []))
    dates = sorted(d for d in done if included(d))
    manifest = {
        'name': 'SADA', 'version': 2, 'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds'),
        'dates': dates, 'months': sorted(infos), 'month_info': infos,
        'legs': sum(i['legs'] for i in infos.values()), 'leg_zones': sum(i['leg_zones'] for i in infos.values()),
        # paths are relative to the manifest's folder (the data URL ends in /v1)
        'files': {'legs': 'flights/legs/{month}.parquet', 'leg_zones': 'flights/leg_zones/{month}.parquet',
                  'aircraft': 'flights/aircraft/{month}.parquet', 'coverage': 'flights/coverage/{month}.parquet',
                  'airports': 'meta/airports.parquet', 'zones': 'meta/zones.geojson', 'registry': 'meta/registry.parquet',
                  'positions': 'days/positions/{date}.parquet', 'callsigns': 'days/callsigns/{date}.parquet', 'h3': 'days/h3/{date}.parquet'},
        'h3_resolution': 3,
        'attribution': ['ADS-B positions: ADSB.lol globe_history, Open Database License (ODbL) 1.0. Derived database also ODbL.',
                        'Countries: Natural Earth (public domain). Sovereign airspace = land + 12 nm, approximate.',
                        'FIRs: VATSpy community boundaries (approximate); Iceland BIRD from the Icelandic eAIP.',
                        'Airports: OurAirports (public domain).']}
    # search indexes (build_index.py): which years / quarters exist and which months each covers
    try:
        idx = json.loads(s3.get_object(Bucket=B, Key='v1/index/info.json')['Body'].read())
        if idx.get('layout') == 2:   # catalog of index files: which keys exist for which period, and the months each covers
            manifest['files'].update({'index_to': 'index/to/{key}/{period}.parquet', 'index_from': 'index/from/{key}/{period}.parquet',
                                      'index_zone': 'index/zone/{key}/{period}.parquet'})
            manifest['index'] = {'routes': {p: {'months': v['months'], 'to': v.get('to', []), 'from': v.get('from', [])} for p, v in idx['routes'].items()},
                                 'zones': {p: {'months': v['months'], 'zone': v.get('zone', [])} for p, v in idx['zones'].items()}}
            for kind in ('hex', 'airport'):   # yearly per-key indexes for one aircraft / one airport
                if idx.get(kind):
                    manifest['files'][f'index_{kind}'] = f'index/{kind}/{{key}}/{{period}}.parquet'
                    manifest['index'][kind] = {p: {'months': v['months'], 'keys': v.get('keys', [])} for p, v in idx[kind].items()}
            if idx.get('lookups'):   # re-sorted month copies for one airport / aircraft / flight (build_index.py)
                manifest['files'].update({'by_airport': 'flights/by_airport/{month}.parquet', 'by_hex': 'flights/by_hex/{month}.parquet',
                                          'zones_by_leg': 'flights/zones_by_leg/{month}.parquet'})
                manifest['lookups'] = sorted(m for m in idx['lookups'] if m in infos)
    except s3.exceptions.NoSuchKey:
        pass
    s3.put_object(Bucket=B, Key='v1/manifest.json', Body=json.dumps(manifest, indent=1).encode(), ContentType='application/json')
    print(f'manifest: {len(dates)} days, {len(infos)} months, {manifest["legs"]:,} legs')


def publish_meta(ap):
    buf = io.BytesIO()
    pq.write_table(pa.Table.from_pylist([{k: v for k, v in a.items() if k not in ('rank', 'tier')} for a in ap.rows if a['tier'] < 2 or a['military']]),
                   buf, compression='zstd')
    s3.put_object(Bucket=B, Key='v1/meta/airports.parquet', Body=buf.getvalue())
    s3.upload_file(f'{DATA}/zones/zones.geojson', B, 'v1/meta/zones.geojson', ExtraArgs={'ContentType': 'application/geo+json'})


def main():
    args = sys.argv[1:]
    done = done_days()
    empty = {d for d, o in done.items() if o['Size'] < 200}   # empty-release markers are tiny JSON without tier sizes
    if '--manifest' not in args:
        ap, sz = Airports(), SovZones()
        if '--keep-meta' not in args:   # airports + simplified zones; the daily job leaves them alone
            publish_meta(ap)
        if '--all' in args:
            built = {o['Key'][16:-5]: json.loads(s3.get_object(Bucket=B, Key=o['Key'])['Body'].read()) for o in listing('v1/flights/info/')}
            months = sorted({d[:7] for d in done if d not in empty})
            # rebuild a month when it is new, built with older logic, or a day in it (or the next day, used for stitching)
            # finished after its last build. Months with permanently failed days are then not rebuilt every night.
            last_done = {}
            for d, o in done.items():
                for mm in {d[:7], shift(d, -1)[:7]}:
                    last_done[mm] = max(last_done.get(mm, ''), o['LastModified'].isoformat())
            # also when a day it lacked is there now: a long run reads the finished days once at its start, so a month
            # built late in it can miss days that finished meanwhile (and those days look older than the build)
            months = [m for m in months if m not in built or built[m].get('version') != VERSION
                      or last_done.get(m, '') > built[m].get('built_utc', '')
                      or any(d in done for d in built[m].get('missing_days', []))]
        else:
            months = args
        jobs = int(args[args.index('--jobs') + 1]) if '--jobs' in args else 1
        months = [m for m in months if not m.startswith('--') and not m.isdigit()]
        # each month in a fresh process (memory goes back to the OS); a failed month does not block the others;
        # the manifest is rewritten after every month so finished months appear in the app right away
        from concurrent.futures import ProcessPoolExecutor, as_completed
        with ProcessPoolExecutor(jobs, max_tasks_per_child=1) as ex:
            futs = {ex.submit(_build_one, m, done, empty): m for m in months}
            for f in as_completed(futs):
                try: f.result()
                except Exception as e: print(f'{futs[f]}: FAILED {e!r}', flush=True)
                write_manifest(done, empty)
    write_manifest(done, empty)


if __name__ == '__main__':
    main()

"""Search indexes for fast long-period searches in the browser (built from the monthly flight tables in R2).

One small file per key, so a search reads only the file(s) it needs (a browser cannot afford to read the table of contents
of a big file, let alone skip through it):
  index/to/<ISO2>/<YYYY>.parquet      flights of the year arriving in a country
  index/from/<ISO2>/<YYYY>.parquet    flights of the year departing from a country
  index/zone/<zone>/<YYYY-Qn>.parquet airspace crossings of the quarter with the flight's columns; zone "sov:ISL" → "sov_ISL"
Unknown country → "_". Monthly files stay the source of truth; these are re-sorted copies.
  index/hex/<2-char prefix>/<YYYY>.parquet   a year's flights by aircraft address prefix (built from the monthly by_hex copies,
                                              so each aircraft sits in a couple of row groups per month)
  index/airport/<2-char prefix>/<YYYY>.parquet a year's flight ends (code, role dep|arr) by ICAO-code prefix (from by_airport)
    Yearly aircraft/airport indexes are built for complete past years only (nightly on CI); --all-years adds the current year.
  flights/by_airport/<YYYY-MM>.parquet  the month's flights once per end (code, role dep|arr), sorted by airport code
  flights/by_hex/<YYYY-MM>.parquet      the month's flights sorted by aircraft address
  flights/zones_by_leg/<YYYY-MM>.parquet the month's airspace crossings sorted by flight
    ("lookups": small row groups, so the browser reads only the few it needs for one airport, aircraft or flight)
Incremental: a year (routes), quarter (zones) or month (lookups) is rebuilt when one of its months was (re)built after it, or with --force.

Usage: python -I build_index.py [--force] [--only routes,zones,lookups,hex,airport] [--all-years] [--memory 6GB]
Writes R2 v1/index/..., v1/index/info.json (catalog of files), then rewrites the manifest.
"""
import os, sys, json, time, glob, shutil, tempfile, datetime as dt
import duckdb

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_month as bm   # R2 client, listings, manifest writer

LEG_COLS = ('leg_id, hex, reg, type, operator, mil, callsigns, date, t0, t1, from_code, from_name, from_country, from_cert, from_mil, '
            'to_code, to_name, to_country, to_cert, to_mil, maxlat, from_lat, from_lon, to_lat, to_lon, days')
# the airspace index repeats flight columns for every crossing (~6 per flight): only what search results need
ZONE_LEG_COLS = ('leg_id, hex, reg, type, mil, callsigns, date, t0, t1, from_code, from_country, from_cert, '
                 'to_code, to_country, to_cert, from_lat, from_lon, to_lat, to_lon')
key_dir = lambda k: (k or '_').replace(':', '_')


def quarter(m):  # '2024-05' -> '2024-Q2'
    y, mo = m.split('-')
    return f'{y}-Q{(int(mo) - 1) // 3 + 1}'


def upload_tree(local_root, prefix, period, con=None, order_by=None, row_group=20_000):
    """local hive dirs <col>=<key>/*.parquet → R2 <prefix>/<key>/<period>.parquet; returns the keys written.
    The partitioned writer rotates files when many partitions are open, so a partition can hold several files: they are
    merged into one (sorted by order_by, so a key spans few row groups) before upload. Uploading them one by one to the
    same name silently kept only the last (the first aircraft/airport indexes lost most of their rows that way)."""
    keys = []
    for d in glob.glob(f'{local_root}/*=*'):
        key = os.path.basename(d).split('=', 1)[1]
        key = '_' if key in ('', 'NULL', '__HIVE_DEFAULT_PARTITION__') else key
        files = sorted(glob.glob(f'{d}/*.parquet'))
        if not files:
            continue
        path = files[0]
        if len(files) > 1 or order_by:
            path = f'{d}/merged.parquet'
            # the partition column is written into the partition files (DuckDB ≥ 1.5): leave it out, so a yearly file has
            # exactly the columns of the monthly copies it is combined with
            pcol = os.path.basename(d).split('=', 1)[0]
            (con or duckdb).execute(f"COPY (SELECT * EXCLUDE ({pcol}) FROM read_parquet({files!r}){' ORDER BY ' + order_by if order_by else ''}) "
                                    f"TO '{path}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {row_group})")
        bm.s3.upload_file(path, bm.B, f'v1/index/{prefix}/{key_dir(key)}/{period}.parquet')
        keys.append(key)
    return sorted(set(keys))


def main():
    args = sys.argv[1:]
    force = '--force' in args
    only = set(args[args.index('--only') + 1].split(',')) if '--only' in args else None   # e.g. hex,airport
    mem = args[args.index('--memory') + 1] if '--memory' in args else '6GB'
    infos = {o['Key'][16:-5]: json.loads(bm.s3.get_object(Bucket=bm.B, Key=o['Key'])['Body'].read()) for o in bm.listing('v1/flights/info/')}
    try:
        idx = json.loads(bm.s3.get_object(Bucket=bm.B, Key='v1/index/info.json')['Body'].read())
        if idx.get('layout') != 2:
            idx = None
    except bm.s3.exceptions.NoSuchKey:
        idx = None
    idx = idx or {'layout': 2, 'routes': {}, 'zones': {}}
    idx.setdefault('lookups', {})

    acct = bm.env['R2_ENDPOINT'].split('//')[1].split('.')[0]
    tmpdir = tempfile.mkdtemp(prefix='oam_index_')
    con = duckdb.connect()
    con.execute(f"SET memory_limit = '{mem}'; SET temp_directory = '{tmpdir}/spill'; SET preserve_insertion_order = false;")
    # a hung connection to R2 once stalled a build for good: time out and retry instead
    con.execute("SET http_timeout = 120000; SET http_retries = 8; SET http_retry_wait_ms = 2000;")
    con.execute("SET partitioned_write_max_open_files = 2048")   # fewer file rotations per partition (merged anyway)
    con.execute(f"CREATE SECRET r2 (TYPE r2, KEY_ID '{bm.env['R2_ACCESS_KEY_ID']}', SECRET '{bm.env['R2_SECRET_ACCESS_KEY']}', ACCOUNT_ID '{acct}')")
    # the month files are downloaded first and read from local disk: DuckDB's own R2 reader hung for good (twice) in these
    # partitioned writes, with no traffic and no error; boto3 downloads are fast and retry on their own
    cache = f'{tmpdir}/months'
    def local(table, m):
        path = f'{cache}/{table}/{m}.parquet'
        if not os.path.exists(path):
            os.makedirs(os.path.dirname(path), exist_ok=True)
            bm.s3.download_file(bm.B, f'v1/flights/{table}/{m}.parquet', path + '.part')
            os.replace(path + '.part', path)
        return path
    src = lambda table, months: '[' + ','.join(f"'{local(table, m)}'" for m in months) + ']'

    groups = {'routes': {}, 'zones': {}}
    for m in sorted(infos):
        groups['routes'].setdefault(m[:4], []).append(m)
        groups['zones'].setdefault(quarter(m), []).append(m)

    for kind in ('routes', 'zones'):
        if only and kind not in only:
            continue
        for period, months in sorted(groups[kind].items()):
            prev = idx[kind].get(period, {})
            newest = max(infos[m]['built_utc'] for m in months)
            if not force and prev.get('months') == months and prev.get('built_utc', '') >= newest:
                continue
            t = time.time()
            entry = {'months': months, 'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}
            # no ORDER BY: one small file per key, and the monthly inputs are already in time order, so a streaming
            # partitioned write keeps memory and temp disk low (a full-year sort needed >13 GB of temp disk on CI)
            if kind == 'routes':
                for side, col in (('to', 'to_country'), ('from', 'from_country')):
                    out = f'{tmpdir}/{side}'
                    con.execute(f"COPY (SELECT {LEG_COLS}, coalesce(nullif({col}, ''), '_') AS k FROM read_parquet({src('legs', months)})) "
                                f"TO '{out}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (k), OVERWRITE_OR_IGNORE)")
                    entry[side] = upload_tree(out, side, period, con)
                    shutil.rmtree(out)
            else:
                cols = ', '.join('l.' + c.strip() for c in ZONE_LEG_COLS.split(','))
                out = f'{tmpdir}/zone'
                con.execute(f"COPY (SELECT replace(z.zone_id, ':', '_') AS zk, z.zone_id, z.evidence, z.t_in, z.t_out, {cols} "
                            f"FROM read_parquet({src('leg_zones', months)}) z JOIN read_parquet({src('legs', months)}) l USING (leg_id)) "
                            f"TO '{out}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (zk), OVERWRITE_OR_IGNORE)")
                entry['zone'] = [k.replace('_', ':', 1) for k in upload_tree(out, 'zone', period, con)]
                shutil.rmtree(out)
            shutil.rmtree(cache, ignore_errors=True)   # local copies of this period's months: free the disk (CI runners are small)
            idx[kind][period] = entry
            bm.s3.put_object(Bucket=bm.B, Key='v1/index/info.json', Body=json.dumps(idx).encode())
            n = len(entry.get('to', [])) + len(entry.get('from', [])) + len(entry.get('zone', []))
            print(f'{kind} {period}: {len(months)} months, {n} files, {time.time() - t:.0f} s', flush=True)

    # yearly per-key indexes for one aircraft / one airport, from the monthly sorted copies (the section below builds
    # those; on a fresh bucket this part waits for the next invocation)
    all_years = '--all-years' in args
    this_year = str(dt.datetime.now(dt.UTC).year)
    for kind, table, keyexpr, cols in (('hex', 'by_hex', 'left(hex, 2)', LEG_COLS), ('airport', 'by_airport', 'left(code, 2)', 'code, role, ' + LEG_COLS)):
        if only and kind not in only:
            continue
        idx.setdefault(kind, {})
        for year, months in sorted(groups['routes'].items()):
            if year == this_year and not all_years:
                continue   # the current year changes nightly: served from the monthly copies until it is complete
            if any(m not in idx['lookups'] for m in months):
                continue   # needs every month's sorted copy
            prev = idx[kind].get(year, {})
            newest = max(idx['lookups'][m]['built_utc'] for m in months)
            if not force and prev.get('months') == months and prev.get('built_utc', '') >= newest:
                continue
            t = time.time()
            out = f'{tmpdir}/{kind}'
            # parallel partitioned write, then each partition's files merged and sorted by the key (and time): a key then
            # sits in a few consecutive row groups, so one lookup reads only those; small row groups keep each read small
            con.execute(f"COPY (SELECT {cols}, {keyexpr} AS k FROM read_parquet({src(table, months)})) "
                        f"TO '{out}' (FORMAT parquet, COMPRESSION zstd, PARTITION_BY (k), OVERWRITE_OR_IGNORE)")
            keys = upload_tree(out, kind, year, con, order_by=('hex, t0' if kind == 'hex' else 'code, role, t0'), row_group=10_000)
            shutil.rmtree(out); shutil.rmtree(cache, ignore_errors=True)
            idx[kind][year] = {'months': months, 'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds'), 'keys': keys}
            bm.s3.put_object(Bucket=bm.B, Key='v1/index/info.json', Body=json.dumps(idx).encode())
            print(f'{kind} {year}: {len(months)} months, {len(keys)} files, {time.time() - t:.0f} s', flush=True)

    # lookups: per month, three re-sorted copies for point lookups (one airport, one aircraft, one flight)
    if not only or 'lookups' in only:
        for m in sorted(infos):
            prev = idx['lookups'].get(m, {})
            if not force and prev.get('built_utc', '') >= infos[m]['built_utc']:
                continue
            t = time.time()
            legs, lz = src('legs', [m]), src('leg_zones', [m])
            for name, sql, rg in (
                ('by_airport', f"SELECT * FROM (SELECT from_code AS code, 'dep' AS role, {LEG_COLS} FROM read_parquet({legs}) "
                               f"UNION ALL SELECT to_code AS code, 'arr' AS role, {LEG_COLS} FROM read_parquet({legs})) "
                               f"WHERE code IS NOT NULL AND code <> '' ORDER BY code, t0", 20_000),
                ('by_hex', f"SELECT {LEG_COLS} FROM read_parquet({legs}) ORDER BY hex, t0", 20_000),
                ('zones_by_leg', f"SELECT * FROM read_parquet({lz}) ORDER BY leg_id, t_in", 50_000)):
                out = f'{tmpdir}/{name}.parquet'
                con.execute(f"COPY ({sql}) TO '{out}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE {rg})")
                bm.s3.upload_file(out, bm.B, f'v1/flights/{name}/{m}.parquet')
                os.remove(out)
            shutil.rmtree(cache, ignore_errors=True)
            idx['lookups'][m] = {'built_utc': dt.datetime.now(dt.UTC).isoformat(timespec='seconds')}
            bm.s3.put_object(Bucket=bm.B, Key='v1/index/info.json', Body=json.dumps(idx).encode())
            print(f'lookups {m}: {time.time() - t:.0f} s', flush=True)

    shutil.rmtree(tmpdir, ignore_errors=True)
    done = bm.done_days()
    bm.write_manifest(done, {d for d, o in done.items() if o['Size'] < 200})


if __name__ == '__main__':
    main()

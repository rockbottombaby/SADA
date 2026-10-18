"""Aircraft registry table (owner / operator per ICAO hex) from the OpenSky Network aircraft database, published to R2.

Usage: python -I build_registry.py [path/to/aircraftDatabase.csv]    (downloads the CSV when no path is given)
Writes R2 v1/meta/registry.parquet and adds 'registry' to the manifest's files. Also writes oam/data/registry.parquet
for the local prototype dataset.
Source: https://opensky-network.org/datasets/#metadata/ (last updated Nov 2024 at the time of writing; newer aircraft are missing).
"""
import os, sys, io, csv, json, urllib.request
import pyarrow as pa, pyarrow.parquet as pq
import boto3

OAM = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = 'https://s3.opensky-network.org/data-samples/metadata/aircraftDatabase.csv'
COLS = {'icao24': 'hex', 'registration': 'reg', 'typecode': 'type', 'manufacturername': 'manufacturer', 'model': 'model',
        'owner': 'owner', 'operator': 'operator', 'operatoricao': 'operator_icao', 'operatorcallsign': 'operator_callsign',
        'built': 'built', 'serialnumber': 'serial'}


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else None
    raw = open(src, 'rb').read() if src else urllib.request.urlopen(URL, timeout=300).read()
    rows = []
    for r in csv.DictReader(io.StringIO(raw.decode('utf-8', 'ignore'))):
        hx = (r.get('icao24') or '').strip().lower()
        if len(hx) != 6:
            continue
        row = {v: (r.get(k) or '').strip() or None for k, v in COLS.items()}
        row['hex'] = hx
        if row['reg'] or row['owner'] or row['operator'] or row['operator_icao']:
            rows.append(row)
    tb = pa.Table.from_pylist(rows).sort_by('hex')
    buf = io.BytesIO()
    pq.write_table(tb, buf, compression='zstd', row_group_size=50_000)
    open(f'{OAM}/data/registry.parquet', 'wb').write(buf.getvalue())
    env = dict(l.strip().split('=', 1) for l in open(f'{OAM}/../.env') if '=' in l and not l.startswith('#'))
    s3 = boto3.client('s3', endpoint_url=env['R2_ENDPOINT'], region_name='auto',
                      aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
    s3.put_object(Bucket=env['R2_BUCKET'], Key='v1/meta/registry.parquet', Body=buf.getvalue())
    # local prototype manifest
    mp = f'{OAM}/data/manifest.json'
    m = json.load(open(mp)); m['files']['registry'] = 'registry.parquet'; json.dump(m, open(mp, 'w'), indent=1)
    print(f'registry: {tb.num_rows:,} aircraft, {sum(1 for r in rows if r["owner"]):,} with owner, {len(buf.getvalue()) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()

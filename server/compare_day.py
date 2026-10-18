"""QA: compare one day's tiers in R2 against a local copy (row counts + content hash of sorted rows).
Usage: python -I compare_day.py DATE LOCAL_DATA_DIR"""
import os, sys, io, hashlib, boto3, pyarrow.parquet as pq
date, local = sys.argv[1], sys.argv[2]
s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
ok = True
for t in ['positions', 'callsigns', 'aircraft', 'segments', 'crossings', 'h3']:
    remote = pq.read_table(io.BytesIO(s3.get_object(Bucket=os.environ['R2_BUCKET'], Key=f'v1/days/{t}/{date}.parquet')['Body'].read()))
    loc = pq.read_table(f'{local}/{t}/{date}.parquet')
    h = lambda tb: hashlib.sha256(tb.sort_by([(c, 'ascending') for c in tb.column_names if str(tb.schema.field(c).type) in ('string', 'int64', 'double', 'float', 'int32', 'bool', 'large_string')]).to_pandas().to_csv(index=False).encode()).hexdigest()[:12]
    same = remote.num_rows == loc.num_rows and remote.schema.equals(loc.schema) and h(remote) == h(loc)
    ok &= same
    print(f'{t:10} remote {remote.num_rows:>9} local {loc.num_rows:>9} {"IDENTICAL" if same else "DIFFERENT"}')
print('PASS' if ok else 'FAIL')

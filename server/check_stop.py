"""Gate for a rebuild with the unrecorded-stop rule: N62FF (a81467) landed at Keflavík 2026-09-10 00:36–01:48 UTC with no
received point below 2,150 ft. The re-ingested day must split there (a segment ending 'hidden' near BIKF, the next starting
'hidden'). Exit 1 otherwise, so the run stops before it spends hours on a rule that does not work.

Env: R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET. Usage: python -I check_stop.py
"""
import os, io, sys
import boto3, pyarrow.parquet as pq

s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
t = pq.read_table(io.BytesIO(s3.get_object(Bucket=os.environ['R2_BUCKET'], Key='v1/days/segments/2026-09-10.parquet')['Body'].read()))
segs = sorted((r for r in t.to_pylist() if r['hex'] == 'a81467'), key=lambda r: r['t0'])
for r in segs:
    print('check_stop:', r['seg_id'], r['start'], '->', r['end'], f"alt {r['alt0']}..{r['alt1']}", f"end {r['lat1']:.2f},{r['lon1']:.2f}")
KEF = (63.985, -22.605)
near = lambda lat, lon: abs(lat - KEF[0]) < 0.5 and abs(lon - KEF[1]) < 1.0
ok = any(a['end'] == 'hidden' and near(a['lat1'], a['lon1']) and b['start'] == 'hidden' and near(b['lat0'], b['lon0'])
         for a, b in zip(segs, segs[1:]))
# segments of all aircraft on the day, for a sanity look at how many new splits the rule makes
print(f"check_stop: {t.num_rows} segments on the day, {sum(1 for e in t.column('end').to_pylist() if e == 'hidden')} end 'hidden'")
print('check_stop:', 'PASS: the Keflavík stop splits' if ok else 'FAIL: no split at Keflavík')
sys.exit(0 if ok else 1)

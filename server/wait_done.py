"""Wait until the other backfill servers have finished: every day in the list is done or failed, or no server still holds a
fresh claim on a missing day (backfill.py treats a claim older than 3 h as abandoned). Run before build_month.py when
several servers share the ingest (--steal), so the months are not built while another server still ingests their days.

Env: R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET. Usage: python -I wait_done.py days.json [--max-hours 6]
"""
import os, sys, json, time
import boto3

s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
B = os.environ['R2_BUCKET']
days = {d['date'] for d in json.load(open(sys.argv[1]))}
max_h = float(sys.argv[sys.argv.index('--max-hours') + 1]) if '--max-hours' in sys.argv else 6


def keys(prefix):
    out = {}
    for p in s3.get_paginator('list_objects_v2').paginate(Bucket=B, Prefix=prefix):
        out.update({o['Key'].rsplit('/', 1)[1][:-5]: o for o in p.get('Contents', [])})
    return out


t0 = time.time()
while True:
    missing = days - set(keys('v1/done/')) - set(keys('v1/failed/'))
    claims = keys('v1/claim/')
    busy = [d for d in missing if d in claims and time.time() - claims[d]['LastModified'].timestamp() < 3 * 3600]
    print(f'wait_done: {len(days) - len(missing)}/{len(days)} days finished, {len(busy)} in progress elsewhere', flush=True)
    if not busy or time.time() - t0 > max_h * 3600:
        if missing:
            print(f'wait_done: {len(missing)} days not done: {sorted(missing)[:20]}', flush=True)
        break
    time.sleep(120)

"""Seed a staging bucket from production with server-side copies, so a rebuild can run there without touching production.

Copies everything under v1/ except the days being rebuilt (--skip-year: their day tiers and done markers, so backfill.py
ingests them afresh) and the private run files (claims, failures, logs, status). Resumable: a key already in the staging
bucket with the same size is skipped. Nothing is ever written to the source bucket.

Env: R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY (a key that reads the source and writes the staging bucket),
     R2_BUCKET (staging), R2_SOURCE_BUCKET (production)
Usage: python -I stage_seed.py [--skip-year 2026] [--threads 32]
"""
import os, sys, time, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3

ap = argparse.ArgumentParser()
ap.add_argument('--skip-year', default='2026')
ap.add_argument('--threads', type=int, default=32)
ap.add_argument('--only', help='comma-separated key prefixes to copy, e.g. v1/meta/ (a full re-ingest needs nothing else)')
a = ap.parse_args()
SRC, DST = os.environ['R2_SOURCE_BUCKET'], os.environ['R2_BUCKET']
assert SRC != DST, 'staging bucket must differ from the source'
s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])


def listing(bucket):
    out = {}
    for p in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='v1/'):
        out.update({o['Key']: o['Size'] for o in p.get('Contents', [])})
    return out


def wanted(k):
    parts = k.split('/')
    if a.only and not any(k.startswith(p) for p in a.only.split(',')):
        return False
    if parts[1] in ('claim', 'failed', 'logs') or parts[1].startswith('status'):
        return False
    if parts[1] == 'done' and parts[2].startswith(a.skip_year):
        return False
    if parts[1] == 'days' and len(parts) > 3 and parts[3].startswith(a.skip_year):
        return False
    return True


src, dst = listing(SRC), listing(DST)
todo = [k for k, n in src.items() if wanted(k) and dst.get(k) != n]
print(f'{len(src)} keys in {SRC}, {sum(map(wanted, src))} wanted, {len(todo)} to copy ({sum(src[k] for k in todo) / 1e9:.1f} GB)', flush=True)
t0, done, failed = time.time(), 0, []
with ThreadPoolExecutor(a.threads) as ex:
    futs = {ex.submit(s3.copy_object, Bucket=DST, Key=k, CopySource={'Bucket': SRC, 'Key': k}): k for k in todo}
    for f in as_completed(futs):
        try:
            f.result(); done += 1
        except Exception as e:
            failed.append(futs[f]); print(f'FAILED {futs[f]}: {e!r}'[:300], flush=True)
        if done % 1000 == 0:
            print(f'{done}/{len(todo)} copied, {time.time() - t0:.0f} s', flush=True)
print(f'seed: {done} copied, {len(failed)} failed, {time.time() - t0:.0f} s', flush=True)
sys.exit(1 if failed else 0)

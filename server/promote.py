"""Promote a staging bucket to production with server-side copies: first a backup of production's built tables (flights/,
index/, manifest, done markers) under v1/meta/backup/<STAMP>/ in production itself, then every published key of staging
copied over production (days, flights, index, meta, done markers), the manifest last so readers switch in one step.
Production keys staging lacks are kept, except done markers for days after staging's last day: those days were ingested
with the old rules and must be ingested again by the nightly job (which skips days whose marker exists).

Resumable: a key already in production with the same size is skipped. Nothing is deleted from staging.
Env: R2_ENDPOINT, R2_STAGE_ACCESS_KEY_ID / R2_STAGE_SECRET_ACCESS_KEY (read staging, write production)
Usage: python -I promote.py --from oam-stage --to oam-data [--threads 32] [--dry-run]
"""
import os, sys, time, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3

ap = argparse.ArgumentParser()
ap.add_argument('--from', dest='src', required=True)
ap.add_argument('--to', dest='dst', required=True)
ap.add_argument('--threads', type=int, default=32)
ap.add_argument('--dry-run', action='store_true')
a = ap.parse_args()
assert a.src != a.dst
env = dict(l.strip().split('=', 1) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.env')) if '=' in l and not l.startswith('#'))
s3 = boto3.client('s3', endpoint_url=env['R2_ENDPOINT'], region_name='auto', aws_access_key_id=env['R2_STAGE_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_STAGE_SECRET_ACCESS_KEY'])
PRIVATE = ('v1/claim/', 'v1/failed/', 'v1/logs/', 'v1/status', 'v1/meta/backup/')


def listing(bucket):
    out = {}
    for p in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix='v1/'):
        out.update({o['Key']: o['Size'] for o in p.get('Contents', [])})
    return out


def copy_all(pairs, label):
    """pairs: (source bucket, source key, dest key)"""
    t0, done, failed = time.time(), 0, []
    with ThreadPoolExecutor(a.threads) as ex:
        futs = {ex.submit(s3.copy_object, Bucket=a.dst, Key=dk, CopySource={'Bucket': sb, 'Key': sk}): dk for sb, sk, dk in pairs}
        for f in as_completed(futs):
            try: f.result(); done += 1
            except Exception as e: failed.append(futs[f]); print(f'  FAILED {futs[f]}: {e!r}'[:200], flush=True)
            if done % 2000 == 0: print(f'  {label}: {done}/{len(pairs)}, {time.time() - t0:.0f} s', flush=True)
    print(f'{label}: {done} copied, {len(failed)} failed, {time.time() - t0:.0f} s', flush=True)
    if failed: sys.exit(1)


src, dst = listing(a.src), listing(a.dst)
stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
# 1. backup of production's built tables (not the day files: 200+ GB, rebuilt from upstream if ever needed)
backup = [(a.dst, k, f'v1/meta/backup/{stamp}/{k[3:]}') for k in dst if k.startswith(('v1/flights/', 'v1/index/', 'v1/done/', 'v1/manifest.json', 'v1/meta/')) and not k.startswith('v1/meta/backup/')]
# 2. staging over production, the manifest last
pub = [k for k in src if not k.startswith(PRIVATE) and k != 'v1/manifest.json']
todo = [(a.src, k, k) for k in pub if dst.get(k) != src[k]]
# 3. production done markers for days after staging's last day: dropped, so the nightly job ingests them with the new rules
last = max(k[8:-5] for k in src if k.startswith('v1/done/'))
stale = sorted(k for k in dst if k.startswith('v1/done/') and k[8:-5] > last)
print(f'{a.src}: {len(src)} keys, {len(pub)} published ({sum(src[k] for k in pub) / 1e9:.0f} GB); {a.dst}: {len(dst)} keys')
print(f'backup: {len(backup)} keys ({sum(dst[b[1]] for b in backup) / 1e9:.1f} GB) → v1/meta/backup/{stamp}/')
print(f'copy: {len(todo)} keys ({sum(src[k] for _, k, _ in todo) / 1e9:.0f} GB) already identical: {len(pub) - len(todo)}')
print(f'done markers to drop (days after {last}): {[k[8:-5] for k in stale]}')
if a.dry_run: sys.exit(0)
copy_all(backup, 'backup')
copy_all(todo, 'promote')
for k in stale: s3.delete_object(Bucket=a.dst, Key=k)
s3.copy_object(Bucket=a.dst, Key='v1/manifest.json', CopySource={'Bucket': a.src, 'Key': 'v1/manifest.json'})
print('manifest switched; production now serves the promoted data', flush=True)

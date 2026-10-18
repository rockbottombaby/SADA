"""Backfill worker: stream each ADSB.lol day through ingest_day.py, upload the tiers to R2, delete locally.

Resumable: a day is skipped when its marker v1/done/DATE.json exists in R2 (written last, after all tiers).
Usage: python -I backfill.py days.json [--workers 8] [--only 2024-06-08,2025-01-01] [--shard 0/2] [--self-delete]
Env: R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET [HCLOUD_TOKEN for --self-delete]
"""
import os, sys, json, time, shlex, shutil, socket, argparse, subprocess, threading, urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
import boto3

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../oam
INGEST = f'{ROOT}/pipeline/ingest_day.py'
DATA = f'{ROOT}/data'
TIERS = ['positions', 'callsigns', 'aircraft', 'segments', 'crossings', 'h3']
PREFIX = 'v1'
LOG = f'{ROOT}/backfill.log'
WORK = f'{ROOT}/work'
ME = socket.gethostname()

s3 = boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'], aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'])
BUCKET = os.environ['R2_BUCKET']
lock = threading.Lock()


def log(msg):
    line = f'{time.strftime("%Y-%m-%d %H:%M:%S")} {msg}'
    with lock:
        print(line, flush=True)
        with open(LOG, 'a') as f:
            f.write(line + '\n')


def done_set():
    keys, tok = set(), None
    while True:
        kw = {'Bucket': BUCKET, 'Prefix': f'{PREFIX}/done/'}
        if tok:
            kw['ContinuationToken'] = tok
        r = s3.list_objects_v2(**kw)
        keys |= {o['Key'].rsplit('/', 1)[1].removesuffix('.json') for o in r.get('Contents', [])}
        if not r.get('IsTruncated'):
            return keys
        tok = r['NextContinuationToken']


def is_done(date):
    try:
        s3.head_object(Bucket=BUCKET, Key=f'{PREFIX}/done/{date}.json'); return True
    except s3.exceptions.ClientError:
        return False


def claim_of(date):
    try:
        return json.loads(s3.get_object(Bucket=BUCKET, Key=f'{PREFIX}/claim/{date}.json')['Body'].read())
    except s3.exceptions.NoSuchKey:
        return None


_fail_cache = None
def failures():
    """{date: runs_failed} from v1/failed/ markers (a day that keeps failing upstream is skipped after --max-fail-runs runs)."""
    global _fail_cache
    if _fail_cache is None:
        _fail_cache = {}
        for o in s3.list_objects_v2(Bucket=BUCKET, Prefix=f'{PREFIX}/failed/').get('Contents', []):
            _fail_cache[o['Key'].rsplit('/', 1)[1][:-5]] = json.loads(s3.get_object(Bucket=BUCKET, Key=o['Key'])['Body'].read()).get('runs_failed', 1)
    return _fail_cache


def run_day(day):
    date, t0 = day['date'], time.time()
    if day['size'] < 10_000_000:   # e.g. 2023-03-10: 174 KB release with no traces
        s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/done/{date}.json',
                      Body=json.dumps({'date': date, 'tag': day['tag'], 'src_bytes': day['size'], 'empty': True}).encode())
        return date, True, f'empty release ({day["size"]} bytes), marked done without tiers'
    # claim the day (work-sharing between servers); skip if already done or freshly claimed by another server
    if is_done(date):
        return date, True, 'already done (by another server)'
    c = claim_of(date)
    if c and c['by'] != ME and time.time() - c['at'] < 3 * 3600:
        return date, True, f"skipped: claimed by {c['by']}"
    s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/claim/{date}.json', Body=json.dumps({'by': ME, 'at': time.time()}).encode())
    # download all parts to local disk with 8 connections per file (GitHub throttles single connections), then ingest
    work = f'{WORK}/{date}'
    parts = [f'{work}/part{i:02d}' for i in range(len(day['urls']))]
    spec = ''.join(f'{u}\n  out=part{i:02d}\n' for i, u in enumerate(day['urls']))
    cmd = (f'set -o pipefail; mkdir -p {work} && rm -f {work}/* && printf %s {shlex.quote(spec)} | aria2c -q -i - -d {work} -j 4 -x 8 -s 8 -k 20M '
           f'--max-tries=8 --retry-wait=10 --lowest-speed-limit=100K --file-allocation=none --auto-file-renaming=false --allow-overwrite=true '
           f'&& {sys.executable} -I -W ignore {INGEST} {date} {" ".join(parts)}')
    for attempt in range(1, 4):
        p = subprocess.run(['bash', '-c', cmd], capture_output=True, text=True)
        if p.returncode == 0:
            break
        if p.returncode == 3:   # the release holds no traces (upstream gap, e.g. 2026-05-05 has only heatmaps)
            shutil.rmtree(work, ignore_errors=True)
            s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/done/{date}.json',
                          Body=json.dumps({'date': date, 'tag': day['tag'], 'src_bytes': day['size'], 'empty': True}).encode())
            return date, True, 'release holds no traces, marked done without tiers'
        log(f'{date} attempt {attempt} failed rc={p.returncode}: {p.stderr.strip()[-400:]}')
        for t in TIERS:
            try: os.remove(f'{DATA}/{t}/{date}.parquet')
            except FileNotFoundError: pass
        time.sleep(30 * attempt)
    else:
        shutil.rmtree(work, ignore_errors=True)
        n = (failures().get(date, 0)) + 1
        s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/failed/{date}.json', Body=json.dumps({'date': date, 'runs_failed': n, 'at': time.time(), 'stderr': p.stderr.strip()[-600:]}).encode())
        return date, False, f'failed after 3 attempts (run {n})'
    shutil.rmtree(work, ignore_errors=True)
    t1 = time.time()
    sizes = {}
    for t in TIERS:
        path = f'{DATA}/{t}/{date}.parquet'
        sizes[t] = os.path.getsize(path)
        s3.upload_file(path, BUCKET, f'{PREFIX}/days/{t}/{date}.parquet')
    stats = {'date': date, 'tag': day['tag'], 'src_bytes': day['size'], 'bytes': sizes,
             'ingest_s': round(t1 - t0), 'upload_s': round(time.time() - t1), 'summary': p.stderr.strip().splitlines()[-1]}
    s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/done/{date}.json', Body=json.dumps(stats).encode())
    for t in TIERS:
        os.remove(f'{DATA}/{t}/{date}.parquet')
    return date, True, f"{stats['ingest_s']}s ingest, {stats['upload_s']}s upload, {sum(sizes.values()) / 1e6:.0f} MB | {stats['summary']}"


def self_delete():
    sid = urllib.request.urlopen('http://169.254.169.254/hetzner/v1/metadata/instance-id', timeout=5).read().decode()
    log(f'deleting server {sid}')
    s3.upload_file(LOG, BUCKET, f'{PREFIX}/logs/backfill-{time.strftime("%Y%m%dT%H%M%S")}.log')
    req = urllib.request.Request(f'https://api.hetzner.cloud/v1/servers/{sid}', method='DELETE',
                                 headers={'Authorization': f"Bearer {os.environ['HCLOUD_TOKEN']}"})
    urllib.request.urlopen(req, timeout=30)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('days')
    ap.add_argument('--workers', type=int, default=os.cpu_count())
    ap.add_argument('--only')
    ap.add_argument('--shard', default='0/1', help='i/n: take every n-th day starting at i (interleaved so each shard gets a mix of years)')
    ap.add_argument('--self-delete', action='store_true')
    ap.add_argument('--max-fail-runs', type=int, default=0, help='skip days that already failed in this many earlier runs (0 = never skip)')
    ap.add_argument('--status-tag', default=None, help='name for the status/log files (default: shard index)')
    ap.add_argument('--steal', action='store_true', help='after our shard, help with the other shards (claim markers prevent duplicates)')
    a = ap.parse_args()
    days = json.load(open(a.days))
    if a.only:
        want = set(a.only.split(','))
        days = [d for d in days if d['date'] in want]
    si, sn = map(int, a.shard.split('/'))
    others = [d for i, d in enumerate(days) if i % sn != si][::-1]   # taken from the end once our own shard is done
    days = days[si::sn] + (others if a.steal else [])
    tag = f'-{a.status_tag}' if a.status_tag else ('' if sn == 1 else f'-{si}')
    done = done_set()
    todo = [d for d in days if d['date'] not in done]
    if a.max_fail_runs:
        skip = {d for d, n in failures().items() if n >= a.max_fail_runs}
        todo = [d for d in todo if d['date'] not in skip]
    log(f'{len(days)} days requested, {len(done & {d["date"] for d in days})} already done, {len(todo)} to do, {a.workers} workers')
    ok = fail = 0
    t0 = time.time()
    # progress heartbeat: status.json + log to R2 every 5 min, readable from anywhere (status.py)
    stop = threading.Event()
    def write_status():
        el = time.time() - t0
        n = ok + fail
        st = {'updated_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'requested': len(days), 'todo': len(todo),
              'ok': ok, 'failed': fail, 'elapsed_h': round(el / 3600, 2), 'running': not stop.is_set(),
              'eta_h': round(el / n * (len(todo) - n) / 3600, 2) if n else None, 'workers': a.workers, 'shard': a.shard}
        try:
            s3.put_object(Bucket=BUCKET, Key=f'{PREFIX}/status{tag}.json', Body=json.dumps(st).encode())
            s3.upload_file(LOG, BUCKET, f'{PREFIX}/logs/backfill-current{tag}.log')
        except Exception as e:
            log(f'status upload failed: {e!r}')
    def heartbeat():
        while not stop.wait(300):
            write_status()
    write_status()
    hb = threading.Thread(target=heartbeat, daemon=True)
    hb.start()
    with ThreadPoolExecutor(a.workers) as ex:
        futs = [ex.submit(run_day, d) for d in todo]
        for f in as_completed(futs):
            try:
                date, good, msg = f.result()
            except Exception as e:
                date, good, msg = '?', False, repr(e)
            ok += good; fail += not good
            el = time.time() - t0
            eta = el / (ok + fail) * (len(todo) - ok - fail) / 3600
            log(f'{"OK  " if good else "FAIL"} {date} {msg} [{ok + fail}/{len(todo)}, {fail} failed, ETA {eta:.1f} h]')
    stop.set(); hb.join(timeout=60)
    write_status()
    total, used, free = shutil.disk_usage('/')
    log(f'FINISHED ok={ok} failed={fail} in {(time.time() - t0) / 3600:.2f} h, disk free {free / 1e9:.0f} GB')
    s3.upload_file(LOG, BUCKET, f'{PREFIX}/logs/backfill-{time.strftime("%Y%m%dT%H%M%S")}.log')
    if a.self_delete:
        self_delete()


if __name__ == '__main__':
    main()

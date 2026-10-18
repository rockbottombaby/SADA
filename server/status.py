"""Backfill progress dashboard for the terminal. Reads R2 (done markers, per-server status, logs) and the Hetzner API.
Works from any machine with the .env keys; the servers need not be reachable.

Usage: python3 oam/server/status.py            one snapshot
       python3 oam/server/status.py --watch    refresh every 30 s (Ctrl+C to quit; the backfill keeps running)
       python3 oam/server/status.py --log 20   also show the last 20 log lines per server
"""
import os, sys, json, time, datetime as dt, urllib.request
import boto3

HERE = os.path.dirname(os.path.abspath(__file__))
env = dict(l.strip().split('=', 1) for l in open(f'{HERE}/../../.env') if '=' in l and not l.startswith('#'))
s3 = boto3.client('s3', endpoint_url=env['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=env['R2_ACCESS_KEY_ID'], aws_secret_access_key=env['R2_SECRET_ACCESS_KEY'])
B = env['R2_BUCKET']
TOTAL = len(json.load(open(f'{HERE}/days.json')))
W, DIM, B_, G, Y, R, X = 46, '\033[2m', '\033[1m', '\033[32m', '\033[33m', '\033[31m', '\033[0m'


def listing(prefix):
    out, tok = [], None
    while True:
        r = s3.list_objects_v2(Bucket=B, Prefix=prefix, **({'ContinuationToken': tok} if tok else {}))
        out += r.get('Contents', [])
        if not r.get('IsTruncated'):
            return out
        tok = r['NextContinuationToken']


def bar(frac, width=W):
    full = int(frac * width)
    part = ' ▏▎▍▌▋▊▉'[int((frac * width - full) * 8)] if full < width else ''
    return f'{G}{"█" * full}{part}{X}{DIM}{"·" * (width - full - len(part))}{X}'


def servers():
    try:
        req = urllib.request.Request('https://api.hetzner.cloud/v1/servers?label_selector=project=oam',
                                     headers={'Authorization': f"Bearer {env['HCLOUD_TOKEN']}"})
        return json.load(urllib.request.urlopen(req, timeout=10))['servers']
    except Exception:
        return None


def snapshot(show_log=0):
    now = dt.datetime.now(dt.timezone.utc)
    done = listing('v1/done/')
    n = len(done)
    times = sorted(o['LastModified'] for o in done)
    last_h = sum(1 for t in times if (now - t).total_seconds() < 3600)
    last_15 = sum(1 for t in times if (now - t).total_seconds() < 900)
    rate = last_15 * 4 if last_15 >= 5 else last_h          # days per hour, recent
    left = TOTAL - n
    eta = left / rate if rate else None
    sts = {}
    for o in listing('v1/status'):
        sts[o['Key'].split('/')[-1]] = json.loads(s3.get_object(Bucket=B, Key=o['Key'])['Body'].read())

    out = [f'{B_}OPEN AIRLIFT MONITOR · BACKFILL{X}   {DIM}{now:%Y-%m-%d %H:%M:%S} UTC{X}', '']
    out.append(f'  {bar(n / TOTAL)}  {B_}{n / TOTAL * 100:5.1f}%{X}')
    out.append(f'  {B_}{n:,}{X} / {TOTAL:,} days in R2   {DIM}·{X}   {left:,} left')
    speed = f'{rate} days/h' if rate else '—'
    fin = (now + dt.timedelta(hours=eta)).strftime('%H:%M UTC') if eta else '—'
    out.append(f'  speed {B_}{speed}{X} {DIM}(last {"15 min" if last_15 >= 5 else "hour"}){X}   ETA {B_}{f"{eta:.1f} h" if eta else "—"}{X} {DIM}→ ~{fin}{X}')
    out.append('')

    if 'status-daily.json' in sts:   # GitHub Actions daily update
        d = sts['status-daily.json']
        out.append(f'  {DIM}DAILY UPDATE (GitHub Actions){X}  last run {d.get("updated_utc", "?")}: {d.get("ok", 0)} days ok, '
                   f'{R if d.get("failed") else DIM}{d.get("failed", 0)} failed{X}{"  (running)" if d.get("running") else ""}')
        out.append('')
    sv = servers()
    out.append(f'  {DIM}SERVERS{X}')
    cost = 0.0
    if sv is None:
        out.append(f'  {Y}Hetzner API not reachable{X}')
    elif not sv:
        out.append(f'  {DIM}none running (all deleted){X}')
    for s in sv or []:
        name, typ = s['name'], s['server_type']['name']
        up_h = (now - dt.datetime.fromisoformat(s['created'].replace('Z', '+00:00'))).total_seconds() / 3600
        price = next((float(p['price_hourly']['gross']) for p in s['server_type']['prices'] if p['location'] == (s.get('location') or s.get('datacenter', {}).get('location', {})).get('name')), 0)
        cost += price * max(1, -(-up_h // 1))
        st = sts.get(f"status-{name.rsplit('-', 1)[-1]}.json", {})
        age = (now - dt.datetime.fromisoformat(st['updated_utc'].replace('Z', '+00:00'))).total_seconds() / 60 if st else None
        live = f'{G}●{X}' if s['status'] == 'running' and age is not None and age < 12 else f'{Y}●{X}'
        failed = st.get('failed', 0)
        out.append(f'  {live} {name:<16} {typ:<6} up {up_h:4.1f} h   €{price:.3f}/h   {st.get("workers", "?")} workers'
                   f'   ok {st.get("ok", "?")}   {R if failed else DIM}failed {failed}{X}   {DIM}heartbeat {f"{age:.0f} min ago" if age is not None else "—"}{X}')
    if sv:
        out.append(f'  {DIM}cost so far ≈ €{cost:.2f} (billed per started hour){X}')
    out.append('')

    fails = []
    for o in listing('v1/logs/backfill-current'):
        lines = s3.get_object(Bucket=B, Key=o['Key'])['Body'].read().decode().splitlines()
        fails += [l for l in lines if ' FAIL ' in l]
        if show_log:
            out.append(f'  {DIM}── {o["Key"].split("/")[-1]}{X}')
            out += [f'  {DIM}{l[:150]}{X}' for l in lines[-show_log:]]
    if fails:
        out.append(f'  {R}FAILED DAYS (redo after the run){X}')
        uniq = {l.split()[3]: l for l in fails}   # by date; a day may be retried across restarts
        out += [f'  {DIM}{l[20:110]}{X}' for l in list(uniq.values())[-10:]]
    return '\n'.join(out)


if __name__ == '__main__':
    k = int(sys.argv[sys.argv.index('--log') + 1]) if '--log' in sys.argv else 0
    if '--watch' in sys.argv:
        try:
            while True:
                s = snapshot(k)
                print('\033[2J\033[H' + s + f'\n\n  {DIM}refreshing every 30 s · Ctrl+C to quit (the backfill keeps running){X}', flush=True)
                time.sleep(30)
        except KeyboardInterrupt:
            print()
    else:
        print(snapshot(k))

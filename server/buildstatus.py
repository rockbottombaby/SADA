"""Progress of a build server (oam/server/build.sh): phase, months done / to do, the months in progress, ETA.

Usage: python3 oam/server/buildstatus.py IP [--watch]
Reads /opt/oam/build.out over ssh; the months still to build come from R2 (same rule as build_month.py --all).
"""
import os, re, sys, json, time, subprocess, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, f'{ROOT}/oam/pipeline')
import build_month as bm

B, D, G, Y, R, X = '\033[1m', '\033[2m', '\033[32m', '\033[33m', '\033[31m', '\033[0m'
SSH = ['ssh', '-i', os.path.expanduser('~/.ssh/oam_backfill'), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
       '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=6']


def to_build():
    """months build_month --all would (still) rebuild now"""
    done = bm.done_days()
    empty = {d for d, o in done.items() if o['Size'] < 200}
    built = {o['Key'][16:-5]: json.loads(bm.s3.get_object(Bucket=bm.B, Key=o['Key'])['Body'].read()) for o in bm.listing('v1/flights/info/')}
    last = {}
    for d, o in done.items():
        for mm in {d[:7], bm.shift(d, -1)[:7]}:
            last[mm] = max(last.get(mm, ''), o['LastModified'].isoformat())
    months = sorted({d[:7] for d in done if d not in empty})
    return {m for m in months if m not in built or built[m].get('version') != bm.VERSION or last.get(m, '') > built[m].get('built_utc', '')
            or any(d in done for d in built[m].get('missing_days', []))}


def bar(f, w=46):
    n = int(f * w * 8)
    return G + '█' * (n // 8) + (' ▏▎▍▌▋▊▉'[n % 8] if n < w * 8 else '') + X + D + '·' * (w - n // 8 - 1) + X


def show(ip, pending, t_start):
    p = subprocess.run(SSH + [f'root@{ip}', 'cat /opt/oam/build.out; echo; echo "@@ $(date +%s)"; echo "@@boot $(( $(date +%s) - $(cut -d. -f1 /proc/uptime) ))"; pgrep -f "[b]uild_index.py" >/dev/null && echo "@@ index"; true'],
                       capture_output=True, text=True)
    now = dt.datetime.now(dt.UTC).strftime('%H:%M:%S UTC')
    print(f'\033[2J\033[H{B}OPEN AIRLIFT MONITOR · BUILD SERVER{X}   {D}{ip} · {now}{X}\n')
    if p.returncode != 0:
        print(f'  {G}server gone: the job finished and the server deleted itself{X} (or it is unreachable)\n')
        print(f'  {D}log: v1/logs/build-*.log in R2 · check the app: the header shows the data coverage{X}')
        return False
    lines = p.stdout.replace('\r', '\n').splitlines()
    finished = [l for l in lines if re.match(r'^\d{4}-\d\d: [\d,]+ legs', l)]
    failed = [l for l in lines if 'FAILED' in l]
    fin = {l[:7] for l in finished}
    slices = {}
    for l in lines:
        m = re.match(r'^\s+(\d{4}-\d\d) slice (\S\S)', l)
        if m and m[1] not in fin:
            slices[m[1]] = m[2]
    total = sorted(pending | fin | set(slices))
    frac = lambda h: min((int(h, 16) + 1) / 256, 1) if re.match(r'^[0-9a-f]{2}$', h) else 0.99
    work = len(fin) + sum(frac(h) for h in slices.values())
    phase = ('3/3 search indexes' if '@@ index' in p.stdout or any(l.startswith(('routes ', 'zones ')) for l in lines) else
             '2/3 months' if slices or finished else '1/3 days')
    print(f'  phase  {B}{phase}{X}')
    if total:
        f = work / len(total)
        # months started when the day ingest finished (or at the first line when there were no days)
        st = [l for l in lines if 'FINISHED' in l] or [l for l in lines if re.match(r'^\d{4}-\d\d-\d\d \d\d:', l)]
        t0 = dt.datetime.strptime(st[-1][:19], '%Y-%m-%d %H:%M:%S').replace(tzinfo=dt.UTC).timestamp() if st else t_start
        el = int(p.stdout.split('@@ ')[1].split()[0]) - t0
        eta = f'{(el / f - el) / 60:.0f} min' if f > 0.02 and el > 60 else '…'
        print(f'  {bar(f)}  {B}{f * 100:4.1f}%{X}')
        print(f'  months {B}{len(fin)}{X} / {len(total)} rebuilt   {D}·{X}   ETA months {B}{eta}{X} {D}(then indexes, ~20-40 min){X}\n')
    for m, h in sorted(slices.items()):
        print(f'  {Y}▶{X} {m}  {bar(frac(h), 20)} {frac(h) * 100:3.0f}%  {D}slice {h}{X}')
    for l in finished[-6:]:
        print(f'  {G}✓{X} {D}{l[:110]}{X}')
    for l in failed:
        print(f'  {R}✗ {l[:110]}{X}')
    for l in [l for l in lines if l.startswith(('routes ', 'zones ', 'manifest:'))][-6:]:
        print(f'  {G}✓{X} {D}{l[:110]}{X}')
    if phase.startswith('3/3'):
        # index files written to R2 during this run, per period, with the previous run's count as the expected total
        try:
            boot = re.search(r'@@boot (\d+)', p.stdout)
            since = dt.datetime.fromtimestamp(int(boot[1]) if boot else t_start, dt.UTC)
            per, expect = {}, {}
            for o in bm.listing('v1/index/'):
                if o['Key'].endswith('info.json'): continue
                kind, period = o['Key'].split('/')[2], o['Key'].rsplit('/', 1)[1][:-8]
                key = f'{"airspace" if kind == "zone" else "routes " + kind} {period}'
                expect[kind] = max(expect.get(kind, 0), 0)
                if o['LastModified'] >= since: per[key] = per.get(key, 0) + 1
            fin = {l.split(':')[0] for l in lines if l.startswith(('routes ', 'zones '))}
            for k, n in sorted(per.items()):
                done_mark = f'{G}✓{X}' if ('zones ' + k.split()[-1] if k.startswith('airspace') else 'routes ' + k.split()[-1]) in fin else f'{Y}▶{X}'
                print(f'  {done_mark} {k:24s} {n:4d} files uploaded')
        except Exception as e:
            print(f'  {D}(index progress unavailable: {e}){X}')
    print(f'\n  {D}the server deletes itself when done (or at its hard deadline){X}')
    return True


if __name__ == '__main__':
    ip = sys.argv[1]
    print('reading the month list from R2…')
    pending, t0 = to_build(), time.time()
    while show(ip, pending, t0) and '--watch' in sys.argv:
        time.sleep(20)

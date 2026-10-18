"""Build days.json: for every ADSB.lol globe_history day, the asset URLs of the larger of prod-0 / prod-0tmp.

Run on a machine with `gh` logged in (avoids the 60 req/h anonymous API limit); the server then
downloads assets directly (asset downloads are not API-rate-limited).
Usage: python -I list_days.py > days.json
"""
import json, re, subprocess, sys, datetime as dt

TAG = re.compile(r'^v(\d{4})\.(\d\d)\.(\d\d)-planes-readsb-prod-0(tmp)?$')
best = {}
for year in range(2023, dt.date.today().year + 1):
    out = subprocess.run(['gh', 'api', '--paginate', f'repos/adsblol/globe_history_{year}/releases?per_page=100',
                          '--jq', '.[] | {tag: .tag_name, assets: [.assets[] | {name, size, url: .browser_download_url}]}'],
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        r = json.loads(line)
        m = TAG.match(r['tag'])
        if not m or not r['assets']:
            continue
        date = f'{m[1]}-{m[2]}-{m[3]}'
        # some releases hold the day twice: a whole .tar and a split .tar.aa/.ab… upload; concatenating both breaks the
        # tar stream, so take the larger of the two copies
        assets = sorted(r['assets'], key=lambda a: a['name'])
        whole = [a for a in assets if a['name'].endswith('.tar')]
        split = [a for a in assets if not a['name'].endswith('.tar')]
        if whole and split:
            assets = max(whole, split, key=lambda s: sum(a['size'] for a in s))
        size = sum(a['size'] for a in assets)
        if size > best.get(date, {}).get('size', 0):
            best[date] = {'date': date, 'tag': r['tag'], 'size': size, 'urls': [a['url'] for a in assets]}
    print(year, sum(d.startswith(str(year)) for d in best), file=sys.stderr)
days = [best[d] for d in sorted(best)]
print(f'{len(days)} days, {sum(d["size"] for d in days) / 1e12:.2f} TB', file=sys.stderr)
json.dump(days, sys.stdout, indent=0)

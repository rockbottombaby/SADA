#!/bin/zsh
# usage: run_day.sh YYYY-MM-DD   streams the ADSB.lol release for that day through ingest_day.py
# Picks the larger of the prod-0 / prod-0tmp releases (some prod-0 files are truncated).
D=$1; Y=${D:0:4}; T=v${D//-/.}-planes-readsb-prod-0
cd ${0:A:h}/../..
[ -s oam/data/segments/$D.parquet ] && exit 0
AUTH="Authorization: Bearer $(gh auth token 2>/dev/null)"
pick() { curl -s -H "$AUTH" "https://api.github.com/repos/adsblol/globe_history_$Y/releases/tags/$1" | .venv/bin/python -I -c "import json,sys; d=json.load(sys.stdin); a=sorted(d.get('assets',[]),key=lambda a:a['name']); print(sum(x['size'] for x in a), ' '.join(x['browser_download_url'] for x in a))"; }
A=$(pick $T); B=$(pick ${T}tmp)
[ "${B%% *}" -gt "${A%% *}" ] && A=$B
urls=${A#* }
[ -z "${urls// }" ] && { echo "$D: no release" >&2; exit 1; }
for u in ${=urls}; do curl -sL --retry 3 "$u"; done | .venv/bin/python -I -W ignore oam/pipeline/ingest_day.py $D

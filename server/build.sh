#!/bin/zsh
# Build flight tables for every finished month on a short-lived Hetzner server, publish them + the manifest to R2,
# then delete the server. Safe to run any time (also while the backfill runs): it only rebuilds months that are new or incomplete.
# usage: [ONLY=date,date…] [REZONE='--zone sov:ISL --parent fir:BIRD'] [MONTHS='2025-04 2025-05'] [INDEX_ARGS='--force --only zones'] oam/server/build.sh [server_type=cpx62] [jobs=2] [deadline_hours=3]
# ONLY: first ingest these days (backfill.py --only), then build months, then the search indexes.
# REZONE: first recompute one zone's crossings from the stored positions (recompute_zone.py; after a boundary change), then the rest.
set -euo pipefail
TYPE=${1:-cpx62}; JOBS=${2:-2}; HOURS=${3:-3}; NAME=oam-build   # a month peaks at ~13 GB RAM (de-duplication included): 2 jobs on a 30 GB cpx62
ROOT=${0:A:h}/../..
cd $ROOT
set -a; . ./.env; set +a
H="Authorization: Bearer $HCLOUD_TOKEN"; API=https://api.hetzner.cloud/v1
KEY=~/.ssh/oam_backfill
SSH=(ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)
[ "$(curl -s -H "$H" "$API/servers?name=$NAME" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["servers"]))')" = 0 ] || { echo "$NAME already running"; exit 1; }

B=$(mktemp -d); mkdir -p $B/oam/pipeline $B/oam/data/zones $B/oam/ref $B/oam/server
cp oam/pipeline/build_legs.py oam/pipeline/build_month.py oam/pipeline/build_index.py oam/pipeline/ingest_day.py oam/pipeline/recompute_zone.py $B/oam/pipeline/
cp oam/server/backfill.py oam/server/days.json $B/oam/server/
cp oam/data/zones/zones_full.geojson oam/data/zones/zones.geojson $B/oam/data/zones/; cp oam/ref/airports.csv $B/oam/ref/
grep -E '^(R2_|HCLOUD_TOKEN)' .env > $B/.env; chmod 600 $B/.env
COPYFILE_DISABLE=1 tar czf $B.tgz -C $B .; rm -rf $B
python3 - "$TYPE" "$NAME" "${LOC:-fsn1}" > $B.json <<PY
import json, sys
print(json.dumps({"name": sys.argv[2], "server_type": sys.argv[1], "location": sys.argv[3], "image": "ubuntu-24.04",
  "ssh_keys": ["oam-backfill"], "labels": {"project": "oam"}, "user_data": open("oam/server/cloud-init.yaml").read()}))
PY
R=$(curl -s -H "$H" -H "Content-Type: application/json" -d @$B.json $API/servers); rm $B.json
IP=$(echo $R | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["server"]["public_net"]["ipv4"]["ip"]) if "server" in d else sys.exit("create failed: "+json.dumps(d.get("error")))')
echo "$NAME ($TYPE) at $IP; waiting for setup…"
for i in {1..60}; do [ "$(${SSH[@]} root@$IP 'test -f /opt/oam/READY && echo y' 2>/dev/null)" = y ] && break; sleep 6; done
scp -q -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR $B.tgz root@$IP:/opt/oam/build.tgz; rm $B.tgz
${SSH[@]} root@$IP "bash -s" <<REMOTE
set -e
mkdir -p /opt/oam/b && cd /opt/oam/b && tar xzf ../build.tgz 2>/dev/null && rm ../build.tgz
cat > /opt/oam/deadline.sh <<'X'
#!/bin/bash
set -a; . /opt/oam/b/.env; set +a
SID=\$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
curl -s -X DELETE -H "Authorization: Bearer \$HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers/\$SID
X
chmod 700 /opt/oam/deadline.sh
systemd-run --quiet --on-active=${HOURS}h --unit=oam-deadline /opt/oam/deadline.sh
cat > /opt/oam/job.sh <<X
#!/bin/bash
set -a; . /opt/oam/b/.env; set +a
cd /opt/oam/b/oam/pipeline
${ONLY:+/opt/oam/.venv/bin/python -I ../server/backfill.py ../server/days.json --only $ONLY --workers 6 --status-tag build > /opt/oam/build.out 2>&1}
${REZONE:+/opt/oam/.venv/bin/python -I recompute_zone.py $REZONE --workers 8 >> /opt/oam/build.out 2>&1}
/opt/oam/.venv/bin/python -I build_month.py ${MONTHS:---all} --jobs $JOBS >> /opt/oam/build.out 2>&1   # MONTHS='2025-04 2025-05' rebuilds those instead of what changed
/opt/oam/.venv/bin/python -I build_index.py --all-years ${INDEX_ARGS:-} --memory 20GB >> /opt/oam/build.out 2>&1   # a big server also indexes the current year; INDEX_ARGS e.g. '--force --only zones'
/opt/oam/.venv/bin/python -I -c "import boto3,os,time;boto3.client('s3',endpoint_url=os.environ['R2_ENDPOINT'],region_name='auto',aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY']).upload_file('/opt/oam/build.out',os.environ['R2_BUCKET'],'v1/logs/build-'+time.strftime('%Y%m%dT%H%M%S')+'.log')"
/opt/oam/deadline.sh
X
chmod 700 /opt/oam/job.sh
tmux new -d -s build /opt/oam/job.sh
REMOTE
echo "started; the server deletes itself when done (or after ${HOURS}h). progress: ssh -i $KEY root@$IP 'tr \"\\\\r\" \"\\\\n\" < /opt/oam/build.out | grep -v slice | tail'"

#!/bin/zsh
# Start the full backfill on a fresh Hetzner server. Runs unattended; this Mac can be closed afterwards.
# usage: oam/server/launch.sh [server_type=ccx53] [deadline_hours=14] [shard=0/1] [workers=auto]
#   e.g. two servers in parallel: launch.sh ccx53 14 0/2 ; launch.sh ccx53 14 1/2
# Safety: the server deletes itself when the job ends (success or crash), and a systemd timer deletes it
# after deadline_hours no matter what. Max cost = hourly price x deadline_hours.
set -euo pipefail
TYPE=${1:-ccx53}; HOURS=${2:-14}; SHARD=${3:-0/1}; WORKERS=${4:-}
NAME=oam-backfill-${SHARD%/*}
ROOT=${0:A:h}/../..
cd $ROOT
set -a; . ./.env; set +a
H="Authorization: Bearer $HCLOUD_TOKEN"; API=https://api.hetzner.cloud/v1
KEY=~/.ssh/oam_backfill
SSH=(ssh -i $KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

[ "$(curl -s -H "$H" "$API/servers?name=$NAME" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["servers"]))')" = 0 ] || { echo "$NAME already exists; refusing to start it twice"; exit 1; }

# bundle: pipeline + zones + day list + backfill + R2/Hetzner keys
B=$(mktemp -d); mkdir -p $B/oam/pipeline $B/oam/data/zones $B/oam/server
cp oam/pipeline/ingest_day.py $B/oam/pipeline/; cp oam/data/zones/zones_full.geojson $B/oam/data/zones/
cp oam/server/backfill.py oam/server/days.json $B/oam/server/
grep -E '^(R2_|HCLOUD_TOKEN)' .env > $B/oam/server/env; chmod 600 $B/oam/server/env
COPYFILE_DISABLE=1 tar czf $B.tgz -C $B oam; rm -rf $B

python3 - "$TYPE" "$NAME" "${LOC:-fsn1}" > $B.json <<PY
import json, sys
print(json.dumps({"name": sys.argv[2], "server_type": sys.argv[1], "location": sys.argv[3], "image": "ubuntu-24.04",
  "ssh_keys": ["oam-backfill"], "labels": {"project": "oam"}, "user_data": open("oam/server/cloud-init.yaml").read()}))
PY
R=$(curl -s -H "$H" -H "Content-Type: application/json" -d @$B.json $API/servers); rm $B.json
IP=$(echo $R | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["server"]["public_net"]["ipv4"]["ip"]) if "server" in d else sys.exit("create failed: "+json.dumps(d.get("error")))')
echo "$NAME ($TYPE, shard $SHARD) at $IP; waiting for setup…"
for i in {1..60}; do [ "$(${SSH[@]} root@$IP 'test -f /opt/oam/READY && echo y' 2>/dev/null)" = y ] && break; sleep 6; done
scp -q -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR $B.tgz root@$IP:/opt/oam/bundle.tgz; rm $B.tgz
${SSH[@]} root@$IP "bash -s" <<REMOTE
set -e
cd /opt/oam && tar xzf bundle.tgz 2>/dev/null && rm bundle.tgz
cat > /opt/oam/deadline.sh <<'X'
#!/bin/bash
set -a; . /opt/oam/oam/server/env; set +a
SID=\$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
curl -s -X DELETE -H "Authorization: Bearer \$HCLOUD_TOKEN" https://api.hetzner.cloud/v1/servers/\$SID
X
chmod 700 /opt/oam/deadline.sh
systemd-run --quiet --on-active=${HOURS}h --unit=oam-deadline /opt/oam/deadline.sh
cat > /opt/oam/job.sh <<'X'
#!/bin/bash
set -a; . /opt/oam/oam/server/env; set +a
/opt/oam/.venv/bin/python -I /opt/oam/oam/server/backfill.py /opt/oam/oam/server/days.json --shard $SHARD ${WORKERS:+--workers $WORKERS} --self-delete
# reached only if the job crashed before self-deleting: delete the server anyway
/opt/oam/deadline.sh
X
chmod 700 /opt/oam/job.sh
tmux new -d -s backfill "/opt/oam/job.sh 2>&1 | tee -a /opt/oam/job.out"
sleep 3; tail -3 /opt/oam/job.out
REMOTE
echo "started. deadline ${HOURS}h. watch: python3 oam/server/status.py   (or ssh -i $KEY root@$IP 'tail -f /opt/oam/job.out')"

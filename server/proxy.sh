#!/bin/zsh
# Create the always-on public proxy for live data the browser cannot fetch itself:
#   /opensky/…        OpenSky (blocks browser requests and Cloudflare's servers); the user's own OpenSky login is passed through
#   /live/…           ADSB.lol live API (sends no CORS headers; refuses Cloudflare Workers), with a 15 s shared cache:
#                     many viewers cost ADSB.lol about one request per endpoint per 15 s; when ADSB.lol is busy the last
#                     good answer (up to 10 min old) is served
#   /live/trace/<hex> the aircraft's recent track (ADSB.lol trace file), 30 s cache
# A small Hetzner server (CX23 ~€6.50/month; TYPE= and LOC= env override): Caddy (automatic HTTPS on <ip>.sslip.io, path
# allowlist, CORS) in front of nginx (micro-cache, per-address rate limits: 10 live requests/s, 2 OpenSky requests/s).
# Only the listed read endpoints are forwarded; nothing is logged or stored. The pre-release /<key>/ prefix still works.
# usage: [PROXY_DOMAIN=live.example.org] oam/server/proxy.sh   → prints the base URL for the app
# PROXY_DOMAIN: also serve this name (point an A record at the server, DNS only); Caddy gets its certificate itself
set -euo pipefail
ROOT=${0:A:h}/../..
cd $ROOT
set -a; . ./.env; set +a
H="Authorization: Bearer $HCLOUD_TOKEN"; API=https://api.hetzner.cloud/v1; NAME=oam-proxy
[ "$(curl -s -H "$H" "$API/servers?name=$NAME" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["servers"]))')" = 0 ] || { echo "$NAME already exists"; exit 1; }
UD=$(KEY=${OAM_ACCESS_KEY:-} PROXY_DOMAIN=${PROXY_DOMAIN:-} python3 - <<'PY'
import os
# optional: an extra path prefix the proxy also accepts (/<key>/live/…); without one only the plain paths exist
key = os.environ.get('KEY', '')
pre = f'(?:{key}/)?' if key else ''
extra_host = ', ' + os.environ['PROXY_DOMAIN'] if os.environ.get('PROXY_DOMAIN') else ''
print(f"""#cloud-config
package_update: true
packages: [caddy, nginx, ufw, unattended-upgrades]
write_files:
  - path: /etc/nginx/conf.d/sada-live.conf
    content: |
      proxy_cache_path /var/cache/nginx/live levels=1 keys_zone=live:10m max_size=200m inactive=10m use_temp_path=off;
      access_log off;
      # the upstream name is resolved per request (a variable in proxy_pass), so nginx starts even when DNS is briefly
      # unavailable at boot and follows ADSB.lol's address changes (with a literal name, a DNS hiccup at boot keeps nginx down)
      resolver 127.0.0.53 1.1.1.1 valid=300s ipv6=off;
      resolver_timeout 5s;
      # per-address budgets (public service): bursts allowed, sustained abuse gets 429
      limit_req_zone $binary_remote_addr zone=live_ip:10m rate=10r/s;
      limit_req_zone $binary_remote_addr zone=os_ip:10m rate=2r/s;
      limit_req_status 429;
      server {{
        listen 127.0.0.1:8081;
        location /v2/ {{
          limit_req zone=live_ip burst=40 nodelay;
          set $adsblol https://api.adsb.lol;
          proxy_pass $adsblol;
          proxy_ssl_server_name on;
          proxy_set_header Host api.adsb.lol;
          proxy_set_header User-Agent "SADA airwatch (open-source investigative flight monitor)";
          proxy_hide_header Access-Control-Allow-Origin;
          proxy_ignore_headers Cache-Control Expires Set-Cookie;
          proxy_cache live;
          proxy_cache_valid 200 15s;
          proxy_cache_lock on;
          proxy_cache_lock_timeout 15s;
          proxy_cache_background_update on;
          proxy_cache_use_stale error timeout updating http_429 http_500 http_502 http_503 http_504;
          add_header X-Cache $upstream_cache_status always;
        }}
        # recent track of one aircraft (tar1090 trace file from ADSB.lol's globe): drawn when Live is switched on
        location /data/traces/ {{
          limit_req zone=live_ip burst=80 nodelay;
          set $adsblol_web https://adsb.lol;
          proxy_pass $adsblol_web;
          proxy_ssl_server_name on;
          proxy_set_header Host adsb.lol;
          proxy_set_header User-Agent "SADA airwatch (open-source investigative flight monitor)";
          proxy_set_header Accept-Encoding gzip;
          proxy_hide_header Access-Control-Allow-Origin;
          proxy_ignore_headers Cache-Control Expires Set-Cookie;
          proxy_cache live;
          proxy_cache_valid 200 30s;
          proxy_cache_valid 404 120s;
          proxy_cache_lock on;
          proxy_cache_use_stale error timeout updating http_429 http_500 http_502 http_503 http_504;
          add_header X-Cache $upstream_cache_status always;
        }}
        # OpenSky REST API and its token endpoint: the viewer's own credentials pass through, nothing is cached
        location /api/ {{
          limit_req zone=os_ip burst=10 nodelay;
          set $opensky https://opensky-network.org;
          proxy_pass $opensky;
          proxy_ssl_server_name on;
          proxy_set_header Host opensky-network.org;
          proxy_pass_header Authorization;
          proxy_hide_header Access-Control-Allow-Origin;
        }}
        location = /auth/realms/opensky-network/protocol/openid-connect/token {{
          limit_req zone=os_ip burst=5 nodelay;
          set $opensky_auth https://auth.opensky-network.org;
          proxy_pass $opensky_auth;
          proxy_ssl_server_name on;
          proxy_set_header Host auth.opensky-network.org;
          proxy_hide_header Access-Control-Allow-Origin;
        }}
      }}
  - path: /etc/systemd/system/nginx.service.d/override.conf
    content: |
      [Unit]
      After=network-online.target
      Wants=network-online.target
      [Service]
      Restart=on-failure
      RestartSec=5s
  - path: /etc/caddy/Caddyfile.tmpl
    content: |
      HOST {{
        header {{
          defer
          Access-Control-Allow-Origin "*"
          Access-Control-Allow-Methods "GET, POST, OPTIONS"
          Access-Control-Allow-Headers "Authorization, Content-Type"
          Access-Control-Max-Age "86400"
          -Server
        }}
        @preflight method OPTIONS
        handle @preflight {{
          respond 204
        }}
        @auth {{
          method POST
          path_regexp auth ^/{pre}opensky-auth$
        }}
        handle @auth {{
          rewrite * /auth/realms/opensky-network/protocol/openid-connect/token
          reverse_proxy 127.0.0.1:8081
        }}
        @trace path_regexp trace ^/{pre}live/trace/([0-9a-f]{{4}}([0-9a-f]{{2}}))$
        handle @trace {{
          rewrite * /data/traces/{{re.trace.2}}/trace_recent_{{re.trace.1}}.json
          reverse_proxy 127.0.0.1:8081 {{
            header_down Cache-Control "public, max-age=30"
          }}
        }}
        # one rewrite from the captured part (Caddy runs rewrite before uri strip_prefix, whatever the written order)
        @live path_regexp live ^/{pre}live/(mil|(hex|icao)/[0-9a-f]{{6}}(,[0-9a-f]{{6}}){{0,49}}|callsign/[A-Z0-9]{{2,8}}|reg/[A-Z0-9-]{{2,10}}|type/[A-Z0-9]{{2,4}}|lat/-?[0-9]{{1,2}}(\\.[0-9])?/lon/-?[0-9]{{1,3}}(\\.[0-9])?/dist/[0-9]{{1,3}})$
        handle @live {{
          rewrite * /v2/{{re.live.1}}
          reverse_proxy 127.0.0.1:8081 {{
            header_down Cache-Control "public, max-age=10"
          }}
        }}
        @api path_regexp os ^/{pre}opensky/(flights/(arrival|departure|aircraft|all)|tracks/all|states/all)$
        handle @api {{
          rewrite * /api/{{re.os.1}}?{{query}}
          reverse_proxy 127.0.0.1:8081
        }}
        handle {{
          respond 404
        }}
      }}
runcmd:
  - ufw default deny incoming && ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
  - IP=$(curl -s http://169.254.169.254/hetzner/v1/metadata/public-ipv4); sed "s/^HOST/$(echo $IP | tr . -).sslip.io{extra_host}/" /etc/caddy/Caddyfile.tmpl > /etc/caddy/Caddyfile
  - rm -f /etc/nginx/sites-enabled/default   # nginx only listens on 127.0.0.1:8081; Caddy owns ports 80/443
  - mkdir -p /var/cache/nginx/live && chown www-data /var/cache/nginx/live && nginx -t && systemctl restart nginx
  - systemctl restart caddy
  - touch /root/READY
""")
PY
)
python3 - "$UD" "${LOC:-nbg1}" "${TYPE:-cx23}" > /tmp/oam_proxy.json <<'PY'
import json, sys
print(json.dumps({"name": "oam-proxy", "server_type": sys.argv[3], "location": sys.argv[2], "image": "ubuntu-24.04",
  "ssh_keys": ["oam-backfill"], "labels": {"project": "oam", "role": "proxy"}, "user_data": sys.argv[1]}))
PY
R=$(curl -s -H "$H" -H "Content-Type: application/json" -d @/tmp/oam_proxy.json $API/servers); rm /tmp/oam_proxy.json
IP=$(echo $R | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["server"]["public_net"]["ipv4"]["ip"]) if "server" in d else sys.exit("create failed: "+json.dumps(d.get("error")))')
echo "proxy server at $IP; base URL: https://${IP//./-}.sslip.io  (…/opensky, …/live; certificate is issued on first request, ~1-2 min after setup)"

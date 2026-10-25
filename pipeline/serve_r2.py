"""Local read-only gateway to an R2 bucket, for testing the app against a bucket the public data worker does not serve
(e.g. a staging rebuild): HTTP Range + CORS, like the worker. Point the app's data URL (Settings → Advanced) at
http://127.0.0.1:PORT/v1.

Env: R2_ENDPOINT, and the key pair given with --key-prefix (R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY, or R2_STAGE_…)
Usage: python -I serve_r2.py --bucket oam-stage --key-prefix R2_STAGE_ [--port 8787]
"""
import os, sys, argparse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import boto3
from botocore.exceptions import ClientError

ap = argparse.ArgumentParser()
ap.add_argument('--bucket', required=True)
ap.add_argument('--key-prefix', default='R2_')
ap.add_argument('--port', type=int, default=8787)
a = ap.parse_args()
env = dict(l.strip().split('=', 1) for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '.env')) if '=' in l and not l.startswith('#'))
s3 = boto3.client('s3', endpoint_url=env['R2_ENDPOINT'], region_name='auto',
                  aws_access_key_id=env[a.key_prefix + 'ACCESS_KEY_ID'], aws_secret_access_key=env[a.key_prefix + 'SECRET_ACCESS_KEY'])
PUBLIC = ('v1/days/', 'v1/flights/', 'v1/meta/', 'v1/index/', 'v1/manifest.json')
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Modified-Since',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified'}


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def _reply(self, code, body=b'', headers=()):
        self.send_response(code)
        for k, v in list(CORS.items()) + list(headers): self.send_header(k, v)
        if not any(k == 'Content-Length' for k, _ in headers): self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD': self.wfile.write(body)

    def do_OPTIONS(self): self._reply(204)

    def do_HEAD(self): self._get(head=True)

    def do_GET(self): self._get()

    def _get(self, head=False):
        key = self.path.lstrip('/').split('?')[0]
        if not key.startswith(PUBLIC): return self._reply(404, b'not found')
        kw = {'Bucket': a.bucket, 'Key': key}
        rng = self.headers.get('Range')
        if rng and not head: kw['Range'] = rng
        try:
            o = s3.head_object(Bucket=a.bucket, Key=key) if head else s3.get_object(**kw)
        except ClientError as e:
            code = e.response['ResponseMetadata']['HTTPStatusCode']
            return self._reply(416 if code == 416 else 404, b'not found')
        hdrs = [('Content-Type', o.get('ContentType', 'application/octet-stream')), ('Accept-Ranges', 'bytes'), ('ETag', o.get('ETag', '')), ('Cache-Control', 'no-store')]
        if head: return self._reply(200, b'', hdrs + [('Content-Length', str(o['ContentLength']))])
        body = o['Body'].read()
        if 'ContentRange' in o: hdrs.append(('Content-Range', o['ContentRange']))
        self._reply(206 if 'ContentRange' in o else 200, body, hdrs)


print(f'serving {a.bucket} on http://127.0.0.1:{a.port}/v1 (Ctrl-C to stop)', flush=True)
ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()

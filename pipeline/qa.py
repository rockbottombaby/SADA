"""Data quality checks after each build. Regression tests for problems found in review (bug report 2026-10-14).

Usage: python -I qa.py   -> prints each check with PASS/WARN and exits non-zero on FAIL
"""
import os, sys, json
import duckdb

DATA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data')
c = duckdb.connect()
c.sql(f"CREATE VIEW legs AS SELECT * FROM '{DATA}/legs.parquet'")
c.sql(f"CREATE VIEW lz AS SELECT * FROM '{DATA}/leg_zones.parquet'")
m = json.load(open(f'{DATA}/manifest.json'))
fails = 0


def check(name, value, ok, warn=None, note=''):
    global fails
    status = 'PASS' if ok(value) else ('WARN' if warn and warn(value) else 'FAIL')
    fails += status == 'FAIL'
    print(f'[{status}] {name}: {value} {note}')


one = lambda q: c.sql(q).fetchone()[0]

# 1. coverage is explicit
check('days covered (manifest)', len(m['dates']), lambda v: v > 0, note=str(m['dates']))
# 2. departure/arrival country registers as a zone crossing (was 97/133 missing for LLBG)
for code, iso3 in [('LLBG', 'ISR'), ('KDOV', 'USA'), ('BIKF', 'ISL'), ('EGLL', 'GBR')]:
    n = one(f"SELECT count(*) FROM legs WHERE from_code='{code}'")
    miss = one(f"SELECT count(*) FROM legs l WHERE from_code='{code}' AND NOT EXISTS (SELECT 1 FROM lz WHERE lz.leg_id=l.leg_id AND zone_id='sov:{iso3}')")
    check(f'{code} departures (any certainty) missing own sovereign zone', f'{miss}/{n}', lambda v, miss=miss, n=n: n == 0 or miss / n <= 0.02,
          lambda v, miss=miss, n=n: miss / max(n, 1) <= 0.1)
# 3. GNSS spoofing: recorded landings at Beirut by aircraft coming from Israel / Israeli-registered
v = one("SELECT count(*) FROM legs WHERE to_code='OLBA' AND to_cert='recorded' AND (from_country='IL' OR hex BETWEEN '738000' AND '73ffff')")
check('recorded Israel->Beirut / 4X->Beirut landings (spoof artefacts)', v, lambda x: x == 0, lambda x: x <= 3)
# 4. airliners matched to small military bases near big airports
v = one("""SELECT count(*) FROM legs WHERE (from_name ILIKE '%Hatzor%' OR to_name ILIKE '%Hatzor%' OR from_name ILIKE '%Kingsfield%' OR to_name ILIKE '%Kingsfield%')
           AND type IN ('A320','A321','A21N','A20N','B738','B38M','B739','B789','B788','B77W','A333','A332','A359','E195','E190')""")
check('airliners matched to Hatzor/Kingsfield', v, lambda x: x == 0, lambda x: x <= 3)
# 5. ends over no airport must not be marked recorded
v = one("SELECT count(*) FROM legs WHERE (to_code IS NULL AND to_cert='recorded') OR (from_code IS NULL AND from_cert='recorded')")
check('"recorded" ends with no airport', v, lambda x: x == 0)
# 6. military flag only from matched bases
v = one("SELECT count(*) FROM legs WHERE (to_mil=1 AND to_cert<>'recorded') OR (from_mil=1 AND from_cert<>'recorded')")
check('military-base flag on unmatched ends', v, lambda x: x == 0)
# 7. known-good case: LOY026 Dover -> Ben Gurion observed in BIRD FIR
v = c.sql("""SELECT l.callsigns, l.from_code, l.to_code, z.evidence FROM legs l JOIN lz z USING (leg_id)
             WHERE l.callsigns LIKE '%LOY026%' AND z.zone_id='fir:BIRD' AND l.from_code='KDOV'""").fetchall()
check('LOY026 KDOV->LLBG observed in BIRD FIR', v, lambda x: any(r[2] == 'LLBG' and r[3] == 'observed' for r in x))
# 8. share of legs with an unknown end (informational)
v = one("SELECT round(100.0*count(*) FILTER (WHERE from_cert='unknown' OR to_cert='unknown')/count(*),1) FROM legs")
check('legs with an unknown end (%)', v, lambda x: True, note='(informational: coverage starts/ends mid-air)')
sys.exit(1 if fails else 0)

// Node context for the shared tool layer: DuckDB (Node) over the same Parquet URLs the browser uses.
import { DuckDBInstance } from '@duckdb/node-api';
import { polygonToCells } from 'h3-js';
import { setupViews, type Ctx, type Manifest, type ZoneMeta } from '../web/src/lib/tools.ts';

export const BASE = (process.env.OAM_DATA_URL || 'https://data.sadawatch.com/v1').replace(/\/$/, '');

export async function makeCtx(): Promise<Ctx> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  await conn.run('INSTALL httpfs; LOAD httpfs;');
  const query = async (sql: string) => {
    const r = await conn.runAndReadAll(sql);
    // native JS values, with BIGINT -> number so results match the browser (DuckDB-WASM) path
    return r.getRowObjectsJS().map(o => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) out[k] = plain(v);
      return out;
    });
  };
  const manifest: Manifest = { ...(await (await fetch(`${BASE}/manifest.json`)).json()), base: BASE };
  const geo = await (await fetch(`${BASE}/${manifest.files.zones}`)).json();
  const zones: ZoneMeta[] = geo.features.map((f: any) => f.properties);
  const ctx: Ctx = { query, manifest, zones, cellsForPolygon: (ring, res) => polygonToCells(ring, res, true),
    keys: () => ({ census: process.env.CENSUS_KEY, openskyId: process.env.OPENSKY_CLIENT_ID, openskySecret: process.env.OPENSKY_CLIENT_SECRET,
      proxyBase: process.env.OAM_PROXY_BASE, openskyBase: process.env.OAM_PROXY_BASE ? process.env.OAM_PROXY_BASE.replace(/\/$/, '') + '/opensky' : undefined }) };
  await setupViews(ctx);
  return ctx;
}

// JSON-friendly values: BIGINT/HUGEINT -> number, DECIMAL/timestamp value objects -> number or ISO-ish string
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const s = String(v);
    const n = Number(s);
    return Number.isFinite(n) && s.trim() !== '' ? n : s;
  }
  return v;
}


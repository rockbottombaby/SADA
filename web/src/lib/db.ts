// DuckDB-WASM over remote Parquet. Everything runs in the browser; the data host only serves static files.
import * as duckdb from '@duckdb/duckdb-wasm';
import type { Manifest, QueryFn } from './tools';

let conn: duckdb.AsyncDuckDBConnection | null = null;

export async function openDb(): Promise<QueryFn> {
  // The engine (35–40 MB of wasm, the version pinned in package.json) loads from jsDelivr: the static site stays small
  // (Cloudflare's 25 MB per-file limit) and the engine is cached in the browser across deployments. A cross-origin
  // worker script has to be started through a same-origin blob.
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const worker = new Worker(URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  // Parquet footers are cached across queries (object cache): a second look at the same month file costs ~0.1 s instead
  // of re-reading its footer (a flight's details: 8 s cold, 0.1 s cached). NOT enable_http_metadata_cache: together with
  // the object cache it makes DuckDB-WASM 1.29 trap on reads spanning many files. Retries cover transient fetch failures.
  for (const st of ['SET enable_object_cache=true', 'SET enable_http_metadata_cache=true', 'SET http_retries=3', 'SET http_retry_wait_ms=500']) await conn.query(st);
  return query;
}

// Arrow rows -> plain JS objects (BigInt -> number, so results are JSON-friendly for UI and LLM).
// Queries are streamed (send) so a running one can be cancelled: DuckDB-WASM has one connection, and a query left
// running after the user pressed Stop would make the next question wait behind it.
let inFlight = 0;
export async function cancelCurrent() { if (conn && inFlight) await conn.cancelSent().catch(() => {}); }
// One query at a time: streamed queries that overlap on the single connection (a lookup's parallel chains, the cache
// warm-up beside a user's query) corrupt the worker, so every query waits for the previous one to finish.
// Every query also has a budget (QUERY_BUDGET_MS). The biggest honest read, the export cross-check's departures from the
// export airports over the whole archive, takes ~2.5 minutes (about 1,300 sequential range requests); a query still
// running after five minutes is stuck, and must become an error the caller sees, never a silent hang of the queue.
export const QUERY_BUDGET_MS = 300_000;
let queue: Promise<unknown> = Promise.resolve();
let qSeq = 0;
export function query(sql: string): Promise<Record<string, unknown>[]> {
  const run = queue.then(() => queryNow(sql));
  queue = run.catch(() => {});
  return run;
}
async function queryNow(sql: string): Promise<Record<string, unknown>[]> {
  if (!conn) throw new Error('database not open');
  inFlight++;
  const qid = ++qSeq, tq = Date.now();
  if (import.meta.env.DEV) console.debug('[q start]', qid, sql.replace(/\s+/g, ' ').slice(0, 140));   // test scripts read these
  const c = conn;
  let timedOut = false;
  let fail: (e: Error) => void = () => {};
  const limit = new Promise<never>((_, reject) => { fail = reject; });
  const timer = setTimeout(() => { timedOut = true; c.cancelSent().catch(() => {}); fail(new QueryTimeout(`stopped after ${QUERY_BUDGET_MS / 1000} s`)); }, QUERY_BUDGET_MS);
  try {
    const reader = await Promise.race([c.send(sql), limit]);
    const rows: Record<string, unknown>[] = [];
    try {
      for await (const batch of reader) {
        if (timedOut) throw new QueryTimeout(`stopped after ${QUERY_BUDGET_MS / 1000} s`);
        for (const r of batch.toArray() as { toJSON: () => Record<string, unknown> }[]) { const o = r.toJSON(); for (const k in o) o[k] = plain(o[k]); rows.push(o); }
      }
    } catch (e) {
      // a read that fails mid-stream leaves the connection with a pending query; every later query would then return
      // nothing (which tools would report as "no flights"). Cancel it so the connection is usable again.
      if (!timedOut) await c.cancelSent().catch(() => {});
      throw e;
    }
    return rows;
  } catch (e) {
    if (timedOut || e instanceof QueryTimeout) throw new QueryTimeout(`This query was stopped after ${QUERY_BUDGET_MS / 1000} s (stuck or far too large).`);
    // DuckDB-WASM reports failed HTTP reads (missing/unreachable data file) as an opaque WebAssembly exception
    const msg = String((e as Error)?.message ?? e);
    if (/WebAssembly\.Exception|HTTP|IO Error/i.test(msg))
      throw new Error('A data file could not be read from the data server (missing, unreachable, or being rebuilt). Check that the data server is running and the dataset build has finished, then reload.');
    throw e;
  } finally { clearTimeout(timer); inFlight--; if (import.meta.env.DEV) console.debug('[q end]', qid, Date.now() - tq, 'ms'); }
}

// A query with a time budget (for the assistant's free-form SQL): streamed with send(), cancelled when the budget runs out,
// so one runaway scan of the whole archive cannot hang the chat or exhaust the tab's memory.
export class QueryTimeout extends Error { name = 'QueryTimeout'; }
// (QueryTimeout is also what the default budget in query() throws)
export async function queryWithin(sql: string, ms: number): Promise<Record<string, unknown>[]> {
  if (!conn) throw new Error('database not open');
  const c = conn;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; c.cancelSent().catch(() => {}); }, ms);
  try {
    const reader = await c.send(sql);
    const rows: Record<string, unknown>[] = [];
    for await (const batch of reader) {
      if (timedOut) break;
      for (const r of batch.toArray() as { toJSON: () => Record<string, unknown> }[]) { const o = r.toJSON(); for (const k in o) o[k] = plain(o[k]); rows.push(o); }
    }
    if (timedOut) throw new QueryTimeout(`stopped after ${Math.round(ms / 1000)} s`);
    return rows;
  } catch (e) {
    if (timedOut || e instanceof QueryTimeout) throw new QueryTimeout(`stopped after ${Math.round(ms / 1000)} s`);
    throw e;
  } finally { clearTimeout(timer); }
}

export async function loadManifest(base: string): Promise<Manifest> {
  const r = await fetch(`${base}/manifest.json`);
  if (!r.ok) throw new Error(`manifest not found at ${base}/manifest.json`);
  return { ...(await r.json()), base };
}

// Make every value JSON-friendly: BIGINT/HUGEINT/DECIMAL -> number, Arrow date/timestamp -> ISO string
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint32Array && v.length === 4) {   // 128-bit integer (e.g. SUM of integers), little-endian words
    let x = 0n;
    for (let i = 3; i >= 0; i--) x = (x << 32n) | BigInt(v[i]);
    if (v[3] & 0x80000000) x -= 1n << 128n;
    return Number(x);
  }
  if (v && typeof v === 'object' && !Array.isArray(v) && 'valueOf' in v) {
    const n = Number(v as any);
    if (Number.isFinite(n)) return n;
  }
  return v;
}

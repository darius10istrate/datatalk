import * as duckdb from '@duckdb/duckdb-wasm';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import eh_wasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvp_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import { DataType, type Field } from 'apache-arrow';
import { CREATE_VIEW, DATA_FILE, DUCKDB_VERSION, EXTENSIONS, LOCKDOWN } from '../../shared/lockdown';
import { sqlString } from '../../shared/sql';
import { checkAsset, SETUP_HINT } from './asset';

export const DATA_URL = `/data/${DATA_FILE}`;
export const QUERY_TIMEOUT_MS = 30_000;
export const MAX_ROWS = 1_000;

export type LoadProgress =
  | { stage: 'engine' }
  | { stage: 'data'; loaded: number; total: number }
  | { stage: 'lock' };

export type Cell = string | number | boolean | null;

export type Column = { name: string; numeric: boolean };

export type Result = { columns: Column[]; rows: Cell[][]; truncated: boolean; ms: number };

export class QueryStopped extends Error {
  constructor(readonly reason: 'cancelled' | 'timeout') {
    super(reason === 'timeout' ? `Query stopped after ${QUERY_TIMEOUT_MS / 1000} s` : 'Cancelled');
    this.name = 'QueryStopped';
  }
}

let conn: duckdb.AsyncDuckDBConnection | null = null;
let loading: Promise<{ rows: number }> | null = null;
let busy = false;

export function init(onProgress: (p: LoadProgress) => void): Promise<{ rows: number }> {
  loading ??= load(onProgress).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(onProgress: (p: LoadProgress) => void): Promise<{ rows: number }> {
  onProgress({ stage: 'engine' });
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: mvp_wasm, mainWorker: mvp_worker },
    eh: { mainModule: eh_wasm, mainWorker: eh_worker },
  });
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(bundle.mainWorker!));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  await db.open({ query: { castBigIntToDouble: false, castDecimalToDouble: true } });
  const c = await db.connect();

  await c.query(`SET custom_extension_repository=${sqlString(`${location.origin}/ext`)}`);
  for (const ext of EXTENSIONS) {
    try {
      await c.query(`LOAD ${ext}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Could not load the ${ext} extension from /ext/${DUCKDB_VERSION}. ${SETUP_HINT} (${reason})`);
    }
  }

  const buf = await fetchWithProgress(DATA_URL, (loaded, total) => onProgress({ stage: 'data', loaded, total }));
  await db.registerFileBuffer(DATA_FILE, buf);
  await c.query(CREATE_VIEW);

  onProgress({ stage: 'lock' });
  for (const s of LOCKDOWN) await c.query(s);

  const count = await c.query('SELECT count(*)::INTEGER AS n FROM trips');
  conn = c;
  return { rows: Number(count.getChildAt(0)!.get(0)) };
}

async function fetchWithProgress(url: string, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  checkAsset(res, url);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function runQuery(sql: string, signal: AbortSignal): Promise<Result> {
  if (!conn) throw new Error('The engine is still loading');
  if (busy) throw new Error('A query is already running');
  const c = conn;
  busy = true;
  const t0 = performance.now();
  let stopped: QueryStopped | null = null;
  const stop = (reason: 'cancelled' | 'timeout') => {
    if (stopped) return;
    stopped = new QueryStopped(reason);
    void c.cancelSent();
  };
  const onAbort = () => stop('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), QUERY_TIMEOUT_MS);
  try {
    if (signal.aborted) throw new QueryStopped('cancelled');
    const reader = await c.send(sql);
    const rows: Cell[][] = [];
    let fields: Field[] | null = null;
    for await (const batch of reader) {
      if (stopped) break;
      fields ??= batch.schema.fields;
      const cols = fields.map((_, j) => batch.getChildAt(j)!);
      for (let i = 0; i < batch.numRows && rows.length <= MAX_ROWS; i++)
        rows.push(cols.map((col, j) => toCell(col.get(i), fields![j]!.type)));
      if (rows.length > MAX_ROWS) break;
    }
    if (stopped) throw stopped;
    fields ??= reader.schema?.fields ?? [];
    const truncated = rows.length > MAX_ROWS;
    return {
      columns: fields.map((f) => ({ name: f.name, numeric: isNumeric(f.type) })),
      rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
      truncated,
      ms: Math.round(performance.now() - t0),
    };
  } catch (e) {
    throw stopped ?? e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    busy = false;
  }
}

const isNumeric = (type: DataType) => DataType.isInt(type) || DataType.isFloat(type) || DataType.isDecimal(type);

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function formatInstant(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : date;
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

function toCell(value: unknown, type: DataType): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (DataType.isTimestamp(type) || DataType.isDate(type)) {
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return formatInstant(ms, DataType.isTimestamp(type));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value, bigintSafe);
}

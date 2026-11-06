import * as duckdb from '@duckdb/duckdb-wasm';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import eh_wasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvp_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import type { Field } from 'apache-arrow';
import { batchToRows, isNumeric, type Cell } from '../../shared/cells';
import { CREATE_VIEW, DATA_FILE, DUCKDB_VERSION, EXTENSIONS, LOCKDOWN } from '../../shared/lockdown';
import { sqlString } from '../../shared/sql';
import { QueryStopped, type EngineAdapters, type Result, type StopReason } from '../../shared/pipeline';
import { SERIALIZE_SQL } from '../../shared/validate';
import { MAX_ROWS } from '../../shared/wrap';
import { checkAsset, SETUP_HINT } from './asset';

export const DATA_URL = `/data/${DATA_FILE}`;
export const QUERY_TIMEOUT_MS = 30_000;

export type LoadProgress =
  | { stage: 'engine' }
  | { stage: 'data'; loaded: number; total: number }
  | { stage: 'lock' };

export type { Result };

const stoppedBy = (reason: StopReason) =>
  new QueryStopped(reason, reason === 'timeout' ? `Query stopped after ${QUERY_TIMEOUT_MS / 1000} s` : 'Cancelled');

type Engine = { conn: duckdb.AsyncDuckDBConnection; serializer: duckdb.AsyncPreparedStatement };

let engine: Engine | null = null;
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

  const serializer = await c.prepare(SERIALIZE_SQL);
  const count = await c.query('SELECT count(*)::INTEGER AS n FROM trips');
  engine = { conn: c, serializer };
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

export async function serialize(sql: string): Promise<unknown> {
  if (!engine) throw new Error('The engine is still loading');
  return (await engine.serializer.query(sql)).getChildAt(0)!.get(0);
}

export async function runQuery(wrapped: string, signal: AbortSignal): Promise<Result> {
  if (!engine) throw new Error('The engine is still loading');
  if (busy) throw new Error('A query is already running');
  const { conn: c } = engine;
  busy = true;
  const t0 = performance.now();
  let stopped: QueryStopped | null = null;
  const stop = (reason: StopReason) => {
    if (stopped) return;
    stopped = stoppedBy(reason);
    void c.cancelSent();
  };
  const onAbort = () => stop('cancelled');
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('timeout'), QUERY_TIMEOUT_MS);
  try {
    if (signal.aborted) throw stoppedBy('cancelled');
    const reader = await c.send(wrapped);
    const rows: Cell[][] = [];
    let fields: Field[] | null = null;
    for await (const batch of reader) {
      if (stopped) break;
      fields ??= batch.schema.fields;
      rows.push(...batchToRows(fields, batch, MAX_ROWS + 1 - rows.length));
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

export const engineAdapters: EngineAdapters = { serialize, run: runQuery };

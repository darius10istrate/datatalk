import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Duck from '@duckdb/duckdb-wasm/blocking';
import { CREATE_VIEW, DATA_FILE, EXTENSIONS, LOCKDOWN } from '../shared/lockdown.ts';
import { sqlString } from '../shared/sql.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PARQUET_PATH = join(ROOT, 'public', 'data', DATA_FILE);
const EXT_ROOT = join(ROOT, 'public', 'ext');

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/blocking') as typeof Duck;
const DIST = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));

function installLocalXhr(): void {
  if ('XMLHttpRequest' in globalThis) return;
  class LocalExtensionXhr {
    status = 0;
    response: ArrayBuffer = new ArrayBuffer(0);
    responseType = '';
    private path = '';
    open(method: string, url: string, async?: boolean): void {
      if (method !== 'GET' || async !== false) throw new Error(`LocalExtensionXhr: only sync GET (${method} ${url})`);
      this.path = resolve(url.replace(/^file:\/\//, ''));
    }
    setRequestHeader(): void {}
    getAllResponseHeaders(): string {
      return '';
    }
    getResponseHeader(): string | null {
      return null;
    }
    send(): void {
      const allowed = this.path.startsWith(EXT_ROOT + sep) && this.path.endsWith('.duckdb_extension.wasm');
      if (!allowed) {
        this.status = 403;
        return;
      }
      try {
        const buf = readFileSync(this.path);
        this.response = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
        this.status = 200;
      } catch {
        this.status = 404;
      }
    }
  }
  (globalThis as Record<string, unknown>).XMLHttpRequest = LocalExtensionXhr;
}

export type Row = Record<string, unknown>;

export type Engine = {
  query(sql: string): Row[];
  conn: Duck.DuckDBConnection;
  close(): void;
};

let cached: Promise<Engine> | null = null;

export function openEngine(): Promise<Engine> {
  cached ??= createEngine();
  return cached;
}

async function createEngine(): Promise<Engine> {
  installLocalXhr();
  const db = await duckdb.createDuckDB(
    {
      mvp: { mainModule: join(DIST, 'duckdb-mvp.wasm'), mainWorker: '' },
      eh: { mainModule: join(DIST, 'duckdb-eh.wasm'), mainWorker: '' },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await db.instantiate();
  const conn = db.connect();
  const run = (sql: string) => conn.query(sql);

  run(`SET custom_extension_repository=${sqlString(EXT_ROOT)}`);
  for (const ext of EXTENSIONS) run(`LOAD ${ext}`);
  db.registerFileBuffer(DATA_FILE, new Uint8Array(readFileSync(PARQUET_PATH)));
  run(CREATE_VIEW);
  for (const s of LOCKDOWN) run(s);

  return {
    query: (sql) => run(sql).toArray().map((r) => (r as { toJSON(): Row }).toJSON()),
    conn,
    close: () => {
      conn.close();
      db.reset();
    },
  };
}

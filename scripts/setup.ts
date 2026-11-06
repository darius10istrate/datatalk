import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { COLUMNS, schemaDrift } from '../shared/schema.ts';
import { DUCKDB_VERSION, EXTENSIONS } from '../shared/lockdown.ts';
import { fingerprintSql, sqlString } from '../shared/sql.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache');
const RAW = join(CACHE, 'yellow_tripdata_2024-01.parquet');
const ZONES = join(CACHE, 'taxi_zone_lookup.csv');
const OUT = join(ROOT, 'public', 'data', 'trips.parquet');
const EXT_DIR = join(ROOT, 'public', 'ext', DUCKDB_VERSION, 'wasm_eh');

const RAW_URL = 'https://d37ci6vzurychx.cloudfront.net/trip-data/yellow_tripdata_2024-01.parquet';
const RAW_SHA256 = 'c4d59da7bbc8abaeeeb1727947ee93d9891a71acb42854bd80db1571b2030510';
const RAW_BYTES = 49_961_641;
const ZONES_URL = 'https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv';
const ZONES_ROWS = 265;
const EXT_URL = `https://extensions.duckdb.org/${DUCKDB_VERSION}/wasm_eh`;
const EXPECTED_ROWS = 2_964_606;

const fmt = (n: number | bigint) => n.toLocaleString('en-US');
const log = (step: string, msg: string) => console.log(`${step.padEnd(12)} ${msg}`);

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function download(url: string, dest: string, label: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url);
  if ((res.status !== 200 && res.status !== 206) || !res.body)
    throw new Error(`${label}: GET ${url} returned HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let seen = 0;
  let lastPrint = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      const now = Date.now();
      if (process.stdout.isTTY && now - lastPrint > 250) {
        lastPrint = now;
        const pct = total ? ` (${Math.floor((seen / total) * 100)}%)` : '';
        process.stdout.write(`\r${label.padEnd(12)} downloading ${(seen / 1e6).toFixed(1)} MB${pct}`);
      }
      done(null, chunk);
    },
  });
  const tmp = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), progress, createWriteStream(tmp));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
  renameSync(tmp, dest);
}

async function stepRaw(): Promise<void> {
  if (existsSync(RAW) && statSync(RAW).size === RAW_BYTES && (await sha256(RAW)) === RAW_SHA256) {
    log('raw', `skip: ${RAW} present, SHA-256 matches`);
    return;
  }
  await download(RAW_URL, RAW, 'raw');
  const size = statSync(RAW).size;
  const hash = await sha256(RAW);
  if (size !== RAW_BYTES || hash !== RAW_SHA256) {
    rmSync(RAW, { force: true });
    throw new Error(`raw: expected ${fmt(RAW_BYTES)} bytes / ${RAW_SHA256}, got ${fmt(size)} bytes / ${hash}`);
  }
  log('raw', `downloaded ${fmt(size)} bytes, SHA-256 matches`);
}

async function stepZones(): Promise<void> {
  if (existsSync(ZONES)) {
    log('zones', `skip: ${ZONES} present`);
    return;
  }
  await download(ZONES_URL, ZONES, 'zones');
  log('zones', 'downloaded');
}

const BUILD_SQL = (raw: string, zones: string, out: string) => `
COPY (
  WITH zones AS (
    SELECT LocationID AS id, Borough AS borough, Zone AS zone
    FROM read_csv(${sqlString(zones)}, header = true, all_varchar = true)
  )
  SELECT
    CAST(t.tpep_pickup_datetime AS TIMESTAMP)  AS pickup_at,
    CAST(t.tpep_dropoff_datetime AS TIMESTAMP) AS dropoff_at,
    CAST(t.passenger_count AS INTEGER)         AS passenger_count,
    CAST(t.trip_distance AS DOUBLE)            AS trip_distance,
    CASE CAST(t.RatecodeID AS INTEGER)
      WHEN 1 THEN 'Standard rate' WHEN 2 THEN 'JFK' WHEN 3 THEN 'Newark'
      WHEN 4 THEN 'Nassau or Westchester' WHEN 5 THEN 'Negotiated fare'
      WHEN 6 THEN 'Group ride' ELSE 'Unknown'
    END                                        AS ratecode,
    pu.borough                                 AS pickup_borough,
    pu.zone                                    AS pickup_zone,
    dz.borough                                 AS dropoff_borough,
    dz.zone                                    AS dropoff_zone,
    CASE CAST(t.payment_type AS INTEGER)
      WHEN 0 THEN 'Flex fare' WHEN 1 THEN 'Credit card' WHEN 2 THEN 'Cash'
      WHEN 3 THEN 'No charge' WHEN 4 THEN 'Dispute' WHEN 6 THEN 'Voided trip'
      ELSE 'Unknown'
    END                                        AS payment_type,
    CAST(t.fare_amount AS DOUBLE)              AS fare_amount,
    CAST(t.tip_amount AS DOUBLE)               AS tip_amount,
    CAST(t.total_amount AS DOUBLE)             AS total_amount
  FROM read_parquet(${sqlString(raw)}) t
  LEFT JOIN zones pu ON pu.id = CAST(t.PULocationID AS VARCHAR)
  LEFT JOIN zones dz ON dz.id = CAST(t.DOLocationID AS VARCHAR)
  WHERE t.tpep_pickup_datetime >= TIMESTAMP '2024-01-01'
    AND t.tpep_pickup_datetime <  TIMESTAMP '2024-02-01'
) TO ${sqlString(out)} (FORMAT parquet, COMPRESSION zstd)`;

const FINGERPRINT_SQL = (file: string) => fingerprintSql(`read_parquet(${sqlString(file)})`);

async function stepBuild(): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    const zoneCount = Number((await conn.runAndReadAll(`SELECT count(*) AS n FROM read_csv(${sqlString(ZONES)}, header = true)`)).getRowObjects()[0]!.n);
    if (zoneCount !== ZONES_ROWS) throw new Error(`zones: expected ${ZONES_ROWS} rows, found ${zoneCount}`);

    if (existsSync(OUT)) {
      log('build', `skip: ${OUT} present`);
    } else {
      mkdirSync(dirname(OUT), { recursive: true });
      const tmp = join(dirname(OUT), 'trips.tmp.parquet');
      rmSync(tmp, { force: true });
      const t0 = performance.now();
      try {
        await conn.run(BUILD_SQL(RAW, ZONES, tmp));
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
      renameSync(tmp, OUT);
      log('build', `wrote ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }

    const described = (await conn.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet(${sqlString(OUT)})`))
      .getRowObjects()
      .map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
    const drift = schemaDrift(described);
    if (drift.length) throw new Error(`schema: trips.parquet does not match shared/schema.ts:\n  ${drift.join('\n  ')}`);
    log('schema', `${COLUMNS.length} columns match shared/schema.ts`);

    const row = (await conn.runAndReadAll(FINGERPRINT_SQL(OUT))).getRowObjects()[0]!;
    const rows = Number(row.n);
    if (rows !== EXPECTED_ROWS) throw new Error(`rows: expected ${fmt(EXPECTED_ROWS)}, found ${fmt(rows)}`);
    log('rows', fmt(rows));
    log('fingerprint', String(row.fp));
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

async function stepExtensions(): Promise<void> {
  for (const ext of EXTENSIONS) {
    const file = join(EXT_DIR, `${ext}.duckdb_extension.wasm`);
    if (existsSync(file) && readFileSync(file).subarray(0, 4).equals(WASM_MAGIC)) {
      log('ext', `skip: ${ext} present`);
      continue;
    }
    await download(`${EXT_URL}/${ext}.duckdb_extension.wasm`, file, 'ext');
    if (!readFileSync(file).subarray(0, 4).equals(WASM_MAGIC)) {
      rmSync(file, { force: true });
      throw new Error(`ext: ${ext} is not a wasm module`);
    }
    log('ext', `downloaded ${ext} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
  }
}

async function main() {
  const t0 = performance.now();
  await stepRaw();
  await stepZones();
  await stepBuild();
  await stepExtensions();
  log('done', `in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e: unknown) => {
  console.error(`\nsetup failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

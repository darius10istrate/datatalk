import { beforeAll, describe, expect, it } from 'vitest';
import { COLUMNS, schemaDrift } from '../shared/schema.ts';
import { openEngine, type Engine } from './engine.ts';

let engine: Engine;
beforeAll(async () => {
  engine = await openEngine();
});

describe('Node engine', () => {
  it('runs DuckDB v1.4.3, the version DuckDB-WASM 1.32.0 ships to the browser', () => {
    expect(engine.query('SELECT version() AS v')[0]!.v).toBe('v1.4.3');
  });

  it('loaded parquet and json from public/ext', () => {
    const rows = engine.query(
      "SELECT extension_name AS name, loaded FROM duckdb_extensions() WHERE extension_name IN ('parquet', 'json') ORDER BY 1",
    );
    expect(rows).toEqual([
      { name: 'json', loaded: true },
      { name: 'parquet', loaded: true },
    ]);
  });

  it('is locked', () => {
    expect(() => engine.query("SET memory_limit='2GB'")).toThrow(/locked/i);
    expect(() => engine.query("SELECT * FROM read_csv('/etc/passwd')")).toThrow(/disabled|permission/i);
  });
});

describe('trips', () => {
  it('DESCRIBE trips matches shared/schema.ts', () => {
    const described = engine
      .query('DESCRIBE trips')
      .map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
    expect(schemaDrift(described)).toEqual([]);
    expect(described.map((c) => c.name)).toEqual(COLUMNS.map((c) => c.name));
  });

  it('holds 2,964,606 January 2024 trips', () => {
    const [row] = engine.query(
      "SELECT count(*)::INTEGER AS n, count(*) FILTER (pickup_at < '2024-01-01' OR pickup_at >= '2024-02-01')::INTEGER AS outside FROM trips",
    );
    expect(row).toEqual({ n: 2_964_606, outside: 0 });
  });
});

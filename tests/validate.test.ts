import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAst, message, validate, type Rejection } from '../shared/validate.ts';
import { MAX_ROWS, stripTail, wrap } from '../shared/wrap.ts';
import { ATTACKS, INJECTION, type Attack } from './attacks.ts';
import { createEngine, openEngine, type Engine } from './engine.ts';

const TRIPS = 2_964_606;

type Outcome = 'blocked by validator' | 'blocked by lockdown only' | 'engine error' | 'not blocked' | 'not run';
type Unguarded = 'blocked' | 'ran' | 'same';
type Row = { attack: Attack; outcome: Outcome; reason: string; unguarded: Unguarded };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

let engine: Engine;
let unguarded: Engine;
let baseline = '';
const rows: Row[] = [];

const fingerprint = (e: Engine) =>
  JSON.stringify(
    e.query(
      `SELECT (SELECT count(*)::INTEGER FROM trips) AS trips,
              (SELECT count(*)::INTEGER FROM duckdb_tables()) AS tables,
              (SELECT count(*)::INTEGER FROM duckdb_views() WHERE NOT internal) AS views,
              (SELECT count(*)::INTEGER FROM duckdb_databases()) AS databases`,
    ),
  );

async function runWithoutValidator(sql: string): Promise<Unguarded> {
  let result: Unguarded;
  try {
    unguarded.conn.query(sql);
    result = 'ran';
  } catch {
    result = 'blocked';
  }
  let healthy: boolean;
  try {
    healthy = fingerprint(unguarded) === baseline;
  } catch {
    healthy = false;
  }
  if (!healthy) {
    unguarded.close();
    unguarded = await createEngine();
  }
  return result;
}

const tripsCount = () => Number(engine.query('SELECT count(*)::INTEGER AS n FROM trips')[0]!.n);

beforeAll(async () => {
  engine = await openEngine();
  unguarded = await createEngine();
  baseline = fingerprint(unguarded);
});

afterAll(() => {
  unguarded?.close();
  if (rows.length === 0) return;
  const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', '\\n');
  const shown = (sql: string) => (sql.length > 90 ? `${sql.slice(0, 60)}… (${sql.length} chars)` : sql);
  const lines = [
    '| Category | SQL | Expected | Result | Reason | Without validator |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.attack.category} | \`${cell(shown(r.attack.sql))}\` | ${r.attack.expect} | ${r.outcome} | ${cell(r.reason)} | ${r.unguarded} |`,
    ),
  ];
  const tally = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  lines.push(
    '',
    `${rows.length} rows: ${tally('blocked by validator')} blocked by validator, ${tally('blocked by lockdown only')} blocked by lockdown only, ${tally('not blocked')} allowed and ran, ${tally('engine error')} engine error, ${tally('not run')} not run`,
  );
  console.log(`\nAttack suite (DuckDB-WASM 1.32.0, locked engine)\n\n${lines.join('\n')}\n`);
});

describe('stripTail', () => {
  it.each([
    ['SELECT 1;', 'SELECT 1'],
    ['SELECT 1; ', 'SELECT 1'],
    ['SELECT 1;\n', 'SELECT 1'],
    ['SELECT 1;;', 'SELECT 1'],
    ['SELECT 1; -- done', 'SELECT 1'],
    ['SELECT 1 /* a */ ; /* b */\n-- c\n', 'SELECT 1'],
    ["SELECT ';' AS s;", "SELECT ';' AS s"],
    ["SELECT '-- not a comment'", "SELECT '-- not a comment'"],
    ['SELECT "a;b" FROM t ;', 'SELECT "a;b" FROM t'],
    ['SELECT 1; DROP VIEW trips;', 'SELECT 1; DROP VIEW trips'],
    ['  SELECT 1  ', '  SELECT 1'],
    [';', ''],
  ])('%j → %j', (sql, body) => {
    expect(stripTail(sql)).toBe(body);
  });
});

describe('wrap', () => {
  it('caps the body at MAX_ROWS + 1 rows on separate lines', () => {
    expect(wrap('SELECT 1')).toBe(`SELECT * FROM (\nSELECT 1\n) LIMIT ${MAX_ROWS + 1}`);
  });

  it('keeps the ORDER BY of the wrapped query', async () => {
    const sql = 'SELECT pickup_zone, count(*)::INTEGER AS n FROM trips GROUP BY ALL ORDER BY n DESC, pickup_zone';
    const plain = engine.query(sql).map((r) => r.pickup_zone);
    const wrapped = engine.query(wrap(sql)).map((r) => r.pickup_zone);
    expect(wrapped).toEqual(plain);
  });
});

describe('checkAst', () => {
  it('rejects a serializer error as not_select', () => {
    expect(checkAst({ error: true, error_type: 'not implemented' })).toEqual({ code: 'not_select' });
    expect(checkAst('{"error":true,"error_type":"not implemented"}')).toEqual({ code: 'not_select' });
    expect(checkAst(null)).toEqual({ code: 'not_select' });
    expect(checkAst({ error: false })).toEqual({ code: 'not_select' });
  });

  it('rejects a parser error as syntax with the parser message', () => {
    expect(checkAst({ error: true, error_type: 'parser', error_message: 'syntax error at or near "SELEC"' })).toEqual({
      code: 'syntax',
      detail: 'syntax error at or near "SELEC"',
    });
  });

  it('rejects more than one statement', () => {
    const select = { node: { type: 'SELECT_NODE', from_table: { type: 'EMPTY' } } };
    expect(checkAst({ error: false, statements: [select, select] })).toEqual({ code: 'multi_statement' });
  });

  it('finds a denied function wherever it sits', () => {
    const buried = { error: false, statements: [{ node: { unknown_field: [{ deep: { class: 'FUNCTION', function_name: 'pragma_version' } }] } }] };
    expect(checkAst(buried)).toEqual({ code: 'function_blocked', name: 'pragma_version' });
  });
});

describe('message', () => {
  it.each<[Rejection, RegExp]>([
    [{ code: 'not_select' }, /only a single SELECT/],
    [{ code: 'multi_statement' }, /one statement/i],
    [{ code: 'table_not_allowed', name: 'system.main.duckdb_settings' }, /system\.main\.duckdb_settings.*trips/],
    [{ code: 'function_blocked', name: 'read_csv' }, /read_csv.*reads files.*trips/],
    [{ code: 'function_blocked', name: 'query' }, /query/],
  ])('%j', (r, pattern) => {
    expect(message(r)).toMatch(/^Blocked: /);
    expect(message(r)).toMatch(pattern);
  });

  it('shows the parser text for a syntax error', () => {
    expect(message({ code: 'syntax', detail: 'syntax error at or near "SELEC"' })).toBe('Syntax error: syntax error at or near "SELEC"');
  });
});

describe('syntax errors', () => {
  it.each([
    ['SELEC 1', /syntax error at or near "SELEC"/],
    ["SELECT 'abc", /unterminated quoted string/],
    ['ＳＥＬＥＣＴ 1', /syntax error/],
  ])('%j is a syntax error', async (sql, detail) => {
    const verdict = await validate(sql, engine.serialize);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.rejection.code).toBe('syntax');
    expect(message(verdict.rejection)).toMatch(/^Syntax error: /);
    expect(message(verdict.rejection)).toMatch(detail);
  });

  it.each(['DROP TABLE trips', "COPY (SELECT 1 AS a) TO 'x.parquet'", "SET memory_limit = '8GB'", 'PRAGMA version', 'PIVOT trips ON payment_type USING count(*)'])(
    '%j is not_select',
    async (sql) => {
      expect(await validate(sql, engine.serialize)).toEqual({ ok: false, rejection: { code: 'not_select' } });
    },
  );

  it('a parser error on the wrapped string after the body passed is not_select', async () => {
    const verdict = await validate('SELECT 1', (s) =>
      s === 'SELECT 1' ? engine.serialize(s) : { error: true, error_type: 'parser', error_message: 'syntax error at or near ")"' },
    );
    expect(verdict).toEqual({ ok: false, rejection: { code: 'not_select' } });
  });

  it('the wrapper break-out stays blocked', async () => {
    const verdict = await validate('SELECT 1 x) UNION ALL (SELECT 2', engine.serialize);
    expect(verdict.ok).toBe(false);
  });
});

describe('CTE scope', () => {
  it.each([
    ['a CTE cannot read itself', 'WITH duckdb_views AS (SELECT * FROM duckdb_views) SELECT * FROM duckdb_views', 'duckdb_views'],
    ['the recursive anchor cannot read the CTE name', 'WITH RECURSIVE r AS (SELECT * FROM r UNION SELECT 1) SELECT * FROM r', 'r'],
    ['an earlier CTE cannot read a later one', 'WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS n) SELECT * FROM a', 'b'],
  ])('%s', async (_label, sql, name) => {
    expect(await validate(sql, engine.serialize)).toEqual({ ok: false, rejection: { code: 'table_not_allowed', name } });
  });
});

describe('attack suite', () => {
  it.each(ATTACKS.map((a) => [a.category, a.sql.length > 80 ? `${a.sql.slice(0, 60)}…` : a.sql, a] as const))(
    '%s: %s',
    async (_category, _label, attack) => {
      const verdict = await validate(attack.sql, engine.serialize);
      let row: Row;
      if (!verdict.ok) {
        row = { attack, outcome: 'blocked by validator', reason: message(verdict.rejection), unguarded: await runWithoutValidator(attack.sql) };
      } else if (attack.run === false) {
        row = { attack, outcome: 'not run', reason: 'passes the validator; Cancel / 30 s timeout stop it in the browser', unguarded: 'same' };
      } else {
        try {
          engine.query(verdict.run);
          row = { attack, outcome: 'not blocked', reason: '', unguarded: 'same' };
        } catch (e) {
          row = { attack, outcome: attack.expect === 'blocked' ? 'blocked by lockdown only' : 'engine error', reason: errorText(e), unguarded: 'same' };
        }
      }
      rows.push(row);

      if (attack.expect === 'blocked') expect(row.outcome, row.reason).toBe('blocked by validator');
      if (attack.expect === 'allowed') expect(row.outcome, row.reason).toBe('not blocked');
      if (attack.expect === 'runaway') expect(row.outcome).not.toBe('blocked by validator');
      expect(tripsCount()).toBe(TRIPS);
    },
  );

  it('the injection string never reaches the engine as SQL and trips survives', async () => {
    const verdict = await validate(INJECTION, engine.serialize);
    expect(verdict).toMatchObject({ ok: false, rejection: { code: 'syntax' } });
    expect(tripsCount()).toBe(TRIPS);
    expect(engine.query("SELECT count(*)::INTEGER AS n FROM duckdb_views() WHERE view_name = 'trips'")[0]!.n).toBe(1);
  });

  it('validates the raw body and the wrapped string', async () => {
    const seen: string[] = [];
    const verdict = await validate('SELECT 1;\n', (s) => {
      seen.push(s);
      return engine.serialize(s);
    });
    expect(seen).toEqual(['SELECT 1', wrap('SELECT 1')]);
    expect(verdict).toEqual({ ok: true, run: wrap('SELECT 1') });
  });

  it('fails closed when the serializer throws', async () => {
    const verdict = await validate('SELECT 1', () => {
      throw new Error('engine gone');
    });
    expect(verdict).toEqual({ ok: false, rejection: { code: 'not_select' } });
  });
});

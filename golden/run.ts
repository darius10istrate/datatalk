import type { Table as ArrowTable } from 'apache-arrow';
import { batchToRows, type Cell } from '../shared/cells.ts';
import { DUCKDB_VERSION } from '../shared/lockdown.ts';
import { openEngine, type Engine } from '../tests/engine.ts';
import { DEV_QUESTIONS, type GoldenQuestion } from './questions.ts';

const ROW_CAP = 1_000;

const capRows = (sql: string) => `SELECT * FROM (\n${sql}\n) LIMIT ${ROW_CAP + 1}`;

const referencesOf = (q: GoldenQuestion): string[] => (typeof q.reference === 'string' ? [q.reference] : q.reference);

type ReferenceResult = { columns: string[]; rows: Cell[][] };

function toResult(table: ArrowTable): ReferenceResult {
  const fields = table.schema.fields;
  return { columns: fields.map((f) => f.name), rows: batchToRows(fields, table) };
}

function runReference(engine: Engine, sql: string): ReferenceResult {
  return toResult(engine.conn.query(capRows(sql)));
}

function shapeProblem(q: GoldenQuestion): string | null {
  const refs = referencesOf(q);
  if (q.check === 'refuse') return refs.length === 0 ? null : 'a refuse question has no reference SQL';
  if (q.check === 'any_of') return refs.length >= 2 ? null : 'any_of needs at least two references';
  return refs.length === 1 ? null : `${q.check} needs exactly one reference`;
}

const describeRow = (columns: string[], row: Cell[] | undefined) =>
  row ? columns.map((c, i) => `${c}=${row[i] === null ? 'NULL' : String(row[i])}`).join(', ') : '(none)';

function reportQuestion(engine: Engine, q: GoldenQuestion): boolean {
  console.log(`\n${q.id} [${q.check}] ${q.question}`);
  if (q.trap) console.log(`  trap: ${q.trap}`);
  const problem = shapeProblem(q);
  if (problem) {
    console.log(`  FAIL ${problem}`);
    return false;
  }
  const refs = referencesOf(q);
  if (refs.length === 0) console.log('  refuse: no reference SQL; passes when the model answers cannot_answer');
  let passed = true;
  refs.forEach((sql, i) => {
    const label = refs.length > 1 ? `  ref ${i + 1}:` : ' ';
    try {
      const { columns, rows } = runReference(engine, sql);
      const count = rows.length > ROW_CAP ? `>${ROW_CAP} rows` : `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;
      if (rows.length === 0) {
        passed = false;
        console.log(`${label} FAIL 0 rows`);
        return;
      }
      console.log(`${label} ${count} · first row: ${describeRow(columns, rows[0])}`);
    } catch (e) {
      passed = false;
      console.log(`${label} FAIL ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return passed;
}

async function referenceMode(questions: readonly GoldenQuestion[]): Promise<number> {
  const engine = await openEngine();
  try {
    const version = engine.query('SELECT version() AS v')[0]!.v;
    const trips = engine.query('SELECT count(*)::INTEGER AS n FROM trips')[0]!.n;
    console.log(`golden --reference · dev set · ${questions.length} questions · DuckDB ${String(version)} · ${Number(trips).toLocaleString('en-US')} trips · ${new Date().toISOString()}`);
    if (version !== DUCKDB_VERSION) console.log(`warning: expected DuckDB ${DUCKDB_VERSION}`);

    const failedQuestions = questions.filter((q) => !reportQuestion(engine, q)).length;
    const summary = failedQuestions === 0 ? `ok: ${questions.length} questions` : `${failedQuestions} of ${questions.length} questions failed`;
    console.log(`\n${summary}`);
    return failedQuestions === 0 ? 0 : 1;
  } finally {
    engine.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--reference')) return referenceMode(DEV_QUESTIONS);
  console.error('usage: npm run golden -- --reference   (model mode arrives with /api/sql)');
  return 2;
}

process.exitCode = await main(process.argv.slice(2));

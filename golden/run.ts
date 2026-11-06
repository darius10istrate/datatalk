import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { CONTEXTS, httpAsk, isContext, isServiceError, SQL_ENDPOINT, type Context } from '../shared/api.ts';
import { DUCKDB_VERSION } from '../shared/lockdown.ts';
import { askAndRun, validateAndRun, type Adapters, type AskOutcome, type EngineAdapters, type RunOutcome } from '../shared/pipeline.ts';
import { fingerprintSql } from '../shared/sql.ts';
import { MAX_ROWS } from '../shared/wrap.ts';
import { engineAdapters, openEngine, type Engine } from '../tests/engine.ts';
import { check, type Observed, type Table } from './check.ts';
import { HOLDOUT_QUESTIONS } from './holdout.ts';
import { DEV_QUESTIONS, type GoldenQuestion } from './questions.ts';
import { OUT_DIR, ROOT, type DatasetInfo, type GoldenReport } from './report.ts';

const DEFAULT_URL = 'http://localhost:5173';

const SETS: Record<string, readonly GoldenQuestion[]> = { dev: DEV_QUESTIONS, holdout: HOLDOUT_QUESTIONS };

const referencesOf = (q: GoldenQuestion): string[] => (typeof q.reference === 'string' ? [q.reference] : q.reference);

const toTable = (run: RunOutcome): Table | null =>
  run.kind === 'rows' ? { columns: run.result.columns.map((c) => c.name), rows: run.result.rows } : null;

function shapeProblem(q: GoldenQuestion): string | null {
  const refs = referencesOf(q);
  if (q.check === 'refuse') return refs.length === 0 ? null : 'a refuse question has no reference SQL';
  if (q.check === 'any_of') return refs.length >= 2 ? null : 'any_of needs at least two references';
  return refs.length === 1 ? null : `${q.check} needs exactly one reference`;
}

const describeRow = (columns: readonly unknown[], row: readonly unknown[] | undefined) =>
  row ? columns.map((c, i) => `${String(c)}=${row[i] === null ? 'NULL' : String(row[i])}`).join(', ') : '(none)';

const failureText = (run: RunOutcome) => (run.kind === 'rows' ? '' : run.message.split('\n')[0]!);

function datasetInfo(engine: Engine): DatasetInfo {
  const version = String(engine.query('SELECT version() AS v')[0]!.v);
  const row = engine.query(fingerprintSql('trips'))[0]!;
  return { version, trips: Number(row.n), fingerprint: String(row.fp) };
}

const fmt = (n: number) => n.toLocaleString('en-US');

function datasetLine(info: DatasetInfo): string {
  const warning = info.version === DUCKDB_VERSION ? '' : ` (expected ${DUCKDB_VERSION})`;
  return `DuckDB ${info.version}${warning} · ${fmt(info.trips)} trips · fingerprint ${info.fingerprint}`;
}

type Reference = { sql: string; run: RunOutcome };

async function runReferences(q: GoldenQuestion, adapters: EngineAdapters, signal: AbortSignal): Promise<Reference[]> {
  const out: Reference[] = [];
  for (const sql of referencesOf(q)) out.push({ sql, run: await validateAndRun(sql, adapters, signal) });
  return out;
}

async function reportReference(q: GoldenQuestion, adapters: EngineAdapters, signal: AbortSignal): Promise<boolean> {
  console.log(`\n${q.id} [${q.check}] ${q.question}`);
  if (q.trap) console.log(`  trap: ${q.trap}`);
  const problem = shapeProblem(q);
  if (problem) {
    console.log(`  FAIL ${problem}`);
    return false;
  }
  const refs = await runReferences(q, adapters, signal);
  if (refs.length === 0) console.log('  refuse: no reference SQL; passes when the model answers cannot_answer');
  let passed = true;
  refs.forEach(({ run }, i) => {
    const label = refs.length > 1 ? `  ref ${i + 1}:` : ' ';
    const table = toTable(run);
    if (!table) {
      passed = false;
      console.log(`${label} FAIL ${failureText(run)}`);
      return;
    }
    if (table.rows.length === 0) {
      passed = false;
      console.log(`${label} FAIL 0 rows`);
      return;
    }
    const truncated = run.kind === 'rows' && run.result.truncated;
    const count = truncated ? `>${MAX_ROWS} rows` : `${table.rows.length} ${table.rows.length === 1 ? 'row' : 'rows'}`;
    console.log(`${label} ${count} · first row: ${describeRow(table.columns, table.rows[0])}`);
  });
  return passed;
}

async function referenceMode(set: string, questions: readonly GoldenQuestion[]): Promise<number> {
  const engine = await openEngine();
  try {
    const adapters = engineAdapters(engine);
    const signal = new AbortController().signal;
    console.log(`golden --reference · ${set} set · ${questions.length} questions · ${datasetLine(datasetInfo(engine))} · ${new Date().toISOString()}`);
    let failed = 0;
    for (const q of questions) if (!(await reportReference(q, adapters, signal))) failed++;
    console.log(`\n${failed === 0 ? `ok: ${questions.length} questions` : `${failed} of ${questions.length} questions failed`}`);
    return failed === 0 ? 0 : 1;
  } finally {
    engine.close();
  }
}

type RunRecord = {
  pass: boolean;
  matched: number | null;
  outcome: string;
  retried: boolean;
  snippet_ids: string[];
  model: string | null;
  sql: string | null;
  rationale: string | null;
  reason: string | null;
  error: string | null;
};

type QuestionRecord = { id: string; question: string; check: GoldenQuestion['check']; passes: number; runs: RunRecord[] };

function observe(outcome: AskOutcome): Observed {
  if (outcome.kind === 'cannot_answer') return { kind: 'cannot_answer' };
  if (outcome.kind === 'answered') {
    const table = toTable(outcome.run);
    if (table) return { kind: 'rows', table };
  }
  return { kind: 'failed' };
}

function outcomeLabel(outcome: AskOutcome): string {
  if (outcome.kind === 'answered') return outcome.run.kind;
  if (outcome.kind === 'service_error') return outcome.answer.error;
  if (outcome.kind === 'stopped') return outcome.reason;
  return 'cannot_answer';
}

function record(outcome: AskOutcome, references: readonly Table[], q: GoldenQuestion): RunRecord {
  const verdict = check(q.check, observe(outcome), references);
  const base = { pass: verdict.pass, matched: verdict.matched, outcome: outcomeLabel(outcome), retried: outcome.retried };
  switch (outcome.kind) {
    case 'answered':
      return {
        ...base,
        snippet_ids: outcome.answer.snippet_ids,
        model: outcome.answer.model,
        sql: outcome.answer.sql,
        rationale: outcome.answer.rationale,
        reason: null,
        error: outcome.run.kind === 'rows' ? null : failureText(outcome.run),
      };
    case 'cannot_answer':
      return { ...base, snippet_ids: outcome.answer.snippet_ids, model: outcome.answer.model, sql: null, rationale: null, reason: outcome.answer.reason, error: null };
    case 'service_error':
    case 'stopped':
      return { ...base, snippet_ids: [], model: null, sql: null, rationale: null, reason: null, error: null };
  }
}

type Args = { set: string; contexts: Context[]; runs: number; url: string; reference: boolean };

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

function parseArgs(argv: readonly string[]): Args | string {
  const set = valueOf(argv, '--set') ?? 'dev';
  const contexts = (valueOf(argv, '--context') ?? 'top4').split(',').map((s) => s.trim());
  const runs = Number(valueOf(argv, '--runs') ?? '3');
  const url = (valueOf(argv, '--url') ?? DEFAULT_URL).replace(/\/+$/, '');
  if (!SETS[set]) return `unknown set "${set}"; available: ${Object.keys(SETS).join(', ')}`;
  if (!contexts.every(isContext)) return `--context takes ${CONTEXTS.join(' | ')}, or a comma-separated list`;
  if (!Number.isInteger(runs) || runs < 1) return '--runs takes a positive integer';
  return { set, contexts: contexts as Context[], runs, url, reference: argv.includes('--reference') };
}

function configuredModel(): { model: string; provider: string } {
  const file = join(ROOT, '.env');
  const env = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  return {
    model: env.OPENROUTER_MODEL?.trim() || '(worker default)',
    provider: env.OPENROUTER_PROVIDER?.trim() || '(any endpoint with require_parameters)',
  };
}

async function serverUp(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/health`)).ok;
  } catch {
    return false;
  }
}

function printSummary(arm: Context, runs: number, results: readonly QuestionRecord[]): void {
  const rows = results.map((r) => {
    const retried = r.runs.filter((x) => x.retried).length;
    const snippets = [...new Set(r.runs.flatMap((x) => x.snippet_ids))].join(', ') || '-';
    const outcomes = r.runs.map((x) => x.outcome).join(', ');
    return `| ${r.id} | ${r.check} | ${r.passes}/${runs} | ${retried} | ${outcomes} | ${snippets} |`;
  });
  const total = results.reduce((sum, r) => sum + r.passes, 0);
  console.log(
    [
      '',
      `Summary · arm ${arm}`,
      '',
      '| Question | Check | Pass | Retried | Outcomes | Snippets |',
      '| --- | --- | --- | --- | --- | --- |',
      ...rows,
      '',
      `${total} of ${results.length * runs} runs passed`,
    ].join('\n'),
  );
}

async function modelMode(args: Args, questions: readonly GoldenQuestion[]): Promise<number> {
  if (!(await serverUp(args.url))) {
    console.error(`No API at ${args.url}/api/health. Start it with npm run dev, or pass --url.`);
    return 1;
  }
  const engine = await openEngine();
  try {
    const signal = new AbortController().signal;
    const engineSide = engineAdapters(engine);
    const adapters: Adapters = { ...engineSide, ask: httpAsk(`${args.url}${SQL_ENDPOINT}`) };
    const info = datasetInfo(engine);
    const { model, provider } = configuredModel();
    const date = new Date().toISOString();
    console.log(`golden · ${args.set} set · ${questions.length} questions · arms ${args.contexts.join(', ')} · ${args.runs} run(s)`);
    console.log(`model ${model} · provider ${provider} · ${date}`);
    console.log(datasetLine(info));

    const references = new Map<string, Table[]>();
    for (const q of questions) {
      const refs = await runReferences(q, engineSide, signal);
      const tables = refs.map((r) => toTable(r.run));
      if (tables.some((t) => t === null)) {
        console.error(`reference SQL failed for ${q.id}; run npm run golden -- --reference`);
        return 1;
      }
      references.set(q.id, tables as Table[]);
    }

    let serviceErrors = 0;
    let total = 0;
    for (const arm of args.contexts) {
      console.log(`\n== arm ${arm}`);
      const results: QuestionRecord[] = [];
      for (const q of questions) {
        const runs: RunRecord[] = [];
        for (let i = 0; i < args.runs; i++) {
          const outcome = await askAndRun(q.question, adapters, signal, { context: arm });
          runs.push(record(outcome, references.get(q.id)!, q));
        }
        const passes = runs.filter((r) => r.pass).length;
        results.push({ id: q.id, question: q.question, check: q.check, passes, runs });
        const retried = runs.filter((r) => r.retried).length;
        const snippets = [...new Set(runs.flatMap((r) => r.snippet_ids))].join(', ') || '-';
        console.log(`${q.id} [${q.check}] ${passes}/${args.runs} · retried ${retried} · snippets: ${snippets}`);
        for (const r of runs.filter((x) => !x.pass)) console.log(`    ${r.outcome}${r.error ? `: ${r.error}` : ''}${r.sql ? `\n      ${r.sql.replaceAll('\n', '\n      ')}` : ''}`);
      }
      printSummary(arm, args.runs, results);
      const armRuns = results.flatMap((r) => r.runs);
      total += armRuns.length;
      serviceErrors += armRuns.filter((r) => isServiceError(r.outcome)).length;

      const served = [...new Set(results.flatMap((r) => r.runs.map((x) => x.model)).filter((m): m is string => m !== null))];
      mkdirSync(OUT_DIR, { recursive: true });
      const file = join(OUT_DIR, `${args.set}-${arm}-${date.slice(0, 19).replaceAll(':', '')}.json`);
      const report: GoldenReport<QuestionRecord> = { set: args.set, arm, runs: args.runs, date, model_configured: model, models_served: served, provider, dataset: info, results };
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`served by ${served.join(', ') || '(no model answered)'} · wrote ${file}`);
    }
    if (total > 0 && serviceErrors === total) {
      console.error('\nEvery request failed at the SQL service. Is OPENROUTER_API_KEY set in .env (restart npm run dev after editing it)?');
      return 1;
    }
    return 0;
  } finally {
    engine.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === 'string') {
    console.error(`${args}\nusage: npm run golden -- [--reference] [--set dev|holdout] [--context none|all|top4] [--runs 3] [--url ${DEFAULT_URL}]`);
    return 2;
  }
  const questions = SETS[args.set]!;
  return args.reference ? referenceMode(args.set, questions) : modelMode(args, questions);
}

process.exitCode = await main(process.argv.slice(2));

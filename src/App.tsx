import { useEffect, useRef, useState } from 'react';
import { validateAndRun, type RunOutcome } from '../shared/pipeline';
import { engineAdapters, init, type LoadProgress, type Result } from './db/duckdb';

type Load = { kind: 'loading'; progress: LoadProgress } | { kind: 'ready'; rows: number } | { kind: 'failed'; message: string };

type Run =
  | { kind: 'idle' }
  | { kind: 'running'; started: number }
  | { kind: 'done'; result: Result }
  | { kind: 'stopped'; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'error'; message: string };

const fmt = (n: number) => n.toLocaleString('en-US');

function toRun(outcome: RunOutcome): Run {
  switch (outcome.kind) {
    case 'rows':
      return { kind: 'done', result: outcome.result };
    case 'stopped':
      return { kind: 'stopped', message: outcome.message };
    case 'rejected':
      return { kind: 'rejected', message: outcome.message };
    case 'query_error':
      return { kind: 'error', message: outcome.message };
  }
}

function loadingText(p: LoadProgress): string {
  if (p.stage === 'engine') return 'Starting DuckDB…';
  if (p.stage === 'lock') return 'Locking the engine…';
  const mb = (n: number) => (n / 1e6).toFixed(1);
  return p.total ? `Loading trips ${mb(p.loaded)} / ${mb(p.total)} MB` : `Loading trips ${mb(p.loaded)} MB`;
}

export function App() {
  const [load, setLoad] = useState<Load>({ kind: 'loading', progress: { stage: 'engine' } });
  const [sql, setSql] = useState('SELECT payment_type, count(*) AS trips, round(avg(tip_amount), 2) AS avg_tip\nFROM trips\nGROUP BY ALL\nORDER BY trips DESC');
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [now, setNow] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    init((progress) => setLoad({ kind: 'loading', progress }))
      .then(({ rows }) => setLoad({ kind: 'ready', rows }))
      .catch((e: unknown) => setLoad({ kind: 'failed', message: e instanceof Error ? e.message : String(e) }));
  }, []);

  useEffect(() => {
    if (run.kind !== 'running') return;
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [run.kind]);

  const ready = load.kind === 'ready';
  const running = run.kind === 'running';

  async function onRun() {
    if (!ready || running || !sql.trim()) return;
    const controller = new AbortController();
    abort.current = controller;
    const started = performance.now();
    setNow(started);
    setRun({ kind: 'running', started });
    try {
      setRun(toRun(await validateAndRun(sql, engineAdapters, controller.signal)));
    } catch (e) {
      setRun({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      abort.current = null;
    }
  }

  return (
    <main>
      <header className="status">
        <span>NYC Yellow Taxi · January 2024</span>
        {load.kind === 'loading' && <span className="muted">{loadingText(load.progress)}</span>}
        {load.kind === 'ready' && <span className="ok">● Ready · {fmt(load.rows)} trips</span>}
        {load.kind === 'failed' && <span className="err">Load failed: {load.message}</span>}
      </header>

      <section className="panel">
        <label htmlFor="sql">SQL</label>
        <textarea
          id="sql"
          value={sql}
          spellCheck={false}
          rows={8}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void onRun();
            }
          }}
        />
        <div className="actions">
          {running ? (
            <>
              <button type="button" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
              <span className="muted">Running… {((now - run.started) / 1000).toFixed(1)} s</span>
            </>
          ) : (
            <button type="button" onClick={() => void onRun()} disabled={!ready || !sql.trim()}>
              Run ▶
            </button>
          )}
        </div>
      </section>

      <section className="panel">
        {run.kind === 'stopped' && <p className="muted">{run.message}</p>}
        {run.kind === 'rejected' && <p className="err">{run.message}</p>}
        {run.kind === 'error' && <p className="err">{run.message}</p>}
        {run.kind === 'done' && <ResultsTable result={run.result} />}
      </section>
    </main>
  );
}

function ResultsTable({ result }: { result: Result }) {
  if (result.rows.length === 0) return <p className="muted">No rows matched · {result.ms} ms</p>;
  return (
    <>
      <p className="muted">
        {result.truncated ? `Showing the first ${fmt(result.rows.length)} rows` : `${fmt(result.rows.length)} rows`} · {result.ms} ms
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} className={c.numeric ? 'num' : undefined}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className={result.columns[j]?.numeric ? 'num' : undefined}>
                    {cell === null ? <span className="muted">NULL</span> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

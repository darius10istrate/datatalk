import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch, type RefObject } from 'react';
import { httpAsk, SQL_ENDPOINT } from '../shared/api';
import { askAndRun, errorText, validateAndRun, type Adapters, type AskOutcome, type EngineAdapters, type RunOutcome } from '../shared/pipeline';
import { QuestionBox } from './components/QuestionBox';
import { AskingBar, ResultsTable, RunningBar } from './components/ResultsTable';
import { SqlEditor } from './components/SqlEditor';
import { StatusBar } from './components/StatusBar';
import { init, runQuery, serialize, type Loaded } from './db/duckdb';
import { initialState, isBusy, MESSAGES, reducer, shown, stateMessage, type Action, type Explained, type Retry } from './state';

const INITIAL_SQL = 'SELECT payment_type, count(*) AS trips, round(avg(tip_amount), 2) AS avg_tip\nFROM trips\nGROUP BY ALL\nORDER BY trips DESC';

const askService = httpAsk(SQL_ENDPOINT);

const failedRun = (e: unknown): RunOutcome => ({ kind: 'query_error', message: errorText(e), problem: null });

const serviceDown: AskOutcome = { kind: 'service_error', answer: { error: 'upstream' }, retried: false };

const RETRY_NOTES: Record<Retry, string | null> = { none: null, pending: 'second try', fixed: 'fixed on a second try', unfixed: 'second try' };

function engineFor(dispatch: Dispatch<Action>, started: RefObject<number>): EngineAdapters {
  return {
    serialize,
    run: (wrapped, signal) => {
      started.current = performance.now();
      dispatch({ type: 'running' });
      return runQuery(wrapped, signal);
    },
  };
}

function adaptersFor(dispatch: Dispatch<Action>, started: RefObject<number>): Adapters {
  return {
    ...engineFor(dispatch, started),
    ask: async (request, signal) => {
      dispatch({ type: 'asking' });
      const response = await askService(request, signal);
      if ('kind' in response && response.kind === 'sql') dispatch({ type: 'answered', answer: response, retried: request.problem !== undefined });
      return response;
    },
  };
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [dataset, setDataset] = useState<Loaded | null>(null);
  const [now, setNow] = useState(0);
  const started = useRef(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    init((progress) => dispatch({ type: 'progress', progress }))
      .then((loaded) => {
        setDataset(loaded);
        dispatch({ type: 'loaded', sql: INITIAL_SQL });
      })
      .catch((e: unknown) => dispatch({ type: 'load_failed', message: errorText(e) }));
  }, []);

  const running = state.phase === 'running';
  useEffect(() => {
    if (!running) return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(id);
  }, [running]);

  const busy = isBusy(state);
  const current = shown(state);

  const begin = useCallback(() => {
    if (abort.current) return null;
    const controller = new AbortController();
    abort.current = controller;
    return controller;
  }, []);

  const onRun = useCallback(async () => {
    if (!current || isBusy(state) || !current.sql.trim()) return;
    const controller = begin();
    if (!controller) return;
    const sql = current.sql;
    let outcome: RunOutcome;
    try {
      outcome = await validateAndRun(sql, engineFor(dispatch, started), controller.signal);
    } catch (e) {
      outcome = failedRun(e);
    } finally {
      abort.current = null;
    }
    dispatch({ type: 'ran', sql, outcome });
  }, [begin, current, state]);

  const onAsk = useCallback(
    async (question: string) => {
      if (!current || isBusy(state)) return;
      const controller = begin();
      if (!controller) return;
      try {
        dispatch({ type: 'asked', outcome: await askAndRun(question, adaptersFor(dispatch, started), controller.signal) });
      } catch {
        dispatch({ type: 'asked', outcome: serviceDown });
      } finally {
        abort.current = null;
      }
    },
    [begin, current, state],
  );

  const onEdit = useCallback((sql: string) => dispatch({ type: 'edit', sql }), []);

  return (
    <main>
      <StatusBar state={state} rows={dataset?.rows ?? null} drift={dataset?.drift ?? []} />

      <QuestionBox enabled={current !== null && !busy} asking={state.phase === 'asking'} onAsk={(q) => void onAsk(q)} />

      {current && (
        <SqlEditor
          value={current.sql}
          onChange={onEdit}
          onRun={() => void onRun()}
          canRun={!busy && current.sql.trim() !== ''}
          readOnly={busy}
          verdict={
            state.phase === 'rejected' ? (
              <span className="err" role="alert">
                {state.message}
              </span>
            ) : current.validated ? (
              <span className="ok">{MESSAGES.readOnly}</span>
            ) : null
          }
        >
          {current.explained && <Explanation explained={current.explained} sql={current.sql} />}
          {state.phase === 'query_error' && (
            <p className="err" role="alert">
              {state.message}
            </p>
          )}
        </SqlEditor>
      )}

      {current && (
        <section className="panel" aria-live="polite">
          {state.phase === 'asking' && <AskingBar onCancel={() => abort.current?.abort()} />}
          {state.phase === 'running' && <RunningBar seconds={Math.max(0, now - started.current) / 1000} onCancel={() => abort.current?.abort()} />}
          {state.phase === 'stopped' && <p className="muted">{stateMessage(state)}</p>}
          {state.phase === 'cannot_answer' && (
            <p className="warn" role="alert">
              Can't answer: {state.message}
            </p>
          )}
          {state.phase === 'service_down' && (
            <p className="err" role="alert">
              {state.message}; the editor still runs hand-written SQL.
            </p>
          )}
          {(state.phase === 'ready' || state.phase === 'asking') && state.result && <ResultsTable result={state.result} />}
          {state.phase === 'ready' && !state.result && <p className="muted">Ask a question or run the SQL above.</p>}
        </section>
      )}
    </main>
  );
}

function Explanation({ explained, sql }: { explained: Explained; sql: string }) {
  const { answer, retry } = explained;
  const notes = [RETRY_NOTES[retry], sql !== answer.sql && 'SQL edited since'].filter(Boolean).join(' · ');
  return (
    <div className="why">
      {answer.rationale && (
        <p>
          <span className="muted">Why:</span> {answer.rationale}
        </p>
      )}
      <p className="muted">
        Context used: {answer.snippet_ids.length ? answer.snippet_ids.join(' · ') : 'schema only'}
        {notes && ` (${notes})`}
      </p>
    </div>
  );
}

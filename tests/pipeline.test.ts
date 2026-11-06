import { beforeAll, describe, expect, it } from 'vitest';
import { httpAsk, type SqlRequest, type SqlResponse } from '../shared/api.ts';
import { askAndRun, problemFromError, QueryStopped, validateAndRun, type Adapters, type EngineAdapters } from '../shared/pipeline.ts';
import { engineAdapters, openEngine } from './engine.ts';

let engine: EngineAdapters;
const signal = new AbortController().signal;

beforeAll(async () => {
  engine = engineAdapters(await openEngine());
});

const sql = (text: string): SqlResponse => ({ kind: 'sql', sql: text, rationale: 'r', snippet_ids: ['s'], model: 'm' });

function scripted(...answers: SqlResponse[]): { adapters: Adapters; requests: SqlRequest[] } {
  const requests: SqlRequest[] = [];
  const adapters: Adapters = {
    ...engine,
    ask: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (!next) throw new Error('no scripted answer left');
      return next;
    },
  };
  return { adapters, requests };
}

async function errorOf(text: string): Promise<string> {
  const outcome = await validateAndRun(text, engine, signal);
  if (outcome.kind !== 'query_error') throw new Error(`expected a query error, got ${outcome.kind}`);
  return outcome.message;
}

describe('problemFromError', () => {
  it('maps DuckDB errors to retry codes and names', async () => {
    expect(problemFromError(await errorOf('SELECT fare FROM trips'))).toEqual({ code: 'unknown_column', name: 'fare' });
    expect(problemFromError(await errorOf('SELECT nosuchfn(1)'))).toEqual({ code: 'unknown_function', name: 'nosuchfn' });
  });

  it('maps a qualified unknown column to unknown_column', async () => {
    const aliased = await errorOf('SELECT t.pickup_time FROM trips t');
    expect(aliased).toContain('Binder Error: Values list "t" does not have a column named "pickup_time"');
    expect(problemFromError(aliased)).toEqual({ code: 'unknown_column', name: 'pickup_time' });
    expect(problemFromError(await errorOf('SELECT trips.pickup_time FROM trips'))).toEqual({ code: 'unknown_column', name: 'pickup_time' });
  });

  it('gives no retry for other errors, which quote values', async () => {
    expect(problemFromError(await errorOf("SELECT 'a'::INT"))).toBeNull();
  });

  it('drops a name that is not a plain identifier', () => {
    expect(problemFromError('Binder Error: Referenced column "a b" not found in FROM clause!')).toEqual({ code: 'unknown_column' });
  });
});

describe('validateAndRun', () => {
  it('runs a valid query capped by the wrapper', async () => {
    const outcome = await validateAndRun('SELECT count(*)::INTEGER AS n FROM trips;', engine, signal);
    expect(outcome).toMatchObject({ kind: 'rows', result: { rows: [[2_964_606]], truncated: false } });
  });

  it('rejects before running', async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      throw new Error('ran');
    };
    const outcome = await validateAndRun('DROP VIEW trips', { ...engine, run }, signal);
    expect(outcome).toMatchObject({ kind: 'rejected', rejection: { code: 'not_select' } });
    expect(ran).toBe(false);
  });

  it('reports a stopped query as stopped, not as an error', async () => {
    const run = async () => {
      throw new QueryStopped('timeout', 'Query stopped after 30 s');
    };
    expect(await validateAndRun('SELECT 1', { ...engine, run }, signal)).toEqual({ kind: 'stopped', reason: 'timeout', message: 'Query stopped after 30 s' });
  });
});

describe('askAndRun', () => {
  it('answers without a retry when the SQL runs', async () => {
    const { adapters, requests } = scripted(sql('SELECT 1 AS one'));
    const outcome = await askAndRun('q', adapters, signal, { context: 'none' });
    expect(outcome).toMatchObject({ kind: 'answered', retried: false, run: { kind: 'rows' } });
    expect(requests).toEqual([{ question: 'q', context: 'none' }]);
  });

  it('retries once with a coded problem after a binder error', async () => {
    const { adapters, requests } = scripted(sql('SELECT avg(fare) FROM trips'), sql('SELECT avg(fare_amount) AS f FROM trips'));
    const outcome = await askAndRun('average fare', adapters, signal);
    expect(outcome).toMatchObject({ kind: 'answered', retried: true, run: { kind: 'rows' } });
    expect(requests[1]).toEqual({ question: 'average fare', previous_sql: 'SELECT avg(fare) FROM trips', problem: { code: 'unknown_column', name: 'fare' } });
  });

  it('retries once after a validator rejection and stops there', async () => {
    const { adapters, requests } = scripted(sql("SELECT * FROM read_csv('/etc/passwd')"), sql('SELECT * FROM duckdb_settings()'));
    const outcome = await askAndRun('q', adapters, signal);
    expect(outcome).toMatchObject({ kind: 'answered', retried: true, run: { kind: 'rejected', rejection: { code: 'function_blocked' } } });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.problem).toEqual({ code: 'function_blocked', name: 'read_csv' });
  });

  it('leaves a dotted table name out of the problem', async () => {
    const { adapters, requests } = scripted(sql('SELECT * FROM system.main.duckdb_settings'), sql('SELECT 1'));
    await askAndRun('q', adapters, signal);
    expect(requests[1]!.problem).toEqual({ code: 'table_not_allowed' });
  });

  it('does not retry a conversion error', async () => {
    const { adapters, requests } = scripted(sql("SELECT 'a'::INT"));
    const outcome = await askAndRun('q', adapters, signal);
    expect(outcome).toMatchObject({ kind: 'answered', retried: false, run: { kind: 'query_error', problem: null } });
    expect(requests).toHaveLength(1);
  });

  it('keeps the first answer when the retry call fails', async () => {
    const { adapters } = scripted(sql('SELECT fare FROM trips'), { error: 'upstream' });
    const outcome = await askAndRun('q', adapters, signal);
    expect(outcome).toMatchObject({ kind: 'answered', retried: true, answer: { sql: 'SELECT fare FROM trips' }, run: { kind: 'query_error' } });
  });

  it('stops as cancelled when the ask is aborted', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const adapters: Adapters = {
      ...engine,
      ask: (_request, askSignal) => {
        seen.push(askSignal);
        controller.abort();
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      },
    };
    const outcome = await askAndRun('q', adapters, controller.signal);
    expect(seen).toEqual([controller.signal]);
    expect(outcome).toEqual({ kind: 'stopped', reason: 'cancelled', message: 'Cancelled', retried: false });
  });

  it('stops as cancelled when the retry ask is aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const adapters: Adapters = {
      ...engine,
      ask: async () => {
        calls += 1;
        if (calls === 1) return sql('SELECT fare FROM trips');
        controller.abort();
        return { error: 'upstream' };
      },
    };
    const outcome = await askAndRun('q', adapters, controller.signal);
    expect(outcome).toMatchObject({ kind: 'stopped', reason: 'cancelled', retried: true });
  });

  it('httpAsk passes the abort signal to fetch', async () => {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      received = init?.signal;
      return new Response(JSON.stringify({ error: 'upstream' }));
    }) as typeof fetch;
    await httpAsk('/api/sql', fetcher)({ question: 'q' }, controller.signal);
    expect(received).toBe(controller.signal);
  });

  it('passes cannot_answer and service errors through', async () => {
    const cannot: SqlResponse = { kind: 'cannot_answer', reason: 'January only', snippet_ids: [], model: 'm' };
    expect(await askAndRun('q', scripted(cannot).adapters, signal)).toEqual({ kind: 'cannot_answer', answer: cannot, retried: false });
    expect(await askAndRun('q', scripted({ error: 'bad_model_output' }).adapters, signal)).toEqual({
      kind: 'service_error',
      answer: { error: 'bad_model_output' },
      retried: false,
    });
    const throwing: Adapters = { ...engine, ask: () => Promise.reject(new Error('offline')) };
    expect(await askAndRun('q', throwing, signal)).toMatchObject({ kind: 'service_error', answer: { error: 'upstream' } });
  });
});

import { describe, expect, it } from 'vitest';
import type { SqlAnswer } from '../shared/api.ts';
import type { AskOutcome, Result, RunOutcome } from '../shared/pipeline.ts';
import { MAX_ROWS } from '../shared/wrap.ts';
import { initialState, MESSAGES, reducer, stateMessage, type Action, type AppState } from '../src/state.ts';

const SQL = 'SELECT 1';

const result = (rows: number, truncated = false): Result => ({
  columns: [{ name: 'n', numeric: true }],
  rows: Array.from({ length: rows }, (_, i) => [i]),
  truncated,
  ms: 5,
});

const answer = (sql: string): SqlAnswer => ({ kind: 'sql', sql, rationale: 'because', snippet_ids: ['tips-not-recorded-for-cash'], model: 'm' });

const play = (...actions: Action[]) => actions.reduce(reducer, initialState);

const ready = (): AppState => play({ type: 'loaded', sql: SQL });

const ran = (outcome: RunOutcome, from: AppState = ready()) => reducer(reducer(from, { type: 'running' }), { type: 'ran', sql: SQL, outcome });

const asked = (outcome: AskOutcome, from: AppState = ready()) => reducer(reducer(from, { type: 'asking' }), { type: 'asked', outcome });

describe('AppState covers every row of the design state table', () => {
  it('Loading', () => {
    const state = play({ type: 'progress', progress: { stage: 'data', loaded: 2e6, total: 44e6 } });
    expect(state.phase).toBe('loading');
    expect(stateMessage(state)).toBe('Loading trips 2.0 / 44.0 MB');
  });

  it('Asking keeps the old SQL and results', () => {
    const before = ran({ kind: 'rows', result: result(3) });
    const state = reducer(before, { type: 'asking' });
    expect(state).toMatchObject({ phase: 'asking', sql: SQL, result: result(3) });
    expect(stateMessage(state)).toBe(MESSAGES.asking);
  });

  it('Running', () => {
    const state = reducer(ready(), { type: 'running' });
    expect(state).toMatchObject({ phase: 'running', validated: true });
    expect(stateMessage(state)).toBe(MESSAGES.running);
  });

  it('Cancelled and timed out keep the SQL', () => {
    const cancelled = ran({ kind: 'stopped', reason: 'cancelled', message: 'Cancelled' });
    const timedOut = ran({ kind: 'stopped', reason: 'timeout', message: 'Query stopped after 30 s' });
    expect(cancelled).toMatchObject({ phase: 'stopped', sql: SQL });
    expect(stateMessage(cancelled)).toBe('Cancelled');
    expect(stateMessage(timedOut)).toBe('Query stopped after 30 s');
  });

  it('Rejected shows the reason and is not marked read-only', () => {
    const state = ran({ kind: 'rejected', rejection: { code: 'not_select' }, message: 'Blocked: only a single SELECT is allowed' });
    expect(state).toMatchObject({ phase: 'rejected', sql: SQL, validated: false });
    expect(stateMessage(state)).toBe('Blocked: only a single SELECT is allowed');
  });

  it('Query error clears the results', () => {
    const before = ran({ kind: 'rows', result: result(3) });
    const state = ran({ kind: 'query_error', message: 'Conversion Error: x', problem: null }, before);
    expect(state.phase).toBe('query_error');
    expect('result' in state).toBe(false);
    expect(stateMessage(state)).toBe('Conversion Error: x');
  });

  it('Empty', () => {
    expect(stateMessage(ran({ kind: 'rows', result: result(0) }))).toBe('No rows matched');
  });

  it('Truncated', () => {
    expect(stateMessage(ran({ kind: 'rows', result: result(MAX_ROWS, true) }))).toBe('Showing the first 1,000 rows');
  });

  it('LLM cannot answer shows the reason with no SQL', () => {
    const state = asked({ kind: 'cannot_answer', answer: { kind: 'cannot_answer', reason: 'Only January 2024', snippet_ids: [], model: 'm' }, retried: false });
    expect(state).toMatchObject({ phase: 'cannot_answer', sql: '' });
    expect(stateMessage(state)).toBe('Only January 2024');
  });

  it('Worker or LLM down keeps the hand-written SQL', () => {
    const state = asked({ kind: 'service_error', answer: { error: 'upstream' }, retried: false });
    expect(state).toMatchObject({ phase: 'service_down', sql: SQL });
    expect(stateMessage(state)).toBe("Couldn't reach the SQL service");
  });
});

describe('Ask and Run', () => {
  it('an answered question shows the model SQL, its rationale and the rows', () => {
    const model = 'SELECT 2';
    const state = asked({ kind: 'answered', answer: answer(model), run: { kind: 'rows', result: result(8) }, retried: true });
    expect(state).toMatchObject({ phase: 'ready', sql: model, validated: true, explained: { answer: answer(model), retry: 'fixed' } });
    expect(stateMessage(state)).toBe('8 rows');
  });

  it('a second try that does not produce rows is not called fixed', () => {
    const rejected = asked({
      kind: 'answered',
      answer: answer('SELECT 2'),
      run: { kind: 'rejected', rejection: { code: 'not_select' }, message: 'Blocked' },
      retried: true,
    });
    const fallback = asked({ kind: 'answered', answer: answer(SQL), run: { kind: 'query_error', message: 'Binder Error', problem: null }, retried: true });
    expect(rejected).toMatchObject({ explained: { retry: 'unfixed' } });
    expect(fallback).toMatchObject({ explained: { retry: 'unfixed' } });
  });

  it('an answer without a retry carries no retry note', () => {
    const state = asked({ kind: 'answered', answer: answer(SQL), run: { kind: 'rows', result: result(1) }, retried: false });
    expect(state).toMatchObject({ explained: { retry: 'none' } });
  });

  it('a retry answer still being run is pending, not fixed', () => {
    const state = reducer(reducer(ready(), { type: 'asking' }), { type: 'answered', answer: answer('SELECT 2'), retried: true });
    expect(state).toMatchObject({ phase: 'asking', explained: { retry: 'pending' } });
  });

  it('cancelling an ask keeps the prior SQL', () => {
    const state = asked({ kind: 'stopped', reason: 'cancelled', message: 'Cancelled', retried: false });
    expect(state).toMatchObject({ phase: 'stopped', reason: 'cancelled', sql: SQL });
    expect(stateMessage(state)).toBe('Cancelled');
  });

  it('a stopped run shows the message it was stopped with', () => {
    const state = ran({ kind: 'stopped', reason: 'timeout', message: 'Query stopped after 5 s' });
    expect(state).toMatchObject({ phase: 'stopped', message: 'Query stopped after 5 s' });
    expect(stateMessage(state)).toBe('Query stopped after 5 s');
  });

  it('editing drops the read-only mark until the SQL runs again', () => {
    const state = reducer(ran({ kind: 'rows', result: result(1) }), { type: 'edit', sql: 'SELECT 3' });
    expect(state).toMatchObject({ phase: 'ready', sql: 'SELECT 3', validated: false });
  });

  it('a run of edited model SQL keeps the rationale', () => {
    const first = asked({ kind: 'answered', answer: answer(SQL), run: { kind: 'rows', result: result(1) }, retried: false });
    const state = ran({ kind: 'rows', result: result(2) }, reducer(first, { type: 'edit', sql: SQL }));
    expect(state).toMatchObject({ phase: 'ready', explained: { answer: answer(SQL) } });
  });
});

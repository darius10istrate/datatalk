import { MAX_ROWS } from '../shared/wrap';
import type { SqlAnswer } from '../shared/api';
import { STOP_MESSAGES } from '../shared/limits';
import type { AskOutcome, Result, RunOutcome, StopReason } from '../shared/pipeline';
import type { LoadProgress } from './db/progress';

export const fmt = (n: number) => n.toLocaleString('en-US');

export const MESSAGES = {
  ready: 'Ready',
  asking: 'Asking…',
  running: 'Running…',
  readOnly: '✓ read-only',
  cancelled: STOP_MESSAGES.cancelled,
  timeout: STOP_MESSAGES.timeout,
  empty: 'No rows matched',
  truncated: `Showing the first ${fmt(MAX_ROWS)} rows`,
  serviceDown: "Couldn't reach the SQL service",
  drift: 'Schema drift: trips no longer matches shared/schema.ts',
} as const;

export type { LoadProgress };

export function loadingMessage(p: LoadProgress): string {
  if (p.stage === 'engine') return 'Starting DuckDB…';
  if (p.stage === 'lock') return 'Locking the engine…';
  const mb = (n: number) => (n / 1e6).toFixed(1);
  return p.total ? `Loading trips ${mb(p.loaded)} / ${mb(p.total)} MB` : `Loading trips ${mb(p.loaded)} MB`;
}

export function resultMessage(result: Result): string {
  if (result.rows.length === 0) return MESSAGES.empty;
  if (result.truncated) return MESSAGES.truncated;
  return `${fmt(result.rows.length)} ${result.rows.length === 1 ? 'row' : 'rows'}`;
}

export type Retry = 'none' | 'pending' | 'fixed' | 'unfixed';

export type Explained = { answer: SqlAnswer; retry: Retry };

const retryOf = (retried: boolean, run: RunOutcome): Retry => (!retried ? 'none' : run.kind === 'rows' ? 'fixed' : 'unfixed');

type Shown = { sql: string; explained?: Explained; validated: boolean };

export type AppState =
  | { phase: 'loading'; progress: LoadProgress }
  | { phase: 'load_failed'; message: string }
  | ({ phase: 'ready' | 'asking' | 'running'; result?: Result } & Shown)
  | ({ phase: 'stopped'; reason: StopReason; message: string } & Shown)
  | ({ phase: 'rejected' | 'query_error' | 'cannot_answer' | 'service_down'; message: string } & Shown);

export type Phase = AppState['phase'];

export type LoadedState = Exclude<AppState, { phase: 'loading' | 'load_failed' }>;

export type Action =
  | { type: 'progress'; progress: LoadProgress }
  | { type: 'load_failed'; message: string }
  | { type: 'loaded'; sql: string }
  | { type: 'edit'; sql: string }
  | { type: 'asking' }
  | { type: 'answered'; answer: SqlAnswer; retried: boolean }
  | { type: 'running' }
  | { type: 'ran'; sql: string; outcome: RunOutcome }
  | { type: 'asked'; outcome: AskOutcome };

export const initialState: AppState = { phase: 'loading', progress: { stage: 'engine' } };

export const isBusy = (state: AppState) => state.phase === 'loading' || state.phase === 'asking' || state.phase === 'running';

export function shown(state: AppState): LoadedState | null {
  return state.phase === 'loading' || state.phase === 'load_failed' ? null : state;
}

export function stateMessage(state: AppState): string {
  switch (state.phase) {
    case 'loading':
      return loadingMessage(state.progress);
    case 'load_failed':
    case 'rejected':
    case 'query_error':
    case 'cannot_answer':
    case 'service_down':
    case 'stopped':
      return state.message;
    case 'ready':
      return state.result ? resultMessage(state.result) : MESSAGES.ready;
    case 'asking':
      return MESSAGES.asking;
    case 'running':
      return MESSAGES.running;
  }
}

function settle(base: Shown, ranSql: string, outcome: RunOutcome): AppState {
  const unchanged = base.sql === ranSql;
  switch (outcome.kind) {
    case 'rows':
      return { ...base, phase: 'ready', result: outcome.result, validated: unchanged };
    case 'stopped':
      return { ...base, phase: 'stopped', reason: outcome.reason, message: outcome.message, validated: unchanged };
    case 'rejected':
      return { ...base, phase: 'rejected', message: outcome.message, validated: false };
    case 'query_error':
      return { ...base, phase: 'query_error', message: outcome.message, validated: unchanged };
  }
}

function settleAsk(base: Shown, outcome: AskOutcome): AppState {
  switch (outcome.kind) {
    case 'answered': {
      const sql = outcome.answer.sql;
      return settle({ sql, explained: { answer: outcome.answer, retry: retryOf(outcome.retried, outcome.run) }, validated: false }, sql, outcome.run);
    }
    case 'cannot_answer':
      return { phase: 'cannot_answer', sql: '', message: outcome.answer.reason, validated: false };
    case 'service_error':
      return { ...base, phase: 'service_down', message: MESSAGES.serviceDown };
    case 'stopped':
      return { ...base, phase: 'stopped', reason: outcome.reason, message: outcome.message };
  }
}

const keep = ({ sql, explained, validated }: Shown): Shown => (explained ? { sql, explained, validated } : { sql, validated });

export function reducer(state: AppState, action: Action): AppState {
  if (action.type === 'progress') return state.phase === 'loading' ? { phase: 'loading', progress: action.progress } : state;
  if (action.type === 'load_failed') return { phase: 'load_failed', message: action.message };
  if (action.type === 'loaded') return state.phase === 'loading' ? { phase: 'ready', sql: action.sql, validated: false } : state;

  const loaded = shown(state);
  if (!loaded) return state;
  const current = keep(loaded);

  switch (action.type) {
    case 'edit':
      return action.sql === loaded.sql ? loaded : { ...loaded, sql: action.sql, validated: false };
    case 'asking':
      return loaded.phase === 'ready' && loaded.result ? { ...current, phase: 'asking', result: loaded.result } : { ...current, phase: 'asking' };
    case 'answered':
      return { phase: 'asking', sql: action.answer.sql, explained: { answer: action.answer, retry: action.retried ? 'pending' : 'none' }, validated: false };
    case 'running':
      return { ...current, phase: 'running', validated: true };
    case 'ran':
      return settle(current, action.sql, action.outcome);
    case 'asked':
      return settleAsk(current, action.outcome);
  }
}

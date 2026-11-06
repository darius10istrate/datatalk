import {
  MAX_PREVIOUS_SQL_LENGTH,
  problemOf,
  type CannotAnswer,
  type Context,
  type Problem,
  type ServiceError,
  type SqlAnswer,
  type SqlRequest,
  type SqlResponse,
} from './api.ts';
import type { Cell } from './cells.ts';
import { STOP_MESSAGES } from './limits.ts';
import { message, validate, type Rejection } from './validate.ts';

export type ResultColumn = { name: string; numeric: boolean };

export type Result = { columns: ResultColumn[]; rows: Cell[][]; truncated: boolean; ms: number };

export type StopReason = 'cancelled' | 'timeout';

export class QueryStopped extends Error {
  constructor(
    readonly reason: StopReason,
    text: string,
  ) {
    super(text);
    this.name = 'QueryStopped';
  }
}

export type Adapters = {
  ask(request: SqlRequest, signal: AbortSignal): Promise<SqlResponse>;
  serialize(sql: string): Promise<unknown> | unknown;
  run(sql: string, signal: AbortSignal): Promise<Result>;
};

export type EngineAdapters = Pick<Adapters, 'serialize' | 'run'>;

export type RunOutcome =
  | { kind: 'rows'; result: Result }
  | { kind: 'rejected'; rejection: Rejection; message: string }
  | { kind: 'query_error'; message: string; problem: Problem | null }
  | { kind: 'stopped'; reason: StopReason; message: string };

export type AskOutcome =
  | { kind: 'answered'; answer: SqlAnswer; run: RunOutcome; retried: boolean }
  | { kind: 'cannot_answer'; answer: CannotAnswer; retried: boolean }
  | { kind: 'service_error'; answer: ServiceError; retried: boolean }
  | { kind: 'stopped'; reason: 'cancelled'; message: string; retried: boolean };

const ERROR_PROBLEMS: readonly [RegExp, (match: RegExpMatchArray) => Problem][] = [
  [/Referenced column "([^"]*)" not found/, (m) => problemOf('unknown_column', m[1])],
  [/does not have a column named "([^"]*)"/, (m) => problemOf('unknown_column', m[1])],
  [/Scalar Function with name (\S+) does not exist/, (m) => problemOf('unknown_function', m[1])],
];

export function problemFromError(text: string): Problem | null {
  for (const [pattern, toProblem] of ERROR_PROBLEMS) {
    const match = text.match(pattern);
    if (match) return toProblem(match);
  }
  return null;
}

export function problemFromRejection(r: Rejection): Problem {
  return 'name' in r ? problemOf(r.code, r.name) : problemOf(r.code);
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function validateAndRun(sql: string, adapters: EngineAdapters, signal: AbortSignal): Promise<RunOutcome> {
  const verdict = await validate(sql, async (s) => adapters.serialize(s));
  if (!verdict.ok) return { kind: 'rejected', rejection: verdict.rejection, message: message(verdict.rejection) };
  try {
    return { kind: 'rows', result: await adapters.run(verdict.run, signal) };
  } catch (e) {
    if (e instanceof QueryStopped) return { kind: 'stopped', reason: e.reason, message: e.message };
    const text = errorText(e);
    return { kind: 'query_error', message: text, problem: problemFromError(text) };
  }
}

export function retryProblem(run: RunOutcome): Problem | null {
  if (run.kind === 'rejected') return problemFromRejection(run.rejection);
  if (run.kind === 'query_error') return run.problem;
  return null;
}

async function safeAsk(adapters: Adapters, request: SqlRequest, signal: AbortSignal): Promise<SqlResponse> {
  try {
    return await adapters.ask(request, signal);
  } catch {
    return { error: 'upstream' };
  }
}

function notAnswered(answer: CannotAnswer | ServiceError, retried: boolean): AskOutcome {
  return 'error' in answer ? { kind: 'service_error', answer, retried } : { kind: 'cannot_answer', answer, retried };
}

const cancelledAsk = (retried: boolean): AskOutcome => ({ kind: 'stopped', reason: 'cancelled', message: STOP_MESSAGES.cancelled, retried });

export type AskOptions = { context?: Context };

export async function askAndRun(question: string, adapters: Adapters, signal: AbortSignal, options: AskOptions = {}): Promise<AskOutcome> {
  const request: SqlRequest = options.context ? { question, context: options.context } : { question };
  const first = await safeAsk(adapters, request, signal);
  if (signal.aborted) return cancelledAsk(false);
  if (!('kind' in first) || first.kind !== 'sql') return notAnswered(first, false);

  const firstRun = await validateAndRun(first.sql, adapters, signal);
  const problem = retryProblem(firstRun);
  if (!problem || signal.aborted || first.sql.length > MAX_PREVIOUS_SQL_LENGTH)
    return { kind: 'answered', answer: first, run: firstRun, retried: false };

  const second = await safeAsk(adapters, { ...request, previous_sql: first.sql, problem }, signal);
  if (signal.aborted) return cancelledAsk(true);
  if (!('kind' in second) || second.kind !== 'sql') {
    if ('kind' in second) return notAnswered(second, true);
    return { kind: 'answered', answer: first, run: firstRun, retried: true };
  }
  return { kind: 'answered', answer: second, run: await validateAndRun(second.sql, adapters, signal), retried: true };
}

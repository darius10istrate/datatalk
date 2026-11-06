export const SQL_ENDPOINT = '/api/sql';

export const MAX_QUESTION_LENGTH = 500;
export const MAX_PREVIOUS_SQL_LENGTH = 4_000;
export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export const CONTEXTS = ['none', 'all', 'top4'] as const;
export type Context = (typeof CONTEXTS)[number];
export const DEFAULT_CONTEXT: Context = 'top4';

export const RETRY_CODES = [
  'not_select',
  'multi_statement',
  'table_not_allowed',
  'function_blocked',
  'unknown_column',
  'unknown_function',
  'syntax',
] as const;
export type RetryCode = (typeof RETRY_CODES)[number];

export type Problem = { code: RetryCode; name?: string };

export type SqlRequest = {
  question: string;
  context?: Context;
  previous_sql?: string;
  problem?: Problem;
};

export type SqlAnswer = { kind: 'sql'; sql: string; rationale: string; snippet_ids: string[]; model: string };
export type CannotAnswer = { kind: 'cannot_answer'; reason: string; snippet_ids: string[]; model: string };
export const SERVICE_ERRORS = ['bad_request', 'bad_model_output', 'upstream'] as const;
export type ServiceError = { error: (typeof SERVICE_ERRORS)[number] };

export type SqlResponse = SqlAnswer | CannotAnswer | ServiceError;

export const isContext = (value: unknown): value is Context => CONTEXTS.includes(value as Context);

export const isServiceError = (value: unknown): value is ServiceError['error'] => SERVICE_ERRORS.includes(value as ServiceError['error']);

export const isRetryCode = (value: unknown): value is RetryCode => RETRY_CODES.includes(value as RetryCode);

export const isName = (value: unknown): value is string => typeof value === 'string' && NAME_PATTERN.test(value);

export const problemOf = (code: RetryCode, name?: string): Problem => (isName(name) ? { code, name } : { code });

export type Fields = Record<string, unknown>;

export const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

export function parseSqlResponse(body: unknown): SqlResponse | null {
  if (!isFields(body)) return null;
  if (isServiceError(body.error)) return { error: body.error };
  if (!isStringArray(body.snippet_ids) || typeof body.model !== 'string') return null;
  const { snippet_ids, model } = body;
  if (body.kind === 'sql' && typeof body.sql === 'string' && typeof body.rationale === 'string')
    return { kind: 'sql', sql: body.sql, rationale: body.rationale, snippet_ids, model };
  if (body.kind === 'cannot_answer' && typeof body.reason === 'string') return { kind: 'cannot_answer', reason: body.reason, snippet_ids, model };
  return null;
}

export function httpAsk(endpoint: string, fetcher: typeof fetch = fetch): (request: SqlRequest, signal?: AbortSignal) => Promise<SqlResponse> {
  return async (request, signal) => {
    try {
      const res = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: signal ?? null,
      });
      return parseSqlResponse(await res.json()) ?? { error: 'upstream' };
    } catch {
      return { error: 'upstream' };
    }
  };
}

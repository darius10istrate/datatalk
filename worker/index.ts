import {
  DEFAULT_CONTEXT,
  isContext,
  isFields,
  isName,
  isRetryCode,
  MAX_PREVIOUS_SQL_LENGTH,
  MAX_QUESTION_LENGTH,
  SQL_ENDPOINT,
  type Fields,
  type ServiceError,
  type SqlRequest,
  type SqlResponse,
} from '../shared/api.ts';
import { complete, DEFAULT_MODEL } from './openrouter.ts';
import { buildMessages, type ChatMessage } from './prompt.ts';
import { selectSnippets } from './retrieve.ts';

export type Env = {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_PROVIDER?: string;
};

const MAX_BODY_BYTES = 16_384;
const REQUEST_KEYS = new Set(['question', 'context', 'previous_sql', 'problem']);
const PROBLEM_KEYS = new Set(['code', 'name']);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const STATUS: Record<ServiceError['error'], number> = {
  bad_request: 400,
  bad_model_output: 502,
  upstream: 502,
};

const reply = (body: SqlResponse) => json(body, 'error' in body ? STATUS[body.error] : 200);

const onlyKeys = (value: Fields, allowed: ReadonlySet<string>) => Object.keys(value).every((k) => allowed.has(k));

export function parseSqlRequest(body: unknown): SqlRequest | null {
  if (!isFields(body) || !onlyKeys(body, REQUEST_KEYS)) return null;
  const { question, context, previous_sql, problem } = body;
  if (typeof question !== 'string' || question.trim() === '' || question.length > MAX_QUESTION_LENGTH) return null;
  if (context !== undefined && !isContext(context)) return null;
  const request: SqlRequest = { question: question.trim(), context: context ?? DEFAULT_CONTEXT };
  if (previous_sql === undefined && problem === undefined) return request;
  if (typeof previous_sql !== 'string' || previous_sql.trim() === '' || previous_sql.length > MAX_PREVIOUS_SQL_LENGTH) return null;
  if (!isFields(problem) || !onlyKeys(problem, PROBLEM_KEYS) || !isRetryCode(problem.code)) return null;
  if (problem.name !== undefined && !isName(problem.name)) return null;
  return {
    ...request,
    previous_sql,
    problem: problem.name === undefined ? { code: problem.code } : { code: problem.code, name: problem.name },
  };
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function logPrompt(messages: readonly ChatMessage[]): void {
  if (!import.meta.env?.DEV) return;
  console.log(`[api/sql] prompt\n${messages.map((m) => `--- ${m.role}\n${m.content}`).join('\n')}`);
}

export async function answer(request: SqlRequest, env: Env): Promise<SqlResponse> {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return { error: 'upstream' };
  const snippets = selectSnippets(request.question, request.context ?? DEFAULT_CONTEXT);
  const snippet_ids = snippets.map((s) => s.id);
  const messages = buildMessages(request, snippets);
  logPrompt(messages);
  const completion = await complete(messages, {
    apiKey,
    model: env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL,
    provider: env.OPENROUTER_PROVIDER?.trim() || undefined,
  });
  if (!completion.ok) return { error: completion.error };
  const { answer: a, model } = completion;
  return a.kind === 'sql'
    ? { kind: 'sql', sql: a.sql, rationale: a.rationale, snippet_ids, model }
    : { kind: 'cannot_answer', reason: a.reason, snippet_ids, model };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
    if (pathname === SQL_ENDPOINT) {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const parsed = parseSqlRequest(await readJson(request));
      if (!parsed) return reply({ error: 'bad_request' });
      return reply(await answer(parsed, env));
    }
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

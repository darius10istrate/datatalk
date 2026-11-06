import { isFields, type ServiceError } from '../shared/api.ts';
import type { ChatMessage } from './prompt.ts';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_MODEL = 'google/gemini-3.7-flash';
const TIMEOUT_MS = 60_000;

export type ModelAnswer = { kind: 'sql'; sql: string; rationale: string } | { kind: 'cannot_answer'; reason: string };

export type Completion = { ok: true; answer: ModelAnswer; model: string } | { ok: false; error: Exclude<ServiceError['error'], 'bad_request'> };

export type OpenRouterConfig = { apiKey: string; model: string; provider?: string };

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['sql', 'cannot_answer'] },
    sql: { type: 'string' },
    rationale: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['kind', 'sql', 'rationale', 'reason'],
  additionalProperties: false,
} as const;

export function requestBody(messages: readonly ChatMessage[], config: OpenRouterConfig) {
  return {
    model: config.model,
    messages,
    temperature: 0,
    response_format: { type: 'json_schema', json_schema: { name: 'sql_answer', strict: true, schema: ANSWER_SCHEMA } },
    provider: config.provider
      ? { require_parameters: true, order: [config.provider], allow_fallbacks: false }
      : { require_parameters: true },
  };
}

const filled = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

export function parseAnswer(content: unknown): ModelAnswer | null {
  if (typeof content !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isFields(parsed)) return null;
  if (parsed.kind === 'sql' && filled(parsed.sql) && typeof parsed.rationale === 'string')
    return { kind: 'sql', sql: parsed.sql, rationale: parsed.rationale.trim() };
  if (parsed.kind === 'cannot_answer' && filled(parsed.reason)) return { kind: 'cannot_answer', reason: parsed.reason.trim() };
  return null;
}

function messageContent(body: unknown): unknown {
  if (!isFields(body) || !Array.isArray(body.choices)) return undefined;
  const [choice] = body.choices as unknown[];
  if (!isFields(choice) || !isFields(choice.message)) return undefined;
  return choice.message.content;
}

function logFailure(detail: string): void {
  if (!import.meta.env?.DEV) return;
  console.error(`[api/sql] OpenRouter ${detail}`);
}

const responseText = (res: Response) => res.text().catch(() => '');

export async function complete(messages: readonly ChatMessage[], config: OpenRouterConfig): Promise<Completion> {
  let body: unknown;
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody(messages, config)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logFailure(`HTTP ${res.status}: ${await responseText(res)}`);
      return { ok: false, error: 'upstream' };
    }
    body = await res.json();
  } catch (e) {
    logFailure(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, error: 'upstream' };
  }
  if (isFields(body) && body.error !== undefined) {
    logFailure(`error: ${JSON.stringify(body.error)}`);
    return { ok: false, error: 'upstream' };
  }
  const answer = parseAnswer(messageContent(body));
  if (!answer) return { ok: false, error: 'bad_model_output' };
  const model = isFields(body) && typeof body.model === 'string' ? body.model : config.model;
  return { ok: true, answer, model };
}

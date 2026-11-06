import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RETRY_CODES, type RetryCode } from '../../shared/api.ts';
import { COLUMNS } from '../../shared/schema.ts';
import worker, { type Env } from '../../worker/index.ts';
import { OPENROUTER_URL } from '../../worker/openrouter.ts';
import { RETRY_TEMPLATES } from '../../worker/prompt.ts';

const ENV: Env = { OPENROUTER_API_KEY: 'test-key', OPENROUTER_MODEL: 'test/model' };

type Sent = { url: string; body: Record<string, unknown>; headers: Headers };

let sent: Sent[] = [];
let upstream: () => Response;

const completion = (content: unknown, model = 'test/model-served') =>
  new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content } }] }), {
    headers: { 'content-type': 'application/json' },
  });

const answerJson = (fields: Record<string, string>) => JSON.stringify({ sql: '', rationale: '', reason: '', ...fields });

beforeEach(() => {
  sent = [];
  upstream = () => completion(answerJson({ kind: 'sql', sql: 'SELECT 1', rationale: 'because' }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
    return upstream();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function post(body: unknown, env: Env = ENV): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request('http://localhost/api/sql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const res = await worker.fetch(request, env);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

type Message = { role: string; content: string };

const messagesOf = (s: Sent) => s.body.messages as Message[];

describe('POST /api/sql', () => {
  it('returns SQL, rationale, snippet ids and the served model', async () => {
    const { status, json } = await post({ question: 'average tip by borough' });
    expect(status).toBe(200);
    expect(json).toEqual({
      kind: 'sql',
      sql: 'SELECT 1',
      rationale: 'because',
      snippet_ids: expect.arrayContaining(['tips-not-recorded-for-cash']),
      model: 'test/model-served',
    });
  });

  it('asks OpenRouter for strict JSON at temperature 0 from endpoints that honour it', async () => {
    await post({ question: 'average tip by borough' }, { ...ENV, OPENROUTER_PROVIDER: 'TestProvider' });
    expect(sent).toHaveLength(1);
    const [call] = sent;
    expect(call!.url).toBe(OPENROUTER_URL);
    expect(call!.headers.get('authorization')).toBe('Bearer test-key');
    expect(call!.body).toMatchObject({
      model: 'test/model',
      temperature: 0,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      provider: { require_parameters: true, order: ['TestProvider'], allow_fallbacks: false },
    });
  });

  it('passes cannot_answer through with its reason', async () => {
    upstream = () => completion(answerJson({ kind: 'cannot_answer', reason: 'The data covers January 2024 only.' }));
    const { status, json } = await post({ question: 'How many trips were there in March?' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ kind: 'cannot_answer', reason: 'The data covers January 2024 only.' });
  });

  it('sends the schema and the retrieved snippets, and context none sends no snippets', async () => {
    await post({ question: 'average tip by borough' });
    await post({ question: 'average tip by borough', context: 'none' });
    const [top4, none] = sent.map((s) => messagesOf(s)[0]!.content);
    for (const c of COLUMNS) expect(top4).toContain(c.name);
    expect(top4).toContain('[tips-not-recorded-for-cash]');
    expect(none).not.toContain('[tips-not-recorded-for-cash]');
  });
});

describe('malformed model output', () => {
  it.each([
    ['not JSON', 'SELECT 1'],
    ['JSON that breaks the schema', JSON.stringify({ kind: 'sql' })],
    ['an empty SQL string', answerJson({ kind: 'sql', sql: '  ', rationale: 'r' })],
    ['an unknown kind', answerJson({ kind: 'table', sql: 'SELECT 1' })],
    ['cannot_answer without a reason', answerJson({ kind: 'cannot_answer' })],
    ['no content at all', null],
  ])('%s → bad_model_output', async (_label, content) => {
    upstream = () => completion(content);
    const { status, json } = await post({ question: 'average tip by borough' });
    expect(status).toBe(502);
    expect(json).toEqual({ error: 'bad_model_output' });
  });

  it('a response with no choices → bad_model_output', async () => {
    upstream = () => new Response(JSON.stringify({ model: 'x' }));
    expect((await post({ question: 'q' })).json).toEqual({ error: 'bad_model_output' });
  });
});

describe('upstream failures', () => {
  it('an HTTP error from OpenRouter → upstream', async () => {
    upstream = () => new Response('{"error":{"message":"rate limited"}}', { status: 429 });
    expect(await post({ question: 'q' })).toEqual({ status: 502, json: { error: 'upstream' } });
  });

  it('a missing API key → upstream, without calling OpenRouter', async () => {
    expect(await post({ question: 'q' }, { OPENROUTER_API_KEY: '' })).toEqual({ status: 502, json: { error: 'upstream' } });
    expect(sent).toHaveLength(0);
  });
});

describe('request checks', () => {
  const retry = { question: 'q', previous_sql: 'SELECT fare FROM trips', problem: { code: 'unknown_column', name: 'fare' } };

  it.each([
    ['a body that is not JSON', '{'],
    ['no question', {}],
    ['an empty question', { question: '   ' }],
    ['a question over 500 characters', { question: 'x'.repeat(501) }],
    ['an unknown field', { question: 'q', rows: [[1]] }],
    ['an unknown context', { question: 'q', context: 'top10' }],
    ['an unknown problem code', { ...retry, problem: { code: 'too_slow' } }],
    ['a problem with free text', { ...retry, problem: { code: 'syntax', message: 'Parser Error: …' } }],
    ['a name with spaces', { ...retry, problem: { code: 'unknown_column', name: 'fare amount' } }],
    ['a name that quotes a value', { ...retry, problem: { code: 'unknown_column', name: "x'; DROP" } }],
    ['a name over 64 characters', { ...retry, problem: { code: 'unknown_column', name: `a${'b'.repeat(64)}` } }],
    ['previous_sql over 4,000 characters', { ...retry, previous_sql: `SELECT ${'1'.repeat(4_000)}` }],
    ['previous_sql without a problem', { question: 'q', previous_sql: 'SELECT 1' }],
    ['a problem without previous_sql', { question: 'q', problem: { code: 'syntax' } }],
  ])('%s → bad_request', async (_label, body) => {
    expect(await post(body)).toEqual({ status: 400, json: { error: 'bad_request' } });
    expect(sent).toHaveLength(0);
  });

  it('accepts a retry at the limits', async () => {
    const body = { ...retry, previous_sql: 'S'.repeat(4_000), problem: { code: 'unknown_column', name: `a${'b'.repeat(63)}` } };
    expect((await post(body)).status).toBe(200);
  });

  it('answers GET with 405 and other paths with 404', async () => {
    expect((await worker.fetch(new Request('http://localhost/api/sql'), ENV)).status).toBe(405);
    expect((await worker.fetch(new Request('http://localhost/api/other'), ENV)).status).toBe(404);
  });
});

describe('retry prompt', () => {
  const columnList = COLUMNS.map((c) => c.name).join(', ');

  it.each(RETRY_CODES.map((code) => [code] as const))('%s: the retry message is template text and column names only', async (code: RetryCode) => {
    const name = code === 'unknown_column' ? 'fare' : code === 'function_blocked' ? 'read_csv' : undefined;
    const previous = "SELECT fare FROM trips WHERE pickup_zone = 'JFK Airport'";
    const problem = name ? { code, name } : { code };
    await post({ question: 'average fare', previous_sql: previous, problem });

    const messages = messagesOf(sent[0]!);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(messages[1]!.content).toBe('average fare');
    expect(JSON.parse(messages[2]!.content)).toEqual({ kind: 'sql', sql: previous, rationale: '', reason: '' });

    const retryText = messages[3]!.content;
    expect(retryText).toBe(`${RETRY_TEMPLATES[code](name)} Valid columns: ${columnList}. Answer the original question again.`);
    expect(retryText).not.toContain('JFK Airport');
    const withoutKnownParts = retryText.replace(RETRY_TEMPLATES[code](name), '').replace(columnList, '');
    expect(withoutKnownParts).toBe(' Valid columns: . Answer the original question again.');
  });
});

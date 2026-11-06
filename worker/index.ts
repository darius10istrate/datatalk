export type Env = {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_PROVIDER?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/health' && request.method === 'GET') return json({ ok: true });
    return json({ error: 'not_found' }, 404);
  },
} satisfies ExportedHandler<Env>;

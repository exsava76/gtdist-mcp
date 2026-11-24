import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { createHttpApi } from '../src/http-api.ts';
import { runLocal } from '../src/local.ts';
import { VERSION } from '../src/version.ts';

type Seen = { url: string; init: RequestInit };

function fakeFetch(answer: (n: number) => Response | Error) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const a = answer(seen.length);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { f, seen };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('HTTP CallApi (local mode)', () => {
  it('reads with the key, user agent and query, without an idempotency key', async () => {
    const { f, seen } = fakeFetch(() => json(200, { items: [] }));
    const api = createHttpApi({ baseUrl: 'https://example.test/', token: 'sm_pat_x', fetch: f });
    const res = await api({
      method: 'GET',
      path: '/v1/inbox',
      query: { limit: 5, cursor: undefined },
    });
    expect(res).toEqual({ status: 200, body: { items: [] } });
    expect(seen[0]?.url).toBe('https://example.test/v1/inbox?limit=5');
    const h = seen[0]?.init.headers as Record<string, string>;
    expect(h['authorization']).toBe('Bearer sm_pat_x');
    expect(h['user-agent']).toBe(`gtdist-mcp/${VERSION}`);
    expect(h['idempotency-key']).toBeUndefined();
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('writes JSON with an idempotency key and retries a dropped connection once with it', async () => {
    const { f, seen } = fakeFetch((n) =>
      n === 1 ? new TypeError('fetch failed') : json(201, { audit_id: 'a' }),
    );
    const api = createHttpApi({ token: 'sm_pat_x', fetch: f });
    const res = await api({ method: 'POST', path: '/v1/inbox', body: { title: 'x' } });
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe('https://task.gtdist.app/v1/inbox');
    const k1 = (seen[0]?.init.headers as Record<string, string>)['idempotency-key'];
    const k2 = (seen[1]?.init.headers as Record<string, string>)['idempotency-key'];
    expect(k1).toMatch(/^[0-9a-f-]{36}$/);
    expect(k2).toBe(k1);
    expect(seen[0]?.init.body).toBe('{"title":"x"}');
  });

  it('turns network failures and timeouts into readable problems without the key', async () => {
    const down = createHttpApi({
      token: 'sm_pat_secret',
      fetch: fakeFetch(() => new TypeError('fetch failed')).f,
    });
    const res = await down({ method: 'GET', path: '/v1/inbox' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('sm_pat_secret');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const slow = createHttpApi({
      token: 't',
      fetch: fakeFetch(() => timeout).f,
      timeoutMs: 30_000,
    });
    const r2 = await slow({ method: 'GET', path: '/v1/inbox' });
    expect(r2.status).toBe(504);
    expect(JSON.stringify(r2.body)).toContain('30 s');
  });

  it('reports a body that breaks off mid-read as a network problem', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new TypeError('socket hang up'));
          },
        }),
        { status: 200 },
      );
    const { f } = fakeFetch(broken);
    const api = createHttpApi({ baseUrl: 'https://example.test', token: 'sm_pat_x', fetch: f });
    const res = await api({ method: 'GET', path: '/v1/inbox' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('sm_pat_x');
  });

  it('keeps a non-JSON error page readable', async () => {
    const { f } = fakeFetch(() => new Response('Bad gateway', { status: 502 }));
    const res = await createHttpApi({ token: 't', fetch: f })({ method: 'GET', path: '/v1/inbox' });
    expect(res).toEqual({ status: 502, body: { title: 'Bad gateway' } });
  });
});

describe('local stdio mode', () => {
  const io = () => {
    const stderr = new PassThrough();
    let err = '';
    stderr.on('data', (c) => (err += String(c)));
    return { io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr }, err: () => err };
  };

  it('refuses to start without GTDIST_TOKEN and says how to get one', async () => {
    const t = io();
    expect(await runLocal({}, t.io)).toBe(1);
    expect(t.err()).toContain('GTDIST_TOKEN');
    expect(t.err()).toContain('Personal keys');
  });

  it('refuses plain http to a remote host, so the key is never sent unencrypted', async () => {
    const t = io();
    expect(
      await runLocal({ GTDIST_TOKEN: 'sm_pat_x', GTDIST_URL: 'http://example.test' }, t.io),
    ).toBe(1);
    expect(t.err()).toContain('https');
    expect(t.err()).not.toContain('sm_pat_x');
  });

  it('refuses a malformed GTDIST_URL', async () => {
    const t = io();
    expect(await runLocal({ GTDIST_TOKEN: 'sm_pat_x', GTDIST_URL: 'not a url' }, t.io)).toBe(1);
    expect(t.err()).toContain('GTDIST_URL');
  });

  it('answers initialize over stdio with a token', async () => {
    const t = io();
    expect(await runLocal({ GTDIST_TOKEN: 'sm_pat_x' }, t.io)).toBeNull();
    let out = '';
    t.io.stdout.on('data', (c) => (out += String(c)));
    t.io.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 50));
    const msg = JSON.parse(out.split('\n')[0] ?? '{}');
    expect(msg.result.serverInfo.version).toBe(VERSION);
    expect(msg.result.capabilities.prompts).toBeDefined();
    expect(out).not.toContain('sm_pat_x');
  });
});

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, withQuery, type ApiRequest, type ApiResponse } from '../src/index.ts';

const ID = '01890a5d-ac96-774b-bcce-b302099a8057';

/** An MCP client against the server with a scripted REST API that records every call. */
async function setup(reply: (req: ApiRequest) => ApiResponse = () => ({ status: 200, body: {} })) {
  const calls: ApiRequest[] = [];
  const server = createMcpServer(async (req) => {
    calls.push(req);
    return reply(req);
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  return { client, calls };
}

type Result = { isError?: boolean; content: { text?: string }[] };
const text = (r: unknown) => (r as Result).content.map((c) => c.text ?? '').join('\n');

describe('tools map onto REST', () => {
  it.each([
    ['capture', { title: 'Купить хлеб' }, 'POST', '/v1/inbox', { title: 'Купить хлеб' }],
    ['list_inbox', { limit: 5 }, 'GET', '/v1/inbox?limit=5', undefined],
    [
      'clarify_item',
      { id: ID, to: 'someday', dry_run: true },
      'POST',
      `/v1/inbox/${ID}/clarify?dry_run=true`,
      { to: 'someday' },
    ],
    [
      'get_next_actions',
      { place: [ID, ID], minutes: 20, energy: 'low' },
      'GET',
      `/v1/now?place=${encodeURIComponent(`${ID},${ID}`)}&minutes=20&energy=low`,
      undefined,
    ],
    ['create_action', { title: 'Позвонить' }, 'POST', '/v1/actions', { title: 'Позвонить' }],
    [
      'update_action',
      { id: ID, status: 'someday' },
      'PATCH',
      `/v1/actions/${ID}?dry_run=false`,
      { status: 'someday' },
    ],
    ['complete_action', { id: ID }, 'POST', `/v1/actions/${ID}/complete?dry_run=false`, undefined],
    ['list_projects', { status: 'active' }, 'GET', '/v1/projects?status=active', undefined],
    ['find_stuck_projects', {}, 'GET', '/v1/projects?stuck=true', undefined],
    ['list_waiting', { older_than_days: 7 }, 'GET', '/v1/waiting?older_than=7d', undefined],
    ['list_contexts', { type: 'person' }, 'GET', '/v1/contexts?type=person', undefined],
    [
      'set_current_context',
      { context_ids: [ID] },
      'PUT',
      '/v1/contexts/current',
      { context_ids: [ID] },
    ],
    ['get_agenda', { person_id: ID }, 'GET', `/v1/people/${ID}/agenda`, undefined],
    ['start_weekly_review', {}, 'GET', '/v1/review/weekly', undefined],
    ['review_step', { n: 3 }, 'POST', '/v1/review/steps/3', undefined],
    ['search', { q: 'ёлка' }, 'GET', `/v1/search?q=${encodeURIComponent('ёлка')}`, undefined],
    [
      'list_done',
      { from: '2026-09-21', to: '2026-09-27' },
      'GET',
      '/v1/done?from=2026-09-21&to=2026-09-27',
      undefined,
    ],
    ['undo', { audit_id: ID }, 'POST', `/v1/audit/${ID}/undo?dry_run=false`, undefined],
    ['assign_item', { id: ID, user_id: ID }, 'POST', `/v1/items/${ID}/assign`, { user_id: ID }],
    [
      'add_comment',
      { item_id: ID, body: 'Когда?', mentions: [ID] },
      'POST',
      `/v1/items/${ID}/comments`,
      { body: 'Когда?', mentions: [ID] },
    ],
    ['list_assigned_to_me', { state: 'pending' }, 'GET', '/v1/assigned?state=pending', undefined],
  ])('%s', async (name, args, method, url, body) => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, text(res)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(method);
    expect(withQuery(calls[0]!.path, calls[0]!.query)).toBe(url);
    expect(calls[0]?.body).toEqual(body);
  });

  it('get_horizons reads areas with their project folders, and goals', async () => {
    const { client, calls } = await setup((req) =>
      req.path === '/v1/areas'
        ? { status: 200, body: { items: [{ id: 'a' }], folders: [{ id: 'f', area_id: 'a' }] } }
        : { status: 200, body: { items: [{ id: 'g' }], links: [] } },
    );
    const res = await client.callTool({ name: 'get_horizons', arguments: {} });
    expect(calls.map((c) => c.path)).toEqual(['/v1/areas', '/v1/goals']);
    expect(JSON.parse(text(res))).toEqual({
      areas: [{ id: 'a' }],
      project_folders: [{ id: 'f', area_id: 'a' }],
      goals: [{ id: 'g' }],
      goal_links: [],
    });
  });

  it('draft_reminder only reads and returns a draft', async () => {
    const { client, calls } = await setup((req) =>
      req.path === '/v1/waiting'
        ? {
            status: 200,
            body: {
              items: [
                { id: ID, title: 'Счёт', waiting_person_id: 'p1', waiting_since: '2026-09-01' },
              ],
              next_cursor: null,
            },
          }
        : { status: 200, body: { items: [{ id: 'p1', name: 'Иван' }] } },
    );
    const res = await client.callTool({
      name: 'draft_reminder',
      arguments: { waiting_id: ID, tone: 'formal' },
    });
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(text(res)).toContain('Иван, добрый день!');
    expect(text(res)).toContain('«Счёт»');
  });

  it('turns API refusals into tool errors with the problem text', async () => {
    const { client } = await setup(() => ({
      status: 403,
      body: { type: 'forbidden', title: 'Not allowed', detail: 'Token lacks the "review" scope' },
    }));
    const res = await client.callTool({ name: 'clarify_item', arguments: { id: ID, to: 'trash' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Error 403 [forbidden] — Not allowed: Token lacks the "review" scope');
  });

  it('describes what a write changed and how to undo it', async () => {
    const { client } = await setup(() => ({
      status: 200,
      body: { audit_id: ID, dry_run: false, items: [{ entity: 'item', id: 'x', status: 'next' }] },
    }));
    const res = await client.callTool({ name: 'clarify_item', arguments: { id: ID, to: 'next' } });
    expect(text(res)).toContain('Saved. Changed:\n- item x: status = "next"');
    expect(text(res)).toContain(`audit_id: ${ID}`);
  });

  it('rejects ids that are not UUIDs before calling the API', async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({
      name: 'get_agenda',
      arguments: { person_id: '../../v1/tokens' },
    });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('marks read-only and destructive tools', async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('list_inbox')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('clarify_item')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('draft_reminder')?.annotations?.readOnlyHint).toBe(true);
    for (const t of tools) expect(t.description?.length ?? 0).toBeGreaterThan(20);
  });
});

describe('GTD coverage tools map onto REST', () => {
  it.each([
    [
      'parse_to_inbox',
      { text: 'купить хлеб, позвонить маме' },
      'POST',
      '/v1/inbox/parse',
      { text: 'купить хлеб, позвонить маме' },
    ],
    [
      'list_actions',
      { status: 'next', project_id: ID, limit: 10 },
      'GET',
      `/v1/actions?status=next&project_id=${ID}&limit=10`,
      undefined,
    ],
    ['get_item', { id: ID }, 'GET', `/v1/actions/${ID}`, undefined],
    [
      'create_project',
      { title: 'Ремонт', first_action: { title: 'Вызвать замерщика' } },
      'POST',
      '/v1/projects',
      { title: 'Ремонт', first_action: { title: 'Вызвать замерщика' } },
    ],
    [
      'update_project',
      { id: ID, status: 'someday' },
      'PATCH',
      `/v1/projects/${ID}`,
      { status: 'someday' },
    ],
    [
      'create_context',
      { type: 'place', name: 'Дача' },
      'POST',
      '/v1/contexts',
      { type: 'place', name: 'Дача' },
    ],
    [
      'get_calendar',
      { from: '2026-11-23', to: '2026-11-29' },
      'GET',
      '/v1/calendar/events?from=2026-11-23&to=2026-11-29',
      undefined,
    ],
    ['list_comments', { item_id: ID }, 'GET', `/v1/items/${ID}/comments`, undefined],
    ['list_comments', { project_id: ID }, 'GET', `/v1/projects/${ID}/comments`, undefined],
    ['get_review_history', {}, 'GET', '/v1/review/history', undefined],
    ['search', { query: 'ёлка' }, 'GET', `/v1/search?q=${encodeURIComponent('ёлка')}`, undefined],
  ])('%s', async (name, args, method, url, body) => {
    const { client, calls } = await setup(() => ({ status: 200, body: { items: [] } }));
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError, text(res)).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(method);
    expect(withQuery(calls[0]!.path, calls[0]!.query)).toBe(url);
    expect(calls[0]?.body).toEqual(body);
  });

  it('get_project reads the project and its actions', async () => {
    const { client, calls } = await setup((req) =>
      req.path === `/v1/projects/${ID}`
        ? { status: 200, body: { id: ID, title: 'Ремонт', status: 'active', sort_key: 'a0' } }
        : {
            status: 200,
            body: { items: [{ id: 'a', title: 'Замер', status: 'next' }], next_cursor: null },
          },
    );
    const res = await client.callTool({ name: 'get_project', arguments: { id: ID } });
    expect(calls.map((c) => withQuery(c.path, c.query))).toEqual([
      `/v1/projects/${ID}`,
      `/v1/actions?project_id=${ID}&limit=200`,
    ]);
    expect(res.structuredContent).toEqual({
      project: { id: ID, title: 'Ремонт', status: 'active' },
      actions: [{ id: 'a', title: 'Замер', status: 'next' }],
    });
  });

  it('capture_many captures each item and reports partial failures', async () => {
    let n = 0;
    const { client, calls } = await setup(() =>
      ++n === 2
        ? { status: 422, body: { title: 'Invalid' } }
        : {
            status: 201,
            body: { audit_id: `au${n}`, dry_run: false, items: [{ entity: 'item', id: `i${n}` }] },
          },
    );
    const res = await client.callTool({
      name: 'capture_many',
      arguments: { items: [{ title: 'A' }, { title: 'B' }, { title: 'C', notes: 'n' }] },
    });
    expect(calls.map((c) => c.body)).toEqual([
      { title: 'A' },
      { title: 'B' },
      { title: 'C', notes: 'n' },
    ]);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      saved: [
        { title: 'A', id: 'i1', audit_id: 'au1' },
        { title: 'C', id: 'i3', audit_id: 'au3' },
      ],
      failed: [{ title: 'B', error: 'Error 422 — Invalid' }],
    });
    expect(text(res)).toContain('Saved 2 of 3');
  });

  it('list_comments needs exactly one target', async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name: 'list_comments', arguments: {} });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('compact answers', () => {
  const inboxItem = {
    id: ID,
    title: 'Купить хлеб',
    notes: null,
    status: 'inbox',
    sort_key: 'a0V',
    hlc: '0001:abc',
    deleted: false,
    series_id: null,
    occurrence_index: null,
    source: 'api',
    source_ref: null,
    reminders: [],
    checklist: [],
    context_ids: [],
    important: false,
    created_by: 'user',
    due_date: '2026-12-01',
  };

  it('drops nulls, empty values and sync fields, keeps what a person needs', async () => {
    const { client } = await setup(() => ({
      status: 200,
      body: { items: [inboxItem], next_cursor: null },
    }));
    const res = await client.callTool({ name: 'list_inbox', arguments: {} });
    const want = {
      items: [
        {
          id: ID,
          title: 'Купить хлеб',
          status: 'inbox',
          source: 'api',
          important: false,
          created_by: 'user',
          due_date: '2026-12-01',
        },
      ],
    };
    expect(JSON.parse(text(res))).toEqual(want);
    expect(res.structuredContent).toEqual(want);
    expect(text(res)).not.toContain('\n');
  });

  it('keeps empty top-level lists so "nothing found" stays explicit', async () => {
    const { client } = await setup(() => ({ status: 200, body: { items: [], next_cursor: null } }));
    const res = await client.callTool({ name: 'list_inbox', arguments: {} });
    expect(JSON.parse(text(res))).toEqual({ items: [] });
  });
});

describe('search and fetch for ChatGPT', () => {
  const hits = {
    items: [
      { id: 'p1', kind: 'project', title: 'Ремонт кухни', status: 'active', sort_key: 'a' },
      { id: 'i1', kind: 'item', title: 'Замер', status: 'next', project_id: 'p1' },
      { id: 'i2', kind: 'item', title: 'Идея', status: 'inbox' },
      { id: 'c1', kind: 'context', name: 'Кухня', type: 'place' },
    ],
    next_cursor: 'abc',
  };

  it('search answers results with web links', async () => {
    const { client } = await setup(() => ({ status: 200, body: hits }));
    const res = await client.callTool({ name: 'search', arguments: { q: 'кухня' } });
    const want = {
      results: [
        {
          id: 'p1',
          kind: 'project',
          title: 'Ремонт кухни',
          status: 'active',
          url: 'https://task.gtdist.app/projects/p1',
        },
        {
          id: 'i1',
          kind: 'item',
          title: 'Замер',
          status: 'next',
          url: 'https://task.gtdist.app/projects/p1',
        },
        {
          id: 'i2',
          kind: 'item',
          title: 'Идея',
          status: 'inbox',
          url: 'https://task.gtdist.app/inbox',
        },
        { id: 'c1', kind: 'context', title: 'Кухня', url: 'https://task.gtdist.app/contexts/c1' },
      ],
      next_cursor: 'abc',
    };
    expect(res.structuredContent).toEqual(want);
    expect(JSON.parse(text(res))).toEqual(want);
  });

  it('search needs query or q', async () => {
    const { client, calls } = await setup();
    const res = await client.callTool({ name: 'search', arguments: {} });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('the app address is configurable', async () => {
    const server = createMcpServer(async () => ({ status: 200, body: hits }), {
      appUrl: 'http://localhost:5173/',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const res = await client.callTool({ name: 'search', arguments: { query: 'x' } });
    expect((res.structuredContent as { results: { url: string }[] }).results[0]?.url).toBe(
      'http://localhost:5173/projects/p1',
    );
  });

  it('fetch reads an item by a bare id', async () => {
    const { client, calls } = await setup(() => ({
      status: 200,
      body: {
        id: ID,
        title: 'Позвонить Ивану',
        notes: 'про договор',
        status: 'next',
        sort_key: 'a',
        due_date: null,
      },
    }));
    const res = await client.callTool({ name: 'fetch', arguments: { id: ID } });
    expect(calls.map((c) => c.path)).toEqual([`/v1/actions/${ID}`]);
    const doc = res.structuredContent as Record<string, unknown>;
    expect(doc).toMatchObject({
      id: ID,
      title: 'Позвонить Ивану',
      url: 'https://task.gtdist.app/next',
      metadata: { kind: 'item', status: 'next' },
    });
    expect(doc['text']).toContain('про договор');
    expect(JSON.parse(text(res))).toEqual(doc);
  });

  it('fetch falls back to a project and lists its actions', async () => {
    const { client, calls } = await setup((req) =>
      req.path === `/v1/actions/${ID}`
        ? { status: 404, body: { title: 'Not found' } }
        : req.path === `/v1/projects/${ID}`
          ? {
              status: 200,
              body: { id: ID, title: 'Ремонт', outcome: 'Кухня готова', status: 'active' },
            }
          : { status: 200, body: { items: [{ id: 'a', title: 'Замер', status: 'next' }] } },
    );
    const res = await client.callTool({ name: 'fetch', arguments: { id: ID } });
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/actions/${ID}`,
      `/v1/projects/${ID}`,
      '/v1/actions',
    ]);
    const doc = res.structuredContent as Record<string, unknown>;
    expect(doc).toMatchObject({
      id: ID,
      title: 'Ремонт',
      url: `https://task.gtdist.app/projects/${ID}`,
    });
    expect(doc['text']).toContain('Кухня готова');
    expect(doc['text']).toContain('Замер');
  });

  it('fetch with a kind prefix goes straight there', async () => {
    const { client, calls } = await setup((req) =>
      req.path === '/v1/actions'
        ? { status: 200, body: { items: [] } }
        : { status: 200, body: { id: ID, title: 'P' } },
    );
    await client.callTool({ name: 'fetch', arguments: { id: `project:${ID}` } });
    expect(calls[0]?.path).toBe(`/v1/projects/${ID}`);
  });

  it('fetch says not found when nothing matches', async () => {
    const { client } = await setup((req) =>
      req.path === '/v1/contexts'
        ? { status: 200, body: { items: [] } }
        : { status: 404, body: { title: 'Not found' } },
    );
    const res = await client.callTool({ name: 'fetch', arguments: { id: ID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('404');
  });
});

describe('prompts and server info', () => {
  it('offers the GTD flows as prompts that name the tools', async () => {
    const { client } = await setup();
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['plan_now', 'prepare_conversation', 'process_inbox', 'weekly_review']);
    const inbox = await client.getPrompt({ name: 'process_inbox', arguments: {} });
    const body = JSON.stringify(inbox.messages);
    expect(body).toContain('list_inbox');
    expect(body).toContain('clarify_item');
    const talk = await client.getPrompt({
      name: 'prepare_conversation',
      arguments: { person: 'Анна' },
    });
    expect(JSON.stringify(talk.messages)).toContain('Анна');
    expect(JSON.stringify(talk.messages)).toContain('get_agenda');
  });

  it('is version 1.0.0 and keeps all 28 earlier tools', async () => {
    const { client } = await setup();
    expect(client.getServerVersion()?.version).toBe('1.0.0');
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const n of [
      'accept_clarification',
      'add_comment',
      'assign_item',
      'capture',
      'clarify_item',
      'complete_action',
      'create_action',
      'draft_reminder',
      'find_stuck_projects',
      'get_agenda',
      'get_horizons',
      'get_next_actions',
      'get_nudges',
      'list_assigned_to_me',
      'list_contexts',
      'list_done',
      'list_inbox',
      'list_projects',
      'list_waiting',
      'review_step',
      'search',
      'set_current_context',
      'start_weekly_review',
      'suggest_clarification',
      'suggest_reminder',
      'summarize_agenda',
      'undo',
      'update_action',
    ])
      expect(names.has(n), n).toBe(true);
  });
});

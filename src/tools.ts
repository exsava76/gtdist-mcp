import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { CallApi } from './api.ts';
import {
  CHANGE,
  READ,
  WRITE,
  actionFields,
  cursor,
  dataResult,
  dryRun,
  encode,
  energy,
  errorResult,
  limit,
  localDate,
  toResult,
  uuid,
} from './common.ts';
import { registerGtdTools, searchResults, type ToolOptions } from './tools-gtd.ts';

/** Every GTDist tool: a thin wrapper over one REST endpoint of the public API. */
export function registerTools(server: McpServer, api: CallApi, options: ToolOptions = {}): void {
  const get = async (path: string, query?: Record<string, string | number | boolean | undefined>) =>
    toResult(await api({ method: 'GET', path, ...(query ? { query } : {}) }));
  const op = async (
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ) =>
    toResult(
      await api({
        method,
        path,
        ...(body !== undefined ? { body } : {}),
        ...(query ? { query } : {}),
      }),
      true,
    );

  // ── collect and clarify ───────────────────────────────────────────────

  server.registerTool(
    'capture',
    {
      title: 'Capture into the inbox',
      description:
        'Write a raw thought into the GTDist inbox (GTD "collect"). Do not clarify here — just capture. ' +
        'Example: «Запиши: продлить страховку» → title "Продлить страховку".',
      inputSchema: {
        title: z.string().min(1).max(1000).describe('What came to mind, in the person’s words'),
        notes: z.string().max(100_000).optional(),
      },
      annotations: WRITE,
    },
    async (a) =>
      op('POST', '/v1/inbox', { title: a.title, ...(a.notes ? { notes: a.notes } : {}) }),
  );

  server.registerTool(
    'list_inbox',
    {
      title: 'List the inbox',
      description:
        'Items waiting to be clarified, oldest first. Example: «Разбери мои входящие» — start here.',
      inputSchema: { cursor, limit },
      annotations: READ,
    },
    async (a) => get('/v1/inbox', { cursor: a.cursor, limit: a.limit }),
  );

  server.registerTool(
    'clarify_item',
    {
      title: 'Clarify an inbox item',
      description:
        'Move one inbox item to a GTD list: next (next action), waiting (delegated), scheduled (calendar, needs due_date), ' +
        'tickler (comes back on tickler_date), someday, project (needs project.title and first_action.title — ' +
        'no project without its next action), done (took under two minutes), trash. ' +
        'Use dry_run=true first and show the person what will change, then call again with dry_run=false. ' +
        'Example: «Позвонить Ивану» → to=next with the person context.',
      inputSchema: {
        id: uuid.describe('Inbox item id (from list_inbox)'),
        to: z.enum([
          'next',
          'waiting',
          'scheduled',
          'tickler',
          'someday',
          'project',
          'done',
          'trash',
        ]),
        dry_run: dryRun,
        ...actionFields,
        waiting_person_id: uuid.nullable().optional().describe('to=waiting: person context'),
        waiting_remind_on: localDate.nullable().optional(),
        tickler_date: localDate.optional().describe('to=tickler: when it returns to the inbox'),
        someday_list_id: uuid.nullable().optional(),
        project: z
          .object({
            title: z.string().min(1).max(1000),
            outcome: z.string().max(100_000).optional().describe('What "done" looks like'),
            kind: z.enum(['sequential', 'parallel', 'checklist']).optional(),
            area_id: uuid.nullable().optional(),
          })
          .optional()
          .describe('to=project: the new project'),
        first_action: z
          .object({ ...actionFields, title: z.string().min(1).max(1000) })
          .optional()
          .describe('to=project: its first next action'),
      },
      annotations: CHANGE,
    },
    async (a) => {
      const { id, dry_run, ...body } = a;
      return op('POST', `/v1/inbox/${encode(id)}/clarify`, body, { dry_run: dry_run ?? false });
    },
  );

  // ── «ИИ-помощник» (wave 1): the server's own suggestions, same as in the apps ────────

  server.registerTool(
    'suggest_clarification',
    {
      title: 'Suggest how to clarify an inbox item',
      description:
        "GTDist's own suggestion for one inbox item: next-action wording, list (next / waiting / " +
        "someday / project), contexts from the person's lists, minutes, energy, «2 минуты», " +
        '«это проект». Writes nothing. A due date appears only if the item itself says one. via=rules ' +
        'means the assistant is off, over its monthly budget or the model failed.',
      inputSchema: {
        item_id: uuid.describe('Inbox item id (from list_inbox)'),
        refresh: z.boolean().optional().describe('Ask the model again instead of the cached one'),
      },
      annotations: READ,
    },
    async (a) =>
      toResult(
        await api({
          method: 'POST',
          path: `/v1/ai/clarify/${encode(a.item_id)}/suggest`,
          query: { refresh: a.refresh ?? false },
        }),
      ),
  );

  server.registerTool(
    'accept_clarification',
    {
      title: 'Accept a clarify suggestion',
      description:
        'Apply a suggestion from suggest_clarification — all fields or only some. Recorded in the ' +
        'journal and undoable. Preview with dry_run first. A project suggestion needs its first action.',
      inputSchema: {
        item_id: uuid,
        suggestion_id: z
          .string()
          .min(1)
          .max(100)
          .describe('id from suggest_clarification ("local" for a rules suggestion)'),
        fields: z
          .array(z.enum(['title', 'list', 'contexts', 'time', 'energy', 'due']))
          .min(1)
          .describe('Which parts to accept; the item leaves the inbox only with "list"'),
        title: z.string().max(1000).optional().describe('The wording as the person corrected it'),
        dry_run: dryRun,
      },
      annotations: CHANGE,
    },
    async (a) => {
      const { item_id, dry_run, ...body } = a;
      return op('POST', `/v1/ai/clarify/${encode(item_id)}/accept`, body, {
        dry_run: dry_run ?? false,
      });
    },
  );

  server.registerTool(
    'get_nudges',
    {
      title: 'What seems forgotten',
      description:
        'Rules, no model: overdue deadlines, «Жду» 7+ days without a follow-up, active projects ' +
        'without a next action, items deferred 3+ times, «Когда-нибудь» untouched for half a year.',
      inputSchema: {},
      annotations: READ,
    },
    async () => get('/v1/nudges'),
  );

  server.registerTool(
    'suggest_reminder',
    {
      title: 'Draft a reminder with the assistant',
      description:
        "GTDist's assistant drafts a short friendly follow-up in Russian for a waiting-for item or " +
        'an assignment (the template when the assistant is off). Only returns the text — nothing is sent.',
      inputSchema: { item_id: uuid.describe('Waiting-for item id (from list_waiting)') },
      annotations: READ,
    },
    async (a) =>
      toResult(await api({ method: 'POST', path: `/v1/ai/reminder/${encode(a.item_id)}` })),
  );

  server.registerTool(
    'summarize_agenda',
    {
      title: 'One line before talking to a person',
      description:
        'A one-line summary on top of a person agenda («К разговору с Анной»): where to start. ' +
        'summary is null when there is nothing to discuss or no model.',
      inputSchema: { person_id: uuid.describe('Person context id') },
      annotations: READ,
    },
    async (a) =>
      toResult(await api({ method: 'POST', path: `/v1/ai/agenda/${encode(a.person_id)}` })),
  );

  // ── do ───────────────────────────────────────────────────────────────

  server.registerTool(
    'get_next_actions',
    {
      title: 'What to do now',
      description:
        'Next actions that fit right now: an action shows only when ALL its contexts are active, plus the day’s hard landscape. ' +
        'Without context ids the person’s current contexts are used. ' +
        'Example: «У меня 20 минут в офисе — что сделать?» → place=[office id], minutes=20.',
      inputSchema: {
        place: z.array(uuid).max(20).optional(),
        person: z.array(uuid).max(20).optional(),
        circumstance: z.array(uuid).max(20).optional(),
        minutes: z.number().int().min(1).max(10_000).optional().describe('Time available'),
        energy: energy.optional(),
      },
      annotations: READ,
    },
    async (a) =>
      get('/v1/now', {
        place: a.place?.join(','),
        person: a.person?.join(','),
        circumstance: a.circumstance?.join(','),
        minutes: a.minutes,
        energy: a.energy,
      }),
  );

  server.registerTool(
    'create_action',
    {
      title: 'Create an action',
      description:
        'Create an already clarified action (default status next). For raw thoughts use capture instead. ' +
        'Example: «Добавь: купить батарейки @магазин».',
      inputSchema: {
        ...actionFields,
        title: z.string().min(1).max(1000),
        status: z.enum(['next', 'waiting', 'scheduled', 'someday']).optional(),
        recurrence: z
          .object({
            rrule: z.string().max(500).describe('RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=MO'),
            mode: z.enum(['from_due', 'from_completion']),
          })
          .optional(),
      },
      annotations: WRITE,
    },
    async (a) => op('POST', '/v1/actions', a),
  );

  server.registerTool(
    'update_action',
    {
      title: 'Change an action',
      description:
        'Change fields of an action: title, contexts, project, dates, status (dropped removes it from lists). ' +
        'Supports dry_run. Example: «Перенеси звонок Ивану на когда-нибудь» → status=someday.',
      inputSchema: {
        id: uuid,
        dry_run: dryRun,
        ...actionFields,
        status: z
          .enum(['next', 'waiting', 'scheduled', 'tickler', 'someday', 'reference', 'dropped'])
          .optional(),
        tickler_date: localDate.nullable().optional(),
        waiting_person_id: uuid.nullable().optional(),
      },
      annotations: CHANGE,
    },
    async (a) => {
      const { id, dry_run, ...body } = a;
      return op('PATCH', `/v1/actions/${encode(id)}`, body, { dry_run: dry_run ?? false });
    },
  );

  server.registerTool(
    'complete_action',
    {
      title: 'Complete an action',
      description:
        'Mark an action done; a recurring one gets its next occurrence. Supports dry_run. ' +
        'Example: «Отметь, что я отправил отчёт».',
      inputSchema: { id: uuid, dry_run: dryRun },
      annotations: CHANGE,
    },
    async (a) =>
      op('POST', `/v1/actions/${encode(a.id)}/complete`, undefined, {
        dry_run: a.dry_run ?? false,
      }),
  );

  // ── projects ─────────────────────────────────────────────────────────

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'Projects with stuck flag and last movement. Example: «Какие у меня активные проекты по работе?» → status=active, area_id.',
      inputSchema: {
        status: z.enum(['active', 'someday', 'done', 'dropped']).optional(),
        area_id: uuid.optional(),
        cursor,
        limit,
      },
      annotations: READ,
    },
    async (a) =>
      get('/v1/projects', {
        status: a.status,
        area_id: a.area_id,
        cursor: a.cursor,
        limit: a.limit,
      }),
  );

  server.registerTool(
    'find_stuck_projects',
    {
      title: 'Find stuck projects',
      description:
        'Active projects without a next action. Example: «Какие проекты застряли?» — then suggest a next action for each.',
      inputSchema: {},
      annotations: READ,
    },
    async () => get('/v1/projects', { stuck: true }),
  );

  // ── waiting for ──────────────────────────────────────────────────────

  server.registerTool(
    'list_waiting',
    {
      title: 'List waiting-for',
      description:
        'What the person waits for from others; older_than_days lists overdue ones. Example: «Кто мне что должен больше недели?» → 7.',
      inputSchema: {
        older_than_days: z.number().int().min(0).max(9999).optional(),
        cursor,
        limit,
      },
      annotations: READ,
    },
    async (a) =>
      get('/v1/waiting', {
        older_than: a.older_than_days === undefined ? undefined : `${a.older_than_days}d`,
        cursor: a.cursor,
        limit: a.limit,
      }),
  );

  server.registerTool(
    'draft_reminder',
    {
      title: 'Draft a reminder',
      description:
        'Draft a short follow-up text for a waiting-for item. Only returns the text — nothing is sent. ' +
        'Example: «Напиши Анне напоминание про договор».',
      inputSchema: {
        waiting_id: uuid.describe('Waiting-for item id (from list_waiting)'),
        tone: z.enum(['friendly', 'formal']).optional(),
      },
      annotations: READ,
    },
    async (a) => {
      const found = await findWaiting(api, a.waiting_id);
      if ('error' in found) return found.error;
      const item = found.item;
      let name: string | null = null;
      if (typeof item['waiting_person_id'] === 'string') {
        const people = await api({
          method: 'GET',
          path: '/v1/contexts',
          query: { type: 'person' },
        });
        if (people.status < 400) {
          const list = (people.body as { items?: Record<string, unknown>[] }).items ?? [];
          const p = list.find((c) => c['id'] === item['waiting_person_id']);
          if (p && typeof p['name'] === 'string') name = p['name'];
        }
      }
      const title = String(item['title'] ?? '');
      const since = typeof item['waiting_since'] === 'string' ? item['waiting_since'] : null;
      const text =
        a.tone === 'formal'
          ? `${name ? `${name}, добрый день!` : 'Добрый день!'} Напоминаю о вопросе «${title}»${since ? ` (жду с ${since})` : ''}. Подскажите, пожалуйста, когда можно ожидать ответ?`
          : `${name ? `${name}, привет!` : 'Привет!'} Напоминаю про «${title}»${since ? ` — жду с ${since}` : ''}. Как там дела?`;
      return {
        content: [
          { type: 'text', text: `Draft (not sent — the person sends it themselves):\n\n${text}` },
        ],
      };
    },
  );

  // ── contexts and people ──────────────────────────────────────────────

  server.registerTool(
    'list_contexts',
    {
      title: 'List contexts',
      description:
        'Contexts of three kinds: place (Офис, Дом), person (Иван), circumstance (За компьютером, В дороге). ' +
        'Use their ids in get_next_actions and set_current_context.',
      inputSchema: { type: z.enum(['place', 'person', 'circumstance']).optional() },
      annotations: READ,
    },
    async (a) => get('/v1/contexts', { type: a.type }),
  );

  server.registerTool(
    'set_current_context',
    {
      title: 'Set current contexts',
      description:
        'Say which contexts are true right now; get_next_actions without parameters then uses them. ' +
        'Example: «Я в дороге, есть полчаса» → the "В дороге" circumstance.',
      inputSchema: { context_ids: z.array(uuid).max(50) },
      annotations: WRITE,
    },
    async (a) =>
      toResult(
        await api({
          method: 'PUT',
          path: '/v1/contexts/current',
          body: { context_ids: a.context_ids },
        }),
      ),
  );

  server.registerTool(
    'get_agenda',
    {
      title: 'Agenda for a person',
      description:
        'What to discuss with a person and what we wait for from them. Example: «Что обсудить с Иваном на встрече?».',
      inputSchema: { person_id: uuid.describe('A person context id') },
      annotations: READ,
    },
    async (a) => get(`/v1/people/${encode(a.person_id)}/agenda`),
  );

  // ── weekly review ────────────────────────────────────────────────────

  server.registerTool(
    'start_weekly_review',
    {
      title: 'Start the weekly review',
      description:
        'The weekly review: 11 steps in 3 blocks (get clear, get current, get creative) with what needs attention in each. ' +
        'Walk the person through the steps one by one and mark each with review_step. Example: «Давай проведём обзор недели».',
      inputSchema: {},
      annotations: READ,
    },
    async () => get('/v1/review/weekly'),
  );

  server.registerTool(
    'review_step',
    {
      title: 'Mark a review step done',
      description: 'Mark step n (1–11) of this week’s review as done.',
      inputSchema: { n: z.number().int().min(1).max(11) },
      annotations: WRITE,
    },
    async (a) => op('POST', `/v1/review/steps/${a.n}`),
  );

  // ── horizons, search, done, undo ─────────────────────────────────────

  server.registerTool(
    'get_horizons',
    {
      title: 'Horizons of focus',
      description:
        'Areas of responsibility (H2) with their project folders, and goals, vision, purpose (H3–H5) with their links. ' +
        'Example: «Какие цели года ничем не обеспечены?».',
      inputSchema: {},
      annotations: READ,
    },
    async () => {
      const areas = await api({ method: 'GET', path: '/v1/areas' });
      if (areas.status >= 400) return toResult(areas);
      const goals = await api({ method: 'GET', path: '/v1/goals' });
      if (goals.status >= 400) return toResult(goals);
      const g = goals.body as { items?: unknown; links?: unknown };
      return toResult({
        status: 200,
        body: {
          areas: (areas.body as { items?: unknown }).items ?? [],
          // Folders of projects inside the areas (a project's `folder_id` points at one).
          project_folders: (areas.body as { folders?: unknown }).folders ?? [],
          goals: g.items ?? [],
          goal_links: g.links ?? [],
        },
      });
    },
  );

  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Find actions, projects and contexts by words («елка» finds «ёлка»). Answers ' +
        'results [{id, kind, title, status, url}]; read one in full with fetch (or get_item / ' +
        'get_project). Example: «Найди всё про страховку» → query "страховка".',
      inputSchema: {
        query: z.string().min(1).max(200).optional().describe('Words to find'),
        q: z.string().min(1).max(200).optional().describe('Same as query (older name)'),
        cursor,
        limit,
      },
      annotations: READ,
    },
    async (a) => {
      const q = a.query ?? a.q;
      if (!q) return errorResult('Error 400 — Pass the words to find in "query"');
      const res = await api({
        method: 'GET',
        path: '/v1/search',
        query: { q, cursor: a.cursor, limit: a.limit },
      });
      if (res.status >= 400) return toResult(res);
      return dataResult(searchResults(res.body, options));
    },
  );

  server.registerTool(
    'list_done',
    {
      title: 'Done by day',
      description:
        'Completed actions grouped by local day, newest first. Example: «Что я сделал на этой неделе?» → from Monday to today.',
      inputSchema: { from: localDate, to: localDate },
      annotations: READ,
    },
    async (a) => get('/v1/done', { from: a.from, to: a.to }),
  );

  // ── collaboration ────────────────────────────────────────────────────

  server.registerTool(
    'assign_item',
    {
      title: 'Assign an item to someone',
      description:
        'Assign an action to a member of its shared project (or, outside shared projects, to someone the person works with — ' +
        'the item gets shared with them). They get it in their Inbox to accept or decline; for the person it waits in «Жду». ' +
        'user_id null takes the assignment off. Member ids: list_assigned_to_me / the project members in the apps.',
      inputSchema: { id: uuid.describe('Item id'), user_id: uuid.nullable() },
      annotations: CHANGE,
    },
    async (a) => op('POST', `/v1/items/${encode(a.id)}/assign`, { user_id: a.user_id }),
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Comment on an item',
      description:
        'Write a comment under an item (everyone in its shared project sees it); mentions notify those members. ' +
        'Example: «Спроси Анну в комментарии, когда будет замер».',
      inputSchema: {
        item_id: uuid,
        body: z.string().min(1).max(100_000),
        mentions: z.array(uuid).max(50).optional().describe('User ids to notify'),
      },
      annotations: WRITE,
    },
    async (a) =>
      op('POST', `/v1/items/${encode(a.item_id)}/comments`, {
        body: a.body,
        ...(a.mentions ? { mentions: a.mentions } : {}),
      }),
  );

  server.registerTool(
    'list_assigned_to_me',
    {
      title: 'Assigned to me',
      description:
        'Open items other people assigned to the person, across shared projects; state=pending — not answered yet ' +
        '(they sit in the Inbox). Example: «Что мне поручили?»',
      inputSchema: { state: z.enum(['pending', 'accepted']).optional() },
      annotations: READ,
    },
    async (a) => get('/v1/assigned', { state: a.state }),
  );

  server.registerTool(
    'undo',
    {
      title: 'Undo an operation',
      description:
        'Revert an operation by its audit_id (every write tool returns one). Fields changed since are left alone and reported. ' +
        'Supports dry_run. Example: «Отмени последнее, что ты сделал».',
      inputSchema: { audit_id: uuid, dry_run: dryRun },
      annotations: CHANGE,
    },
    async (a) =>
      op('POST', `/v1/audit/${encode(a.audit_id)}/undo`, undefined, {
        dry_run: a.dry_run ?? false,
      }),
  );

  registerGtdTools(server, api, options);
}

async function findWaiting(
  api: CallApi,
  id: string,
): Promise<{ item: Record<string, unknown> } | { error: CallToolResult }> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await api({ method: 'GET', path: '/v1/waiting', query: { limit: 500, cursor } });
    if (res.status >= 400) return { error: toResult(res) };
    const body = res.body as { items?: Record<string, unknown>[]; next_cursor?: string | null };
    const item = body.items?.find((i) => i['id'] === id);
    if (item) return { item };
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return {
    error: {
      isError: true,
      content: [{ type: 'text', text: 'Error 404 — No waiting-for item with this id' }],
    },
  };
}

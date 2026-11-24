import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compact, problemText, type ApiResponse, type CallApi } from './api.ts';
import {
  CHANGE,
  READ,
  WRITE,
  actionFields,
  cursor,
  dataResult,
  encode,
  errorResult,
  limit,
  localDate,
  toResult,
  uuid,
} from './common.ts';

export interface ToolOptions {
  /** The web app the `url` of search and fetch results points at. */
  appUrl?: string;
}

export const DEFAULT_APP_URL = 'https://task.gtdist.app';

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function appBase(options: ToolOptions): string {
  return (options.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
}

/** The web app has no page per item: an item opens on its project or on the list it sits in. */
const LIST_OF_STATUS: Record<string, string> = {
  inbox: '/inbox',
  next: '/next',
  waiting: '/waiting',
  scheduled: '/calendar',
  tickler: '/tickler',
  someday: '/someday',
  reference: '/someday',
  done: '/archive',
  dropped: '/archive',
};

function webPath(kind: string, rec: Rec): string {
  const id = encode(String(rec['id'] ?? ''));
  if (kind === 'project') return `/projects/${id}`;
  if (kind === 'context') return `/contexts/${id}`;
  const project = str(rec['project_id']);
  if (project) return `/projects/${encode(project)}`;
  return LIST_OF_STATUS[str(rec['status']) ?? ''] ?? '/next';
}

/** `GET /v1/search` rows as ChatGPT-style results: id, kind, title, status, link into the app. */
export function searchResults(body: unknown, options: ToolOptions): Rec {
  const b = (body ?? {}) as { items?: Rec[]; next_cursor?: string | null };
  const base = appBase(options);
  const results = (b.items ?? []).map((r) => {
    const kind = str(r['kind']) ?? 'item';
    const out: Rec = {
      id: r['id'],
      kind,
      title: str(r['title']) ?? str(r['name']) ?? '',
    };
    const status = str(r['status']);
    if (status) out['status'] = status;
    out['url'] = base + webPath(kind, r);
    return out;
  });
  return b.next_cursor ? { results, next_cursor: b.next_cursor } : { results };
}

const projectFields = {
  outcome: z.string().max(100_000).nullable().optional().describe('What "done" looks like'),
  why: z.string().max(100_000).nullable().optional(),
  kind: z.enum(['sequential', 'parallel', 'checklist']).optional(),
  area_id: uuid.nullable().optional().describe('Area of responsibility (get_horizons)'),
  folder_id: uuid.nullable().optional(),
  goal_id: uuid.nullable().optional(),
  defer_until: localDate.nullable().optional(),
  due_date: localDate
    .nullable()
    .optional()
    .describe('HARD deadline only if the person named one; never guess a date.'),
  pinned: z.boolean().optional(),
};

const notFound = (what: string) => errorResult(`Error 404 — No ${what} with this id`);

/** One record as a readable document (fetch): the fields that matter first, notes after. */
function documentText(kind: string, rec: Rec, actions: Rec[] = []): string {
  const lines: string[] = [str(rec['title']) ?? str(rec['name']) ?? ''];
  const facts: [string, unknown][] =
    kind === 'context'
      ? [
          ['Type', rec['type']],
          ['Also', Array.isArray(rec['aliases']) ? rec['aliases'].join(', ') : undefined],
        ]
      : [
          ['Kind', kind],
          ['Status', rec['status']],
          ['Due', [rec['due_date'], rec['due_time']].filter(Boolean).join(' ')],
          ['Deferred until', rec['defer_until']],
          ['Tickler', rec['tickler_date']],
          ['Waiting since', rec['waiting_since']],
          ['Project', rec['project_id']],
          ['Area', rec['area_id']],
          ['Contexts', Array.isArray(rec['context_ids']) ? rec['context_ids'].join(', ') : ''],
          ['Minutes', rec['time_estimate_min']],
          ['Energy', rec['energy']],
          ['Important', rec['important'] === true ? 'yes' : undefined],
          ['Completed', rec['completed_at']],
        ];
  for (const [k, v] of facts)
    if (v !== undefined && v !== null && v !== '') lines.push(`${k}: ${String(v)}`);
  for (const k of ['outcome', 'why', 'notes'] as const) {
    const t = str(rec[k]);
    if (t) lines.push('', k === 'notes' ? t : `${k === 'outcome' ? 'Outcome' : 'Why'}: ${t}`);
  }
  if (actions.length) {
    lines.push('', 'Actions:');
    for (const a of actions)
      lines.push(
        `- [${String(a['status'] ?? '')}] ${String(a['title'] ?? '')} (${String(a['id'])})`,
      );
  }
  return lines.join('\n');
}

/** The new GTD coverage tools (v1.0.0): projects, lists by filter, records by id, calendar, comments. */
export function registerGtdTools(server: McpServer, api: CallApi, options: ToolOptions): void {
  const get = async (path: string, query?: Record<string, string | number | boolean | undefined>) =>
    api({ method: 'GET', path, ...(query ? { query } : {}) });
  const base = appBase(options);

  // ── collect ──────────────────────────────────────────────────────────

  server.registerTool(
    'parse_to_inbox',
    {
      title: 'Split text into proposed cards',
      description:
        'Split dictated or pasted text («Диктор») into separate cards with proposed list, contexts, ' +
        'project and dates. Writes nothing: show the cards to the person, then save the ones they ' +
        'keep with capture_many (or create_action). Counts against the monthly «Диктор» limit.',
      inputSchema: {
        text: z
          .union([z.string().min(1).max(20_000), z.array(z.string().max(20_000)).min(1).max(50)])
          .describe('The text, or its chunks in order'),
      },
      annotations: READ,
    },
    async (a) =>
      toResult(await api({ method: 'POST', path: '/v1/inbox/parse', body: { text: a.text } })),
  );

  server.registerTool(
    'capture_many',
    {
      title: 'Capture several thoughts',
      description:
        'Capture up to 50 raw thoughts into the inbox at once (a brain dump), one inbox item each. ' +
        'Each gets its own audit_id for undo; failures are listed and the rest is still saved.',
      inputSchema: {
        items: z
          .array(
            z.object({
              title: z.string().min(1).max(1000),
              notes: z.string().max(100_000).optional(),
            }),
          )
          .min(1)
          .max(50),
      },
      annotations: WRITE,
    },
    async (a) => {
      const saved: Rec[] = [];
      const failed: Rec[] = [];
      for (const it of a.items) {
        const res = await api({
          method: 'POST',
          path: '/v1/inbox',
          body: { title: it.title, ...(it.notes ? { notes: it.notes } : {}) },
        });
        if (res.status >= 400) {
          failed.push({ title: it.title, error: problemText(res) });
          continue;
        }
        const b = res.body as { audit_id?: string | null; items?: Rec[] };
        saved.push({
          title: it.title,
          id: b.items?.[0]?.['id'],
          audit_id: b.audit_id ?? undefined,
        });
      }
      const head = `Saved ${saved.length} of ${a.items.length} into the inbox.${failed.length ? ` ${failed.length} failed.` : ''} Undo any one with its audit_id.`;
      const data: Rec = { saved };
      if (failed.length) data['failed'] = failed;
      const result = dataResult(compact(data), head);
      if (saved.length === 0) result.isError = true;
      return result;
    },
  );

  // ── organize: actions and projects ───────────────────────────────────

  server.registerTool(
    'list_actions',
    {
      title: 'List actions by filter',
      description:
        'Actions filtered by status, project or context (without status: every list except the inbox ' +
        'and reference). Example: «Что у меня в «Когда-нибудь»?» → status=someday.',
      inputSchema: {
        status: z
          .enum(['next', 'waiting', 'scheduled', 'tickler', 'someday', 'done', 'dropped'])
          .optional(),
        project_id: uuid.optional(),
        context_id: uuid.optional(),
        cursor,
        limit,
      },
      annotations: READ,
    },
    async (a) =>
      toResult(
        await get('/v1/actions', {
          status: a.status,
          project_id: a.project_id,
          context_id: a.context_id,
          cursor: a.cursor,
          limit: a.limit,
        }),
      ),
  );

  server.registerTool(
    'get_item',
    {
      title: 'Read one item',
      description:
        'One item (an action or an inbox item) by id, with its contexts, dates and notes.',
      inputSchema: { id: uuid },
      annotations: READ,
    },
    async (a) => toResult(await get(`/v1/actions/${encode(a.id)}`)),
  );

  server.registerTool(
    'get_project',
    {
      title: 'Read one project',
      description:
        'A project with its outcome, stuck flag and its actions. Example: «Что осталось по ремонту?».',
      inputSchema: { id: uuid },
      annotations: READ,
    },
    async (a) => {
      const project = await get(`/v1/projects/${encode(a.id)}`);
      if (project.status >= 400) return toResult(project);
      const actions = await get('/v1/actions', { project_id: a.id, limit: 200 });
      if (actions.status >= 400) return toResult(actions);
      const list = actions.body as { items?: unknown[]; next_cursor?: string | null };
      return toResult({
        status: 200,
        body: {
          project: project.body,
          actions: list.items ?? [],
          next_cursor: list.next_cursor ?? null,
        },
      });
    },
  );

  server.registerTool(
    'create_project',
    {
      title: 'Create a project',
      description:
        'Create a project (an outcome needing more than one action) together with its first next ' +
        'action — GTD: no project without a next action. Example: «Заведи проект «Ремонт кухни», ' +
        'первым — вызвать замерщика».',
      inputSchema: {
        title: z.string().min(1).max(1000),
        ...projectFields,
        first_action: z
          .object({ ...actionFields, title: z.string().min(1).max(1000) })
          .describe('Its first next action'),
      },
      annotations: WRITE,
    },
    async (a) => toResult(await api({ method: 'POST', path: '/v1/projects', body: a }), true),
  );

  server.registerTool(
    'update_project',
    {
      title: 'Change a project',
      description:
        'Change a project: title, outcome, area, dates; status someday pauses it, done or dropped ' +
        'closes it. No dry run here: say what you will change first. Undo with its audit_id.',
      inputSchema: {
        id: uuid,
        title: z.string().min(1).max(1000).optional(),
        ...projectFields,
        status: z.enum(['active', 'someday', 'done', 'dropped']).optional(),
      },
      annotations: CHANGE,
    },
    async (a) => {
      const { id, ...body } = a;
      return toResult(
        await api({ method: 'PATCH', path: `/v1/projects/${encode(id)}`, body }),
        true,
      );
    },
  );

  server.registerTool(
    'create_context',
    {
      title: 'Create a context',
      description:
        'A new context: place (Дача), person (Анна — for agendas and waiting-for) or circumstance ' +
        '(За рулём). Check list_contexts first so you do not create a duplicate.',
      inputSchema: {
        type: z.enum(['place', 'person', 'circumstance']),
        name: z.string().min(1).max(1000),
        aliases: z.array(z.string().max(200)).max(50).optional().describe('Other names to match'),
        person_email: z.email().optional(),
      },
      annotations: WRITE,
    },
    async (a) => toResult(await api({ method: 'POST', path: '/v1/contexts', body: a }), true),
  );

  // ── reflect and engage ───────────────────────────────────────────────

  server.registerTool(
    'get_calendar',
    {
      title: 'Calendar events',
      description:
        'Calendar events (the hard landscape) on local days from..to inclusive, with the people in ' +
        'them; default — two weeks from today, at most a few months at once. Needs a connected calendar.',
      inputSchema: { from: localDate.optional(), to: localDate.optional() },
      annotations: READ,
    },
    async (a) => toResult(await get('/v1/calendar/events', { from: a.from, to: a.to })),
  );

  server.registerTool(
    'list_comments',
    {
      title: 'Comments',
      description: 'Comments under an item or a project, oldest first. Pass item_id or project_id.',
      inputSchema: { item_id: uuid.optional(), project_id: uuid.optional() },
      annotations: READ,
    },
    async (a) => {
      const target: [string, string] | null =
        a.item_id && !a.project_id
          ? ['items', a.item_id]
          : a.project_id && !a.item_id
            ? ['projects', a.project_id]
            : null;
      if (!target) return errorResult('Error 400 — Pass exactly one of item_id or project_id');
      return toResult(await get(`/v1/${target[0]}/${encode(target[1])}/comments`));
    },
  );

  server.registerTool(
    'get_review_history',
    {
      title: 'Past reviews',
      description: 'Completed reviews, newest first, with how many minutes each took.',
      inputSchema: {},
      annotations: READ,
    },
    async () => toResult(await get('/v1/review/history')),
  );

  // ── fetch (ChatGPT deep research / company knowledge) ───────────────

  server.registerTool(
    'fetch',
    {
      title: 'Fetch a record',
      description:
        'Read one search result in full: {id, title, text, url, metadata}. Takes the id from search ' +
        '(an item, project or context; "project:<id>" style prefixes also work).',
      inputSchema: { id: z.string().min(1).max(120) },
      annotations: READ,
    },
    async (a) => {
      const m = /^(item|project|context):(.+)$/.exec(a.id);
      const prefixed = m?.[1] && m[2] ? { kind: m[1], id: m[2] } : null;
      const kinds = prefixed ? [prefixed.kind] : ['item', 'project', 'context'];
      const id = prefixed ? prefixed.id : a.id;
      if (!uuid.safeParse(id).success) return errorResult('Error 400 — Not a GTDist id');
      for (const kind of kinds) {
        const doc = await fetchDocument(kind, id);
        if (doc === null) continue;
        return 'error' in doc ? doc.error : dataResult(doc.doc);
      }
      return notFound(prefixed ? prefixed.kind : 'item, project or context');
    },
  );

  /** null — not found as this kind; a tool error — the API refused; otherwise the document. */
  async function fetchDocument(
    kind: string,
    id: string,
  ): Promise<{ doc: Rec } | { error: CallToolResult } | null> {
    let rec: Rec | undefined;
    let actions: Rec[] = [];
    if (kind === 'context') {
      const res = await get('/v1/contexts');
      if (res.status >= 400) return { error: toResult(res) };
      rec = ((res.body as { items?: Rec[] }).items ?? []).find((c) => c['id'] === id);
      if (!rec) return null;
    } else {
      const res: ApiResponse = await get(
        `/v1/${kind === 'item' ? 'actions' : 'projects'}/${encode(id)}`,
      );
      if (res.status === 404) return null;
      if (res.status >= 400) return { error: toResult(res) };
      rec = res.body as Rec;
      if (kind === 'project') {
        const list = await get('/v1/actions', { project_id: id, limit: 200 });
        if (list.status < 400) actions = (list.body as { items?: Rec[] }).items ?? [];
      }
    }
    const { title, name, notes, ...rest } = compact(rec) as Rec;
    void notes;
    return {
      doc: {
        id,
        title: str(title) ?? str(name) ?? '',
        text: documentText(kind, rec, actions),
        url: base + webPath(kind, rec),
        metadata: { kind, ...rest, ...(actions.length ? { actions: actions.length } : {}) },
      },
    };
  }
}

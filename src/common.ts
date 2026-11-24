import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { compact, problemText, type ApiResponse } from './api.ts';

/** Schemas and result helpers shared by every tool module. */

export const uuid = z.uuid();
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const energy = z.enum(['low', 'mid', 'high']);
export const cursor = z.string().max(100).optional().describe('next_cursor from the previous page');
export const limit = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe('Page size (default 100)');
export const dryRun = z
  .boolean()
  .optional()
  .describe('true = only show what would change, nothing is saved. Preview first, then apply.');

/** Action fields shared by create_action, update_action and clarify_item. */
export const actionFields = {
  title: z.string().min(1).max(1000).optional(),
  notes: z.string().max(100_000).nullable().optional(),
  project_id: uuid.nullable().optional(),
  context_ids: z
    .array(uuid)
    .max(20)
    .optional()
    .describe('Contexts (places, people, circumstances); all must match for «Сейчас»'),
  time_estimate_min: z.number().int().min(0).max(100_000).nullable().optional(),
  energy: energy.nullable().optional(),
  important: z.boolean().optional(),
  defer_until: localDate.nullable().optional().describe('Hide until this local date (YYYY-MM-DD)'),
  due_date: localDate
    .nullable()
    .optional()
    .describe(
      'HARD deadline. Only if the person explicitly named one («до пятницы»); never guess a date.',
    ),
  due_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
};

export const encode = encodeURIComponent;

type OpBody = {
  audit_id?: string | null;
  dry_run?: boolean;
  items?: Record<string, unknown>[];
  conflicts?: { entity: string; id: string; field: string }[];
};

/** «What changes» in plain words for write operations, followed by the raw API answer. */
export function describeOp(body: OpBody): string {
  const lines: string[] = [];
  const items = body.items ?? [];
  lines.push(
    body.dry_run
      ? 'DRY RUN — nothing was saved. This is what would change:'
      : items.length > 0
        ? 'Saved. Changed:'
        : 'Nothing changed.',
  );
  for (const it of items) {
    const { entity, id, ...fields } = it;
    const shown = Object.entries(fields)
      .filter(([k, v]) => !isSyncNoise(k, v))
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`- ${String(entity)} ${String(id)}: ${shown}`);
  }
  if (body.conflicts?.length)
    lines.push(
      `Left alone because they were changed later: ${body.conflicts.map((c) => `${c.entity} ${c.id}.${c.field}`).join(', ')}`,
    );
  if (!body.dry_run && body.audit_id)
    lines.push(`audit_id: ${body.audit_id} (pass it to the undo tool to revert)`);
  return lines.join('\n');
}

/** Sync bookkeeping and empty defaults that say nothing in «what changed». */
function isSyncNoise(key: string, value: unknown): boolean {
  if (['sort_key', 'hlc', 'series_id', 'occurrence_index'].includes(key)) return true;
  if (key === 'deleted' && value === false) return true;
  return Array.isArray(value) && value.length === 0;
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** A successful answer: compact JSON as text (for clients without structured output) and as data. */
export function dataResult(data: unknown, prefix?: string): CallToolResult {
  const json = JSON.stringify(data);
  const result: CallToolResult = {
    content: [{ type: 'text', text: prefix ? `${prefix}\n\n${json}` : json }],
  };
  if (data !== null && typeof data === 'object' && !Array.isArray(data))
    result.structuredContent = data as Record<string, unknown>;
  return result;
}

export function toResult(res: ApiResponse, op = false): CallToolResult {
  if (res.status >= 400) return errorResult(problemText(res));
  const data = compact(res.body);
  return dataResult(data, op ? describeOp(res.body as OpBody) : undefined);
}

export const READ = { readOnlyHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
export const CHANGE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

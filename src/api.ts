/**
 * The only way the MCP tools touch GTDist: a call to the public REST API made with the caller's
 * own bearer token (the server binds it). No business logic lives in this package.
 */
export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path under the API root, e.g. `/v1/inbox`. Path segments must already be encoded. */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export type CallApi = (req: ApiRequest) => Promise<ApiResponse>;

export function withQuery(path: string, query: ApiRequest['query']): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Problem+json from the API as one readable line for the assistant. */
export function problemText(res: ApiResponse): string {
  const p = (res.body ?? {}) as { title?: unknown; detail?: unknown; type?: unknown };
  const title = typeof p.title === 'string' ? p.title : 'Request failed';
  const detail = typeof p.detail === 'string' ? `: ${p.detail}` : '';
  const type = typeof p.type === 'string' ? ` [${p.type}]` : '';
  return `Error ${res.status}${type} — ${title}${detail}`;
}

/**
 * Fields that only serve sync and ordering between replicas (field clocks, fractional sort keys,
 * recurrence bookkeeping, dangling-reference flags): no help to a person or an assistant.
 */
const SYNC_FIELDS = new Set(['sort_key', 'hlc', 'series_id', 'occurrence_index', '_missing_refs']);

function compactNested(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const out = value.map(compactNested).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SYNC_FIELDS.has(k) || (k === 'deleted' && v === false)) continue;
      const c = compactNested(v);
      if (c !== undefined) out[k] = c;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/**
 * The API answer without what costs tokens and says nothing: nulls, empty lists and objects inside
 * records, and sync fields. Top-level lists stay even when empty, so «nothing found» is explicit.
 */
export function compact(body: unknown): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return compactNested(body) ?? body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (SYNC_FIELDS.has(k) || v === null || v === undefined) continue;
    const c = compactNested(v);
    out[k] = c ?? (Array.isArray(v) ? [] : {});
  }
  return out;
}

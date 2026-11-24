import { randomUUID } from 'node:crypto';
import { withQuery, type ApiResponse, type CallApi } from './api.ts';
import { VERSION } from './version.ts';

export const DEFAULT_API_URL = 'https://task.gtdist.app';

export interface HttpApiOptions {
  /** Where the GTDist REST API lives (its `/v1/…` paths), e.g. `https://task.gtdist.app`. */
  baseUrl?: string;
  /** A personal key `sm_pat_…` (or an OAuth access token). Never logged or returned. */
  token: string;
  timeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
}

const problem = (status: number, title: string, detail: string): ApiResponse => ({
  status,
  body: { type: 'network', title, detail },
});

/**
 * `CallApi` over HTTPS for the local (stdio) mode: the same REST calls the hosted `/mcp` makes
 * in-process. Writes carry an `Idempotency-Key`, so the one retry after a dropped connection
 * cannot apply an operation twice.
 */
export function createHttpApi(options: HttpApiOptions): CallApi {
  const base = (options.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 30_000;
  const doFetch = options.fetch ?? fetch;
  return async (req) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token}`,
      accept: 'application/json',
      'user-agent': `gtdist-mcp/${VERSION}`,
    };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    if (req.method !== 'GET') headers['idempotency-key'] = randomUUID();
    const url = base + withQuery(req.path, req.query);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      let text: string;
      try {
        res = await doFetch(url, {
          method: req.method,
          headers,
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        // Inside the try: a timeout or reset while the body streams is the same failure.
        text = await res.text();
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'TimeoutError' || name === 'AbortError')
          return problem(504, 'Timed out', `${base} did not answer in ${timeoutMs / 1000} s`);
        if (attempt === 0) continue;
        const why = err instanceof Error && err.message ? `: ${err.message}` : '';
        return problem(503, 'Network error', `Could not reach ${base}${why}`);
      }
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { title: text.slice(0, 200) };
        }
      }
      return { status: res.status, body };
    }
  };
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallApi } from './api.ts';
import { registerPrompts } from './prompts.ts';
import { registerTools } from './tools.ts';
import type { ToolOptions } from './tools-gtd.ts';
import { VERSION } from './version.ts';

export type { ApiRequest, ApiResponse, CallApi } from './api.ts';
export { compact, withQuery } from './api.ts';
export { DEFAULT_APP_URL, type ToolOptions } from './tools-gtd.ts';
export { VERSION } from './version.ts';

export const SERVER_INFO = { name: 'gtdist', title: 'GTDist', version: VERSION } as const;

const INSTRUCTIONS =
  'GTDist is a GTD planner (David Allen). Collect: capture (or capture_many for a brain dump). ' +
  'Clarify: list_inbox, then clarify_item item by item — preview with dry_run first. Engage: ' +
  'get_next_actions says what fits now by context, time and energy. Reflect: start_weekly_review, ' +
  'find_stuck_projects, list_waiting. Find anything with search, read it in full with fetch. ' +
  'Prompts process_inbox, weekly_review, plan_now and prepare_conversation guide these flows. ' +
  'Never invent hard deadlines: set due_date only when the person named one. Every write returns ' +
  'an audit_id that undo reverts.';

/** A fresh MCP server whose tools call the REST API through `api` (bound to the caller's token). */
export function createMcpServer(api: CallApi, options: ToolOptions = {}): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, prompts: {} },
    instructions: INSTRUCTIONS,
  });
  registerTools(server, api, options);
  registerPrompts(server);
  return server;
}

/**
 * One Streamable HTTP request, stateless: a new server and transport per request, JSON responses
 * (no server-initiated streams). The caller has already authenticated the bearer token.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  api: CallApi,
  options: ToolOptions = {},
): Promise<void> {
  const server = createMcpServer(api, options);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

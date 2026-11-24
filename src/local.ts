import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createHttpApi, DEFAULT_API_URL } from './http-api.ts';
import { createMcpServer } from './index.ts';

export interface LocalIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
}

/**
 * The local mode: an MCP server over stdio that calls the GTDist REST API with a personal key.
 * Returns the exit code to use now (1 for a configuration error), or null while it keeps serving.
 */
export async function runLocal(env: NodeJS.ProcessEnv, io: LocalIo): Promise<number | null> {
  const token = env['GTDIST_TOKEN']?.trim();
  if (!token) {
    io.stderr.write(
      'gtdist-mcp: GTDIST_TOKEN is not set.\n' +
        'Create a personal key in GTDist (Settings → Personal keys, «Личные ключи»), then pass it as\n' +
        'the GTDIST_TOKEN environment variable in your MCP client configuration.\n',
    );
    return 1;
  }
  const baseUrl = env['GTDIST_URL']?.trim() || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    io.stderr.write(`gtdist-mcp: GTDIST_URL is not a valid URL: ${baseUrl}\n`);
    return 1;
  }
  // The key travels in every request: plain http only to this machine.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    io.stderr.write(
      `gtdist-mcp: GTDIST_URL must use https (plain http only for localhost): ${baseUrl}\n`,
    );
    return 1;
  }
  const server = createMcpServer(createHttpApi({ baseUrl, token }), {
    appUrl: env['GTDIST_APP_URL']?.trim() || baseUrl,
  });
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  return null;
}

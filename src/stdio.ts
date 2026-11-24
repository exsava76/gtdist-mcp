#!/usr/bin/env node
/** `gtdist-mcp` — the GTDist MCP server over stdio (GTDIST_TOKEN, optional GTDIST_URL). */
import { runLocal } from './local.ts';

const code = await runLocal(process.env, {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
if (code !== null) process.exit(code);

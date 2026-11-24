# GTDist MCP

[Model Context Protocol](https://modelcontextprotocol.io) server for **[GTDist](https://gtdist.app)**, a planner built on David Allen's *Getting Things Done*. It lets an AI assistant (Claude, ChatGPT, Codex, Cursor, Gemini CLI, VS Code, OpenCode…) capture thoughts into your inbox, clarify them, pick what to do now, keep projects moving and walk you through the weekly review.

- **Hosted:** `https://task.gtdist.app/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration). Nothing to install.
- **Local:** `npx -y github:exsava76/gtdist-mcp` (stdio) with a personal key.

Every tool is a thin wrapper over the GTDist REST API, called with *your* token: the server enforces scopes, area limits and rate limits, and writes every change to the journal, where it can be undone. Answers are compact JSON (also returned as `structuredContent`) to save tokens.

[Русская версия ниже](#по-русски)

## Tools

| GTD stage | Tools |
|---|---|
| **Collect** | `capture`, `capture_many` (up to 50 at once), `parse_to_inbox` (split dictated text into proposed cards; writes nothing) |
| **Clarify** | `list_inbox`, `clarify_item` (to next / waiting / scheduled / tickler / someday / project / done / trash), `suggest_clarification`, `accept_clarification` |
| **Organize** | `create_action`, `update_action`, `list_actions`, `get_item`, `create_project`, `update_project`, `list_projects`, `get_project`, `list_contexts`, `create_context`, `set_current_context` |
| **Reflect** | `start_weekly_review`, `review_step`, `get_review_history`, `find_stuck_projects`, `list_waiting`, `get_nudges`, `get_horizons`, `get_calendar`, `list_done` |
| **Engage** | `get_next_actions` (by context, time and energy), `complete_action`, `get_agenda`, `summarize_agenda`, `draft_reminder`, `suggest_reminder` |
| **Together** | `assign_item`, `list_assigned_to_me`, `add_comment`, `list_comments` |
| **Find** | `search` (`query` → `results: [{id, kind, title, status, url}]`), `fetch` (`id` → `{id, title, text, url, metadata}`, the shape ChatGPT deep research expects) |
| **Safety** | `undo` (by `audit_id`) |

## Prompts

| Prompt | What it does |
|---|---|
| `process_inbox` | Clarify the inbox to zero, item by item, previewing each change |
| `weekly_review` | Get clear, get current, get creative — the 11 review steps |
| `plan_now` | What fits right now (`minutes`, `where`, `energy`) |
| `prepare_conversation` | Agenda and waiting-for items before talking to a `person` |

## Connect

Two ways to sign in:

1. **OAuth (recommended where supported).** Add the hosted URL `https://task.gtdist.app/mcp`; the client opens GTDist in the browser, you choose what it may do and confirm.
2. **Personal key.** In GTDist open **Settings → Personal keys**, create a key with the scopes you want and copy it (`sm_pat_…`, shown once). Use it either with the hosted URL as an `Authorization: Bearer` header, or with the local stdio server as `GTDIST_TOKEN`.

Local server environment: `GTDIST_TOKEN` (required), `GTDIST_URL` (default `https://task.gtdist.app`; https only, plain http is allowed just for localhost), `GTDIST_APP_URL` (base for links in `search` and `fetch` results; defaults to `GTDIST_URL`). Requires Node.js 20 or newer.

### Claude.ai and Claude Desktop

**Settings → Connectors → Add custom connector**, name `GTDist`, URL `https://task.gtdist.app/mcp`, then **Connect** and sign in.

Local server in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "gtdist": {
      "command": "npx",
      "args": ["-y", "github:exsava76/gtdist-mcp"],
      "env": { "GTDIST_TOKEN": "sm_pat_..." }
    }
  }
}
```

### Claude Code

```sh
claude mcp add --transport http gtdist https://task.gtdist.app/mcp
```

Then run `/mcp` in Claude Code and sign in. With a personal key instead:

```sh
claude mcp add --transport http gtdist https://task.gtdist.app/mcp --header "Authorization: Bearer sm_pat_..."
# or locally over stdio
claude mcp add gtdist --env GTDIST_TOKEN=sm_pat_... -- npx -y github:exsava76/gtdist-mcp
```

### ChatGPT

**Settings → Apps & Connectors → Advanced settings**, turn on **Developer mode**, then **Create** a connector: MCP server URL `https://task.gtdist.app/mcp`, authentication **OAuth**. `search` and `fetch` make GTDist usable in deep research.

### OpenAI Codex CLI

`~/.codex/config.toml`, hosted with a personal key from the environment:

```toml
[mcp_servers.gtdist]
url = "https://task.gtdist.app/mcp"
bearer_token_env_var = "GTDIST_TOKEN"
```

or local over stdio:

```toml
[mcp_servers.gtdist]
command = "npx"
args = ["-y", "github:exsava76/gtdist-mcp"]
env = { GTDIST_TOKEN = "sm_pat_..." }
```

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "gtdist": {
      "url": "https://task.gtdist.app/mcp",
      "headers": { "Authorization": "Bearer sm_pat_..." }
    }
  }
}
```

Leave out `headers` to sign in with OAuth instead.

### VS Code

`.vscode/mcp.json` (or **MCP: Add Server** from the command palette):

```json
{
  "servers": {
    "gtdist": { "type": "http", "url": "https://task.gtdist.app/mcp" }
  }
}
```

Local server with the key asked once and stored by VS Code:

```json
{
  "inputs": [
    { "type": "promptString", "id": "gtdist-token", "description": "GTDist personal key", "password": true }
  ],
  "servers": {
    "gtdist": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:exsava76/gtdist-mcp"],
      "env": { "GTDIST_TOKEN": "${input:gtdist-token}" }
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "gtdist": {
      "httpUrl": "https://task.gtdist.app/mcp",
      "headers": { "Authorization": "Bearer sm_pat_..." }
    }
  }
}
```

Leave out `headers` to sign in with OAuth (`/mcp auth gtdist`).

### OpenCode

`opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "gtdist": {
      "type": "local",
      "command": ["npx", "-y", "github:exsava76/gtdist-mcp"],
      "environment": { "GTDIST_TOKEN": "sm_pat_..." },
      "enabled": true
    }
  }
}
```

### Any other client

Hosted: Streamable HTTP at `https://task.gtdist.app/mcp`, OAuth discovery via `WWW-Authenticate` / `/.well-known/oauth-protected-resource`, or a `Bearer` personal key. Local: run `npx -y github:exsava76/gtdist-mcp` with `GTDIST_TOKEN`.

## Scopes and safety

| Scope | Allows |
|---|---|
| `capture` | Write into the inbox only |
| `read` | Read lists, projects, contexts, calendar |
| `write` | Create and change actions, projects, contexts |
| `review` | Clarify the inbox and mark weekly review steps |

- A key or an OAuth grant can be limited to one area of responsibility (for example, only «Work»); everything else is invisible to the assistant.
- `clarify_item`, `accept_clarification`, `update_action`, `complete_action` and `undo` accept `dry_run: true` — a preview of what would change, nothing saved.
- Every write answers in plain lines what changed plus an `audit_id`; `undo` reverts it. The assistant's changes are listed in the GTDist journal under its name.
- Hard deadlines are set only when you name one; the tools tell assistants never to invent dates.
- Revoke access any time in GTDist settings (connected assistants or personal keys). The local server never prints or logs your key.

## Development

```sh
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run typecheck
```

`src/index.ts` exports `createMcpServer(callApi, { appUrl })` and `handleMcpRequest(...)` for hosting the same tools over Streamable HTTP; `src/stdio.ts` is the local binary. This repository is published from the GTDist codebase; issues and pull requests are welcome.

License: [MIT](LICENSE).

---

## По-русски

**GTDist MCP** — сервер [Model Context Protocol](https://modelcontextprotocol.io) для планировщика [GTDist](https://gtdist.app) по методу Дэвида Аллена «Как привести дела в порядок» (GTD). Через него ИИ-ассистент записывает мысли во «Входящие», помогает их разобрать, подсказывает, что сделать сейчас, следит за проектами и ведёт еженедельный обзор.

**Подключение.**

1. **Через вход (OAuth)** — адрес `https://task.gtdist.app/mcp`. Ассистент откроет GTDist в браузере, вы выберете, что ему можно, и подтвердите. Так подключаются Claude.ai и Claude Desktop («Настройки → Коннекторы → Добавить свой коннектор»), Claude Code (`claude mcp add --transport http gtdist https://task.gtdist.app/mcp`), ChatGPT (режим разработчика → новый коннектор), VS Code, Cursor, Gemini CLI.
2. **Личным ключом** — в GTDist «Настройки → Личные ключи», создайте ключ (`sm_pat_…`, показывается один раз). Его можно передать с тем же адресом заголовком `Authorization: Bearer sm_pat_…` (Codex, Cursor, Gemini CLI) или запустить локальный сервер: `npx -y github:exsava76/gtdist-mcp` с переменной `GTDIST_TOKEN`. Готовые настройки для каждого клиента — в разделе [Connect](#connect) выше.

**Инструменты** по этапам GTD: сбор (`capture`, `capture_many`, `parse_to_inbox`), разбор (`list_inbox`, `clarify_item`, подсказки ИИ), организация (действия, проекты, контексты), обзор (`start_weekly_review`, застрявшие проекты, «Жду», календарь, сделанное), действие (`get_next_actions` — что подходит сейчас по контексту, времени и силам), совместная работа, поиск (`search`, `fetch`) и отмена (`undo`). Подсказки (prompts): `process_inbox` — разобрать «Входящие», `weekly_review` — еженедельный обзор, `plan_now` — что сделать сейчас, `prepare_conversation` — подготовка к разговору с человеком.

**Безопасность.** Права выдаются по частям (`capture`, `read`, `write`, `review`), доступ можно ограничить одной зоной ответственности. Любое изменение можно сначала посмотреть (`dry_run`), каждое записывается в журнал и отменяется (`undo`). Жёсткие сроки ассистент ставит только если вы их назвали. Отключить ассистента или ключ можно в настройках GTDist в любой момент; локальный сервер ключ не печатает и не пишет в журналы.

Лицензия — MIT.

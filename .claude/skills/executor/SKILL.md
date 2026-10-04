---
name: executor
description: Use when "Do It Once" must perform an API/tool action (not a browser chore) through Executor (executor.sh), the open-source MCP gateway, e.g. creating a Google Calendar event after a Kernel-replayed booking, from a Mastra workflow step or agent. Covers setup (Cloud / CLI / Docker), connecting Google Calendar, calling Executor's MCP endpoint from TypeScript, and the .ics fallback. Rule: API/tool available -> Executor; human-only website -> Kernel.
---

# Executor (executor.sh): API/MCP actions for agents

Checked 2026-10-04 against the live docs and repo HEAD `98d606b` (2026-09-30). **[UNVERIFIED]** marks things
read from source code or inferred, not stated in the docs. Do not invent tool IDs. Discover them at runtime.

## Identification
- **The product:** **Executor** by Useful Software Co (founder Rhys Sullivan, YC), MIT-licensed. It is "the
  open-source integration layer for AI agents". It puts MCP servers, OpenAPI specs and GraphQL APIs behind
  **one MCP endpoint**, with stored credentials (the agent never sees them) and per-tool policies
  (allow / require approval / block).
  - Site: https://executor.sh · Docs: https://executor.sh/docs · Repo: https://github.com/UsefulSoftwareCo/executor
  - Machine-readable: https://executor.sh/llms.txt, https://executor.sh/docs/llms.txt, https://executor.sh/setup-prompt.md
- **Alternatives considered (rejected):** `github.com/RhysSullivan/executor` (the same project, now under the
  UsefulSoftwareCo org) and generic "MCP gateways" (Obot, etc.). They do not match the sponsor's name.
- **Official agent skills:** none are published for end users. The repo's `.agents/skills` and `.claude/skills`
  are for internal development. The server itself serves usage guides over MCP through its `skills` tool
  (`skills({ name: "execute" })` or `skills({ name: "search-invoke" })`). This file is based on those guides.

## Deployment options (pick one)
| Option | How | MCP URL | Auth to `/mcp` |
|---|---|---|---|
| **Cloud** (recommended for a deployed app) | Sign in at executor.sh. Free for 3 users or fewer. | Copy it from the **Connect** card. It is `https://executor.sh/mcp` or `https://executor.sh/<org-slug>/mcp` **[UNVERIFIED, from source]** | OAuth (WorkOS AuthKit) for interactive clients, or `Authorization: Bearer <user API key>` **[UNVERIFIED, from source]**. Org-scoped keys are rejected for MCP. |
| **CLI (local)** | `npm i -g executor` (Node 20+), then `executor install`, then `executor web` (http://127.0.0.1:4788) | `http://127.0.0.1:4788/mcp` | A local bearer token stored in `~/.executor/server-control/auth.json` **[UNVERIFIED, from source]**. It is reachable only from your machine, not from Fly. |
| **Self-host Docker** | `docker run -d -p 4788:4788 -v executor-data:/data ghcr.io/usefulsoftwareco/executor-selfhost:latest` | `<EXECUTOR_WEB_BASE_URL>/mcp` | Sign in. The first account becomes the owner. |
| Desktop / Cloudflare Worker | See the docs | (same `/mcp`) | |

Query params on `/mcp`: `?mode=passthrough` (the search/invoke tools, **use this from code**),
`elicitation_mode=browser|model`, `artifacts=false`, `search_tools=true`.

## Env vars for our app
```bash
EXECUTOR_MCP_URL=https://executor.sh/<org-slug>/mcp   # copy exactly from Connect card
EXECUTOR_API_KEY=...        # Cloud user API key (the CLI also reads this name). Server-side only, never NEXT_PUBLIC_
# Local daemon instead: EXECUTOR_AUTH_TOKEN=<token from ~/.executor/server-control/auth.json>
```
Self-host server env (documented): `PORT`, `EXECUTOR_WEB_BASE_URL` (**must** equal the public URL or logins and
OAuth callbacks break), `EXECUTOR_DATA_DIR=/data`, `EXECUTOR_SECRET_KEY`, `BETTER_AUTH_SECRET`,
`EXECUTOR_BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD`, `EXECUTOR_ALLOW_LOCAL_NETWORK`.

## Connecting Google Calendar (do this by hand in the web UI, once)
1. Go to Integrations, then Add. Choose the **Google Calendar** preset (built from Google's discovery doc
   `calendar v3`) or the "Google" bundle.
2. Create a **connection**. This runs the OAuth sign-in. Executor stores and refreshes the tokens.
   - **Cloud:** it uses Executor's own first-party Google OAuth client, so no GCP setup is needed
     **[UNVERIFIED, from source]**.
   - **Local / self-host:** you paste your own Google OAuth client ID and secret (a GCP project with the
     Calendar API enabled and a redirect URI set to the Executor host). This is slow at a hackathon, so use Cloud.
3. Policies: GET operations are allowed. POST/PUT/PATCH/DELETE require approval by default. See "Approval
   gotcha" below.
- Other sources: `executor call executor openapi addSource '{"spec":"<url>","namespace":"x","baseUrl":"<url>"}'`
  (CLI docs). The README spells it `addIntegration`, so check `executor tools search` for the right name.
  MCP servers and GraphQL endpoints are added from the UI.

## MCP tool surfaces
- **Default "codemode":** tools `execute({ code })` (TypeScript run in a QuickJS sandbox with a `tools` proxy),
  `skills`, and `resume({ executionId })`. Inside the code you call
  `tools.search({query})`, `tools.describe.tool({path})` and `tools[path](input)`. Results come back as
  `{ok:true,data}` or `{ok:false,error}`. Writes that need approval **pause** and return an `executionId`.
- **`?mode=passthrough` (best for deterministic server code):** tools `integrations({})`,
  `search({ query, integration?, owner?, connection?, offset? })`, `invoke({ tool, arguments })` and `skills`.
  `search` returns each tool's `id` and `inputSchema`. Policy approvals are **auto-accepted on invoke** because
  the client is expected to gate approval (source: `executePassthroughCall`). Block policies still apply.

## Minimal TypeScript: workflow step (deterministic, no LLM)
Uses `@modelcontextprotocol/sdk` (`npm i @modelcontextprotocol/sdk`). The tool id and argument shape come from
`search`. Never hard-code a guessed id.
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

async function withExecutor<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = new URL(process.env.EXECUTOR_MCP_URL!);
  url.searchParams.set("mode", "passthrough");
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${process.env.EXECUTOR_API_KEY}` } },
  });
  const client = new Client({ name: "do-it-once", version: "0.1.0" });
  await client.connect(transport);
  try { return await fn(client); } finally { await client.close(); }
}

const json = (r: any) => JSON.parse(r.content?.find((c: any) => c.type === "text")?.text ?? "null");

export async function createCalendarEvent(ev: { title: string; startISO: string; endISO: string; location?: string }) {
  return withExecutor(async (c) => {
    const found = json(await c.callTool({ name: "search", arguments: { query: "google calendar create event insert" } }));
    const tool = found?.items?.find((t: any) => /events\.insert$/.test(t.id)) ?? found?.items?.[0];
    if (!tool) throw new Error("No Executor calendar tool. Connect Google Calendar in the Executor UI.");
    // Argument shape [UNVERIFIED]: follow tool.inputSchema. Google discovery tools usually take path/query params + a body.
    const res = await c.callTool({ name: "invoke", arguments: { tool: tool.id, arguments: {
      calendarId: "primary",
      body: { summary: ev.title, location: ev.location,
              start: { dateTime: ev.startISO }, end: { dateTime: ev.endISO } },
    } } });
    if (res.isError) throw new Error(`Executor invoke failed: ${JSON.stringify(res.content)}`);
    return json(res);
  });
}
```
In development, log `tool.id` and `tool.inputSchema` once, then fix the argument mapping to match. The exact
JSON shape of `search` and `invoke` results (text content vs `structuredContent`) is **[UNVERIFIED]**, so check
both.

## Mastra agent option (`@mastra/mcp`, not installed yet: `npm i @mastra/mcp`)
```ts
import { MCPClient } from "@mastra/mcp";
export const executorMcp = new MCPClient({
  id: "executor",
  servers: { executor: {
    url: new URL(`${process.env.EXECUTOR_MCP_URL}?mode=passthrough`),
    requestInit: { headers: { Authorization: `Bearer ${process.env.EXECUTOR_API_KEY}` } },
  } },
});
// Agent: new Agent({ ..., tools: await executorMcp.listTools() })  -> executor_search, executor_invoke, ...
// Or per call: agent.generate(prompt, { toolsets: await executorMcp.listToolsets() })
```
Mastra docs: https://mastra.ai/reference/tools/mcp-client. In a workflow step, the plain MCP SDK above is more
predictable than letting an LLM pick tools. If the URL already has a query string, add `mode` with
`URLSearchParams`.

## Gotchas
- **Approval gotcha:** in the default codemode, `execute` pauses on POST (calendar insert) and returns an
  `executionId`. A headless server then hangs or fails. Use `?mode=passthrough`, or set that tool's policy to
  **Allow** in the UI.
- A local daemon (`127.0.0.1:4788`) is unreachable from Fly or Vercel. A deployed app needs Cloud or self-hosted
  Docker.
- Self-host: if `EXECUTOR_WEB_BASE_URL` does not match the public URL, you get invalid-origin errors and OAuth
  callbacks break. Always mount `/data`.
- The `tools` proxy in `execute` cannot be enumerated (`Object.keys` throws), and `fetch` is not available in
  the sandbox.
- If `integrations` shows a health of null or failing, the user must reconnect in the UI. Never pass Google
  credentials through chat or code.
- Keep `EXECUTOR_API_KEY` server-side (a Next.js route handler or Mastra step), never in client components.

## Fallback if Google OAuth is too slow
1. **.ics file (zero dependencies, always works).** Return it as a download or email attachment:
```ts
export function toICS(e: { uid: string; title: string; start: Date; end: Date; location?: string }) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//DoItOnce//EN","BEGIN:VEVENT",
    `UID:${e.uid}@doitonce`,`DTSTAMP:${f(new Date())}`,`DTSTART:${f(e.start)}`,`DTEND:${f(e.end)}`,
    `SUMMARY:${e.title}`, e.location ? `LOCATION:${e.location}` : "", "END:VEVENT","END:VCALENDAR"]
    .filter(Boolean).join("\r\n");   // serve with Content-Type: text/calendar
}
```
2. **Google "add event" link** (the user clicks once, no OAuth):
   `https://calendar.google.com/calendar/render?action=TEMPLATE&text=<enc title>&dates=<YYYYMMDDTHHMMSSZ>/<end>&location=<enc>`.
3. **Keep Executor in the demo:** connect any one-click integration that Cloud supports (for example Slack,
   Linear or Notion through first-party OAuth **[UNVERIFIED]**), or a no-auth public OpenAPI spec. Then
   `invoke` a "post reminder" action and attach the .ics.

## Open questions (verify at the event)
- The exact Cloud MCP URL and where to create a user API key (Settings? Connect card?).
- Whether Cloud's first-party Google OAuth is live for consumer Gmail accounts (the app may be unverified).
- The exact Calendar tool id (`...events.insert`?) and its `inputSchema` (`body` vs flattened fields).
- The `@executor-js/sdk` packages (README) appear to embed Executor in-process rather than act as a remote client.
  They are not used here.

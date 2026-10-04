// Executor MCP client (passthrough mode) + pure helpers for the Google Calendar insert call.
// Executor passthrough tools: integrations({}), search({query,...}), invoke({tool, arguments}), skills.
// Result shapes are not fully documented, so every parser below is tolerant.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CalendarEventInput } from '@/lib/contracts';

/** The tiny slice of the MCP client we use (mockable in tests). */
export interface McpLike {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  listTools?(): Promise<{ tools: { name: string; description?: string }[] }>;
  close(): Promise<void>;
}

/** HTTP = Executor Cloud / self-host (`/mcp` + Bearer). stdio = local CLI (`executor mcp --mode passthrough`). */
export type ExecutorConfig =
  | { kind: 'http'; url: string; apiKey: string }
  | { kind: 'stdio'; command: string; args: string[] };

type Env = Record<string, string | undefined>;

/** Find the `executor` CLI on PATH (Windows: executor.cmd / .exe). EXECUTOR_BIN overrides. */
export function resolveExecutorBin(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  const override = env.EXECUTOR_BIN?.trim();
  if (override) return override;
  const win = platform === 'win32';
  const names = win ? ['executor.cmd', 'executor.exe', 'executor.bat'] : ['executor'];
  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(win ? ';' : ':')) {
    if (!dir) continue;
    for (const n of names) {
      const p = win ? path.win32.join(dir, n) : path.posix.join(dir, n);
      if (exists(p)) return p;
    }
  }
  return null;
}

/**
 * Transport selection: EXECUTOR_MCP_URL + EXECUTOR_API_KEY → HTTP; else the local `executor` CLI on
 * PATH (unless EXECUTOR_LOCAL=0) → stdio; else null (→ .ics fallback).
 */
export function readExecutorConfig(
  env: Env = process.env,
  resolveBin: (env: Env) => string | null = (e) => resolveExecutorBin(e),
): ExecutorConfig | null {
  const url = env.EXECUTOR_MCP_URL?.trim();
  const apiKey = (env.EXECUTOR_API_KEY ?? env.EXECUTOR_AUTH_TOKEN)?.trim();
  if (url && apiKey) return { kind: 'http', url, apiKey };
  if (env.EXECUTOR_LOCAL?.trim() === '0') return null;
  const command = resolveBin(env);
  return command ? { kind: 'stdio', command, args: ['mcp', '--mode', 'passthrough'] } : null;
}

export function describeConfig(cfg: ExecutorConfig): string {
  if (cfg.kind === 'stdio') return `stdio: ${cfg.command} ${cfg.args.join(' ')}`;
  const u = new URL(cfg.url);
  return `http: ${u.origin}${u.pathname}`;
}

export async function connectExecutor(cfg: ExecutorConfig): Promise<McpLike> {
  const client = new Client({ name: 'do-it-once', version: '0.1.0' });
  if (cfg.kind === 'http') {
    const url = new URL(cfg.url);
    url.searchParams.set('mode', 'passthrough');
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${cfg.apiKey}` } } }),
    );
  } else {
    // Attaches to the running local Executor daemon. cross-spawn (inside the SDK) handles .cmd on Windows.
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...getDefaultEnvironment(), ...(process.env.HOME ? { HOME: process.env.HOME } : {}) },
      stderr: 'pipe', // keep the CLI's logs out of our stdout; drained below
    });
    transport.stderr?.on('data', () => undefined);
    await client.connect(transport);
    const pid = transport.pid;
    if (pid) {
      killOnExit(pid);
      return {
        callTool: (p) => client.callTool(p),
        listTools: () => client.listTools(),
        close: async () => {
          exitPids.delete(pid);
          await client.close();
        },
      };
    }
  }
  return client as unknown as McpLike;
}

const exitPids = new Set<number>();
let exitHookInstalled = false;
function killOnExit(pid: number) {
  exitPids.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const p of exitPids) {
      try {
        // Windows: the pid is the .cmd shim; kill its whole tree. Synchronous calls are allowed in 'exit'.
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(p);
      } catch {
        /* already gone */
      }
    }
  });
}

// ───────── result parsing ─────────

type Json = unknown;
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pull JSON out of a CallToolResult: structuredContent first, then the first parseable text block. */
export function parseToolResult(res: unknown): Json {
  if (!isRec(res)) return res;
  if (res.structuredContent !== undefined) return res.structuredContent;
  const content = Array.isArray(res.content) ? res.content : [];
  const texts = content.filter((c): c is { type: 'text'; text: string } => isRec(c) && c.type === 'text' && typeof c.text === 'string');
  for (const t of texts) {
    try {
      return JSON.parse(t.text);
    } catch {
      /* not JSON */
    }
  }
  return texts.map((t) => t.text).join('\n') || null;
}

/** Text of an MCP error result, for messages. */
export function toolErrorText(res: unknown): string {
  const parsed = parseToolResult(res);
  return (typeof parsed === 'string' ? parsed : JSON.stringify(parsed)).slice(0, 500);
}

/** Executor sometimes wraps results as {ok, data} / {ok:false, error}. */
function unwrap(v: Json): Json {
  if (isRec(v) && 'ok' in v && ('data' in v || 'error' in v)) {
    if (v.ok === false) throw new Error(`Executor error: ${JSON.stringify(v.error).slice(0, 400)}`);
    return v.data;
  }
  return v;
}

export interface FoundTool {
  id: string;
  description: string;
  inputSchema: Rec | null;
}

export function extractSearchItems(raw: Json): FoundTool[] {
  const v = unwrap(raw);
  let arr: unknown[] = [];
  if (Array.isArray(v)) arr = v;
  else if (isRec(v)) {
    for (const k of ['items', 'results', 'tools', 'matches']) {
      if (Array.isArray(v[k])) {
        arr = v[k] as unknown[];
        break;
      }
    }
  }
  return arr.filter(isRec).flatMap((t) => {
    const id = [t.id, t.path, t.tool, t.name].find((x) => typeof x === 'string') as string | undefined;
    if (!id) return [];
    const schema = [t.inputSchema, t.input_schema, t.schema, t.parameters].find(isRec) ?? null;
    return [{ id, description: typeof t.description === 'string' ? t.description : '', inputSchema: schema }];
  });
}

/** Pick the Google Calendar "events.insert" tool from search results. */
export function pickCalendarInsertTool(items: FoundTool[]): FoundTool | null {
  const score = (t: FoundTool) => {
    const s = `${t.id} ${t.description}`.toLowerCase();
    let n = 0;
    if (/events[._/-]?insert\b/.test(t.id.toLowerCase())) n += 10;
    if (/calendar/.test(s)) n += 3;
    if (/\binsert\b|\bcreate\b/.test(s)) n += 2;
    if (/\bevents?\b/.test(s)) n += 1;
    if (/quick ?add|import|instances|delete|update|patch|list|watch|move/.test(t.id.toLowerCase())) n -= 6;
    return n;
  };
  const ranked = items.map((t) => ({ t, n: score(t) })).filter((x) => x.n >= 5).sort((a, b) => b.n - a.n);
  return ranked[0]?.t ?? null;
}

/** Google Calendar Event resource for our input. Times are sent as UTC ISO (RFC 3339). */
export function toGoogleEvent(input: CalendarEventInput): Rec {
  const ev: Rec = {
    summary: input.title,
    start: { dateTime: new Date(input.start).toISOString() },
    end: { dateTime: new Date(input.end).toISOString() },
  };
  if (input.location) ev.location = input.location;
  if (input.description) ev.description = input.description;
  return ev;
}

/**
 * Map our input onto the tool's real inputSchema.
 * Supported shapes: a body field (`body` / `requestBody` / `resource` / `event`), or flattened
 * event fields next to `calendarId`. Unknown schema → the documented default `{calendarId, body}`.
 */
export function buildInsertArguments(tool: FoundTool, input: CalendarEventInput, calendarId = 'primary'): Rec {
  const event = toGoogleEvent(input);
  const props = isRec(tool.inputSchema?.properties) ? (tool.inputSchema!.properties as Rec) : null;
  if (!props) return { calendarId, body: event };

  const args: Rec = {};
  if ('calendarId' in props) args.calendarId = calendarId;
  const bodyKey = ['body', 'requestBody', 'resource', 'event', 'data'].find((k) => k in props);
  if (bodyKey) {
    args[bodyKey] = event;
    return args;
  }
  // Nested path/query containers (e.g. {path:{calendarId}, body})
  if ('path' in props) args.path = { calendarId };
  if ('summary' in props || 'start' in props) Object.assign(args, event);
  else args.body = event;
  return args;
}

/** Find the event's htmlLink (or id) anywhere in the invoke result. */
export function extractEventLink(raw: Json): { url: string | null; id: string | null } {
  let url: string | null = null;
  let id: string | null = null;
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (isRec(v)) {
      if (!url && typeof v.htmlLink === 'string') url = v.htmlLink;
      if (!id && typeof v.id === 'string' && (v.kind === 'calendar#event' || 'htmlLink' in v)) id = v.id;
    }
    for (const c of Object.values(v as Rec)) walk(c, depth + 1);
  };
  walk(raw, 0);
  return { url, id };
}

export { unwrap as unwrapExecutorResult };

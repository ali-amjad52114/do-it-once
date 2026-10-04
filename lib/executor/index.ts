// Executor (executor.sh) tool adapter — agent L3.
// Rule: API/tool available → Executor; human-only website → Kernel.
// createCalendarEvent: Executor MCP (passthrough) → Google Calendar events.insert; on any problem,
// falls back to an RFC 5545 .ics file so the demo never breaks.
import type { CalendarEventInput, ToolActionResult, ToolAdapter } from '@/lib/contracts';
import { buildIcs } from './ics';
import {
  buildInsertArguments,
  connectExecutor,
  describeConfig,
  extractEventLink,
  extractSearchItems,
  parseToolResult,
  pickCalendarInsertTool,
  readExecutorConfig,
  toolErrorText,
  unwrapExecutorResult,
  type ExecutorConfig,
  type FoundTool,
  type McpLike,
} from './mcp';

export { buildIcs, escapeIcsText, foldIcsLine, formatIcsUtc } from './ics';
export { buildInsertArguments, describeConfig, pickCalendarInsertTool, readExecutorConfig, resolveExecutorBin } from './mcp';
export type { ExecutorConfig, McpLike, FoundTool } from './mcp';

const SEARCH_QUERIES = ['google calendar create event', 'google calendar events insert', 'calendar event'];
const DEFAULT_TIMEOUT_MS = 25_000;

export class CalendarNotConnectedError extends Error {
  constructor() {
    super('Google Calendar not connected in Executor');
    this.name = 'CalendarNotConnectedError';
  }
}

export type ClientCache = Map<string, Promise<McpLike>>;

export interface ToolAdapterDeps {
  /** Defaults to readExecutorConfig(): HTTP if EXECUTOR_MCP_URL+EXECUTOR_API_KEY, else local stdio CLI, else null. */
  config?: ExecutorConfig | null;
  /** Defaults to connectExecutor (Streamable HTTP or stdio, passthrough mode). */
  connect?: (cfg: ExecutorConfig) => Promise<McpLike>;
  /** Client cache. Default: a globalThis cache when `connect` is the default; none when `connect` is injected. */
  cache?: ClientCache | false;
  calendarId?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

// One connected client per config, shared across Next.js hot reloads / route handlers.
const g = globalThis as typeof globalThis & { __doItOnceExecutorClients?: ClientCache };
function globalCache(): ClientCache {
  return (g.__doItOnceExecutorClients ??= new Map());
}

interface Lease {
  client: McpLike;
  /** Done with the client. `broken` drops a cached client so the next call reconnects. */
  release(broken?: boolean): Promise<void>;
}

async function acquire(cfg: ExecutorConfig, deps: Pick<ToolAdapterDeps, 'connect' | 'cache'>): Promise<Lease> {
  const connect = deps.connect ?? connectExecutor;
  const cache = deps.cache === undefined ? (deps.connect ? false : globalCache()) : deps.cache;
  if (!cache) {
    const client = await connect(cfg);
    return { client, release: () => client.close().catch(() => undefined) };
  }
  const key = JSON.stringify(cfg);
  let p = cache.get(key);
  if (!p) {
    p = connect(cfg);
    cache.set(key, p);
    p.catch(() => cache.get(key) === p && cache.delete(key));
  }
  const client = await p;
  return {
    client,
    release: async (broken) => {
      if (!broken) return;
      if (cache.get(key) === p) cache.delete(key);
      await client.close().catch(() => undefined);
    },
  };
}

/** Closes every cached Executor client (and the local `executor mcp` child process). */
export async function closeExecutor(): Promise<void> {
  const cache = globalCache();
  const all = [...cache.values()];
  cache.clear();
  await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => undefined)));
}

let schemaLogged = false;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

async function call(client: McpLike, name: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await client.callTool({ name, arguments: args });
  if (res && typeof res === 'object' && (res as { isError?: boolean }).isError) {
    throw new Error(`Executor ${name} failed: ${toolErrorText(res)}`);
  }
  return parseToolResult(res);
}

/** search → pick events.insert → invoke. Exported for tests. */
export async function createViaExecutor(
  client: McpLike,
  input: CalendarEventInput,
  opts: { calendarId?: string; log?: (m: string) => void } = {},
): Promise<ToolActionResult> {
  const log = opts.log ?? ((m: string) => console.info(m));
  let tool: FoundTool | null = null;
  for (const query of SEARCH_QUERIES) {
    tool = pickCalendarInsertTool(extractSearchItems(await call(client, 'search', { query })));
    if (tool) break;
  }
  if (!tool) throw new CalendarNotConnectedError();

  if (!schemaLogged) {
    schemaLogged = true;
    log(`[executor] using tool ${tool.id}; inputSchema=${JSON.stringify(tool.inputSchema)?.slice(0, 2000)}`);
  }

  const args = buildInsertArguments(tool, input, opts.calendarId ?? 'primary');
  const result = unwrapExecutorResult(await call(client, 'invoke', { tool: tool.id, arguments: args }));
  const { url, id } = extractEventLink(result);
  return {
    ok: true,
    via: 'executor',
    detail: `Added to Google Calendar via Executor (${tool.id}${id ? `, event ${id}` : ''})`,
    url,
  };
}

function icsFallback(input: CalendarEventInput, err: unknown): ToolActionResult {
  let detail = 'Calendar file ready';
  if (err instanceof CalendarNotConnectedError) detail = `Calendar file ready (${err.message})`;
  else if (err) detail = `Calendar file ready (Executor unavailable: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)})`;
  return {
    ok: true,
    via: 'ics',
    detail,
    url: null,
    icsContent: buildIcs(input),
  };
}

export function createToolAdapter(deps: ToolAdapterDeps = {}): ToolAdapter {
  return {
    async createCalendarEvent(input) {
      const cfg = deps.config === undefined ? readExecutorConfig() : deps.config;
      if (!cfg) return icsFallback(input, null);
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const run = (async () => {
        const lease = await acquire(cfg, deps);
        let broken = false;
        try {
          return await createViaExecutor(lease.client, input, { calendarId: deps.calendarId, log: deps.log });
        } catch (e) {
          broken = !(e instanceof CalendarNotConnectedError);
          throw e;
        } finally {
          await lease.release(broken); // also runs if the timeout already fired
        }
      })();
      run.catch(() => undefined); // avoid an unhandled rejection after a timeout
      try {
        return await withTimeout(run, timeoutMs, 'Executor calendar call');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (deps.log ?? console.warn)(`[executor] falling back to .ics: ${msg}`);
        return icsFallback(input, err);
      }
    },
  };
}

export function getToolAdapter(): ToolAdapter {
  return createToolAdapter();
}

// ───────── generic tool access (agent: search any connected integration, then invoke) ─────────

export interface ExecutorToolHit {
  id: string;
  integration: string | null;
  description: string;
  inputSchema: Record<string, unknown> | null;
  /** True when the tool looks like it changes something (create/send/delete/book...). */
  writes: boolean;
}

const WRITE_VERBS =
  /(^|[._/-])(insert|create|add|update|patch|put|post|delete|remove|clear|move|import|send|reply|forward|draft|trash|modify|set|book|reserve|purchase|buy|order|pay|checkout|cancel|submit|upload|share|stop|watch|publish)/i;

/** Heuristic: does this Executor tool id describe a write action? Exported for tests. */
export function isWriteTool(toolId: string): boolean {
  const name = toolId.split('.').slice(-2).join('.');
  return WRITE_VERBS.test(name);
}

function integrationOf(toolId: string): string | null {
  const m = /^tools\.([^.]+)\./.exec(toolId);
  return m ? m[1] : null;
}

async function withLease<T>(fn: (client: McpLike) => Promise<T>, deps: Pick<ToolAdapterDeps, 'config' | 'connect' | 'cache'> = {}) {
  const cfg = deps.config === undefined ? readExecutorConfig() : deps.config;
  if (!cfg) throw new Error('Executor not configured: set EXECUTOR_MCP_URL + EXECUTOR_API_KEY');
  const lease = await acquire(cfg, deps);
  let broken = false;
  try {
    return await fn(lease.client);
  } catch (e) {
    broken = true;
    throw e;
  } finally {
    await lease.release(broken);
  }
}

/** Search every connected Executor integration for tools matching a plain-language query. */
export async function searchExecutorTools(
  query: string,
  opts: { integration?: string; limit?: number } & Pick<ToolAdapterDeps, 'config' | 'connect' | 'cache'> = {},
): Promise<ExecutorToolHit[]> {
  const { integration, limit = 8, ...deps } = opts;
  const raw = await withLease(
    (c) => call(c, 'search', integration ? { query, integration } : { query }),
    deps,
  );
  return extractSearchItems(raw)
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      integration: integrationOf(t.id),
      description: t.description.slice(0, 400),
      inputSchema: t.inputSchema,
      writes: isWriteTool(t.id),
    }));
}

/** Invoke one Executor tool by id with JSON arguments. Returns the unwrapped result. */
export async function invokeExecutorTool(
  toolId: string,
  args: Record<string, unknown>,
  deps: Pick<ToolAdapterDeps, 'config' | 'connect' | 'cache'> = {},
): Promise<unknown> {
  return withLease(async (c) => unwrapExecutorResult(await call(c, 'invoke', { tool: toolId, arguments: args })), deps);
}

export interface ExecutorToolsReport {
  transport: string;
  mcpTools: string[];
  integrations: unknown;
  searchQuery: string;
  searchResult: unknown;
  calendarTools: FoundTool[];
}

/** Debugging: MCP tools, connected integrations and what a calendar search returns. Throws if not configured. */
export async function listExecutorTools(
  deps: Pick<ToolAdapterDeps, 'config' | 'connect' | 'cache'> = {},
): Promise<ExecutorToolsReport> {
  const cfg = deps.config === undefined ? readExecutorConfig() : deps.config;
  if (!cfg) throw new Error('Executor not configured: set EXECUTOR_MCP_URL + EXECUTOR_API_KEY, or install the executor CLI');
  const lease = await acquire(cfg, deps);
  let broken = false;
  try {
    const { client } = lease;
    const mcpTools = client.listTools ? (await client.listTools()).tools.map((t) => t.name) : [];
    const integrations = await call(client, 'integrations', {}).catch((e: Error) => `error: ${e.message}`);
    const searchQuery = SEARCH_QUERIES[0];
    const searchResult = await call(client, 'search', { query: searchQuery });
    return {
      transport: describeConfig(cfg),
      mcpTools,
      integrations,
      searchQuery,
      searchResult,
      calendarTools: extractSearchItems(searchResult),
    };
  } catch (e) {
    broken = true;
    throw e;
  } finally {
    await lease.release(broken);
  }
}

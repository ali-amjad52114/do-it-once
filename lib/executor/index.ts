// Executor (executor.sh) tool adapter — agent L3.
// Rule: API/tool available → Executor; human-only website → Kernel.
// createCalendarEvent: Executor MCP (passthrough) → Google Calendar events.insert; on any problem,
// falls back to an RFC 5545 .ics file so the demo never breaks.
import type { CalendarEventInput, ToolActionResult, ToolAdapter } from '@/lib/contracts';
import { buildIcs } from './ics';
import {
  buildInsertArguments,
  connectExecutor,
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
export { buildInsertArguments, pickCalendarInsertTool, readExecutorConfig } from './mcp';
export type { McpLike, FoundTool } from './mcp';

const SEARCH_QUERIES = ['google calendar events insert', 'calendar create event', 'calendar event'];
const DEFAULT_TIMEOUT_MS = 25_000;

export interface ToolAdapterDeps {
  /** Defaults to EXECUTOR_MCP_URL + EXECUTOR_API_KEY from process.env. */
  config?: ExecutorConfig | null;
  /** Defaults to a Streamable HTTP MCP client in passthrough mode. */
  connect?: (cfg: ExecutorConfig) => Promise<McpLike>;
  calendarId?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
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
  if (!tool) throw new Error('No Google Calendar insert tool found in Executor. Connect Google Calendar in the Executor UI.');

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

function icsFallback(input: CalendarEventInput, reason: string | null): ToolActionResult {
  return {
    ok: true,
    via: 'ics',
    detail: reason ? `Calendar file ready (Executor unavailable: ${reason})` : 'Calendar file ready',
    url: null,
    icsContent: buildIcs(input),
  };
}

export function createToolAdapter(deps: ToolAdapterDeps = {}): ToolAdapter {
  return {
    async createCalendarEvent(input) {
      const cfg = deps.config === undefined ? readExecutorConfig() : deps.config;
      if (!cfg) return icsFallback(input, null);
      const connect = deps.connect ?? connectExecutor;
      const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const run = (async () => {
        const client = await connect(cfg);
        try {
          return await createViaExecutor(client, input, { calendarId: deps.calendarId, log: deps.log });
        } finally {
          await client.close().catch(() => undefined); // also runs if the timeout already fired
        }
      })();
      run.catch(() => undefined); // avoid an unhandled rejection after a timeout
      try {
        return await withTimeout(run, timeoutMs, 'Executor calendar call');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        (deps.log ?? console.warn)(`[executor] falling back to .ics: ${msg}`);
        return icsFallback(input, msg.slice(0, 300));
      }
    },
  };
}

export function getToolAdapter(): ToolAdapter {
  return createToolAdapter();
}

/** Debugging: the MCP tools Executor exposes plus its connected integrations. Throws if not configured. */
export async function listExecutorTools(
  deps: Pick<ToolAdapterDeps, 'config' | 'connect'> = {},
): Promise<{ mcpTools: string[]; integrations: unknown; calendarTools: FoundTool[] }> {
  const cfg = deps.config === undefined ? readExecutorConfig() : deps.config;
  if (!cfg) throw new Error('Executor not configured: set EXECUTOR_MCP_URL and EXECUTOR_API_KEY');
  const client = await (deps.connect ?? connectExecutor)(cfg);
  try {
    const mcpTools = client.listTools ? (await client.listTools()).tools.map((t) => t.name) : [];
    const integrations = await call(client, 'integrations', {}).catch((e: Error) => `error: ${e.message}`);
    const calendarTools = extractSearchItems(await call(client, 'search', { query: 'google calendar' }));
    return { mcpTools, integrations, calendarTools };
  } finally {
    await client.close().catch(() => undefined);
  }
}

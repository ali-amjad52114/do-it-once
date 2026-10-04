import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventInput } from '@/lib/contracts';
import { createToolAdapter, invokeExecutorTool, isWriteTool, listExecutorTools, searchExecutorTools } from './index';
import { buildInsertArguments, extractEventLink, extractSearchItems, pickCalendarInsertTool, readExecutorConfig, resolveExecutorBin, type McpLike } from './mcp';

const input: CalendarEventInput = {
  title: 'Return drop-off',
  start: '2026-10-05T17:00:00.000Z',
  end: '2026-10-05T17:30:00.000Z',
  location: 'UPS Store',
};
const cfg = { kind: 'http' as const, url: 'https://executor.sh/acme/mcp', apiKey: 'k' };
const stdioCfg = { kind: 'stdio' as const, command: 'executor', args: ['mcp', '--mode', 'passthrough'] };
const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

const insertSchema = {
  type: 'object',
  properties: { calendarId: { type: 'string' }, body: { type: 'object' }, sendUpdates: { type: 'string' } },
  required: ['calendarId'],
};

function mockClient(over: Partial<Record<'search' | 'invoke', (args: any) => unknown>> = {}) {
  const calls: { name: string; arguments?: any }[] = [];
  const client: McpLike & { calls: typeof calls } = {
    calls,
    callTool: vi.fn(async (p: { name: string; arguments?: any }) => {
      calls.push(p);
      if (p.name === 'search')
        return (over.search ?? (() => text({ items: [
          { id: 'google_calendar.events.list', description: 'List events', inputSchema: {} },
          { id: 'google_calendar.events.insert', description: 'Creates an event.', inputSchema: insertSchema },
        ] })))(p.arguments);
      if (p.name === 'invoke')
        return (over.invoke ?? (() => text({ ok: true, data: { kind: 'calendar#event', id: 'ev1', htmlLink: 'https://www.google.com/calendar/event?eid=ev1' } })))(p.arguments);
      return text({});
    }),
    close: vi.fn(async () => undefined),
  };
  return client;
}

describe('fallback selection', () => {
  it('uses .ics when Executor is not configured', async () => {
    const connect = vi.fn();
    const r = await createToolAdapter({ config: null, connect }).createCalendarEvent(input);
    expect(r).toMatchObject({ ok: true, via: 'ics', detail: 'Calendar file ready' });
    expect(r.icsContent).toContain('BEGIN:VEVENT');
    expect(connect).not.toHaveBeenCalled();
  });

});

describe('transport selection', () => {
  const noBin = () => null;
  const bin = () => 'C:\\node\\executor.cmd';

  it('HTTP when URL + key are set (even if the CLI is installed)', () => {
    expect(readExecutorConfig({ EXECUTOR_MCP_URL: 'https://x/mcp', EXECUTOR_API_KEY: 'k' }, bin)).toEqual({ kind: 'http', url: 'https://x/mcp', apiKey: 'k' });
  });
  it('stdio when only the CLI is available', () => {
    expect(readExecutorConfig({ EXECUTOR_MCP_URL: 'https://x/mcp' }, bin)).toEqual({
      kind: 'stdio',
      command: 'C:\\node\\executor.cmd',
      args: ['mcp', '--mode', 'passthrough'],
    });
    expect(readExecutorConfig({}, bin)?.kind).toBe('stdio');
  });
  it('EXECUTOR_LOCAL=0 disables stdio', () => {
    expect(readExecutorConfig({ EXECUTOR_LOCAL: '0' }, bin)).toBeNull();
  });
  it('null (→ ics) when nothing is available', () => {
    expect(readExecutorConfig({}, noBin)).toBeNull();
  });
  it('resolves executor.cmd on Windows PATH, plain executor elsewhere, and EXECUTOR_BIN overrides', () => {
    const files = new Set(['C:\\b\\executor.cmd', '/usr/local/bin/executor']);
    const exists = (p: string) => files.has(p);
    expect(resolveExecutorBin({ PATH: 'C:\\a;C:\\b' }, 'win32', exists)).toBe('C:\\b\\executor.cmd');
    expect(resolveExecutorBin({ Path: 'C:\\b' }, 'win32', exists)).toBe('C:\\b\\executor.cmd');
    expect(resolveExecutorBin({ PATH: '/usr/bin:/usr/local/bin' }, 'linux', exists)).toBe('/usr/local/bin/executor');
    expect(resolveExecutorBin({ PATH: 'C:\\a' }, 'win32', exists)).toBeNull();
    expect(resolveExecutorBin({ PATH: '', EXECUTOR_BIN: '/opt/executor' }, 'linux', exists)).toBe('/opt/executor');
  });
});

describe('client caching', () => {
  it('reuses one client across calls and drops it after a transport failure', async () => {
    const cache = new Map();
    const client = mockClient();
    const connect = vi.fn(async () => client);
    const adapter = createToolAdapter({ config: stdioCfg, connect, cache, log: () => {} });
    expect((await adapter.createCalendarEvent(input)).via).toBe('executor');
    expect((await adapter.createCalendarEvent(input)).via).toBe('executor');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.close).not.toHaveBeenCalled();

    // "not connected" keeps the client; a real error drops it
    const notConnected = mockClient({ search: () => text({ items: [] }) });
    const c2 = new Map();
    const connect2 = vi.fn(async () => notConnected);
    const a2 = createToolAdapter({ config: stdioCfg, connect: connect2, cache: c2, log: () => {} });
    expect((await a2.createCalendarEvent(input)).detail).toContain('not connected');
    expect(c2.size).toBe(1);

    const failing = mockClient({ invoke: () => { throw new Error('pipe closed'); } });
    const c3 = new Map();
    const a3 = createToolAdapter({ config: stdioCfg, connect: async () => failing, cache: c3, log: () => {} });
    expect((await a3.createCalendarEvent(input)).detail).toContain('pipe closed');
    expect(c3.size).toBe(0);
    expect(failing.close).toHaveBeenCalled();
  });

  it('falls back with the Executor error when connect fails', async () => {
    const r = await createToolAdapter({ config: cfg, connect: async () => { throw new Error('401 Unauthorized'); }, log: () => {} }).createCalendarEvent(input);
    expect(r.via).toBe('ics');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('401 Unauthorized');
    expect(r.icsContent).toContain('SUMMARY:Return drop-off');
  });

  it('falls back when invoke returns an MCP error, and closes the client', async () => {
    const client = mockClient({ invoke: () => ({ isError: true, content: [{ type: 'text', text: 'policy blocked' }] }) });
    const r = await createToolAdapter({ config: cfg, connect: async () => client, log: () => {} }).createCalendarEvent(input);
    expect(r.via).toBe('ics');
    expect(r.detail).toContain('policy blocked');
    expect(client.close).toHaveBeenCalled();
  });

  it('falls back when no calendar tool is connected', async () => {
    const client = mockClient({ search: () => text({ items: [] }) });
    const r = await createToolAdapter({ config: cfg, connect: async () => client, log: () => {} }).createCalendarEvent(input);
    expect(r.via).toBe('ics');
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('Calendar file ready (Google Calendar not connected in Executor)');
  });

  it('falls back on timeout', async () => {
    const client = mockClient({ search: () => new Promise(() => {}) });
    const r = await createToolAdapter({ config: cfg, connect: async () => client, timeoutMs: 20, log: () => {} }).createCalendarEvent(input);
    expect(r.via).toBe('ics');
    expect(r.detail).toContain('timed out');
  });
});

describe('executor path with a mocked MCP client', () => {
  it('searches, invokes events.insert with mapped args and returns the link', async () => {
    const client = mockClient();
    const r = await createToolAdapter({ config: cfg, connect: async () => client, log: () => {} }).createCalendarEvent(input);
    expect(r).toMatchObject({ ok: true, via: 'executor', url: 'https://www.google.com/calendar/event?eid=ev1' });
    const invoke = client.calls.find((c) => c.name === 'invoke')!;
    expect(invoke.arguments).toEqual({
      tool: 'google_calendar.events.insert',
      arguments: {
        calendarId: 'primary',
        body: {
          summary: 'Return drop-off',
          location: 'UPS Store',
          start: { dateTime: '2026-10-05T17:00:00.000Z' },
          end: { dateTime: '2026-10-05T17:30:00.000Z' },
        },
      },
    });
    expect(client.close).toHaveBeenCalled();
  });

  it('accepts structuredContent search results', async () => {
    const client = mockClient({ search: () => ({ content: [], structuredContent: { results: [{ path: 'gcal.events.insert', input_schema: insertSchema }] } }) });
    const r = await createToolAdapter({ config: cfg, connect: async () => client, log: () => {} }).createCalendarEvent(input);
    expect(r.via).toBe('executor');
  });

  it('listExecutorTools reports tools and integrations', async () => {
    const client = mockClient();
    client.listTools = async () => ({ tools: [{ name: 'search' }, { name: 'invoke' }] });
    const out = await listExecutorTools({ config: cfg, connect: async () => client });
    expect(out.mcpTools).toEqual(['search', 'invoke']);
    expect(out.calendarTools.map((t) => t.id)).toContain('google_calendar.events.insert');
  });
});

describe('argument mapping', () => {
  const tool = (properties: Record<string, unknown> | null) => ({ id: 't', description: '', inputSchema: properties ? { type: 'object', properties } : null });

  it('defaults to {calendarId, body} without a schema', () => {
    expect(Object.keys(buildInsertArguments(tool(null), input))).toEqual(['calendarId', 'body']);
  });
  it('uses requestBody when that is the field name', () => {
    const a = buildInsertArguments(tool({ calendarId: {}, requestBody: {} }), input, 'me@x.com');
    expect(a).toMatchObject({ calendarId: 'me@x.com', requestBody: { summary: 'Return drop-off' } });
  });
  it('flattens when the schema has event fields at the top level', () => {
    const a = buildInsertArguments(tool({ calendarId: {}, summary: {}, start: {}, end: {} }), input);
    expect(a).toMatchObject({ calendarId: 'primary', summary: 'Return drop-off', start: { dateTime: '2026-10-05T17:00:00.000Z' } });
  });
  it('supports {path:{calendarId}, body}', () => {
    expect(buildInsertArguments(tool({ path: {}, body: {} }), input)).toEqual(
      expect.objectContaining({ body: expect.objectContaining({ summary: 'Return drop-off' }) }),
    );
    expect(buildInsertArguments(tool({ path: {}, query: {} }), input)).toMatchObject({ path: { calendarId: 'primary' }, body: {} });
  });
  it('picks events.insert over other calendar tools', () => {
    const items = extractSearchItems([
      { id: 'google_calendar.events.quickAdd', description: 'Creates an event based on a simple text string.' },
      { id: 'google_calendar.events.insert', description: 'Creates an event.' },
      { id: 'google_calendar.calendars.insert', description: 'Creates a secondary calendar.' },
    ]);
    expect(pickCalendarInsertTool(items)?.id).toBe('google_calendar.events.insert');
    expect(pickCalendarInsertTool(extractSearchItems({ items: [{ id: 'slack.chat.postMessage' }] }))).toBeNull();
  });
  it('finds htmlLink in nested results', () => {
    expect(extractEventLink({ result: { body: { kind: 'calendar#event', id: 'e', htmlLink: 'https://g/e' } } })).toEqual({ url: 'https://g/e', id: 'e' });
  });
});

describe('generic Executor tools', () => {
  it('flags write tools by their action name', () => {
    expect(isWriteTool('tools.google_gmail.user.personal.gmail.users.messages.send')).toBe(true);
    expect(isWriteTool('tools.google_calendar.org.ws.calendar.events.insert')).toBe(true);
    expect(isWriteTool('tools.google_calendar.org.ws.calendar.events.list')).toBe(false);
    expect(isWriteTool('tools.kiwi_com.user.personalKiwiMcp.search_flight')).toBe(false);
    expect(isWriteTool('tools.tomorrow_io_weather.user.p.get_forecast')).toBe(false);
  });

  it('searches with an optional integration filter and tags hits', async () => {
    const client = mockClient({
      search: () => text({ items: [{ id: 'tools.google_gmail.user.p.gmail.users.messages.send', description: 'Send mail', inputSchema: {} }] }),
    });
    const hits = await searchExecutorTools('send email', { integration: 'google_gmail', config: cfg, connect: async () => client });
    expect(client.calls[0]).toEqual({ name: 'search', arguments: { query: 'send email', integration: 'google_gmail' } });
    expect(hits).toEqual([
      { id: 'tools.google_gmail.user.p.gmail.users.messages.send', integration: 'google_gmail', description: 'Send mail', inputSchema: {}, writes: true },
    ]);
  });

  it('invokes a tool and unwraps {ok,data}', async () => {
    const client = mockClient({ invoke: () => text({ ok: true, data: { temp: 21 } }) });
    const out = await invokeExecutorTool('tools.x.user.p.get_forecast', { city: 'SF' }, { config: cfg, connect: async () => client });
    expect(client.calls[0]).toEqual({ name: 'invoke', arguments: { tool: 'tools.x.user.p.get_forecast', arguments: { city: 'SF' } } });
    expect(out).toEqual({ temp: 21 });
  });
});

describe('write confirmations', () => {
  it('only unlocks a write after the user message carries its code', async () => {
    const { approveFromUserText, consumeConfirmation, requestConfirmation } = await import('./confirmations');
    const args = { tasklist: 'x', body: { title: 'Buy milk' } };
    const id = requestConfirmation('tools.google_tasks.user.p.tasks.insert', args);
    expect(consumeConfirmation(id, 'tools.google_tasks.user.p.tasks.insert', args)).toBe(false); // model alone can't
    expect(approveFromUserText(`Yes, go ahead. (confirm:${id})`)).toEqual([id]);
    expect(consumeConfirmation(id, 'tools.google_tasks.user.p.tasks.insert', { ...args, tasklist: 'y' })).toBe(false); // other args
    expect(consumeConfirmation(id, 'tools.google_tasks.user.p.tasks.insert', { ...args, body: { title: 'Buy beer' } })).toBe(false); // nested change
    expect(consumeConfirmation(id, 'tools.google_tasks.user.p.tasks.insert', args)).toBe(true);
    expect(consumeConfirmation(id, 'tools.google_tasks.user.p.tasks.insert', args)).toBe(false); // one-time
  });
});

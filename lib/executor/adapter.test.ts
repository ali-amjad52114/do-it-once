import { describe, expect, it, vi } from 'vitest';
import type { CalendarEventInput } from '@/lib/contracts';
import { createToolAdapter, listExecutorTools } from './index';
import { buildInsertArguments, extractEventLink, extractSearchItems, pickCalendarInsertTool, readExecutorConfig, type McpLike } from './mcp';

const input: CalendarEventInput = {
  title: 'Return drop-off',
  start: '2026-10-05T17:00:00.000Z',
  end: '2026-10-05T17:30:00.000Z',
  location: 'UPS Store',
};
const cfg = { url: 'https://executor.sh/acme/mcp', apiKey: 'k' };
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

  it('reads config only when both env vars are set', () => {
    expect(readExecutorConfig({ EXECUTOR_MCP_URL: 'https://x/mcp' })).toBeNull();
    expect(readExecutorConfig({ EXECUTOR_MCP_URL: 'https://x/mcp', EXECUTOR_API_KEY: 'k' })).toEqual({ url: 'https://x/mcp', apiKey: 'k' });
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
    expect(r.detail).toContain('Connect Google Calendar');
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

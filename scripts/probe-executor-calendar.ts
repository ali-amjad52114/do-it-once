// Asks Executor (not Google directly) to run a read-only Google Calendar tool and prints
// Executor's full response, so connection errors are visible: npx tsx scripts/probe-executor-calendar.ts
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.EXECUTOR_MCP_URL!);
url.searchParams.set('mode', 'passthrough');
const client = new Client({ name: 'do-it-once-probe', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${process.env.EXECUTOR_API_KEY}` } } }),
);
const r = (await client.callTool({
  name: 'invoke',
  arguments: { tool: 'tools.google_calendar.org.workspaceGoogleCalendarApi.calendar.calendarList.list', arguments: {} },
})) as { structuredContent?: unknown; content?: unknown };
const text = JSON.stringify(r.structuredContent ?? r.content);
const messages = text.match(/"message":"[^"]{0,600}/g);
console.log(messages ? messages.join('\n') : text.slice(0, 1200));
await client.close();

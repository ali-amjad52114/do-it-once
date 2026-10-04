// Lists Executor Cloud MCP tools + integrations: npx tsx scripts/check-executor.ts
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.EXECUTOR_MCP_URL!);
url.searchParams.set('mode', 'passthrough');
const client = new Client({ name: 'do-it-once-check', version: '0.1.0' });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${process.env.EXECUTOR_API_KEY}` } } }),
);
const { tools } = await client.listTools();
console.log('MCP tools:', tools.map((t) => t.name).join(', '));
const show = (r: any) => JSON.stringify(r.structuredContent ?? r.content?.map((c: any) => c.text).join('\n')).slice(0, 1500);
if (tools.some((t) => t.name === 'integrations')) console.log('integrations:', show(await client.callTool({ name: 'integrations', arguments: {} })));
if (tools.some((t) => t.name === 'search'))
  console.log('search calendar:', show(await client.callTool({ name: 'search', arguments: { query: 'google calendar create event' } })));
await client.close();

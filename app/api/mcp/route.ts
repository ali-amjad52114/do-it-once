// A2: MCP Streamable HTTP endpoint (stateless). Bearer MCP_TOKEN; 404 unless ADDON_MCP is on.
import { mcpGate } from '@/lib/mcp/auth';
import { handleMcpRequest } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handler(request: Request): Promise<Response> {
  const denied = mcpGate(request);
  if (denied) return denied;
  try {
    return await handleMcpRequest(request);
  } catch (err) {
    console.error('[mcp]', err);
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
      { status: 500 },
    );
  }
}

export const GET = handler;
export const POST = handler;
export const DELETE = handler;

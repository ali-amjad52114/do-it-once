// A2: bearer auth + flag gate for the MCP endpoint.
import { timingSafeEqual } from 'node:crypto';
import { flag } from '@/lib/addons/flags';

/** Returns a Response to send (404 when the add-on is off, 401 on a bad token), or null when the request may proceed. */
export function mcpGate(request: Request): Response | null {
  if (!flag('ADDON_MCP')) return new Response('Not found', { status: 404 });
  const expected = process.env.MCP_TOKEN ?? '';
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const got = m?.[1]?.trim() ?? '';
  if (!expected || !tokenEquals(got, expected)) {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }
  return null;
}

export function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function publicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

import { flag } from '@/lib/addons/flags';
import { LocateRequestSchema, locate } from '@/lib/guide/guide';
import { handle, jsonError, readJson } from '../../_lib/http';
import { preflight, withCors } from '../../teach/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return preflight(request);
}

const post = handle(async (request: Request) => {
  if (!flag('ADDON_GUIDE')) return jsonError(404, 'Not found');
  const body = await readJson(request);
  if (body === undefined) return jsonError(400, 'Request body must be JSON');
  const parsed = LocateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return Response.json(await locate(parsed.data));
});

export async function POST(request: Request) {
  return withCors(request, await post(request));
}

import { ensureNormalized, getRecording } from '@/lib/learn/store';
import { handle, jsonError, type IdContext } from '../../../_lib/http';
import { preflight, withCors } from '../../cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return preflight(request);
}

/** GET → the recording row. ?normalize=1 runs (or waits for) the LLM normalization first. */
const get = handle(async (request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  if (new URL(request.url).searchParams.get('normalize') === '1') {
    await ensureNormalized(id).catch(() => undefined); // a failure is recorded on the row
  }
  const rec = await getRecording(id);
  if (!rec) return jsonError(404, `Recording ${id} not found`);
  return Response.json(rec);
});

export async function GET(request: Request, ctx: IdContext) {
  return withCors(request, await get(request, ctx));
}

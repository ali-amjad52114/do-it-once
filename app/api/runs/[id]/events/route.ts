import { getRun } from '@/lib/neon/repo';
import { handle, intParam, jsonError, type IdContext } from '../../../_lib/http';
import { createRunStream, SSE_HEADERS } from '../../../_lib/sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** SSE stream of RunStreamFrame. `?after=N` skips events with sequence <= N. */
export const GET = handle(async (request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return jsonError(404, `Run ${id} not found`);
  const after = intParam(new URL(request.url), 'after', 0, 0, Number.MAX_SAFE_INTEGER);
  const stream = createRunStream(id, { after, signal: request.signal });
  return new Response(stream, { headers: SSE_HEADERS });
});

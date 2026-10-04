import { getRunTrace } from '@/lib/mastra';
import { getRun } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Mastra observability trace for a run: `{ runId, mastraRunId, traceId, spans }` (spans stored in Neon). */
export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return jsonError(404, `Run ${id} not found`);
  return Response.json(await getRunTrace(id));
});

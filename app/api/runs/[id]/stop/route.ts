import { getRunEngine } from '@/lib/engine';
import { getRun } from '@/lib/neon/repo';
import { handle, isTerminal, jsonError, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return jsonError(404, `Run ${id} not found`);
  if (isTerminal(run.state)) return jsonError(409, `Run ${id} already finished (state: ${run.state})`);
  await getRunEngine().stop(id);
  return Response.json({ ok: true });
});

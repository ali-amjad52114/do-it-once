import { getRunEngine } from '@/lib/engine';
import { getLatestApproval, getRun } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return jsonError(404, `Run ${id} not found`);
  const approval = await getLatestApproval(id);
  if (run.state !== 'waiting_approval' || !approval || approval.status !== 'pending') {
    return jsonError(409, `Run ${id} is not waiting for approval (state: ${run.state})`);
  }
  await getRunEngine().approve(id);
  return Response.json({ ok: true });
});

import type { RunView } from '@/lib/contracts';
import { getLatestApproval, getRun, getSkill, listEvents } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return jsonError(404, `Run ${id} not found`);
  const [skill, approval, events] = await Promise.all([getSkill(run.skillId), getLatestApproval(id), listEvents(id, 0)]);
  if (!skill) return jsonError(404, `Skill ${run.skillId} for run ${id} not found`);
  const view: RunView = { run, skill, approval, events };
  return Response.json(view);
});

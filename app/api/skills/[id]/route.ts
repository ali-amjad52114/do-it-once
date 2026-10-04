import { DEMO_USER_ID } from '@/lib/contracts';
import { getSkill, listRuns } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const skill = await getSkill(id);
  if (!skill) return jsonError(404, `Skill ${id} not found`);
  const runs = await listRuns(DEMO_USER_ID, { skillId: id, limit: 20 });
  return Response.json({ skill, runs });
});

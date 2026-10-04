import { listSkillVersions } from '@/lib/heal/versions';
import { handle, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/skills/:id/versions → { versions: SkillVersion[] } (newest first). */
export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  return Response.json({ versions: await listSkillVersions(id) });
});

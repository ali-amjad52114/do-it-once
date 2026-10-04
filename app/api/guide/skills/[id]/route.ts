import { flag } from '@/lib/addons/flags';
import { toGuideSkill } from '@/lib/guide/guide';
import { getSkill } from '@/lib/neon/repo';
import { handle, jsonError, type IdContext } from '../../../_lib/http';
import { preflight, withCors } from '../../../teach/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return preflight(request);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const get = handle(async (_request: Request, ctx: IdContext) => {
  if (!flag('ADDON_GUIDE')) return jsonError(404, 'Not found');
  const { id } = await ctx.params;
  if (!UUID.test(id)) return jsonError(404, 'Skill not found');
  const skill = await getSkill(id);
  if (!skill || skill.status === 'archived') return jsonError(404, 'Skill not found');
  return Response.json({ skill: toGuideSkill(skill) });
});

export async function GET(request: Request, ctx: IdContext) {
  return withCors(request, await get(request, ctx));
}

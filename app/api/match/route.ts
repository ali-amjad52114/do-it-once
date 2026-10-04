import { DEMO_USER_ID, type SkillMatch } from '@/lib/contracts';
import { matchSkills } from '@/lib/skills/retrieve';
import { handle, jsonError } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/match?q=stop+paying+for+this[&limit=3] → { matches: SkillMatch[] } (debug / UI). */
export const GET = handle(async (request: Request) => {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q) return jsonError(400, 'Missing query parameter q');
  const limitParam = Number(url.searchParams.get('limit') ?? 3);
  const limit = Number.isFinite(limitParam) ? Math.min(10, Math.max(1, Math.floor(limitParam))) : 3;
  const matches: SkillMatch[] = await matchSkills(DEMO_USER_ID, q, limit);
  return Response.json({ matches });
});

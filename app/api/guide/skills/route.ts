import { DEMO_USER_ID } from '@/lib/contracts';
import { flag } from '@/lib/addons/flags';
import { listSkills } from '@/lib/neon/repo';
import { handle, jsonError } from '../../_lib/http';
import { preflight, withCors } from '../../teach/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return preflight(request);
}

const get = handle(async () => {
  if (!flag('ADDON_GUIDE')) return jsonError(404, 'Not found');
  const skills = await listSkills(DEMO_USER_ID);
  return Response.json({
    skills: skills
      .filter((s) => s.status !== 'archived') // drafts too: in Guide mode the user does the clicking
      .map((s) => ({ id: s.id, title: s.title, startUrl: s.startUrl })),
  });
});

export async function GET(request: Request) {
  return withCors(request, await get());
}

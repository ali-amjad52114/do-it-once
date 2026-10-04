// POST /api/discover/:id/login-done — the user signed in themselves in the live view. Closes the login browser
// (Kernel saves the site profile on delete) and restarts the race signed in (A4 login handoff, flag ADDON_DISCOVER).
import { flag } from '@/lib/addons/flags';
import { finishLogin } from '@/lib/discover/race';
import { handle, jsonError, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = handle(async (_request: Request, ctx: IdContext) => {
  if (!flag('ADDON_DISCOVER')) return jsonError(404, 'Not found');
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError(404, 'Not found');
  const r = await finishLogin(id);
  if (!r.ok) return jsonError(r.error === 'not found' ? 404 : 409, r.error);
  return Response.json({ ok: true });
});

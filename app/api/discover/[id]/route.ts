// GET /api/discover/:id → DiscoveryView (A4, flag ADDON_DISCOVER).
import { flag } from '@/lib/addons/flags';
import { getDiscoveryView } from '@/lib/discover/race';
import { handle, jsonError, type IdContext } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, ctx: IdContext) => {
  if (!flag('ADDON_DISCOVER')) return jsonError(404, 'Not found');
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError(404, 'Not found');
  const view = await getDiscoveryView(id);
  return view ? Response.json(view) : jsonError(404, 'Not found');
});

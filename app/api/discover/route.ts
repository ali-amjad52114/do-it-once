// POST /api/discover {goal, startUrl} → {id}. Runs the discovery race in the background (A4, flag ADDON_DISCOVER).
import { z } from 'zod';
import { DEMO_USER_ID } from '@/lib/contracts';
import { flag } from '@/lib/addons/flags';
import { startDiscovery } from '@/lib/discover/race';
import { handle, jsonError, readJson } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({ goal: z.string().trim().min(5).max(500), startUrl: z.string().url().max(2000) });

export const POST = handle(async (request: Request) => {
  if (!flag('ADDON_DISCOVER')) return jsonError(404, 'Not found');
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return jsonError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  if (!/^https?:$/.test(new URL(parsed.data.startUrl).protocol)) return jsonError(400, 'startUrl must be http(s)');
  const { id } = await startDiscovery(DEMO_USER_ID, parsed.data.goal, parsed.data.startUrl);
  return Response.json({ id });
});

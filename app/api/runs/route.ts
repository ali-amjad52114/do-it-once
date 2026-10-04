import { z } from 'zod';
import { DEMO_USER_ID } from '@/lib/contracts';
import { getRunEngine } from '@/lib/engine';
import { getSkill, listRuns } from '@/lib/neon/repo';
import { handle, intParam, jsonError, readJson } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Plain non-empty strings rather than z.uuid(): seeded ids are fixed, non-RFC-variant UUIDs.
const StartRunBody = z.object({
  skillId: z.string().trim().min(1, 'skillId is required'),
  triggerId: z.string().trim().min(1).nullish(),
});

export const POST = handle(async (request: Request) => {
  const body = await readJson(request);
  if (body === undefined) return jsonError(400, 'Request body must be JSON');
  const parsed = StartRunBody.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return jsonError(400, msg);
  }
  const { skillId, triggerId } = parsed.data;
  const skill = await getSkill(skillId);
  if (!skill) return jsonError(404, `Skill ${skillId} not found`);

  const { runId } = await getRunEngine().startRun({ skillId, userId: DEMO_USER_ID, triggerId: triggerId ?? null });
  return Response.json({ runId });
});

export const GET = handle(async (request: Request) => {
  const limit = intParam(new URL(request.url), 'limit', 10, 1, 100);
  const runs = await listRuns(DEMO_USER_ID, { limit });
  return Response.json({ runs });
});

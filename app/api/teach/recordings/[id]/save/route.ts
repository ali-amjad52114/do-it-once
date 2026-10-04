import { z } from 'zod';
import { saveTaughtSkill } from '@/lib/learn/save';
import { handle, jsonError, readJson, type IdContext } from '../../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Edits = z.object({
  title: z.string().max(80).optional(),
  description: z.string().max(400).optional(),
  triggers: z.array(z.string().max(80)).max(12).optional(),
  steps: z.array(z.object({ sequence: z.number().int(), intent: z.string().max(120) })).optional(),
});

/** POST { edits? } → { skillId } (draft skill, version 1). */
export const POST = handle(async (request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const body = await readJson(request);
  if (body === undefined) return jsonError(400, 'Request body must be JSON');
  const parsed = Edits.safeParse(body);
  if (!parsed.success) return jsonError(400, parsed.error.issues.map((i) => i.message).join('; '));
  return Response.json(await saveTaughtSkill(id, parsed.data));
});

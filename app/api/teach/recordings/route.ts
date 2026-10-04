import { DEMO_USER_ID } from '@/lib/contracts';
import { RecordingSchema } from '@/lib/learn/schema';
import { ensureNormalized, insertRecording, listRecordings, promoteVerifiedTaughtSkills } from '@/lib/learn/store';
import { handle, jsonError, readJson } from '../../_lib/http';
import { preflight, withCors } from '../cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function OPTIONS(request: Request) {
  return preflight(request);
}

const post = handle(async (request: Request) => {
  const body = await readJson(request);
  if (body === undefined) return jsonError(400, 'Request body must be JSON');
  const parsed = RecordingSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  const id = await insertRecording(DEMO_USER_ID, parsed.data);
  // Start normalizing right away (Neon AI Gateway) so the preview is ready when the user opens /teach.
  void ensureNormalized(id).catch((err) => console.warn('[teach] normalize failed', err));
  return Response.json({ id });
});

const get = handle(async () => {
  await promoteVerifiedTaughtSkills(DEMO_USER_ID);
  const rows = await listRecordings(DEMO_USER_ID);
  return Response.json({
    recordings: rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      startUrl: r.recording.startUrl,
      actionCount: r.recording.actions.length,
      title: r.normalized?.title ?? null,
      skillId: r.skillId,
      skillStatus: r.skillStatus,
      error: r.error,
    })),
  });
});

export async function POST(request: Request) {
  return withCors(request, await post(request));
}
export async function GET(request: Request) {
  return withCors(request, await get());
}

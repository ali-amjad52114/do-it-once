import { getJudgmentView } from '@/lib/judge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ runId: string }> };

/** GET /api/judge/:runId → JudgmentView (latest judgment + combined verdict). */
export async function GET(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const { runId } = await ctx.params;
    const view = await getJudgmentView(runId);
    if (!view) return Response.json({ error: `Run ${runId} not found` }, { status: 404 });
    return Response.json(view);
  } catch (err) {
    console.error('[api/judge]', err);
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

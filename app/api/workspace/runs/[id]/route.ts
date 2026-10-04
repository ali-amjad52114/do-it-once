// What the agent saved after a run (post-actions): label file + calendar result. Agent R.
import { listEvents } from '@/lib/neon/repo';
import { handle, type IdContext } from '../../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async (_request: Request, ctx: IdContext) => {
  const { id } = await ctx.params;
  const events = await listEvents(id);
  const saved = events.find((e) => e.type === 'workspace.saved');
  const cal = events.find((e) => e.type === 'tool.called');
  const finished = events.some((e) => e.metadata?.postActionsDone === true || /^Follow-ups skipped/.test(e.message));
  const failures = events.filter((e) => e.metadata?.postAction === true && typeof e.metadata?.error === 'string').map((e) => e.message);
  return Response.json({
    done: finished,
    label: saved ? { message: saved.message, ...saved.metadata } : null,
    calendar: cal ? { message: cal.message, ...cal.metadata } : null,
    failures,
  });
});

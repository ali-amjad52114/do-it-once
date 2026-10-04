// Agent inbox address + email provenance per Today trigger (TodayItem has no source fields).
import { DEMO_USER_ID } from '@/lib/contracts';
import { agentInboxId } from '@/lib/agentmail/client';
import { listEmailTriggerSources } from '@/lib/triggers/store';
import { handle } from '../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handle(async () => {
  const sources = await listEmailTriggerSources(DEMO_USER_ID);
  return Response.json({ inbox: agentInboxId(), sources: Object.fromEntries(sources.map((s) => [s.triggerId, s])) });
});

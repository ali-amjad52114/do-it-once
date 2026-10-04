// Pull fallback: ingests unread mail from the agent inbox (works without a public webhook URL).
import { syncInbox } from '@/lib/agentmail/ingest';
import { handle } from '../../_lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = handle(async () => {
  const { inboxId, checked, results } = await syncInbox();
  const ingested = results.filter((r) => r.status === 'ingested' && r.created).length;
  return Response.json({ inboxId, checked, ingested, results });
});

// Creates (idempotently) the agent inbox and the "Lumen+ Billing" demo-sender inbox, and registers the
// message.received webhook when PUBLIC_APP_URL is set.
// Usage: npx tsx scripts/agentmail-setup.ts
import 'dotenv/config';
import { AGENT_INBOX, DEMO_SENDER_INBOX, ensureInbox, ensureWebhook, getAgentMail } from '../lib/agentmail/client';

async function main() {
  const am = getAgentMail();
  const before = await am.inboxes.list({ limit: 50 });
  console.log(`account inboxes (${before.count}): ${before.inboxes.map((i) => i.inboxId).join(', ') || '(none)'}`);

  const agent = process.env.AGENTMAIL_INBOX_ID
    ? { inboxId: process.env.AGENTMAIL_INBOX_ID, displayName: null, how: 'env' as const }
    : await ensureInbox(AGENT_INBOX);
  const sender = process.env.AGENTMAIL_SENDER_INBOX_ID
    ? { inboxId: process.env.AGENTMAIL_SENDER_INBOX_ID, displayName: null, how: 'env' as const }
    : await ensureInbox(DEMO_SENDER_INBOX, [agent.inboxId]);
  console.log(`agent inbox:  ${agent.inboxId}  (${agent.how})`);
  console.log(`sender inbox: ${sender.inboxId}  (${sender.how})`);

  const lines = [`AGENTMAIL_INBOX_ID=${agent.inboxId}`, `AGENTMAIL_SENDER_INBOX_ID=${sender.inboxId}`];
  const base = process.env.PUBLIC_APP_URL?.replace(/\/+$/, '');
  if (base) {
    const wh = await ensureWebhook(`${base}/api/webhooks/agentmail`, agent.inboxId);
    console.log(`webhook: ${wh.webhookId} → ${wh.url}${wh.replaced ? ' (replaced a stale URL)' : ''}`);
    lines.push(`AGENTMAIL_WEBHOOK_SECRET=${wh.secret}`);
  } else {
    console.log('PUBLIC_APP_URL not set: no webhook registered (use POST /api/inbox/sync).');
  }
  console.log('\nAdd to .env:\n' + lines.join('\n'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

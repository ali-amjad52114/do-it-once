// Sends the demo renewal email from the "Lumen+ Billing" demo inbox to the agent inbox.
// Usage: npx tsx scripts/agentmail-send-demo.ts
import 'dotenv/config';
import { agentInboxId, demoSenderInboxId, getAgentMail } from '../lib/agentmail/client';

function renewalDate(): string {
  const d = new Date(Date.now() + 86_400_000);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

async function main() {
  const site = (process.env.DEMO_SITE_URL || 'https://do-it-once-demo.fly.dev').replace(/\/+$/, '');
  const manageUrl = `${site}/account/membership`;
  const date = renewalDate();
  const to = agentInboxId();
  const from = demoSenderInboxId();

  const text = [
    'Hi Ali,',
    '',
    `Your Lumen+ Premium membership renews tomorrow, ${date}.`,
    '',
    'Plan: Lumen+ Premium',
    'Price: $19/month',
    `Next charge: $19.00 on ${date} to the Visa on file`,
    '',
    'Nothing to do if you want to keep watching. To change or cancel your plan before you are charged,',
    `manage your membership here: ${manageUrl}`,
    '',
    'Thanks for watching,',
    'Lumen+ Billing',
  ].join('\n');

  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1b1a17">
<p>Hi Ali,</p>
<p>Your <b>Lumen+ Premium</b> membership renews <b>tomorrow, ${date}</b>.</p>
<table style="border-collapse:collapse;margin:12px 0">
<tr><td style="padding:2px 16px 2px 0;color:#57534c">Plan</td><td>Lumen+ Premium</td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#57534c">Price</td><td><b>$19/month</b></td></tr>
<tr><td style="padding:2px 16px 2px 0;color:#57534c">Next charge</td><td>$19.00 on ${date} to the Visa on file</td></tr>
</table>
<p>Nothing to do if you want to keep watching. To change or cancel your plan before you are charged:</p>
<p><a href="${manageUrl}">Manage membership</a></p>
<p>Thanks for watching,<br/>Lumen+ Billing</p>
</div>`;

  const res = await getAgentMail().inboxes.messages.send(from, {
    to,
    subject: 'Your Lumen+ Premium membership renews tomorrow',
    text,
    html,
    labels: ['demo'],
  });
  console.log(`sent ${from} → ${to}`);
  console.log(`messageId=${res.messageId} threadId=${res.threadId}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

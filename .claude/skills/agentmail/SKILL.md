---
name: agentmail
description: Use when working with AgentMail (agentmail.to), the email-inbox API for AI agents. Covers giving the "Do It Once" agent its own inbox, receiving inbound mail (webhook route in Next.js with Svix verification, or a WebSocket/polling fallback), classifying it into a pending task, sending or replying from the agent, and sending a demo email into the inbox. Use for any code that imports `agentmail` or reads AGENTMAIL_API_KEY.
---

# AgentMail (TypeScript, Next.js route handlers)

Checked 2026-10-04 against the docs and the `agentmail@0.5.35` npm type definitions. Items marked **[unverified]** were not confirmed in docs or types.

## Official sources (read these first if anything below looks off)
- Docs index for LLMs: https://docs.agentmail.to/llms.txt (full OpenAPI spec at https://docs.agentmail.to/openapi.json)
- **Official agent skill:** https://github.com/agentmail-to/agentmail-skills (`npx skills add agentmail-to/agentmail-skills`), listed at https://docs.agentmail.to/integrations/skills.md. Claude Code plugin: `/plugin marketplace add agentmail-to/agentmail-plugins` then `/plugin install agentmail@agentmail`. This file is a project-specific version of that skill.
- **Official MCP server:** `claude mcp add --transport http agentmail https://mcp.agentmail.to/mcp` (OAuth, or an `x-api-key` header). It is handy for inspecting inboxes by hand while developing. The app itself uses the SDK. https://docs.agentmail.to/integrations/mcp.md
- Webhooks: /webhooks-overview.md, /events.md, /webhook-setup.md, /webhook-verification.md
- WebSockets: /websockets/quickstart.md · Limits: /knowledge-base/rate-limits.md

## Setup
```bash
npm install agentmail svix   # agentmail 0.5.35, svix 2.6.1 as of 2026-10-04
```
Env vars: `AGENTMAIL_API_KEY` (already exists), `AGENTMAIL_INBOX_ID` (the agent's address, e.g. `do-it-once@agentmail.to`), `AGENTMAIL_WEBHOOK_SECRET` (`whsec_...`, returned when you create the webhook), and optionally `AGENTMAIL_SENDER_INBOX_ID` for the demo sender.

```ts
// lib/agentmail.ts
import { AgentMailClient } from "agentmail";
export const agentmail = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
export const AGENT_INBOX = process.env.AGENTMAIL_INBOX_ID!;
```

## Key concepts
- **inboxId is the email address** (for example `do-it-once@agentmail.to`). Every `client.inboxes.*` call takes it as the first argument. The `Inbox` object has `inboxId`, `email`, `podId`, `displayName`, `clientId`, and `metadata`.
- The default domain is `agentmail.to`. Custom domains require a paid plan.
- `clientId` makes a create call idempotent: calling it again with the same `clientId` returns the existing resource instead of a duplicate. Use it in setup scripts so they can be re-run safely.
- SDK objects are **camelCase** (`messageId`, `extractedText`). The raw webhook HTTP body is **snake_case** (`message_id`, `inbox_id`, `event_type`).
- Labels are used for state: received messages carry `received` and `unread`. Change them with `messages.update(inbox, id, { addLabels, removeLabels })`.

## 1. Create inboxes (one-off setup script, idempotent)
```ts
// scripts/agentmail-setup.ts   (run with: npx tsx scripts/agentmail-setup.ts)
import { agentmail } from "../lib/agentmail";

const agent = await agentmail.inboxes.create({
  username: "do-it-once",          // gives do-it-once@agentmail.to; fails if the name is already taken globally [unverified error shape]
  displayName: "Do It Once Agent",
  clientId: "do-it-once-agent-v1", // idempotency key
});
// A second inbox that sends the demo emails (the free tier allows 3 inboxes)
const sender = await agentmail.inboxes.create({
  username: "acme-billing-demo",
  displayName: "Acme Streaming Billing",
  clientId: "do-it-once-demo-sender-v1",
});
console.log({ agent: agent.inboxId, sender: sender.inboxId });

const { inboxes, count } = await agentmail.inboxes.list({ limit: 20 });
```
To use your own domain, pass `domain: "yourdomain.com"` after the domain is verified (see /custom-domains.md; paid plans only).

## 2. Register the webhook (needs a public HTTPS URL)
```ts
const wh = await agentmail.webhooks.create({
  url: `${process.env.PUBLIC_BASE_URL}/api/webhooks/agentmail`,
  eventTypes: ["message.received"],
  inboxIds: [process.env.AGENTMAIL_INBOX_ID!], // only the agent inbox, so demo-sender mail does not fire it
  clientId: "do-it-once-webhook-v1",
});
console.log("AGENTMAIL_WEBHOOK_SECRET=", wh.secret); // whsec_...  Also wh.webhookId and wh.enabled
```
You can also scope a webhook to one inbox with `agentmail.inboxes.webhooks.create(inboxId, { url, eventTypes })`. Other calls: `webhooks.list()`, `webhooks.get(id)` (returns `.secret`), `webhooks.update`, `webhooks.delete`.

Event types: `message.received`, `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected`, `message.opened`, `domain.verified`. The events `message.received.spam`, `message.received.blocked`, and `message.received.unauthenticated` are **excluded unless you list them**.

**Local development:** AgentMail cannot reach localhost. Use one of these:
- Tunnel: run `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`), then register `https://<id>.ngrok-free.app/api/webhooks/agentmail`. Re-register (or `webhooks.update`) whenever the tunnel URL changes.
- Deploy: the repo already has `fly.toml`. Point the webhook at the deployed URL.
- Skip webhooks: use the WebSocket or polling fallback in section 5.

## 3. Next.js webhook route (App Router) with Svix verification
```ts
// app/api/webhooks/agentmail/route.ts
import { Webhook } from "svix";
import { after } from "next/server"; // Next 15+. On older versions, process inline and keep it quick.

export const runtime = "nodejs";        // svix needs Node crypto
export const dynamic = "force-dynamic";

type AgentMailEvent = {
  type: "event";
  event_type: string;                   // "message.received", ...
  event_id: string;
  message?: {
    inbox_id: string; thread_id: string; message_id: string;
    from: string; to: string[]; subject?: string;
    text?: string; html?: string; preview?: string; // text/html are dropped if the payload exceeds 1 MB
    labels: string[]; timestamp: string;
  };
};

export async function POST(req: Request) {
  const raw = await req.text();          // RAW body. Never use req.json() before verifying.
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };
  let evt: AgentMailEvent;
  try {
    evt = new Webhook(process.env.AGENTMAIL_WEBHOOK_SECRET!).verify(raw, headers) as AgentMailEvent;
  } catch {
    return new Response("invalid signature", { status: 400 });
  }

  if (evt.event_type === "message.received" && evt.message) {
    const m = evt.message;
    after(() => handleInbound(evt.event_id, m)); // return 200 fast and do the work after responding
  }
  return new Response(null, { status: 200 });
}

async function handleInbound(eventId: string, m: NonNullable<AgentMailEvent["message"]>) {
  // 1. Dedupe on eventId (or message_id) in Neon, for example with a UNIQUE constraint. Assume retries can re-deliver. [unverified retry policy]
  // 2. If text is missing (payload too large), fetch the full message:
  //    const full = await agentmail.inboxes.messages.get(m.inbox_id, m.message_id); use full.extractedText ?? full.text
  // 3. Classify (Mastra agent): "Your membership renews tomorrow, $19/month" maps to skill "Cancel Subscription"
  // 4. Insert a pending task row in Neon for the UI to show.
}
```

## 4. Send a test email INTO the agent inbox (demo trigger)
Send from the second AgentMail inbox through the API. This needs no external mail client and gives the same result every time.
```ts
// scripts/send-demo-email.ts
import { agentmail } from "../lib/agentmail";
const res = await agentmail.inboxes.messages.send(process.env.AGENTMAIL_SENDER_INBOX_ID!, {
  to: process.env.AGENTMAIL_INBOX_ID!,  // a string or string[]
  subject: "Your membership renews tomorrow",
  text: "Hi! Your Acme Streaming Premium membership renews tomorrow at $19/month. Manage or cancel: https://example.com/account",
  html: "<p>Your Acme Streaming Premium membership renews tomorrow at <b>$19/month</b>.</p>",
  labels: ["demo"],
});
console.log(res.messageId, res.threadId);
```
**[unverified]** Mail between two `@agentmail.to` inboxes should produce a normal `message.received` event and not the `.unauthenticated` one. Test this before the demo. As a backup, send from a real Gmail account to the agent address.

## 5. Fallbacks when webhooks cannot reach you
**WebSocket** (works from localhost and needs no public URL; run it in a long-lived Node process, not a serverless route):
```ts
// scripts/agentmail-listen.ts
import { agentmail, AGENT_INBOX } from "../lib/agentmail";
const socket = await agentmail.websockets.connect();
socket.on("message", async (event: any) => {
  if (event.type === "subscribed") console.log("subscribed", event.inboxIds);
  else if (event.type === "event" && event.eventType === "message.received") {
    await handleInbound(event.eventId, event.message); // SDK objects are camelCase here, so adapt the handler
  }
});
await socket.waitForOpen();
socket.sendSubscribe({ type: "subscribe", inboxIds: [AGENT_INBOX], eventTypes: ["message.received"] });
```
**Polling** (the simplest option; the docs recommend webhooks or WebSockets instead because of rate limits):
```ts
const { messages } = await agentmail.inboxes.messages.list(AGENT_INBOX, { labels: ["unread"], limit: 20 });
for (const item of messages) {
  const msg = await agentmail.inboxes.messages.get(AGENT_INBOX, item.messageId);
  // classify msg.extractedText ?? msg.text, then mark it handled:
  await agentmail.inboxes.messages.update(AGENT_INBOX, msg.messageId, { addLabels: ["processed"], removeLabels: ["unread"] });
}
```

## 6. Send or reply from the agent (confirmation summary)
```ts
await agentmail.inboxes.messages.send(AGENT_INBOX, {
  to: userEmail, subject: "Done: cancelled Acme Streaming", text: summary, html: summaryHtml,
  attachments: [{ filename: "receipt.txt", contentType: "text/plain", content: Buffer.from(log).toString("base64") }],
});
// Reply in the same thread (no subject param; the "Re:" prefix is added for you)
await agentmail.inboxes.messages.reply(AGENT_INBOX, messageId, { text: "Cancelled. Screenshot attached." });
// Also available: replyAll(inbox, id, {...}) and forward(inbox, id, { to, ... })
```
Reading and other calls:
- Threads: `inboxes.threads.list(inbox)` and `inboxes.threads.get(inbox, threadId)`.
- Search: `inboxes.messages.search(inbox, { q })`.
- Inbound attachments: `messages.getAttachment(inbox, messageId, attachmentId)` returns `{ downloadUrl, expiresAt, filename, contentType, size }`. The URL expires (about 1 hour), so download it immediately.

## Gotchas
- **Verify against the raw body.** Call `req.text()` first. Parsing the JSON and then re-stringifying it breaks the signature. Svix's default timestamp tolerance is 5 minutes.
- **Return 200 quickly** and process after responding with `after()` or a queue. Slow LLM classification inside the request risks timeouts and re-delivery. Make handling idempotent.
- The webhook body is **snake_case** and SDK/WebSocket objects are **camelCase**. Normalize both into a single `InboundEmail` type.
- When classifying, prefer `extractedText`/`extractedHtml` (which strip quoted reply history) over `text`. The raw webhook `message` may not include `extracted_text` **[unverified]**, so fetch the message if you need it.
- Payloads larger than 1 MB omit `text`/`html`. Fetch the message through the API in that case.
- Scope the webhook with `inboxIds`. Otherwise mail sent *by* the demo sender inbox and other org events can trigger work. Also make sure the agent's own outbound confirmations do not loop back into classification.
- `username` is global on `agentmail.to`. If it is taken, `create` fails, so pick something unique. `clientId` makes setup scripts safe to re-run.
- The official skill says individual messages cannot be deleted (delete the thread instead), but SDK 0.5.35 exposes `messages.delete` **[unverified behavior]**.
- The tunnel URL changes on every ngrok restart. Update the webhook URL (`webhooks.update`), or the secret and URL will no longer match your environment.
- Use the WebSocket listener from a persistent process (a script or Fly machine), not from a Next.js route on serverless.

## Free tier limits (from rate-limits doc, 2026-10-04)
- 3 inboxes, 3,000 emails/month, no custom domains.
- API throttling returns 429 with `Retry-After` (usually 1 s). Back off and retry.
- Attachments: up to 6 MB inline (base64) per request, or about 30 MB per message when passed by `url`.

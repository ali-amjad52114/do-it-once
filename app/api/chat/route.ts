// Assistant UI ⇄ Mastra chat. Streams `choreAgent` (Neon AI Gateway model) as an AI SDK v7 UI message stream.
import { handleChatStream } from '@mastra/ai-sdk';
import { createUIMessageStreamResponse, type UIMessage } from 'ai';
import { getMastra } from '@/lib/mastra';
import { approveFromUserText } from '@/lib/executor/confirmations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: { messages?: UIMessage[]; trigger?: 'submit-message' | 'regenerate-message' };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) return Response.json({ error: 'messages is required' }, { status: 400 });

  // Approve buttons send "(confirm:<code>)" in the user's own message; only that unlocks an Executor write.
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  const userText = (lastUser?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
  approveFromUserText(userText);

  // Only forward the conversation: the transport also sends client tool schemas/system, which the
  // server-side agent must not take from the browser.
  const stream = await handleChatStream({
    mastra: getMastra(),
    agentId: 'choreAgent',
    version: 'v7',
    params: { messages: body.messages, trigger: body.trigger, maxSteps: 6 },
    onError: (e) => {
      console.error('[chat]', e);
      return 'Your agent hit a snag. Please try again.';
    },
  });
  return createUIMessageStreamResponse({ stream });
}

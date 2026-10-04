// Quick health check for every API key in .env. Run: node check-apis.mjs
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { AssistantCloud } from 'assistant-cloud';

const checks = {
  'Neon API': async () => {
    const r = await fetch('https://console.neon.tech/api/v2/projects', {
      headers: { Authorization: `Bearer ${process.env.NEON_API_KEY}` },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return `${d.projects.length} project(s)`;
  },
  'Neon database': async () => {
    const [{ version }] = await neon(process.env.DATABASE_URL)`SELECT version()`;
    return version.split(' on ')[0];
  },
  'Mastra gateway': async () => {
    const { agent } = await import('./agent.mjs');
    const r = await agent.generate('Reply with just: ok');
    return r.text;
  },
  Exa: async () => {
    const r = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Neon Postgres', numResults: 1 }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return d.results[0]?.url;
  },
  AgentMail: async () => {
    const r = await fetch('https://api.agentmail.to/v0/inboxes', {
      headers: { Authorization: `Bearer ${process.env.AGENTMAIL_API_KEY}` },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return d.inboxes.map((i) => i.email).join(', ');
  },
  'assistant-ui cloud': async () => {
    const cloud = new AssistantCloud({ apiKey: process.env.ASSISTANT_API_KEY, userId: 'check', workspaceId: 'check' });
    const { token } = await cloud.auth.tokens.create();
    const { threads } = await cloud.threads.list();
    return `token issued, ${threads.length} thread(s)`;
  },
  Kernel: async () => {
    const r = await fetch('https://api.onkernel.com/browsers', {
      headers: { Authorization: `Bearer ${process.env.KERNEL_API_KEY}` },
    });
    const d = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(d));
    return `${d.length} browser session(s)`;
  },
};

for (const [name, fn] of Object.entries(checks)) {
  try {
    console.log(`PASS ${name}: ${await fn()}`);
  } catch (err) {
    console.log(`FAIL ${name}: ${(err.responseBody ?? err.message).slice(0, 160)}`);
  }
}
process.exit(0);

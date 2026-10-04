import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { neon } from '@neondatabase/serverless';
import { z } from 'zod';

export const sql = neon(process.env.DATABASE_URL);

// Tool: lets the agent read rows from the Neon `hello` table
const readHello = createTool({
  id: 'read-hello',
  description: 'Read the latest rows from the hello table in the Neon database',
  inputSchema: z.object({ limit: z.number().default(5) }),
  execute: async ({ limit }) => ({ rows: await sql`SELECT id, msg, created_at FROM hello ORDER BY id DESC LIMIT ${limit}` }),
});

// Tool: web search via Exa
const exaSearch = createTool({
  id: 'exa-search',
  description: 'Search the web with Exa and return titles and URLs',
  inputSchema: z.object({ query: z.string(), numResults: z.number().default(3) }),
  execute: async ({ query, numResults }) => {
    const res = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: { 'x-api-key': process.env.EXA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, numResults }),
    });
    const data = await res.json();
    return { results: data.results?.map(({ title, url }) => ({ title, url })) ?? [] };
  },
});

// Agent memory is persisted in Neon Postgres
const memory = new Memory({
  storage: new PostgresStore({ id: 'neon-memory', connectionString: process.env.DATABASE_URL }),
});

export const agent = new Agent({
  id: 'neon-agent',
  name: 'Neon Agent',
  instructions: 'You are a concise assistant. Use read-hello for database questions and exa-search for web questions.',
  model: 'mastra/openai/gpt-5-mini',
  tools: { readHello, exaSearch },
  memory,
});


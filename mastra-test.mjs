import { agent } from './agent.mjs';

const opts = { memory: { thread: 'test-thread', resource: 'ali' } };

const r1 = await agent.generate('My favourite colour is teal. What rows are in the hello table?', opts);
console.log('Turn 1:', r1.text);
console.log('Tools called:', r1.toolCalls?.map((t) => t.payload?.toolName ?? t.toolName));

const r2 = await agent.generate('What is my favourite colour?', opts);
console.log('Turn 2:', r2.text);
process.exit(0);

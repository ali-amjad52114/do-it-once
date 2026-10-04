// Smoke test for the Neon AI Gateway client: npx tsx scripts/check-gateway.ts
import 'dotenv/config';
import { z } from 'zod';
import { chatJSON, embed } from '../lib/ai/gateway';

const r = await chatJSON({
  system: 'Extract fields from the email.',
  user: 'Your Lumen+ membership ($19/month) renews tomorrow.',
  schema: z.object({ merchant: z.string(), amount: z.string() }),
});
console.log('chatJSON', r);
console.log('embed dims', (await embed(['stop paying for this'])).map((v) => v.length));

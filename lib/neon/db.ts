// Server-only. Lazily created Neon HTTP client (stateless, safe to share across requests).
import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let client: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing env var DATABASE_URL (see .env.example)');
    client = neon(url);
  }
  return client;
}

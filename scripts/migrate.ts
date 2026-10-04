// Applies db/migrations/*.sql in filename order, once each, tracked in `_migrations`.
// Usage: npm run db:migrate
// Uses the WebSocket Pool (multi-statement SQL files) over the direct (non-pooler) URL.
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 22+ ships a global WebSocket; the driver needs it set explicitly outside the browser.
neonConfig.webSocketConstructor = globalThis.WebSocket;

function directUrl(): string {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env)');
  // Neon convention: the pooled host has a "-pooler" suffix on the endpoint id.
  return url.replace('-pooler.', '.');
}

async function main() {
  const dir = path.resolve(process.cwd(), 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();

  const pool = new Pool({ connectionString: directUrl() });
  const client = await pool.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name));

    let applied = 0;
    for (const file of files) {
      if (done.has(file)) {
        console.log(`skip    ${file} (already applied)`);
        continue;
      }
      const text = await readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(text);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied++;
        console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    console.log(`done: ${applied} applied, ${files.length - applied} skipped`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

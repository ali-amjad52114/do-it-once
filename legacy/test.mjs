import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const [{ version }] = await sql`SELECT version()`;
console.log('Connected:', version);

await sql`CREATE TABLE IF NOT EXISTS hello (id serial PRIMARY KEY, msg text, created_at timestamptz DEFAULT now())`;
await sql`INSERT INTO hello (msg) VALUES (${'hello from neon repo'})`;
console.log(await sql`SELECT * FROM hello ORDER BY id DESC LIMIT 3`);

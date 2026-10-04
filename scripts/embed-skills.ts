// (Re)embeds trigger phrases (+ the synthetic title/description phrase) for skills via the Neon AI Gateway.
// Usage:
//   npx tsx scripts/embed-skills.ts            all ACTIVE skills (every user)
//   npx tsx scripts/embed-skills.ts --all      every non-archived skill (drafts too)
//   npx tsx scripts/embed-skills.ts <skillId>  one skill
// Requires migration 002 (npm run db:migrate) and NEON_AI_GATEWAY_* + DATABASE_URL in .env.
import 'dotenv/config';
import { getSql } from '../lib/neon/db';
import { embedSkillTriggers } from '../lib/skills/retrieve';

async function main() {
  const args = process.argv.slice(2);
  const sql = getSql();
  let skills: { id: string; title: string }[];
  if (args[0] && !args[0].startsWith('--')) {
    skills = (await sql`SELECT id, title FROM personal_skills WHERE id = ${args[0]}`) as typeof skills;
  } else if (args.includes('--all')) {
    skills = (await sql`SELECT id, title FROM personal_skills WHERE status <> 'archived' ORDER BY title`) as typeof skills;
  } else {
    skills = (await sql`SELECT id, title FROM personal_skills WHERE status = 'active' ORDER BY title`) as typeof skills;
  }
  if (!skills.length) throw new Error('no skills to embed');

  let total = 0;
  for (const s of skills) {
    const t0 = Date.now();
    const n = await embedSkillTriggers(s.id);
    total += n;
    console.log(`embedded ${String(n).padStart(3)} vectors  ${s.title} (${s.id})  ${Date.now() - t0}ms`);
  }
  console.log(`done: ${total} vectors across ${skills.length} skill(s)`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

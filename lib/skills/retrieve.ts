// CONTRACT STUB (working keyword fallback) — owned by agent L1 (Retrieval). L1 replaces the
// body with pgvector semantic search over skill_triggers.embedding; the signature is fixed.
import type { SkillMatch } from '@/lib/contracts';
import { getSql } from '@/lib/neon/db';

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9+]+/g) ?? []);

/** Best matching ACTIVE skills for a plain-language request, highest score first. */
export async function matchSkills(userId: string, text: string, limit = 3): Promise<SkillMatch[]> {
  const sql = getSql();
  const rows = (await sql`
    SELECT s.id, s.title, t.phrase
    FROM personal_skills s JOIN skill_triggers t ON t.skill_id = s.id
    WHERE s.user_id = ${userId} AND s.status = 'active'`) as { id: string; title: string; phrase: string }[];
  const q = words(text);
  const best = new Map<string, SkillMatch>();
  for (const r of rows) {
    const p = words(r.phrase);
    const overlap = [...p].filter((w) => q.has(w)).length;
    const score = p.size ? overlap / p.size : 0;
    const prev = best.get(r.id);
    if (!prev || score > prev.score) best.set(r.id, { skillId: r.id, title: r.title, score, matchedPhrase: r.phrase });
  }
  return [...best.values()].filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** (Re)computes embeddings for a skill's trigger phrases. L1 implements; no-op in the stub. */
export async function embedSkillTriggers(_skillId: string): Promise<number> {
  return 0;
}

// Skill retrieval (agent L1): pgvector cosine similarity over trigger phrase embeddings in Neon,
// with embeddings from the Neon AI Gateway. Falls back to keyword overlap when the gateway fails or
// a skill has no embeddings yet. Server-only.
import type { SkillMatch } from '@/lib/contracts';
import { embed, toVectorLiteral } from '@/lib/ai/gateway';
import { getSql } from '@/lib/neon/db';

/**
 * Embedding model for retrieval (Neon AI Gateway, 1024 dims → vector(1024)). gte-large-en separates
 * intents far better than MODELS.embed (qwen3-embedding-0-6b) on short requests: "return my headphones"
 * scores 0.78 vs Return (qwen: 0.55) and 0.51 vs Cancel. Rows embedded with another model are ignored.
 */
export const RETRIEVAL_EMBED_MODEL = 'gte-large-en';

/**
 * Minimum cosine similarity (1 - cosine distance) for a semantic match. Tuned on a real phrase set
 * (see the integration test in lib/skills/retrieve.test.ts): unrelated requests score <= 0.53,
 * paraphrased positives >= 0.64.
 */
export const SEMANTIC_THRESHOLD = 0.6;

/** A semantic match more than this far below the top match is dropped (kills cross-skill echoes). */
export const RELATIVE_MARGIN = 0.15;

/** Minimum keyword-overlap score (fraction of a trigger's words present in the query) for the fallback. */
export const KEYWORD_THRESHOLD = 0.5;

/** Synthetic phrase embedded alongside the trigger phrases. */
export function profilePhrase(title: string, description: string): string {
  return description.trim() ? `${title.trim()}: ${description.trim()}` : title.trim();
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9+]+/g) ?? []);

/** Fraction of the phrase's words that appear in the query (0..1). */
export function keywordScore(query: string, phrase: string): number {
  const q = words(query);
  const p = words(phrase);
  if (!p.size) return 0;
  return [...p].filter((w) => q.has(w)).length / p.size;
}

export interface Candidate {
  skillId: string;
  title: string;
  phrase: string | null;
  score: number | null; // null = this skill has no embeddings → keyword fallback
}

/** Keeps the best phrase per skill, drops scores under `threshold`, sorts descending, truncates. */
export function rankMatches(cands: Candidate[], threshold: number, limit: number, margin = Infinity): SkillMatch[] {
  const best = new Map<string, SkillMatch>();
  for (const c of cands) {
    if (c.score === null || c.score < threshold) continue;
    const prev = best.get(c.skillId);
    if (!prev || c.score > prev.score) {
      best.set(c.skillId, { skillId: c.skillId, title: c.title, score: c.score, matchedPhrase: c.phrase });
    }
  }
  const sorted = [...best.values()].sort((a, b) => b.score - a.score);
  const top = sorted[0]?.score ?? 0;
  return sorted.filter((m) => top - m.score <= margin).slice(0, Math.max(0, limit));
}

/** Keyword fallback over the given (skillId, title, phrase) rows. */
export function keywordMatches(
  text: string,
  rows: { skillId: string; title: string; phrase: string }[],
  limit: number,
): SkillMatch[] {
  return rankMatches(
    rows.map((r) => ({ ...r, score: keywordScore(text, r.phrase) })),
    KEYWORD_THRESHOLD,
    limit,
  );
}

type Row = { skill_id: string; title: string; phrase: string | null; score: number | string | null };

async function keywordRows(userId: string, skillIds?: string[]) {
  const sql = getSql();
  const rows = (await sql`
    SELECT s.id AS skill_id, s.title, t.phrase
    FROM personal_skills s JOIN skill_triggers t ON t.skill_id = s.id
    WHERE s.user_id = ${userId} AND s.status = 'active'
      AND (${skillIds ?? null}::uuid[] IS NULL OR s.id = ANY(${skillIds ?? null}::uuid[]))
    UNION ALL
    SELECT s.id, s.title, s.title FROM personal_skills s
    WHERE s.user_id = ${userId} AND s.status = 'active'
      AND (${skillIds ?? null}::uuid[] IS NULL OR s.id = ANY(${skillIds ?? null}::uuid[]))`) as {
    skill_id: string;
    title: string;
    phrase: string;
  }[];
  return rows.map((r) => ({ skillId: r.skill_id, title: r.title, phrase: r.phrase }));
}

/**
 * Raw semantic candidates: one row per ACTIVE skill of the user with its best-matching phrase
 * (a trigger phrase, or null for the synthetic title+description phrase) and cosine similarity.
 * `score` is null when the skill has no embeddings at all.
 */
export async function semanticCandidates(userId: string, queryVector: number[]): Promise<Candidate[]> {
  const sql = getSql();
  const v = toVectorLiteral(queryVector);
  const model = RETRIEVAL_EMBED_MODEL;
  const rows = (await sql`
    WITH active AS (
      SELECT id, title FROM personal_skills WHERE user_id = ${userId} AND status = 'active'
    ),
    scored AS (
      SELECT t.skill_id, t.phrase, 1 - (t.embedding <=> ${v}::vector) AS score
      FROM skill_triggers t JOIN active a ON a.id = t.skill_id
      WHERE t.embedding IS NOT NULL AND t.embed_model = ${model}
      UNION ALL
      SELECT p.skill_id, NULL, 1 - (p.embedding <=> ${v}::vector)
      FROM skill_profile_embeddings p JOIN active a ON a.id = p.skill_id
      WHERE p.embed_model = ${model}
    ),
    best AS (
      SELECT DISTINCT ON (skill_id) skill_id, phrase, score FROM scored ORDER BY skill_id, score DESC
    )
    SELECT a.id AS skill_id, a.title, b.phrase, b.score
    FROM active a LEFT JOIN best b ON b.skill_id = a.id
    ORDER BY b.score DESC NULLS LAST`) as Row[];
  return rows.map((r) => ({
    skillId: r.skill_id,
    title: r.title,
    phrase: r.phrase,
    score: r.score === null ? null : Number(r.score),
  }));
}

/** Best matching ACTIVE skills for a plain-language request, highest score first. */
export async function matchSkills(userId: string, text: string, limit = 3): Promise<SkillMatch[]> {
  const query = text.trim();
  if (!query || limit <= 0) return [];

  let cands: Candidate[];
  try {
    const [vec] = await embed([query], RETRIEVAL_EMBED_MODEL);
    if (!vec?.length) throw new Error('empty embedding');
    cands = await semanticCandidates(userId, vec);
  } catch (err) {
    console.warn('[matchSkills] semantic retrieval failed, using keyword fallback:', (err as Error).message);
    return keywordMatches(query, await keywordRows(userId), limit);
  }

  const semantic = rankMatches(cands, SEMANTIC_THRESHOLD, limit, RELATIVE_MARGIN);
  // Skills that were never embedded still get a chance via keyword overlap.
  const unembedded = cands.filter((c) => c.score === null).map((c) => c.skillId);
  if (!unembedded.length) return semantic;
  const kw = keywordMatches(query, await keywordRows(userId, unembedded), limit);
  return [...semantic, ...kw].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * (Re)computes embeddings for every trigger phrase of a skill plus one synthetic
 * title+description phrase, via the Neon AI Gateway. Returns the number of vectors stored.
 */
export async function embedSkillTriggers(skillId: string): Promise<number> {
  const sql = getSql();
  const [skill] = (await sql`SELECT id, user_id, title, description FROM personal_skills WHERE id = ${skillId}`) as {
    id: string;
    user_id: string;
    title: string;
    description: string;
  }[];
  if (!skill) throw new Error(`embedSkillTriggers: skill ${skillId} not found`);
  const triggers = (await sql`SELECT id, phrase FROM skill_triggers WHERE skill_id = ${skillId} ORDER BY created_at, phrase`) as {
    id: string;
    phrase: string;
  }[];
  const profile = profilePhrase(skill.title, skill.description);
  const vectors = await embed([...triggers.map((t) => t.phrase), profile], RETRIEVAL_EMBED_MODEL);
  if (vectors.length !== triggers.length + 1) {
    throw new Error(`embedSkillTriggers: expected ${triggers.length + 1} vectors, got ${vectors.length}`);
  }

  const model = RETRIEVAL_EMBED_MODEL;
  await sql.transaction([
    ...triggers.map(
      (t, i) => sql`
        UPDATE skill_triggers SET embedding = ${toVectorLiteral(vectors[i])}::vector, embed_model = ${model}
        WHERE id = ${t.id}`,
    ),
    sql`
      INSERT INTO skill_profile_embeddings (skill_id, user_id, phrase, embedding, embed_model)
      VALUES (${skill.id}, ${skill.user_id}, ${profile}, ${toVectorLiteral(vectors[triggers.length])}::vector, ${model})
      ON CONFLICT (skill_id) DO UPDATE SET user_id = EXCLUDED.user_id, phrase = EXCLUDED.phrase,
        embedding = EXCLUDED.embedding, embed_model = EXCLUDED.embed_model, updated_at = now()`,
  ]);
  return vectors.length;
}

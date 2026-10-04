// Pure helpers for the AI judge (no I/O): JSON parsing/validation and the combined verdict.
import { z } from 'zod';
import type { CombinedVerdict, Judgment } from '@/lib/contracts.addons';
import type { RunState } from '@/lib/contracts';

export const JudgmentSchema = z.object({
  verdict: z.enum(['pass', 'fail', 'unsure']),
  // Accept 0..1, or 0..100 (some answers come back as percentages).
  confidence: z.coerce
    .number()
    .min(0)
    .max(100)
    .transform((n) => (n > 1 ? n / 100 : n)),
  reasons: z.array(z.string()).max(8).default([]),
  quotedEvidence: z.array(z.string()).max(8).default([]),
});

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/** Parses the model's answer. Returns the judgment or an error message (used for the retry prompt). */
export function parseJudgment(text: string): { ok: true; judgment: Judgment } | { ok: false; error: string } {
  const json = extractJson(text);
  if (json === null) return { ok: false, error: 'answer was not a JSON object' };
  const parsed = JudgmentSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.message.slice(0, 400) };
  const j = parsed.data;
  return {
    ok: true,
    judgment: {
      verdict: j.verdict,
      confidence: Math.round(j.confidence * 100) / 100,
      reasons: j.reasons.map((r) => r.slice(0, 300)),
      quotedEvidence: j.quotedEvidence.map((q) => q.slice(0, 200)),
    },
  };
}

/** Display-only combination of the rule check (run state) and the judge. */
export function combineVerdict(runState: RunState, judgment: Pick<Judgment, 'verdict'> | null): CombinedVerdict {
  if (runState === 'failed' || runState === 'stopped') return 'failed';
  if (runState !== 'succeeded' || !judgment) return 'judging';
  if (judgment.verdict === 'pass') return 'succeeded';
  if (judgment.verdict === 'unsure') return 'succeeded_judge_unsure';
  return 'needs_review';
}

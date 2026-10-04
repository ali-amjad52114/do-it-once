// A3 AI judge: run hook + `judgments` table access (server-only).
import type { JudgeVerdict, JudgmentView } from '@/lib/contracts.addons';
import { TERMINAL_STATES, type SkillRun } from '@/lib/contracts';
import { getSql } from '@/lib/neon/db';
import { getArtifact, getRun, getSkill, listArtifacts, listEvents } from '@/lib/neon/repo';
import { judgeRunDetailed, JUDGE_MODEL, type JudgeResult } from './judge';
import { combineVerdict } from './parse';

export { judgeRun, judgeRunDetailed, JUDGE_MODEL } from './judge';
export { combineVerdict, parseJudgment } from './parse';

export async function insertJudgment(runId: string, r: JudgeResult, extra: Record<string, unknown> = {}): Promise<void> {
  const sql = getSql();
  const evidence = { quotedEvidence: r.judgment.quotedEvidence, imageUsed: r.imageUsed, imageNote: r.imageNote, ...extra };
  await sql`
    INSERT INTO judgments (run_id, model, verdict, confidence, reasons, evidence, latency_ms)
    VALUES (${runId}, ${r.model}, ${r.judgment.verdict}, ${r.judgment.confidence},
            ${JSON.stringify(r.judgment.reasons)}::jsonb, ${JSON.stringify(evidence)}::jsonb, ${r.latencyMs})`;
}

export async function getJudgmentView(runId: string): Promise<JudgmentView | null> {
  const run = await getRun(runId);
  if (!run) return null;
  const sql = getSql();
  const rows = await sql`
    SELECT model, verdict, confidence, reasons, evidence, latency_ms, created_at
    FROM judgments WHERE run_id = ${runId} ORDER BY created_at DESC LIMIT 1`;
  const r = rows[0];
  const judgment = r
    ? {
        verdict: r.verdict as JudgeVerdict,
        confidence: Number(r.confidence),
        reasons: (r.reasons as string[]) ?? [],
        quotedEvidence: ((r.evidence as { quotedEvidence?: string[] })?.quotedEvidence ?? []) as string[],
        model: r.model as string,
        latencyMs: Number(r.latency_ms ?? 0),
        createdAt: new Date(r.created_at as string).toISOString(),
      }
    : null;
  return { runId, judgment, combined: combineVerdict(run.state, judgment) };
}

async function waitForTerminal(runId: string, ms: number): Promise<SkillRun | null> {
  const end = Date.now() + ms;
  for (;;) {
    const run = await getRun(runId);
    if (!run || TERMINAL_STATES.includes(run.state) || Date.now() > end) return run;
    await new Promise((res) => setTimeout(res, 500));
  }
}

/**
 * Judges a verified run and stores the judgment. Fire-and-forget from the engine:
 * `if (flag('ADDON_JUDGE')) void onRunVerified(runId);` — never throws, logs only.
 */
export async function onRunVerified(runId: string): Promise<void> {
  try {
    // The hook fires right after the verify.* event; the run result is written a moment later.
    const run = await waitForTerminal(runId, 10_000);
    if (!run) throw new Error(`run ${runId} not found`);
    const skill = await getSkill(run.skillId);
    if (!skill) throw new Error(`skill ${run.skillId} not found`);

    let artifactId = run.result?.screenshotArtifactId ?? null;
    if (!artifactId) {
      const shots = (await listArtifacts(runId)).filter((a) => a.type === 'screenshot');
      artifactId = shots.at(-1)?.id ?? null;
    }
    const artifact = artifactId ? await getArtifact(artifactId) : null;

    let pageText = (run.result?.evidenceText ?? []).join('\n');
    let finalUrl = run.result?.finalUrl ?? '';
    if (!pageText || !finalUrl) {
      const verifyEvent = (await listEvents(runId)).filter((e) => e.type.startsWith('verify.')).at(-1);
      const meta = verifyEvent?.metadata ?? {};
      if (!pageText && Array.isArray(meta.evidence)) pageText = (meta.evidence as string[]).join('\n');
      if (!finalUrl && typeof meta.url === 'string') finalUrl = meta.url;
    }

    const result = await judgeRunDetailed({
      intent: `${skill.title}. ${skill.description}`.trim(),
      verification: skill.verification,
      finalUrl,
      pageText,
      screenshotPng: artifact?.bytes ?? null,
    });
    await insertJudgment(runId, result, { finalUrl, screenshotArtifactId: artifactId });
    console.log(`[judge] run ${runId}: ${result.judgment.verdict} ${Math.round(result.judgment.confidence * 100)}% in ${result.latencyMs}ms`);
  } catch (err) {
    console.error(`[judge] run ${runId} not judged:`, err instanceof Error ? err.message : err);
    // Store an "unsure" row so the badge stops polling and shows why.
    await insertJudgment(runId, {
      judgment: { verdict: 'unsure', confidence: 0, reasons: [`Judge unavailable: ${String((err as Error)?.message ?? err).slice(0, 200)}`], quotedEvidence: [] },
      model: JUDGE_MODEL,
      latencyMs: 0,
      imageUsed: false,
      imageNote: null,
    }).catch(() => undefined);
  }
}

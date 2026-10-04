// Self-heal hooks wired into the run core (lib/engine/runtime.ts). Server-only.
//   heal    — a stored step failed: run the healer (Kernel + Exa + Neon AI Gateway), save the healed path as pending
//   restore — loadCtx: a run with a pending heal keeps using the healed steps (also after a restart / resume)
//   commit  — verified success: write skill version N+1 and emit heal.succeeded
import { z } from 'zod';
import type { BrowserAdapter, EventType, SkillDetail, SkillStep } from '@/lib/contracts';
import { chatJSON, MODELS } from '@/lib/ai/gateway';
import { researchProcedure } from '@/lib/exa/research';
import { healDecisionSchema, runHealer } from './healer';
import type { GuardQuestion } from './guard';
import { commitPendingHeal, getPendingHeal, savePendingHeal } from './versions';

export { listSkillVersions, resetSkillToVersion } from './versions';
export { runHealer } from './healer';

type Emit = (runId: string, type: EventType, message: string, metadata?: Record<string, unknown>) => Promise<unknown>;

export async function llmIsIrreversible(q: GuardQuestion): Promise<boolean> {
  const r = await chatJSON({
    model: MODELS.fast,
    system:
      'You are a safety check for a browser agent. Decide if clicking the control would itself PERFORM the irreversible action ' +
      '(submit/confirm/pay/delete/end), rather than just open a page that leads towards it. Answer {"irreversible": boolean, "reason": string}.',
    user: `Irreversible action: ${q.approvalIntent}\nControl: ${q.role} "${q.name}"\nPage text: ${q.pageText.slice(0, 1500)}`,
    schema: z.object({ irreversible: z.boolean(), reason: z.string() }),
    maxTokens: 200,
  });
  return r.irreversible;
}

export function createHealHooks(deps: { browser: BrowserAdapter; emit: Emit }) {
  return {
    async heal(input: { runId: string; sessionId: string; skill: SkillDetail; steps: SkillStep[]; failedIndex: number; failure: string }) {
      const result = await runHealer(
        {
          browser: deps.browser,
          emit: (type, message, metadata) => deps.emit(input.runId, type, message, metadata ?? {}),
          decide: ({ system, user }) => chatJSON({ system, user, schema: healDecisionSchema, model: MODELS.smart, maxTokens: 500 }),
          isIrreversible: llmIsIrreversible,
          research: (task, opts) => researchProcedure(task, opts),
        },
        input,
      ).catch(async (err) => {
        if (err && typeof err === 'object' && (err as { name?: string }).name === 'BrowserSessionGoneError') throw err;
        await deps.emit(input.runId, 'heal.failed', `Couldn't re-learn the path: ${err instanceof Error ? err.message : String(err)}`, {});
        return { ok: false as const, reason: 'error', actions: 0 };
      });
      if (!result.ok) return null;
      await savePendingHeal({
        runId: input.runId,
        skillId: input.skill.id,
        baseVersion: input.skill.version,
        steps: result.steps,
        note: result.note,
      });
      await deps.emit(input.runId, 'log', `New path found (${result.actions} actions). ${result.note}`, {
        heal: true,
        changes: result.changes,
      });
      return { steps: result.steps, resumeIndex: result.resumeIndex };
    },

    async restore(runId: string, skill: SkillDetail): Promise<SkillDetail | null> {
      const p = await getPendingHeal(runId).catch(() => null);
      return p ? { ...skill, steps: p.steps } : null;
    },

    async commit(runId: string): Promise<void> {
      try {
        const done = await commitPendingHeal(runId);
        if (!done) return;
        const first = done.note?.replace(/^Website changed:\s*/, '').split(', ')[0] ?? 'path re-learned';
        await deps.emit(runId, 'heal.succeeded', `Skill updated to v${done.version}: ${first}`, {
          version: done.version,
          note: done.note,
        });
      } catch (err) {
        await deps.emit(runId, 'log', `Couldn't save the new skill version: ${err instanceof Error ? err.message : String(err)}`, {});
      }
    },
  };
}

export type HealHooks = ReturnType<typeof createHealHooks>;

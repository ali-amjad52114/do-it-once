// Chat agent (M3). Server-only. Model = Neon AI Gateway via Mastra's built-in `neon` provider
// (reads NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN; calls `${base}/v1/chat/completions`).
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { DEMO_USER_ID, TERMINAL_STATES } from '@/lib/contracts';
import { MODELS } from '@/lib/ai/gateway';
import { matchSkills } from '@/lib/skills/retrieve';
import { getRunEngine } from '@/lib/engine';
import * as repo from '@/lib/neon/repo';

export const CHORE_AGENT_MODEL = `neon/${MODELS.fast}` as const;

/** A skill only counts as a real match above this score (keyword fallback or cosine). */
const MIN_SCORE = 0.3;

export const findSkill = createTool({
  id: 'findSkill',
  description:
    "Find the user's learned skill (a chore they taught the agent once) that best matches a plain-language request. Always call this before talking about or starting a chore.",
  inputSchema: z.object({ request: z.string().describe("The user's request in their own words") }),
  execute: async ({ request }) => {
    const matches = (await matchSkills(DEMO_USER_ID, request, 3)).filter((m) => m.score >= MIN_SCORE);
    const best = matches[0] ?? null;
    let pending: { subject: string; merchant: string | null; amount: string | null; dueLabel: string | null } | null = null;
    if (best) {
      const item = (await repo.listTodayItems(DEMO_USER_ID)).find(
        (i) => i.matchedSkill?.id === best.skillId && i.state === 'pending',
      );
      if (item) pending = { subject: item.title, merchant: item.merchant, amount: item.amount, dueLabel: item.dueLabel };
    }
    return {
      found: !!best,
      skill: best
        ? { skillId: best.skillId, title: best.title, score: Math.round(best.score * 100) / 100, matchedPhrase: best.matchedPhrase }
        : null,
      alternatives: matches.slice(1).map((m) => ({ skillId: m.skillId, title: m.title, score: m.score })),
      pendingToday: pending,
    };
  },
});

export const startSkillRun = createTool({
  id: 'startSkillRun',
  description:
    'Start a live run of a learned skill in a cloud browser. Only call this after findSkill, and only when the user has clearly asked you to act (e.g. "yes", "do it", "go ahead"). The run pauses for the user\'s approval before anything irreversible.',
  inputSchema: z.object({ skillId: z.string().describe('skillId returned by findSkill') }),
  execute: async ({ skillId }) => {
    const skill = await repo.getSkill(skillId);
    if (!skill || skill.userId !== DEMO_USER_ID) return { started: false as const, error: 'Unknown skill' };
    if (skill.status !== 'active' || skill.steps.length === 0)
      return { started: false as const, error: `"${skill.title}" is not learned yet (no steps). Do it once first.` };

    const items = (await repo.listTodayItems(DEMO_USER_ID)).filter((i) => i.matchedSkill?.id === skillId);
    // Already running for this chore? Re-attach instead of starting a second browser.
    for (const i of items.filter((x) => x.state === 'running' && x.latestRunId)) {
      const run = await repo.getRun(i.latestRunId!);
      if (run && !TERMINAL_STATES.includes(run.state))
        return { started: true as const, runId: run.id, skillTitle: skill.title, alreadyRunning: true };
    }
    const triggerId = items.find((i) => i.state === 'pending')?.triggerId ?? null;
    const { runId } = await getRunEngine().startRun({ skillId, userId: DEMO_USER_ID, triggerId });
    return { started: true as const, runId, skillTitle: skill.title, alreadyRunning: false };
  },
});

export const listSkills = createTool({
  id: 'listSkills',
  description: "List every skill the user has taught the agent, with status and run history.",
  inputSchema: z.object({}),
  execute: async () => {
    const skills = await repo.listSkills(DEMO_USER_ID);
    return {
      skills: skills.map((s) => ({
        skillId: s.id,
        title: s.title,
        status: s.status,
        learned: s.status === 'active',
        runCount: s.runCount,
        successCount: s.successCount,
      })),
    };
  },
});

const INSTRUCTIONS = `You are the user's personal chores agent in "Do It Once". The user taught you web chores once
(cancel a subscription, return an order, book a haircut...). You replay them for real in a cloud browser.

How to work:
1. When the user asks for a chore, call findSkill with their words right away, with no text before the tool call.
   If nothing matches, say so briefly and suggest they do it once so you can learn it (listSkills shows what you know).
2. When a skill matches, say in one or two short sentences which skill you found, using its exact title in quotes
   (e.g. I found your "Cancel subscription" skill), and why it fits (the phrase it matched, and the pending item
   from Today if there is one, e.g. "Lumen+ renews tomorrow at $19/month"). Then ask if you should go ahead.
   Do NOT start it yet.
3. Call startSkillRun only when the user clearly asks you to act ("yes", "do it", "go ahead", "cancel it now").
   If their first message is already an explicit, unambiguous order to act now, you may find and start in one turn.
4. After starting, say it has started and that they can watch it live in the run panel; it will stop and ask for
   their approval before anything irreversible.

Rules:
- Never claim a chore is done, canceled, paid or confirmed. You only start runs; the run panel shows verified results.
- Never invent skills, prices or dates. Only use what the tools return.
- Be brief and warm: at most 2-3 short sentences, plain text, no markdown headings or lists.`;

export const choreAgent = new Agent({
  id: 'choreAgent',
  name: 'Chore agent',
  description: "Finds and starts the user's learned web chores.",
  instructions: INSTRUCTIONS,
  model: CHORE_AGENT_MODEL,
  tools: { findSkill, startSkillRun, listSkills },
});

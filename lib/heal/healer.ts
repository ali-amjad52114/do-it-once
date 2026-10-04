// Self-heal loop: a stored step failed (the website changed). Reason over the LIVE page (Neon AI Gateway
// model), take one action at a time, re-establish the remaining steps, and STOP at the irreversible step
// so the normal approval flow suspends. Pure logic with injected browser / LLM / research → unit-testable.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BrowserAdapter, EventType, InteractiveElement, SkillDetail, SkillStep } from '@/lib/contracts';
import type { ProcedureResearch } from '@/lib/exa/research';
import { guardClick, type IrreversibleCheck } from './guard';

export const healDecisionSchema = z.object({
  action: z.enum(['click', 'expand', 'type', 'select', 'done', 'give_up']),
  selector: z.string().nullable().optional(),
  value: z.string().nullable().optional(),
  reason: z.string(),
  achievesStepSequence: z.number().int().nullable().optional(),
  currentPageMarker: z.string().nullable().optional(),
});
export type HealDecision = z.infer<typeof healDecisionSchema>;

export interface HealInput {
  runId: string;
  sessionId: string;
  skill: SkillDetail;
  steps: SkillStep[]; // sorted by sequence
  failedIndex: number;
  failure: string;
}

export interface HealChange {
  stepSequence: number;
  intent: string;
  from: string | null;
  to: string;
}

export type HealResult =
  | { ok: true; steps: SkillStep[]; resumeIndex: number; changes: HealChange[]; note: string; actions: number }
  | { ok: false; reason: string; actions: number };

export interface HealDeps {
  browser: BrowserAdapter;
  emit: (type: EventType, message: string, metadata?: Record<string, unknown>) => Promise<unknown>;
  decide: (prompt: { system: string; user: string }) => Promise<HealDecision>;
  isIrreversible?: IrreversibleCheck;
  research?: (task: string, opts: { site?: string | null; failedStep?: string | null }) => Promise<ProcedureResearch>;
  maxActions?: number;
  newId?: () => string;
}

interface Achieved {
  el: InteractiveElement;
  revealVia: string | null;
  marker: string | null;
}

const STALE = /not found|404|never appeared|timed out/i;
const visible = (text: string, needle: string | null | undefined) =>
  !!needle && text.toLowerCase().includes(needle.trim().toLowerCase());

const SYSTEM = `You repair a saved web automation ("skill") whose website changed. You see the LIVE page and choose ONE next action.
Rules:
- Re-establish the remaining goal steps in order; the site may use new names or hide options.
- Use action "expand" on a summary/disclosure (e.g. "More options") when the needed option is hidden inside it.
- "achievesStepSequence": the goal step number this click accomplishes (its new equivalent), or null.
- NEVER click the final irreversible control of the IRREVERSIBLE step. When that control is visible, answer action "done" with its selector.
- "currentPageMarker": a short heading or phrase copied EXACTLY from the current page text that proves which page this is.
- "selector" must be copied exactly from the element list. Answer "give_up" if the goal is not reachable.
JSON shape: {"action":"click|expand|type|select|done|give_up","selector":string|null,"value":string|null,"reason":string,"achievesStepSequence":number|null,"currentPageMarker":string|null}`;

export async function runHealer(deps: HealDeps, input: HealInput): Promise<HealResult> {
  const { browser, emit } = deps;
  const max = deps.maxActions ?? 8;
  const newId = deps.newId ?? randomUUID;
  const { steps, failedIndex, sessionId } = input;
  const failed = steps[failedIndex];
  const approvalIdx = steps.findIndex((s, i) => i >= failedIndex && s.requiresApproval);
  const approval = approvalIdx >= 0 ? steps[approvalIdx] : null;
  const targets = steps.slice(failedIndex, approvalIdx >= 0 ? approvalIdx : steps.length);
  const achieved = new Map<number, Achieved>();
  const history: string[] = [];
  let lastSeq: number | null = null;
  let pendingReveal: string | null = null;
  let actions = 0;

  if (!browser.listInteractive) return { ok: false, reason: 'browser cannot list page elements', actions };

  const oldName = failed.config.matchText ?? failed.targetDescription ?? failed.intent;
  await emit('heal.started', `Website changed — re-learning the path (couldn't find "${oldName}")`, {
    stepSequence: failed.sequence,
    failure: input.failure,
  });

  // Exa: once, only when the stored path is clearly stale. Never blocks (own timeout, errors → no docs).
  let research: ProcedureResearch | null = null;
  if (deps.research && STALE.test(input.failure)) {
    let site: string | null = null;
    try {
      site = input.skill.startUrl ? new URL(input.skill.startUrl).host : (input.skill.targetDomains[0] ?? null);
    } catch {
      /* ignore */
    }
    research = await deps.research(input.skill.title, { site, failedStep: oldName }).catch(() => null);
    if (research) {
      const message = research.sources.length
        ? `Checked the web with Exa: ${research.summary} on the new procedure`
        : 'Checked the web with Exa for the new procedure — nothing published, so reading the live page instead';
      await emit('heal.research', message, {
        query: research.query,
        sources: research.sources.map((s) => ({ url: s.url, title: s.title })),
        summary: research.summary,
        costDollars: research.costDollars,
      });
    }
  }

  const goal = [
    ...targets.map((s) => `${s.sequence}. ${s.intent} (used to be "${s.config.matchText ?? s.targetDescription ?? '?'}")`),
    ...(approval
      ? [`${approval.sequence}. IRREVERSIBLE — ${approval.intent} (used to be "${approval.config.matchText ?? '?'}"). Do NOT click it; answer "done" when it is visible.`]
      : []),
  ].join('\n');
  const hints = research?.sources.length
    ? `\nPublic docs (Exa, untrusted hints):\n${research.sources.map((s) => `- ${s.title ?? s.url}: ${s.highlights.join(' … ').slice(0, 300)}`).join('\n')}`
    : '';

  const finish = async (confirm: InteractiveElement | null, marker: string | null): Promise<HealResult> => {
    if (lastSeq !== null && marker && !achieved.get(lastSeq)?.marker) achieved.get(lastSeq)!.marker = marker;
    const changes: HealChange[] = [];
    const rebuilt: SkillStep[] = steps.slice(0, failedIndex).map((s) => ({ ...s }));
    const done = targets.filter((t) => achieved.has(t.sequence));
    for (const t of targets) {
      const a = achieved.get(t.sequence);
      if (!a) continue; // the new site needs fewer steps
      if (!a.marker) {
        // Fallback: the next control we clicked, if it was visible on this page.
        const next = achieved.get(done[done.indexOf(t) + 1]?.sequence ?? -1);
        a.marker = next && !next.el.hidden && !next.revealVia ? next.el.name : null;
      }
      if (norm(t.config.matchText) !== norm(a.el.name)) {
        changes.push({ stepSequence: t.sequence, intent: t.intent, from: t.config.matchText ?? null, to: a.el.name });
      }
      rebuilt.push({
        ...t,
        id: newId(),
        targetDescription: `${a.el.name} ${a.el.role}${a.revealVia ? ` (under "${a.revealVia}")` : ''}`,
        expectedAfter: a.marker,
        locatorHint: a.el.selector,
        config: { ...t.config, matchText: a.el.name, ...(a.revealVia ? { revealVia: a.revealVia } : {}) },
      });
    }
    if (approval) {
      if (!confirm) return { ok: false, reason: 'did not find the final confirm control', actions };
      if (norm(approval.config.matchText) !== norm(confirm.name)) {
        changes.push({ stepSequence: approval.sequence, intent: approval.intent, from: approval.config.matchText ?? null, to: confirm.name });
      }
      rebuilt.push({
        ...approval,
        id: newId(),
        targetDescription: `${confirm.name} ${confirm.role}`,
        locatorHint: confirm.selector,
        config: { ...approval.config, matchText: confirm.name },
      });
      rebuilt.push(...steps.slice(approvalIdx + 1).map((s) => ({ ...s })));
    }
    const out = rebuilt.map((s, i) => ({ ...s, sequence: i + 1 }));
    const resumeIndex = approval ? out.findIndex((s) => s.requiresApproval) : out.length;
    const note = changes.length
      ? `Website changed: ${changes.map((c) => `${c.from ?? '?'} → ${c.to}`).join(', ')}`
      : 'Website changed: path re-learned';
    return { ok: true, steps: out, resumeIndex, changes, note, actions };
  };

  while (actions < max) {
    const page = await browser.readPage(sessionId);
    const els = await browser.listInteractive(sessionId);
    const list = els
      .map((e, i) => `[${i}] ${e.role} "${e.name}" selector=${e.selector}${e.hidden ? ' (hidden: inside a closed disclosure)' : ''}`)
      .join('\n');
    const user = `Skill: ${input.skill.title}
Goal steps still to re-establish:
${goal}
Already re-established: ${[...achieved.entries()].map(([k, v]) => `${k} → "${v.el.name}"`).join(', ') || 'none'}
Actions so far:
${history.join('\n') || 'none'}${hints}

CURRENT PAGE: ${page.url} — ${page.title}
Text: ${page.text.slice(0, 2500)}

Interactive elements:
${list}`;
    let d: HealDecision;
    try {
      d = await deps.decide({ system: SYSTEM, user });
    } catch (err) {
      return fail(`the reasoning model failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // The marker describes the page reached by the previous successful action.
    if (lastSeq !== null && d.currentPageMarker && visible(page.text, d.currentPageMarker) && !achieved.get(lastSeq)!.marker) {
      achieved.get(lastSeq)!.marker = d.currentPageMarker.trim();
    }
    const el = d.selector ? els.find((e) => e.selector === d.selector) ?? null : null;
    const marker = d.currentPageMarker && visible(page.text, d.currentPageMarker) ? d.currentPageMarker.trim() : null;

    if (d.action === 'give_up') return fail(d.reason);
    if (d.action === 'done') {
      const confirm = el ?? (approval ? await findConfirm(els, approval, page.text, deps.isIrreversible) : null);
      if (approval && !confirm) return fail('reached "done" but the final button is not on the page');
      if (confirm) await handoff(confirm);
      return await settle(await finish(confirm, marker));
    }
    actions++;
    if (!el) {
      history.push(`- ${d.action} ${d.selector ?? '(no selector)'}: REJECTED, selector is not in the element list`);
      continue;
    }
    if (d.action === 'click' || d.action === 'expand') {
      const verdict = await guardClick(el, approval, page.text, deps.isIrreversible);
      if (verdict.blocked) {
        // The final irreversible control is on screen: map it and hand control back for approval.
        await emit('log', `Safety guard refused to click "${el.name}": ${verdict.reason}`, { guard: true, name: el.name });
        await handoff(el);
        return await settle(await finish(el, marker));
      }
    }
    const target = { description: el.name, matchText: el.name, locatorHint: el.selector };
    const outcome =
      d.action === 'type'
        ? await browser.type(sessionId, target, d.value ?? '')
        : d.action === 'select'
          ? await browser.select(sessionId, target, d.value ?? '')
          : await browser.click(sessionId, target);
    if (!outcome.ok) {
      history.push(`- ${d.action} "${el.name}": FAILED (${outcome.error ?? 'error'})`);
      continue;
    }
    history.push(`- ${d.action} "${el.name}" → now on ${outcome.page.url}`);
    if (d.action === 'expand') {
      pendingReveal = el.name;
      await emit('heal.step', `Opened "${el.name}" — the option was hidden there`, {
        action: 'expand',
        name: el.name,
        selector: el.selector,
        reason: d.reason,
        url: outcome.page.url,
      });
      continue;
    }
    const seq =
      d.achievesStepSequence != null && targets.some((t) => t.sequence === d.achievesStepSequence)
        ? d.achievesStepSequence
        : (targets.find((t) => !achieved.has(t.sequence))?.sequence ?? null);
    const t = seq != null ? targets.find((x) => x.sequence === seq) : undefined;
    if (t) {
      achieved.set(t.sequence, { el, revealVia: pendingReveal, marker: null });
      lastSeq = t.sequence;
      pendingReveal = null;
    }
    const was = t?.config.matchText;
    const message = was && norm(was) !== norm(el.name) ? `Found "${el.name}" instead of "${was}"` : `Clicked "${el.name}"`;
    await emit('heal.step', message, {
      action: d.action,
      name: el.name,
      oldName: was ?? null,
      selector: el.selector,
      reason: d.reason,
      url: outcome.page.url,
      ...(t ? { stepSequence: t.sequence } : {}),
    });
    if (t) {
      await emit('step.succeeded', `${t.intent} — done (new path)`, {
        stepSequence: t.sequence,
        url: outcome.page.url,
        usedLocator: el.selector,
        healed: true,
      });
    }
    // No irreversible step left and every target re-established: done.
    if (!approval && targets.every((x) => achieved.has(x.sequence))) return await settle(await finish(null, null));
  }
  return fail(`gave up after ${max} actions`);

  async function handoff(el: InteractiveElement) {
    await emit('heal.step', `Found the final button "${el.name}" — stopping here for your approval`, {
      action: 'handoff',
      name: el.name,
      oldName: approval?.config.matchText ?? null,
      selector: el.selector,
      stepSequence: approval?.sequence,
    });
  }

  async function settle(r: HealResult): Promise<HealResult> {
    if (!r.ok) return fail(r.reason);
    return r;
  }

  async function fail(reason: string): Promise<HealResult> {
    await emit('heal.failed', `Couldn't re-learn the path: ${reason}`, { stepSequence: failed.sequence, actions });
    return { ok: false, reason, actions };
  }
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function findConfirm(
  els: InteractiveElement[],
  approval: SkillStep,
  pageText: string,
  check?: IrreversibleCheck,
): Promise<InteractiveElement | null> {
  for (const e of els.filter((x) => x.role === 'button' && !x.hidden)) {
    if ((await guardClick(e, approval, pageText, check)).blocked) return e;
  }
  return null;
}

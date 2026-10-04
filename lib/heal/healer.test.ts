import { describe, expect, it } from 'vitest';
import type { ActionOutcome, BrowserAdapter, ElementTarget, InteractiveElement, PageState, SkillDetail, SkillStep } from '@/lib/contracts';
import { guardClick } from './guard';
import { runHealer, type HealDecision } from './healer';
import { nameFromLocator, toInteractive } from '@/lib/kernel/interactive';

const step = (sequence: number, intent: string, matchText: string, extra: Partial<SkillStep> = {}): SkillStep => ({
  id: `s${sequence}`, skillId: 'k', sequence, intent, actionType: sequence === 1 ? 'navigate' : 'click',
  targetDescription: `${matchText} link`, inputSource: sequence === 1 ? 'url:/account' : null, expectedBefore: null,
  expectedAfter: null, locatorHint: `role=link[name="${matchText}"]`, requiresApproval: false, config: { matchText }, ...extra,
});

const STEPS: SkillStep[] = [
  step(1, 'Open my account', 'Account'),
  step(2, 'Open billing settings', 'Billing'),
  step(3, 'Start cancellation', 'Cancel membership'),
  step(4, 'Confirm the cancellation', 'Confirm cancellation', {
    requiresApproval: true,
    locatorHint: 'role=button[name="Confirm cancellation"]',
    config: { matchText: 'Confirm cancellation', approval: { title: 'Cancel $19/month?', description: 'x' } },
  }),
];
const SKILL = { id: 'k', title: 'Cancel subscription', version: 1, startUrl: 'https://demo.test/account', targetDomains: [], steps: STEPS } as unknown as SkillDetail;

const el = (role: string, name: string, hidden = false): InteractiveElement => ({
  role, name, tag: role === 'button' ? 'button' : role === 'summary' ? 'summary' : 'a',
  selector: role === 'summary' ? `summary:has-text("${name}")` : `role=${role}[name="${name}"]`, ...(hidden ? { hidden } : {}),
});

/** v2-like site: /account → Plan & payments → (More options) End membership → confirm page with "End my membership". */
function fakeSite() {
  let page = 'account';
  let open = false;
  const clicks: string[] = [];
  const pages: Record<string, { text: string; els: () => InteractiveElement[] }> = {
    account: { text: 'Welcome back, Ali', els: () => [el('link', 'Plan & payments'), el('link', 'Profile')] },
    plan: {
      text: 'Your plan $19/month',
      els: () => [el('summary', 'More options'), el('link', 'End membership', !open), el('button', 'Change plan')],
    },
    retention: { text: 'Wait — a better deal', els: () => [el('link', 'Continue to end membership'), el('button', 'Accept offer')] },
    confirm: { text: 'Review and end membership', els: () => [el('button', 'End my membership'), el('link', 'Keep my membership')] },
  };
  const state = (): PageState => ({ url: `https://demo.test/${page}`, title: page, text: pages[page].text });
  const ok = (): ActionOutcome => ({ ok: true, usedLocator: null, page: state() });
  const browser: BrowserAdapter = {
    open: async () => ({ id: 'b', liveViewUrl: null }),
    goto: async () => ok(),
    click: async (_s: string, t: ElementTarget) => {
      clicks.push(t.matchText ?? '');
      const n = t.matchText;
      if (n === 'Plan & payments') page = 'plan';
      else if (n === 'More options') open = true;
      else if (n === 'End membership') page = 'retention';
      else if (n === 'Continue to end membership') page = 'confirm';
      else if (n === 'End my membership') page = 'done';
      return ok();
    },
    type: async () => ok(),
    select: async () => ok(),
    waitForText: async () => ok(),
    readPage: async () => state(),
    screenshot: async () => Buffer.alloc(0),
    close: async () => {},
    listInteractive: async () => pages[page].els(),
  };
  return { browser, clicks, page: () => page };
}

function scripted(decisions: HealDecision[]) {
  let i = 0;
  return async () => decisions[Math.min(i++, decisions.length - 1)];
}

const sel = (role: string, name: string) => (role === 'summary' ? `summary:has-text("${name}")` : `role=${role}[name="${name}"]`);

describe('guardClick', () => {
  const approval = STEPS[3];
  it('blocks the stored irreversible control by name', async () => {
    expect((await guardClick({ role: 'button', name: 'Confirm cancellation' }, approval, '')).blocked).toBe(true);
  });
  it('blocks a risky button when the LLM says it is irreversible, allows a navigating link', async () => {
    expect((await guardClick({ role: 'button', name: 'End my membership' }, approval, '', async () => true)).blocked).toBe(true);
    expect((await guardClick({ role: 'link', name: 'End membership' }, approval, '', async () => false)).blocked).toBe(false);
  });
  it('fails safe: risky buttons are blocked when the LLM check errors', async () => {
    const boom = async () => {
      throw new Error('down');
    };
    expect((await guardClick({ role: 'button', name: 'Submit' }, approval, '', boom)).blocked).toBe(true);
    expect((await guardClick({ role: 'link', name: 'Profile' }, approval, '', boom)).blocked).toBe(false);
  });
});

describe('runHealer', () => {
  const base = { runId: 'r', sessionId: 'b', skill: SKILL, steps: STEPS, failedIndex: 1, failure: 'Element not found: Billing' };

  it('re-learns the v2 path, stops before the irreversible click and rebuilds the steps', async () => {
    const site = fakeSite();
    const events: string[] = [];
    let n = 0;
    const res = await runHealer(
      {
        browser: site.browser,
        emit: async (t, m) => void events.push(`${t}: ${m}`),
        decide: scripted([
          { action: 'click', selector: sel('link', 'Plan & payments'), reason: 'billing renamed', achievesStepSequence: 2 },
          { action: 'expand', selector: sel('summary', 'More options'), reason: 'hidden', currentPageMarker: 'Your plan' },
          { action: 'click', selector: sel('link', 'End membership'), reason: 'cancel renamed', achievesStepSequence: 3 },
          { action: 'click', selector: sel('link', 'Continue to end membership'), reason: 'retention', achievesStepSequence: null },
          { action: 'done', selector: sel('button', 'End my membership'), reason: 'final', currentPageMarker: 'Review and end membership' },
        ]),
        isIrreversible: async (q) => q.role === 'button',
        newId: () => `new${++n}`,
      },
      base,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(site.clicks).not.toContain('End my membership');
    expect(site.page()).toBe('confirm');
    expect(res.steps.map((s) => s.config.matchText)).toEqual(['Account', 'Plan & payments', 'End membership', 'End my membership']);
    expect(res.steps[2].config.revealVia).toBe('More options');
    expect(res.steps[1].expectedAfter).toBe('Your plan');
    expect(res.steps[3].requiresApproval).toBe(true);
    expect(res.steps[3].locatorHint).toBe('role=button[name="End my membership"]');
    expect(res.resumeIndex).toBe(3);
    expect(res.note).toContain('Billing → Plan & payments');
    expect(events.some((e) => e.includes('Found "Plan & payments" instead of "Billing"'))).toBe(true);
    expect(events.some((e) => e.startsWith('heal.started'))).toBe(true);
  });

  it('refuses the irreversible click even when the model asks for it, and hands off for approval', async () => {
    const site = fakeSite();
    const events: string[] = [];
    const res = await runHealer(
      {
        browser: site.browser,
        emit: async (t, m) => void events.push(`${t}: ${m}`),
        decide: scripted([
          { action: 'click', selector: sel('link', 'Plan & payments'), reason: '', achievesStepSequence: 2 },
          { action: 'expand', selector: sel('summary', 'More options'), reason: '' },
          { action: 'click', selector: sel('link', 'End membership'), reason: '', achievesStepSequence: 3 },
          { action: 'click', selector: sel('link', 'Continue to end membership'), reason: '' },
          { action: 'click', selector: sel('button', 'End my membership'), reason: 'just finish it' },
        ]),
        isIrreversible: async (q) => q.role === 'button',
      },
      base,
    );
    expect(site.clicks).not.toContain('End my membership');
    expect(res.ok).toBe(true);
    expect(events.some((e) => e.includes('Safety guard refused'))).toBe(true);
  });

  it('gives up after the action cap', async () => {
    const site = fakeSite();
    const events: string[] = [];
    const res = await runHealer(
      {
        browser: site.browser,
        emit: async (t, m) => void events.push(t),
        decide: scripted([{ action: 'click', selector: sel('link', 'Profile'), reason: 'wander' }]),
        maxActions: 3,
      },
      base,
    );
    expect(res).toMatchObject({ ok: false, reason: 'gave up after 3 actions' });
    expect(events).toContain('heal.failed');
  });
});

describe('kernel interactive helpers', () => {
  it('maps raw elements to role selectors and marks hidden ones', () => {
    const out = toInteractive([
      { tag: 'a', type: '', role: null, text: ' Plan &  payments ', hidden: false },
      { tag: 'summary', type: '', role: null, text: 'More options', hidden: false },
      { tag: 'a', type: '', role: null, text: 'End membership', hidden: true },
      { tag: 'input', type: 'radio', role: null, text: 'Store credit', hidden: false },
    ]);
    expect(out.map((e) => e.selector)).toEqual([
      'role=link[name="Plan & payments"]',
      'summary:has-text("More options")',
      'role=link[name="End membership"]',
      'role=radio[name="Store credit"]',
    ]);
    expect(out[2].hidden).toBe(true);
    expect(nameFromLocator('role=button[name="End my membership"]')).toBe('End my membership');
  });
});

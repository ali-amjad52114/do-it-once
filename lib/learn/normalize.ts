// Teach Mode normalizer (agent K): a raw Recording → an intent-based skill draft.
// The LLM (Neon AI Gateway, MODELS.smart) only supplies wording (intents, title, triggers, confirmation
// text); every structural rule is enforced in code afterwards (buildDraft), so a sloppy model answer
// can never produce an unsafe skill (e.g. an irreversible step without approval).
import { z } from 'zod';
import type { ActionType, RecordedAction, Recording, StepConfig, VerificationRule, VerificationSpec } from '@/lib/contracts';

export interface TaughtStep {
  sequence: number;
  intent: string;
  actionType: ActionType;
  targetDescription: string | null;
  inputSource: string | null;
  expectedBefore: string | null;
  expectedAfter: string | null;
  locatorHint: string | null;
  requiresApproval: boolean;
  config: StepConfig;
}

export interface TaughtSkillDraft {
  title: string;
  description: string;
  icon: string;
  startUrl: string;
  targetDomains: string[];
  steps: TaughtStep[];
  triggers: string[];
  preferences: Record<string, unknown>;
  verification: VerificationSpec;
  valuePerYear?: number | null;
}

export const ICONS = ['subscription', 'return', 'haircut', 'registration', 'skill'] as const;

export const LlmOutputSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(400),
  icon: z.string(),
  triggers: z.array(z.string()).max(12),
  valuePerYear: z.number().nullable().optional(),
  startIntent: z.string().max(120).nullable().optional(),
  steps: z
    .array(
      z.object({
        index: z.number().int(),
        intent: z.string().max(120),
        targetDescription: z.string().max(200).nullable().optional(),
        prefKey: z.string().max(60).nullable().optional(),
        noise: z.boolean().optional(),
      }),
    )
    .max(500),
  preferences: z.record(z.string(), z.union([z.boolean(), z.string(), z.number()])).optional(),
  approval: z.object({ title: z.string().max(120), description: z.string().max(300) }).nullable().optional(),
  confirmationTexts: z.array(z.string()).max(10),
});
export type LlmOutput = z.infer<typeof LlmOutputSchema>;

export type CleanAction = RecordedAction & { n: number }; // n = 1-based index shown to the LLM

const REDACTED = '[redacted]';
const IRREVERSIBLE = /\b(confirm|cancel|end|submit|delete|remove|pay|place order|purchase|buy|unsubscribe|terminate|close account|checkout)\b/i;

const samePage = (a: string, b: string) => stripHash(a) === stripHash(b);
function stripHash(u: string) {
  try {
    const x = new URL(u);
    x.hash = '';
    return x.toString();
  } catch {
    return u;
  }
}
const targetKey = (a: RecordedAction) => (a.target ? `${a.target.selector ?? ''}|${a.target.name ?? ''}|${a.target.text ?? ''}` : '');
const nameOf = (a: RecordedAction) => (a.target?.name || a.target?.text || a.target?.label || '').trim() || null;
const lc = (s: string | null | undefined) => (s ?? '').toLowerCase().trim();

/** "Billing · Lumen+" → "Billing"; "Before you go…" → "Before you go". */
export function cleanTitle(t: string | null | undefined): string | null {
  if (!t) return null;
  const first = t.split(/\s+[·|–—-]\s+/)[0].replace(/[…\s.]+$/, '').trim();
  return first || null;
}

/** Deterministic cleanup: drops reload-navigations, double clicks, and no-op link clicks on the same page. */
export function cleanActions(rec: Recording): CleanAction[] {
  const out: RecordedAction[] = [];
  const acts = rec.actions;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    const prev = out[out.length - 1];
    const prevUrl = prev ? prev.url : rec.startUrl;
    if (a.action === 'navigate' && samePage(a.url, prevUrl)) continue; // reload / start page
    if (
      a.action === 'click' &&
      prev?.action === 'click' &&
      targetKey(prev) === targetKey(a) &&
      samePage(prev.url, a.url) &&
      Math.abs(Date.parse(a.at) - Date.parse(prev.at)) <= 1500
    )
      continue; // double click
    const next = acts[i + 1];
    if (
      a.action === 'click' &&
      next &&
      samePage(next.url, a.url) &&
      next.pageTitle === a.pageTitle &&
      (a.target?.role === 'link' || a.target?.tag === 'a')
    )
      continue; // link that did not navigate: no-op
    out.push(a);
  }
  return out.map((a, i) => ({ ...a, n: i + 1 }));
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'value'
  );
}

function relUrl(url: string, startUrl: string): string {
  try {
    const u = new URL(url);
    if (u.origin === new URL(startUrl).origin) return `${u.pathname}${u.search}`;
    return u.toString();
  } catch {
    return url;
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function derivedConfirmations(text: string): string[] {
  const t = lc(text);
  const out: string[] = [];
  if (/cancel/.test(t)) out.push('canceled', 'cancelled');
  if (/unsubscribe/.test(t)) out.push('unsubscribed');
  if (/delete/.test(t)) out.push('deleted');
  if (/remove/.test(t)) out.push('removed');
  if (/\b(pay|place order|purchase|buy|checkout)\b/.test(t)) out.push('order placed', 'thank you');
  if (/submit/.test(t)) out.push('submitted');
  if (/\bend\b/.test(t)) out.push('ended');
  return out;
}

/** Pure post-processing: enforces every rule on top of the LLM's wording. */
export function buildDraft(rec: Recording, clean: CleanAction[], llm: LlmOutput): TaughtSkillDraft {
  const byN = new Map(llm.steps.map((s) => [s.index, s]));
  const startUrl = rec.startUrl;
  const preferences: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(llm.preferences ?? {})) if (v !== REDACTED) preferences[slug(k)] = v;

  // Noise flags from the LLM only apply to same-page, non-final clicks (never to navigations or inputs).
  const kept = clean.filter((a, i) => {
    const s = byN.get(a.n);
    if (!s?.noise || a.action !== 'click' || i === clean.length - 1) return true;
    const next = clean[i + 1];
    return !(next && samePage(next.url, a.url));
  });

  const steps: TaughtStep[] = [];
  const first = kept[0];
  const startTitle = first && samePage(first.url, startUrl) ? cleanTitle(first.pageTitle) : null;
  steps.push({
    sequence: 1,
    intent: llm.startIntent?.trim() || `Open ${startTitle ?? new URL(startUrl).hostname}`,
    actionType: 'navigate',
    targetDescription: null,
    inputSource: `url:${relUrl(startUrl, startUrl)}`,
    expectedBefore: null,
    expectedAfter: startTitle ?? (first ? nameOf(first) : null),
    locatorHint: null,
    requiresApproval: false,
    config: {},
  });

  // Last irreversible-looking click/submit gets the approval gate.
  let approvalIdx = -1;
  kept.forEach((a, i) => {
    if ((a.action === 'click' || a.action === 'submit') && IRREVERSIBLE.test(nameOf(a) ?? '')) approvalIdx = i;
  });

  const lastIdx = kept.length - 1;
  const last = kept[lastIdx];
  const lastName = last ? nameOf(last) ?? '' : '';
  const lastTitle = last ? cleanTitle(last.pageTitle) ?? '' : '';
  const confirmations: string[] = [];
  for (const t of [...llm.confirmationTexts, ...derivedConfirmations(lastName)]) {
    const v = t.trim().replace(/[.!]+$/, '');
    if (!v || v.length > 60) continue;
    if (lc(lastName).includes(lc(v)) || lc(lastTitle).includes(lc(v))) continue; // visible before acting
    if (!confirmations.some((c) => lc(c) === lc(v))) confirmations.push(v);
  }
  const anyOf = confirmations.slice(0, 6);

  kept.forEach((a, i) => {
    const s = byN.get(a.n);
    const next = kept[i + 1];
    const name = nameOf(a);
    const config: StepConfig = {};
    let actionType: ActionType;
    let inputSource: string | null = null;
    let expectedAfter: string | null = null;
    let intent = s?.intent?.trim() || '';

    if (a.action === 'navigate') {
      actionType = 'navigate';
      inputSource = `url:${relUrl(a.url, startUrl)}`;
      const title = cleanTitle(next && samePage(next.url, a.url) ? next.pageTitle : a.pageTitle);
      expectedAfter = title ?? (next ? nameOf(next) : null);
      intent ||= `Open ${title ?? 'the page'}`;
    } else if (a.action === 'type' || a.action === 'select') {
      actionType = a.action;
      const label = a.target?.label || a.target?.name || 'value';
      if (a.value === null || a.value === REDACTED) {
        inputSource = null;
        config.note = 'ask the user at run time';
        config.askUser = true;
      } else {
        let key = slug(s?.prefKey || label);
        while (key in preferences && preferences[key] !== a.value) key = `${key}_2`;
        preferences[key] = a.value;
        inputSource = `pref:${key}`;
      }
      intent ||= `${a.action === 'type' ? 'Enter' : 'Choose'} ${label.toLowerCase()}`;
    } else {
      actionType = 'click';
      if (next && !samePage(next.url, a.url)) {
        const title = cleanTitle(next.pageTitle);
        const mt = lc(name);
        expectedAfter = title && !(mt && (mt.includes(lc(title)) || lc(title).includes(mt))) ? title : nameOf(next) ?? title;
      }
      intent ||= name ? `Click "${name}"` : 'Submit the form';
    }
    if (i === lastIdx && anyOf.length && actionType === 'click') expectedAfter = anyOf.join('|');
    if (name && actionType !== 'navigate') config.matchText = name;
    const requiresApproval = i === approvalIdx;
    if (requiresApproval) {
      config.approval = {
        title: llm.approval?.title?.trim() || `${name ?? 'Continue'}?`,
        description: llm.approval?.description?.trim() || 'Your agent reached the final step. This cannot be undone.',
      };
    }
    steps.push({
      sequence: steps.length + 1,
      intent,
      actionType,
      targetDescription:
        actionType === 'navigate' ? null : s?.targetDescription?.trim() || (name ? `${name} ${a.target?.role ?? a.target?.tag ?? ''}`.trim() : null),
      inputSource,
      expectedBefore: null,
      expectedAfter,
      locatorHint: actionType === 'navigate' ? null : a.target?.selector ?? null,
      requiresApproval,
      config,
    });
  });

  const hosts = [...new Set([startUrl, ...kept.map((a) => a.url)].map((u) => { try { return new URL(u).host; } catch { return null; } }).filter((h): h is string => !!h))];
  const origin = new URL(startUrl);
  const allOf: VerificationRule[] = [];
  if (last) {
    let lastPath = '';
    try { lastPath = new URL(last.url).pathname; } catch { /* ignore */ }
    allOf.push({
      type: 'url_matches',
      value: `^https?://${escapeRe(origin.host)}${lastPath && lastPath !== '/' ? `(?!${escapeRe(lastPath)}(?:[?#]|$))` : ''}`,
    });
  }

  const triggers: string[] = [];
  for (const t of [...llm.triggers, llm.title]) {
    const v = t.trim().toLowerCase().replace(/[.!?]+$/, '');
    if (v && v.length <= 80 && !triggers.includes(v)) triggers.push(v);
  }

  return {
    title: llm.title.trim(),
    description: llm.description.trim(),
    icon: (ICONS as readonly string[]).includes(llm.icon) ? llm.icon : 'skill',
    startUrl,
    targetDomains: hosts,
    steps,
    triggers: triggers.slice(0, 8),
    preferences,
    verification: { anyOf: anyOf.map((value) => ({ type: 'text_contains' as const, value })), allOf },
    valuePerYear: typeof llm.valuePerYear === 'number' && llm.valuePerYear > 0 ? llm.valuePerYear : null,
  };
}

const SYSTEM = `You turn a recording of a person doing a web chore once into a reusable skill for a browser agent.
Write steps as INTENTS ("Open billing settings", "Decline the retention offer"), not as clicks.
Return JSON: {
 "title": short chore name ("Cancel subscription"),
 "description": one sentence,
 "icon": one of ${ICONS.join(' | ')},
 "triggers": 4-6 short phrases the user might say to ask for this chore,
 "valuePerYear": yearly money saved/at stake if obvious from the pages, else null,
 "startIntent": intent for opening the start page ("Open my Lumen+ account"),
 "steps": [{ "index": action number, "intent": ..., "targetDescription": "Billing link in the account sidebar", "prefKey": snake_case key for typed/selected values or null, "noise": true only for clicks that clearly did nothing useful }],
 "preferences": behavioural preferences shown by the recording, snake_case keys with boolean/string values (e.g. {"decline_retention_offers": true}),
 "approval": { "title": question for the user before the final irreversible action ("Cancel $19/month membership?"), "description": why it needs approval } or null,
 "confirmationTexts": 2-4 SHORT text fragments likely shown on the page AFTER the chore succeeded (e.g. "Membership canceled", "canceled")
}
One "steps" entry per numbered action. Never include passwords or "[redacted]" values.`;

function describe(a: CleanAction): string {
  const t = a.target;
  const tgt = t ? `${t.role ?? t.tag} "${t.name ?? t.text ?? t.label ?? ''}"` : '';
  const val = a.value === null ? '' : a.value === REDACTED ? ' value=[redacted]' : ` value="${a.value}"`;
  let path = a.url;
  try { path = new URL(a.url).pathname + new URL(a.url).search; } catch { /* ignore */ }
  return `${a.n}. ${a.action} ${tgt}${val} — on ${path} (page "${a.pageTitle}")`;
}

export type LlmFn = (input: { system: string; user: string }) => Promise<LlmOutput>;

async function gatewayLlm(input: { system: string; user: string }): Promise<LlmOutput> {
  const { chatJSON, MODELS } = await import('@/lib/ai/gateway');
  return chatJSON({ ...input, schema: LlmOutputSchema, model: MODELS.smart, maxTokens: 2500 });
}

/** Recording → skill draft. `llm` is injectable for tests (defaults to Neon AI Gateway, MODELS.smart). */
export async function normalizeRecording(recording: Recording, opts: { llm?: LlmFn } = {}): Promise<TaughtSkillDraft> {
  const clean = cleanActions(recording);
  if (!clean.length) throw new Error('The recording has no usable actions');
  const user = `Start page: ${recording.startUrl}\nRecorded actions:\n${clean.map(describe).join('\n')}`;
  const llm = await (opts.llm ?? gatewayLlm)({ system: SYSTEM, user });
  return buildDraft(recording, clean, llm);
}

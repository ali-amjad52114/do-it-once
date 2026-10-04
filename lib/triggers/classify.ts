// Email → EmailClassification (agent S4). Server-only.
// 1. Deterministic regex pre-pass (amount, cadence, renewal date → dueLabel, merchant hint).
// 2. Neon AI Gateway `chatJSON` with a zod schema of EmailClassification (pre-pass given as hints).
// 3. Merge: deterministic amount wins; nulls from the model are filled from the pre-pass.
// If the gateway errors, the pre-pass alone produces the classification.
import { z } from 'zod';
import type { EmailClassification } from '@/lib/contracts';
import { chatJSON, MODELS } from '@/lib/ai/gateway';

export const EmailClassificationSchema = z.object({
  actionable: z.boolean(),
  kind: z.enum(['renewal', 'purchase', 'appointment', 'other']),
  title: z.string().trim().min(1).max(80),
  merchant: z.string().trim().min(1).max(80).nullable(),
  amount: z.string().trim().min(1).max(40).nullable(),
  cadence: z.string().trim().min(1).max(40).nullable(),
  dueLabel: z.string().trim().min(1).max(60).nullable(),
  skillQuery: z.string().trim().min(1).max(200),
  confidence: z.number().min(0).max(1),
}) satisfies z.ZodType<EmailClassification>;

export interface EmailInput {
  subject: string;
  text: string;
  from?: string | null;
  /** When the email arrived (ISO). Relative dates ("tomorrow") are computed against it. Default: now. */
  receivedAt?: string | null;
}

export interface PrePass {
  amount: string | null; // "$19/month"
  cadence: string | null; // "monthly"
  dueDate: string | null; // ISO date (YYYY-MM-DD) of the renewal / due date, if found
  dueLabel: string | null; // "Renews tomorrow"
  merchant: string | null; // from the subject or the sender display name
  kind: EmailClassification['kind'];
}

// ───────────────────────── Pre-pass ─────────────────────────

const CADENCES: [RegExp, string, string][] = [
  [/^(?:month|mo|monthly)$/i, 'month', 'monthly'],
  [/^(?:year|yr|annual|annually|yearly)$/i, 'year', 'yearly'],
  [/^(?:week|wk|weekly)$/i, 'week', 'weekly'],
];

function cadenceOf(word: string | undefined): { unit: string; cadence: string } | null {
  if (!word) return null;
  for (const [re, unit, cadence] of CADENCES) if (re.test(word)) return { unit, cadence };
  return null;
}

/** "$19/month", "$19.00 per month", "USD 19 a month", "$228/yr". Falls back to the first bare $ amount. */
export function extractAmount(text: string): { amount: string | null; cadence: string | null } {
  const money = String.raw`(?:\$|USD\s?|US\$)\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)`;
  const withCadence = new RegExp(`${money}\\s*(?:\\/|per\\s+|a\\s+|each\\s+|every\\s+)(month|mo|year|yr|week|wk)\\b`, 'i');
  const m = text.match(withCadence);
  if (m) {
    const c = cadenceOf(m[2]);
    return { amount: `$${trimCents(m[1])}/${c?.unit ?? m[2].toLowerCase()}`, cadence: c?.cadence ?? null };
  }
  const bare = text.match(new RegExp(money, 'i'));
  const adverb = text.match(/\b(monthly|yearly|annually|annual|weekly)\b/i);
  const c = cadenceOf(adverb?.[1]);
  if (bare) return { amount: c ? `$${trimCents(bare[1])}/${c.unit}` : `$${trimCents(bare[1])}`, cadence: c?.cadence ?? null };
  return { amount: null, cadence: c?.cadence ?? null };
}

function trimCents(n: string): string {
  return n.replace(/,/g, '').replace(/\.00?$/, '');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Finds the renewal/due date. Relative words win over absolute dates ("renews tomorrow, Oct 5"). */
export function extractDueDate(text: string, now: Date): Date | null {
  const day = (offset: number) => new Date(utcDay(now) + offset * 86_400_000);
  if (/\btomorrow\b/i.test(text)) return day(1);
  if (/\b(?:renews?|due|charged|expires?)\s+(?:today|tonight)\b/i.test(text)) return day(0);
  const inDays = text.match(/\bin\s+(\d{1,2}|one|two|three|seven)\s+days?\b/i);
  if (inDays) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, seven: 7 };
    return day(words[inDays[1].toLowerCase()] ?? Number(inDays[1]));
  }
  // "October 5, 2026" / "Oct 5" / "5 October 2026"
  const mdy = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i);
  const dmy = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i);
  let parts: { m: number; d: number; y: number | null } | null = null;
  if (mdy) parts = { m: MONTHS.indexOf(mdy[1].slice(0, 3).toLowerCase()), d: Number(mdy[2]), y: mdy[3] ? Number(mdy[3]) : null };
  else if (dmy) parts = { m: MONTHS.indexOf(dmy[2].slice(0, 3).toLowerCase()), d: Number(dmy[1]), y: dmy[3] ? Number(dmy[3]) : null };
  if (!parts) {
    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) parts = { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };
  }
  if (!parts || parts.m < 0 || parts.d < 1 || parts.d > 31) return null;
  let year = parts.y ?? now.getUTCFullYear();
  let date = new Date(Date.UTC(year, parts.m, parts.d));
  if (parts.y === null && utcDay(date) < utcDay(now) - 30 * 86_400_000) date = new Date(Date.UTC(++year, parts.m, parts.d));
  return date;
}

function dueVerb(text: string, kind: EmailClassification['kind']): string {
  if (/\bexpires?\b/i.test(text)) return 'Expires';
  if (kind === 'renewal' || /\brenew/i.test(text)) return 'Renews';
  if (kind === 'appointment') return 'On';
  return 'Due';
}

export function dueLabelFor(date: Date, now: Date, verb: string): string {
  const diff = Math.round((utcDay(date) - utcDay(now)) / 86_400_000);
  if (diff === 0) return `${verb} today`;
  if (diff === 1) return `${verb} tomorrow`;
  if (diff > 1 && diff < 7) return `${verb} in ${diff} days`;
  return `${verb} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function detectKind(text: string): EmailClassification['kind'] {
  if (/\b(renew(?:s|al|ing)?|subscription|membership|auto-?renew|recurring)\b/i.test(text)) return 'renewal';
  if (/\b(appointment|booking|reservation|scheduled for)\b/i.test(text)) return 'appointment';
  if (/\b(order|purchase|receipt|shipped|delivered)\b/i.test(text)) return 'purchase';
  return 'other';
}

/** Merchant from "Your Lumen+ Premium membership…" or a sender like "Lumen+ Billing <billing@…>". */
export function extractMerchant(subject: string, from?: string | null): string | null {
  const s = subject.match(/\byour\s+([A-Z][\w+&.'-]*(?:\s+[A-Z][\w+&.'-]*)?)\s+(?:premium\s+|plus\s+|pro\s+)?(?:membership|subscription|plan|account|order)\b/i);
  if (s) return s[1].replace(/\s+(Premium|Plus|Pro)$/i, '').trim();
  const display = from?.match(/^\s*"?([^"<]+?)"?\s*</)?.[1];
  if (display) {
    const cleaned = display.replace(/\b(billing|team|support|no-?reply|notifications?|accounts?|payments?)\b/gi, '').trim();
    if (cleaned) return cleaned;
  }
  return null;
}

export function prePass(input: EmailInput): PrePass {
  const now = input.receivedAt ? new Date(input.receivedAt) : new Date();
  const text = `${input.subject}\n${input.text}`;
  const kind = detectKind(text);
  const { amount, cadence } = extractAmount(text);
  const due = extractDueDate(text, now);
  return {
    amount,
    cadence,
    dueDate: due ? due.toISOString().slice(0, 10) : null,
    dueLabel: due ? dueLabelFor(due, now, dueVerb(text, kind)) : null,
    merchant: extractMerchant(input.subject, input.from),
    kind,
  };
}

/** Classification from the pre-pass alone (gateway unavailable). */
export function fallbackClassification(input: EmailInput, p: PrePass = prePass(input)): EmailClassification {
  const titles: Record<EmailClassification['kind'], string> = {
    renewal: 'Membership renewal',
    purchase: 'Recent purchase',
    appointment: 'Upcoming appointment',
    other: input.subject.slice(0, 80) || 'New email',
  };
  const queries: Record<EmailClassification['kind'], string> = {
    renewal: 'cancel this subscription',
    purchase: 'return online order',
    appointment: 'book appointment',
    other: input.subject,
  };
  const actionable = p.kind === 'renewal' && (p.amount !== null || p.dueLabel !== null);
  return {
    actionable,
    kind: p.kind,
    title: titles[p.kind],
    merchant: p.merchant,
    amount: p.amount,
    cadence: p.cadence,
    dueLabel: p.dueLabel,
    skillQuery: queries[p.kind] || 'other',
    confidence: actionable ? 0.6 : 0.3,
  };
}

// ───────────────────────── Gateway classification ─────────────────────────

const SYSTEM = `You triage emails for a personal agent that handles recurring life chores (cancel subscriptions,
return orders, book appointments, renew registrations). Classify ONE email.

Fields:
- actionable: true only if the user plausibly needs to act soon (a renewal/charge they may want to stop,
  an order to return, an appointment to book or change). Newsletters, marketing, plain receipts → false.
- kind: "renewal" | "purchase" | "appointment" | "other".
- title: short card title, 2-4 words, e.g. "Membership renewal".
- merchant: the company/service name only (e.g. "Lumen+"), or null.
- amount: price with cadence, formatted like "$19/month", or null.
- cadence: "monthly" | "yearly" | "weekly" | null.
- dueLabel: when it happens, short, e.g. "Renews tomorrow", "Renews Oct 5", or null.
- skillQuery: what the user would say to their agent to handle it, e.g. "cancel this subscription".
- confidence: 0..1.

Deterministic hints extracted by regex are provided; trust them for amount and dates unless clearly wrong.`;

export type ClassifiedBy = 'gateway' | 'regex';

/** Classification plus provenance (for logs / trigger payload). */
export async function classifyEmailDetailed(
  input: EmailInput,
): Promise<{ classification: EmailClassification; by: ClassifiedBy; prePass: PrePass; error?: string }> {
  const p = prePass(input);
  const body = input.text.length > 6000 ? `${input.text.slice(0, 6000)}\n[truncated]` : input.text;
  try {
    const llm = await chatJSON({
      system: SYSTEM,
      user: [
        `From: ${input.from ?? 'unknown'}`,
        `Subject: ${input.subject}`,
        `Received: ${input.receivedAt ?? new Date().toISOString()}`,
        `Hints: ${JSON.stringify({ amount: p.amount, cadence: p.cadence, dueDate: p.dueDate, dueLabel: p.dueLabel, merchant: p.merchant, kind: p.kind })}`,
        '',
        body,
      ].join('\n'),
      schema: EmailClassificationSchema,
      model: MODELS.fast,
      maxTokens: 400,
    });
    const classification: EmailClassification = {
      ...llm,
      amount: p.amount ?? llm.amount,
      cadence: llm.cadence ?? p.cadence,
      dueLabel: p.dueLabel ?? llm.dueLabel,
      merchant: llm.merchant ?? p.merchant,
    };
    return { classification, by: 'gateway', prePass: p };
  } catch (err) {
    return { classification: fallbackClassification(input, p), by: 'regex', prePass: p, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function classifyEmail(input: { subject: string; text: string; from?: string | null; receivedAt?: string | null }): Promise<EmailClassification> {
  return (await classifyEmailDetailed(input)).classification;
}

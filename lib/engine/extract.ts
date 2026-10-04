// Owned by agent B6 (Evidence). Pure extraction of the facts shown on the approval card.
import type { Approval, PageState } from '@/lib/contracts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "$19/month", "$19.99 / mo", "$228 per year", "$5 a yr"
const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})*|\d+)(\.\d{1,2})?\s*(?:\/|per\s+|a\s+)\s*(months?|mo|years?|yr)\b/i;

// "Nov 5, 2026", "November 5th 2026", "Sept. 5, 2026"
const DATE_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const RENEWAL_WORDS = /\b(renew\w*|until|ends?|ending|expires?|expiry|next billing|billing date|access ends)\b/i;

// Words that describe a page, not a merchant.
const GENERIC_WORDS = new Set(
  (
    'account accounts billing membership memberships subscription subscriptions plan plans premium basic standard ' +
    'family cancel cancellation canceled cancelled confirm confirmation manage your my the a an of and to for ' +
    'settings setting overview profile devices device home sign in log login out welcome back before you go page ' +
    'payment payments invoices invoice help support change offer offers dashboard'
  ).split(' '),
);

function normalize(s: string): string {
  return s.normalize('NFKC').replace(/[\s ]+/g, ' ').trim();
}

function extractPrice(text: string): string | undefined {
  const m = PRICE_RE.exec(text);
  if (!m) return undefined;
  const whole = m[1];
  const cents = m[2] && !/^\.0+$/.test(m[2]) ? m[2].padEnd(3, '0') : '';
  const period = /^(mo|month)/i.test(m[3]) ? 'month' : 'year';
  return `$${whole}${cents}/${period}`;
}

function extractRenewal(text: string): string | undefined {
  const candidates: { index: number; end: number; formatted: string }[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const month = MONTHS.findIndex((mo) => m[1].toLowerCase().startsWith(mo.toLowerCase()));
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) continue;
    candidates.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, formatted: `${MONTHS[month]} ${day}, ${m[3]}` });
  }
  for (const m of text.matchAll(ISO_DATE_RE)) {
    const month = Number(m[2]) - 1;
    const day = Number(m[3]);
    if (month < 0 || month > 11 || day < 1 || day > 31) continue;
    candidates.push({ index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, formatted: `${MONTHS[month]} ${day}, ${m[1]}` });
  }
  candidates.sort((a, b) => a.index - b.index);

  // A date counts only if a renewal word sits just before it ("Renews tomorrow (Nov 5, 2026)"),
  // or, failing that, right after it in the same sentence ("Nov 5, 2026 renewal").
  const before = candidates.find((c) => RENEWAL_WORDS.test(text.slice(Math.max(0, c.index - 50), c.index)));
  if (before) return before.formatted;
  const after = candidates.find((c) => RENEWAL_WORDS.test(text.slice(c.end, c.end + 15).split(/[.!?;]/)[0]));
  return after?.formatted;
}

function cleanToken(t: string): string {
  // Keep brand punctuation like "+" or "&"; drop surrounding quotes/punctuation.
  return t.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}+&!]+$/u, '');
}

/** Strips page-describing words from a title segment; whatever brand-ish words remain are the merchant. */
function brandFromSegment(segment: string): string | undefined {
  const words = segment.split(' ').map(cleanToken).filter(Boolean);
  const kept = words.filter((w) => !GENERIC_WORDS.has(w.toLowerCase()) && /\p{L}/u.test(w));
  if (kept.length === 0 || kept.length > 3) return undefined;
  if (!kept.some((w) => /^\p{Lu}/u.test(w) || /[+&!]/.test(w))) return undefined;
  return kept.join(' ');
}

function extractMerchant(title: string, text: string): string | undefined {
  const t = normalize(title);
  if (t) {
    const segments = t.split(/\s+[|·•—–:-]\s+|\s*[|·•]\s*/).map((s) => s.trim()).filter(Boolean);
    const brands = segments.map(brandFromSegment).filter((b): b is string => Boolean(b));
    if (brands.length > 0) {
      // Prefer a name with brand punctuation ("Lumen+"), else the shortest one.
      return brands.find((b) => /[+&!]/.test(b)) ?? brands.reduce((a, b) => (b.length < a.length ? b : a));
    }
  }

  // Fallback: the first brand-like word in the text — one with brand punctuation, or a capitalized word seen twice.
  const tokens = text.split(' ').map(cleanToken).filter(Boolean);
  const punct = tokens.find((w) => /^\p{Lu}[\p{L}\p{N}]*[+&!]$/u.test(w));
  if (punct) return punct;
  const counts = new Map<string, number>();
  for (const w of tokens) {
    if (/^\p{Lu}[\p{L}\p{N}]+$/u.test(w) && !GENERIC_WORDS.has(w.toLowerCase())) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  for (const [w, n] of counts) if (n >= 2) return w;
  return undefined;
}

/** Pulls price ("$19/month"), renewal date and merchant from the page shown at the approval step. */
export function extractApprovalPayload(page: PageState): Approval['payload'] {
  const text = normalize(page?.text ?? '');
  const payload: Approval['payload'] = {};

  const price = extractPrice(text);
  if (price) payload.price = price;
  const renewal = extractRenewal(text);
  if (renewal) payload.renewal = renewal;
  const merchant = extractMerchant(page?.title ?? '', text);
  if (merchant) payload.merchant = merchant;
  if (page?.url) payload.pageUrl = page.url;

  return payload;
}

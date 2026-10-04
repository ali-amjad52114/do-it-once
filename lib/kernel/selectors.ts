// Pure helpers for element resolution. No Playwright / Kernel imports so they are unit-testable.

/** Roles tried by matchText/keywords for each kind of action. */
export const CLICK_ROLES = ['link', 'button'] as const;
export const TYPE_ROLES = ['textbox', 'searchbox', 'combobox'] as const;
export const SELECT_ROLES = ['combobox', 'listbox'] as const;

/** A Playwright selector string that page.locator() accepts, e.g. `role=link[name="Billing"]`. */
export function roleLocator(role: string, name: string): string {
  return `role=${role}[name=${JSON.stringify(name)}]`;
}

/** Role selector whose accessible name matches a case-insensitive regex of the keyword. */
export function roleRegexLocator(role: string, keyword: string): string {
  return `role=${role}[name=/${escapeRegex(keyword)}/i]`;
}

/** Text selector: exact (quoted, full-string match) or loose (substring, case-insensitive). */
export function textLocator(text: string, exact = false): string {
  return exact ? `text=${JSON.stringify(text)}` : `text=${text.replace(/\s+/g, ' ').trim()}`;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'into',
  'my', 'your', 'this', 'that', 'it', 'its', 'is', 'be', 'page', 'button', 'link', 'field', 'input',
  'box', 'tab', 'menu', 'item', 'icon', 'section', 'sidebar', 'header', 'footer', 'nav', 'navigation',
  'dropdown', 'select', 'option', 'text', 'area', 'textbox', 'control', 'element', 'top', 'bottom',
  'left', 'right', 'main', 'primary', 'secondary', 'click', 'open', 'press', 'labeled',
  'labelled', 'called', 'named',
]);

/**
 * Words from a target description worth matching on visible text, most specific first.
 * "Billing link in the account sidebar" → ["Billing", "account"].
 * Quoted phrases, then the leading multi-word phrase, then single words (longest first).
 */
export function keywordsFromDescription(description: string | null | undefined): string[] {
  if (!description) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (w: string) => {
    const k = w.toLowerCase();
    if (!w || seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  for (const m of description.matchAll(/["“]([^"”]{2,60})["”]/g)) push(m[1].trim());
  const tokens = description
    .replace(/["“”‘’]/g, ' ')
    .split(/[^\p{L}\p{N}'+&-]+/u)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter(Boolean);
  // Leading run of meaningful words ("Manage membership" from "Manage membership button").
  const lead: string[] = [];
  for (const t of tokens) {
    if (STOP_WORDS.has(t.toLowerCase())) break;
    lead.push(t);
  }
  if (lead.length >= 2) push(lead.join(' '));
  const words = tokens.filter((w) => w.length >= 3 && !STOP_WORDS.has(w.toLowerCase()));
  // Longer words are usually more distinctive; keep original order among equals.
  words
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.length - a.w.length || a.i - b.i)
    .forEach(({ w }) => push(w));
  return out;
}

/** Collapse whitespace and cap length, as PageState.text requires. */
export function collapseText(raw: string, max = 8000): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** "Membership canceled|Renews: No" → ["Membership canceled", "Renews: No"]. */
export function splitAlternatives(text: string): string[] {
  return text
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True if the page text contains any of the "|"-separated alternatives (case- and whitespace-insensitive). */
export function textContainsAny(pageText: string, expected: string): string | null {
  const hay = pageText.replace(/\s+/g, ' ').toLowerCase();
  for (const alt of splitAlternatives(expected)) {
    if (hay.includes(alt.replace(/\s+/g, ' ').toLowerCase())) return alt;
  }
  return null;
}

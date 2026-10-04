// Pure helpers for listInteractive (no Playwright imports, unit-testable).
import type { InteractiveElement } from '@/lib/contracts';
import { roleLocator } from './selectors';

/** What the in-page collector returns for one element. */
export interface RawInteractive {
  tag: string;
  type: string;
  role: string | null; // explicit role attribute
  text: string;
  hidden: boolean;
}

/** Implicit ARIA role of an element (the subset Playwright's role selectors need). */
export function implicitRole(tag: string, type: string, explicit: string | null): string {
  if (explicit) return explicit;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'summary') return 'summary';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return tag;
}

/** A reusable Playwright selector for an element. Summaries have no usable ARIA role, so they use CSS :has-text. */
export function selectorFor(role: string, name: string): string {
  if (role === 'summary') return `summary:has-text(${JSON.stringify(name)})`;
  return roleLocator(role, name);
}

export function cleanName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 100);
}

/** Raw collector output → InteractiveElement[] (named, de-duplicated by selector). */
export function toInteractive(raw: RawInteractive[]): InteractiveElement[] {
  const out: InteractiveElement[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const name = cleanName(r.text);
    if (!name) continue;
    const role = implicitRole(r.tag, r.type, r.role);
    const selector = selectorFor(role, name);
    if (seen.has(selector)) continue;
    seen.add(selector);
    out.push({ role, name, selector, tag: r.tag, ...(r.hidden ? { hidden: true } : {}) });
  }
  return out;
}

/** 'role=link[name="Billing"]' → 'Billing'; 'summary:has-text("More options")' → 'More options'. */
export function nameFromLocator(locator: string | null | undefined): string | null {
  if (!locator) return null;
  const m = /name=("(?:[^"\\]|\\.)*")/.exec(locator) ?? /has-text\(("(?:[^"\\]|\\.)*")\)/.exec(locator);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

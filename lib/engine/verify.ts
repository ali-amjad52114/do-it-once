// Owned by agent B6 (Evidence). Pure verification of the final page — never trusts an LLM "done".
import type { PageState, VerificationResult, VerificationRule, VerificationSpec } from '@/lib/contracts';

/** Placeholder rule reported when a spec has no rules: an unverifiable run must never count as verified. */
export const EMPTY_SPEC_RULE: VerificationRule = {
  type: 'text_contains',
  value: '(no verification rules configured — run cannot be verified)',
};

const SNIPPET_LENGTH = 60;

/** Collapses all whitespace (incl. NBSP) and unifies quote/dash variants so page text compares reliably. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[\s ​]+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Finds `needle` in `haystack` (both already normalized), case-insensitively. Returns the match position. */
function findText(haystack: string, needle: string): { index: number; length: number } | null {
  if (!needle) return null;
  const m = new RegExp(escapeRegExp(needle), 'i').exec(haystack);
  return m ? { index: m.index, length: m[0].length } : null;
}

/** ~60 chars of context around a match, with ellipses where the page text was cut. */
function snippetAround(text: string, index: number, length: number): string {
  const pad = Math.max(0, Math.floor((SNIPPET_LENGTH - length) / 2));
  let start = Math.max(0, index - pad);
  let end = Math.min(text.length, index + length + pad);
  // Avoid cutting words in half where possible.
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < index) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    if (space !== -1 && space >= index + length) end = space;
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function testUrl(pattern: string, url: string): boolean {
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return url.includes(pattern); // invalid regex: treat as a literal substring
  }
}

/** Evaluates one rule. `evidence` is set for rules that positively matched something on the page. */
function evaluate(rule: VerificationRule, text: string, url: string): { pass: boolean; evidence?: string } {
  switch (rule.type) {
    case 'text_contains': {
      const hit = findText(text, normalizeText(rule.value));
      return hit ? { pass: true, evidence: snippetAround(text, hit.index, hit.length) } : { pass: false };
    }
    case 'text_absent': {
      const needle = normalizeText(rule.value);
      if (!needle) return { pass: false }; // "absent nothing" is meaningless; fail closed
      return { pass: findText(text, needle) === null };
    }
    case 'url_matches':
      return testUrl(rule.value, url) ? { pass: true, evidence: url } : { pass: false };
    default:
      return { pass: false }; // unknown rule type: fail closed
  }
}

/** Pure function: checks the final page against the skill's verification spec. Never trusts an LLM "done". */
export function verifyPage(spec: VerificationSpec, page: PageState): VerificationResult {
  const allOf = spec?.allOf ?? [];
  const anyOf = spec?.anyOf ?? [];

  if (allOf.length === 0 && anyOf.length === 0) {
    return { passed: false, matched: [], failedRules: [EMPTY_SPEC_RULE] };
  }

  const text = normalizeText(page?.text ?? '');
  const url = page?.url ?? '';
  const matched: string[] = [];
  const failedRules: VerificationRule[] = [];
  const addEvidence = (e?: string) => {
    if (e && !matched.includes(e)) matched.push(e);
  };

  for (const rule of allOf) {
    const r = evaluate(rule, text, url);
    if (r.pass) addEvidence(r.evidence);
    else failedRules.push(rule);
  }

  if (anyOf.length > 0) {
    const results = anyOf.map((rule) => ({ rule, ...evaluate(rule, text, url) }));
    const passing = results.filter((r) => r.pass);
    if (passing.length === 0) failedRules.push(...anyOf);
    else passing.forEach((r) => addEvidence(r.evidence));
  }

  return { passed: failedRules.length === 0, matched, failedRules };
}

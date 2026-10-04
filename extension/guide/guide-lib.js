/*
 * Do It Once — Guide me: pure logic (no DOM writes, no clicks).
 *
 * Loaded as a classic content script after lib.js, and by the Node tests (via vm).
 * Exposes globalThis.DoItOnceGuide. Guide mode only ever *points*: nothing here (or in
 * guide.js) clicks, submits or types for the user.
 */
(function (root) {
  'use strict';

  const ci = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

  // ── selectors (the subset that buildSelector / locatorHint produce) ───────

  /** 'role=link[name="Billing"]' → { kind:'role', role, name } ; 'text="x"' → { kind:'text', text } … */
  function parseSelector(sel) {
    if (!sel || typeof sel !== 'string') return null;
    let s = sel.trim();
    let nth = null;
    const nthM = /\s*>>\s*nth=(\d+)\s*$/.exec(s);
    if (nthM) {
      nth = Number(nthM[1]);
      s = s.slice(0, nthM.index).trim();
    }
    let m = /^role=([a-z]+)(?:\[name=("(?:[^"\\]|\\.)*")(i|s)?\])?$/.exec(s);
    if (m) return { kind: 'role', role: m[1], name: m[2] ? JSON.parse(m[2]) : null, exact: m[3] === 's', nth };
    m = /^text=("(?:[^"\\]|\\.)*")(i|s)?$/.exec(s);
    if (m) return { kind: 'text', text: JSON.parse(m[1]), nth };
    m = /^internal:label=("(?:[^"\\]|\\.)*")(i|s)?$/.exec(s);
    if (m) return { kind: 'label', label: JSON.parse(m[1]), nth };
    m = /^#([A-Za-z][\w-]*)$/.exec(s);
    if (m) return { kind: 'id', id: m[1], nth };
    m = /^([a-z][a-z0-9]*)\[name=("(?:[^"\\]|\\.)*")\]$/.exec(s);
    if (m) return { kind: 'attr', tag: m[1], nameAttr: JSON.parse(m[2]), nth };
    m = /^text=(.+)$/.exec(s);
    if (m) return { kind: 'text', text: m[1], nth };
    return null;
  }

  function nameMatch(actual, wanted, exactOnly) {
    const a = ci(actual);
    const w = ci(wanted);
    if (!w) return true;
    if (!a) return false;
    return exactOnly ? a === w : a === w || a.includes(w);
  }

  /** Does one element match a parsed selector? Uses lib.js (L) for role / name / text. */
  function matchesParsed(p, el, L) {
    if (!p || !el) return false;
    switch (p.kind) {
      case 'role':
        return L.roleOf(el) === p.role && nameMatch(L.accessibleName(el), p.name, p.exact);
      case 'text':
        return nameMatch(textOf(el), p.text, false);
      case 'label':
        return nameMatch(L.labelOf(el), p.label, false);
      case 'id':
        return el.getAttribute && el.getAttribute('id') === p.id;
      case 'attr':
        return L.tagOf(el) === p.tag && el.getAttribute && el.getAttribute('name') === p.nameAttr;
      default:
        return false;
    }
  }

  function textOf(el) {
    const t = el && (typeof el.innerText === 'string' && el.innerText ? el.innerText : el.textContent);
    return String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
  }

  /** Best match for a selector in a candidate list: exact names first, then substring; honours nth. */
  function findBySelector(sel, elements, L) {
    const p = parseSelector(sel);
    if (!p) return null;
    const hits = elements.filter((el) => matchesParsed(p, el, L));
    if (!hits.length) return null;
    if (p.nth != null) return hits[p.nth] || null;
    const want = ci(p.name || p.text || p.label || '');
    if (want) {
      const exact = hits.find((el) => ci(p.kind === 'label' ? L.labelOf(el) : p.kind === 'text' ? textOf(el) : L.accessibleName(el)) === want);
      if (exact) return exact;
    }
    return hits[0];
  }

  // ── step resolution: locatorHint → role+name from matchText → visible text ──

  const CLICKABLE_ROLES = ['link', 'button', 'tab', 'menuitem', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'textbox', 'listbox', 'searchbox', 'spinbutton'];

  function stepWords(step) {
    return (step && (step.matchText || null)) || null;
  }

  /**
   * Find the element for a step among visible candidates (in DOM order).
   * Returns { el, via: 'hint' | 'name' | 'text' } or null. Never touches the element.
   */
  function resolveStep(step, elements, L) {
    if (!step || !elements || !elements.length) return null;
    if (step.locatorHint) {
      const el = findBySelector(step.locatorHint, elements, L);
      if (el) return { el, via: 'hint' };
    }
    const words = stepWords(step);
    if (words) {
      const w = ci(words);
      const byName = (exact) =>
        elements.find((el) => {
          const r = L.roleOf(el);
          const n = ci(L.accessibleName(el));
          return (CLICKABLE_ROLES.includes(r) || L.tagOf(el) === 'summary') && n && (exact ? n === w : n.includes(w));
        });
      const el = byName(true) || byName(false);
      if (el) return { el, via: 'name' };
    }
    const text = words || step.targetDescription;
    if (text) {
      const w = ci(text);
      let best = null;
      for (const el of elements) {
        const t = ci(textOf(el));
        if (!t) continue;
        if (t === w) return { el, via: 'text' };
        if (t.includes(w) && (!best || t.length < ci(textOf(best)).length)) best = el;
      }
      if (best) return { el: best, via: 'text' };
    }
    return null;
  }

  // ── advance detection ──────────────────────────────────────────────────

  /** "a|b" alternatives; true when any appears in the page text (case-insensitive). */
  function expectedMet(expectedAfter, pageText) {
    if (!expectedAfter) return false;
    const t = ci(pageText);
    return String(expectedAfter)
      .split('|')
      .map(ci)
      .filter(Boolean)
      .some((alt) => t.includes(alt));
  }

  function sameUrl(a, b) {
    const strip = (u) => String(u || '').replace(/#.*$/, '');
    return strip(a) === strip(b);
  }

  /**
   * Should the guide move past the current step?
   * ctx: { step, pageText, url, acted: { url, onTarget } | null }
   *  - navigate steps advance once their expected text (or any page) is there; no click needed.
   *  - other steps need the user to have acted first; then the expected text appearing, or the
   *    URL changing after a click on the highlighted element, moves on.
   */
  function shouldAdvance(ctx) {
    const c = ctx || {};
    const step = c.step;
    if (!step) return false;
    if (step.actionType === 'navigate') return !step.expectedAfter || expectedMet(step.expectedAfter, c.pageText);
    if (!c.acted) return false;
    if (expectedMet(step.expectedAfter, c.pageText)) return true;
    return !!c.acted.onTarget && !sameUrl(c.acted.url, c.url);
  }

  // ── verification (VerificationSpec from lib/contracts.ts) ─────────────────

  function ruleOk(rule, text, url) {
    if (!rule) return false;
    if (rule.type === 'text_contains') return ci(text).includes(ci(rule.value));
    if (rule.type === 'text_absent') return !ci(text).includes(ci(rule.value));
    if (rule.type === 'url_matches') {
      try {
        return new RegExp(rule.value).test(url);
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /** Every allOf rule passes and, if anyOf is non-empty, at least one of those. Empty spec → false. */
  function verify(spec, page) {
    const s = spec || {};
    const all = s.allOf || [];
    const any = s.anyOf || [];
    if (!all.length && !any.length) return false;
    const text = (page && page.text) || '';
    const url = (page && page.url) || '';
    return all.every((r) => ruleOk(r, text, url)) && (!any.length || any.some((r) => ruleOk(r, text, url)));
  }

  // ── tooltip wording ──────────────────────────────────────────────────────

  const IRREVERSIBLE = 'This is the irreversible step — your call.';

  function tooltipFor(skill, index) {
    const steps = (skill && skill.steps) || [];
    const step = steps[index];
    if (!step) return { title: '', note: '', amber: false };
    return {
      title: 'Step ' + (index + 1) + ' of ' + steps.length + ' · ' + step.intent,
      note: step.requiresApproval ? IRREVERSIBLE : step.targetDescription || '',
      amber: !!step.requiresApproval,
    };
  }

  // ── "I can't find it": what may leave the page ──────────────────────────

  /**
   * Element list for /api/guide/locate: role, accessible name and a selector per element
   * (de-duplicated with ' >> nth=K'). Never includes field values. Returns { list, map }.
   */
  function buildLocateList(elements, L, max) {
    const list = [];
    const map = new Map();
    const seen = new Map();
    for (const el of elements) {
      if (list.length >= (max || 200)) break;
      const d = L.describeElement(el);
      if (!d || !d.selector) continue;
      const k = seen.get(d.selector) || 0;
      seen.set(d.selector, k + 1);
      const selector = k ? d.selector + ' >> nth=' + k : d.selector;
      list.push({ role: d.role || null, name: d.name || d.label || null, selector });
      map.set(selector, el);
    }
    return { list, map };
  }

  /** Parse '#dio-guide=<id>' from a URL hash. */
  function guideIdFromHash(hash) {
    const m = /(?:^#|[#&])dio-guide=([0-9a-fA-F-]{36})(?:&|$)/.exec(String(hash || ''));
    return m ? m[1].toLowerCase() : null;
  }

  root.DoItOnceGuide = {
    IRREVERSIBLE,
    parseSelector,
    matchesParsed,
    findBySelector,
    resolveStep,
    expectedMet,
    shouldAdvance,
    verify,
    tooltipFor,
    buildLocateList,
    guideIdFromHash,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);

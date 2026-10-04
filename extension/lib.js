/*
 * Do It Once — Teach Mode helpers (pure / DOM-light).
 *
 * Loaded as a classic content script before recorder.js, by the popup, and by the
 * Node tests (via vm). Everything hangs off globalThis.DoItOnceLib. No dependencies.
 *
 * Element helpers only use a small duck-typed surface (tagName, getAttribute,
 * textContent/innerText, type, value, id, labels, parentElement, closest,
 * ownerDocument.getElementById / querySelector) so tests can pass plain fakes.
 */
(function (root) {
  'use strict';

  const REDACTED = '[redacted]';
  const MAX_TEXT = 80;

  // ── strings ──────────────────────────────────────────────────────────────

  function clean(s) {
    if (s == null) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  function truncate(s, n) {
    const max = n || MAX_TEXT;
    const c = clean(s);
    if (c.length <= max) return c;
    return c.slice(0, max - 1).trimEnd() + '…';
  }

  /** Empty → null, otherwise cleaned + truncated. */
  function nn(s, n) {
    const c = truncate(s, n);
    return c ? c : null;
  }

  /** Quote a value for a Playwright selector (JSON-style escaping). */
  function quote(s) {
    return JSON.stringify(String(s));
  }

  // ── element basics ───────────────────────────────────────────────────────

  function tagOf(el) {
    return el && el.tagName ? String(el.tagName).toLowerCase() : '';
  }

  function attr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return null;
    const v = el.getAttribute(name);
    return v == null ? null : String(v);
  }

  function inputType(el) {
    return (attr(el, 'type') || (el && el.type) || 'text').toLowerCase();
  }

  function visibleText(el) {
    if (!el) return '';
    // innerText respects CSS visibility in a real DOM; fall back to textContent.
    const t = typeof el.innerText === 'string' && el.innerText ? el.innerText : el.textContent;
    return clean(t);
  }

  function docOf(el) {
    return (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  }

  // ── implicit ARIA role ───────────────────────────────────────────────────

  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox',
    password: null, hidden: null, file: null, color: null, date: null,
    'datetime-local': null, month: null, time: null, week: null,
  };

  const TAG_ROLES = {
    button: 'button', textarea: 'textbox', nav: 'navigation', main: 'main',
    ul: 'list', ol: 'list', li: 'listitem', option: 'option', table: 'table',
    tr: 'row', td: 'cell', th: 'columnheader', dialog: 'dialog', article: 'article',
    aside: 'complementary', progress: 'progressbar', h1: 'heading', h2: 'heading',
    h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', hr: 'separator',
    fieldset: 'group', details: 'group', summary: null, label: null,
  };

  /** Explicit role (first token of role="") or implicit role per HTML-AAM. */
  function roleOf(el) {
    const explicit = clean(attr(el, 'role')).split(' ')[0];
    if (explicit) return explicit.toLowerCase();
    return implicitRole(el);
  }

  function implicitRole(el) {
    const tag = tagOf(el);
    if (tag === 'a' || tag === 'area') return attr(el, 'href') != null ? 'link' : null;
    if (tag === 'input') {
      const t = inputType(el);
      if (t in INPUT_ROLES) {
        const r = INPUT_ROLES[t];
        if (r === 'textbox' && attr(el, 'list')) return 'combobox';
        return r;
      }
      return 'textbox';
    }
    if (tag === 'select') {
      const size = Number(attr(el, 'size') || 0);
      return attr(el, 'multiple') != null || size > 1 ? 'listbox' : 'combobox';
    }
    if (tag === 'img') return attr(el, 'alt') === '' ? 'presentation' : 'img';
    if (tag === 'form') return attr(el, 'aria-label') || attr(el, 'aria-labelledby') || attr(el, 'name') ? 'form' : null;
    if (tag === 'section') return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'region' : null;
    if (Object.prototype.hasOwnProperty.call(TAG_ROLES, tag)) return TAG_ROLES[tag];
    return null;
  }

  // ── labels & accessible name ─────────────────────────────────────────────

  function textOfIds(el, ids) {
    const doc = docOf(el);
    if (!doc || !ids) return '';
    return clean(
      ids
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const node = doc.getElementById(id);
          return node ? visibleText(node) : '';
        })
        .join(' '),
    );
  }

  /** Text of the <label>(s) associated with a form control (label[for], wrapping label). */
  function associatedLabelText(el) {
    if (!el) return '';
    let labels = [];
    if (el.labels && el.labels.length) {
      labels = Array.from(el.labels);
    } else {
      const doc = docOf(el);
      const id = attr(el, 'id');
      if (doc && id && typeof doc.querySelector === 'function') {
        let found = null;
        try {
          found = doc.querySelector('label[for=' + quote(id) + ']');
        } catch (_) {
          found = null;
        }
        if (found) labels.push(found);
      }
      if (!labels.length && typeof el.closest === 'function') {
        const wrap = el.closest('label');
        if (wrap) labels.push(wrap);
      }
    }
    return clean(labels.map((l) => labelTextExcludingControl(l, el)).join(' '));
  }

  // A wrapping <label> contains the control itself; don't include e.g. a <select>'s options.
  function labelTextExcludingControl(label, control) {
    const full = visibleText(label);
    const tag = tagOf(control);
    if (tag === 'select' || tag === 'textarea') {
      const inner = visibleText(control);
      if (inner && full.includes(inner)) return clean(full.replace(inner, ' '));
    }
    return full;
  }

  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'treeitem', 'heading', 'cell', 'columnheader', 'rowheader', 'row', 'tooltip',
  ]);

  /** Accessible name, approximating accname-1.2 for the cases that matter on real sites. */
  function accessibleName(el) {
    if (!el) return null;
    const labelledBy = textOfIds(el, attr(el, 'aria-labelledby'));
    if (labelledBy) return nn(labelledBy);
    const ariaLabel = clean(attr(el, 'aria-label'));
    if (ariaLabel) return nn(ariaLabel);

    const tag = tagOf(el);
    const role = roleOf(el);
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      const t = inputType(el);
      if (tag === 'input' && (t === 'submit' || t === 'button' || t === 'reset')) {
        const v = clean(attr(el, 'value') || el.value);
        if (v) return nn(v);
        if (t === 'submit') return 'Submit';
        if (t === 'reset') return 'Reset';
      }
      if (tag === 'input' && t === 'image') {
        const alt = clean(attr(el, 'alt'));
        if (alt) return nn(alt);
      }
      const lbl = associatedLabelText(el);
      if (lbl) return nn(lbl);
      const title = clean(attr(el, 'title'));
      if (title) return nn(title);
      const ph = clean(attr(el, 'placeholder'));
      if (ph) return nn(ph);
      return null;
    }
    if (tag === 'img' || tag === 'area') {
      const alt = clean(attr(el, 'alt'));
      if (alt) return nn(alt);
    }
    if (NAME_FROM_CONTENT.has(role) || tag === 'a' || tag === 'button' || tag === 'summary' || tag === 'label') {
      const txt = visibleText(el);
      if (txt) return nn(txt);
      // icon-only buttons: look for an <img alt> / [aria-label] / <title> inside
      if (typeof el.querySelector === 'function') {
        const inner = el.querySelector('img[alt],[aria-label],svg title');
        if (inner) {
          const n = clean(attr(inner, 'alt') || attr(inner, 'aria-label') || inner.textContent);
          if (n) return nn(n);
        }
      }
    }
    const title = clean(attr(el, 'title'));
    if (title) return nn(title);
    return null;
  }

  /** "label" field: associated <label>, else aria-label, else placeholder. */
  function labelOf(el) {
    const lbl = associatedLabelText(el);
    if (lbl) return nn(lbl);
    const aria = clean(attr(el, 'aria-label')) || textOfIds(el, attr(el, 'aria-labelledby'));
    if (aria) return nn(aria);
    const ph = clean(attr(el, 'placeholder'));
    if (ph) return nn(ph);
    return null;
  }

  // ── selectors ────────────────────────────────────────────────────────────

  const ROLE_SELECTOR_ROLES = new Set([
    'link', 'button', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'combobox', 'listbox', 'textbox', 'searchbox', 'spinbutton', 'slider', 'treeitem',
    'heading', 'img',
  ]);

  const TEXT_LIKE = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'listbox']);

  /**
   * Best-effort Playwright selector from already-extracted facts.
   * Preference: role=<role>[name="…"] → internal:label="…"i → text="…" → #id / [name] / tag.
   */
  function buildSelector(info) {
    const i = info || {};
    const role = i.role || null;
    const name = clean(i.name);
    const label = clean(i.label);
    const text = clean(i.text);
    if (role && name && ROLE_SELECTOR_ROLES.has(role)) {
      return 'role=' + role + '[name=' + quote(name) + ']';
    }
    if (label && (TEXT_LIKE.has(role) || i.tag === 'input' || i.tag === 'select' || i.tag === 'textarea')) {
      return 'internal:label=' + quote(label) + 'i';
    }
    if (text && text.length <= MAX_TEXT) {
      return 'text=' + quote(text);
    }
    if (i.id && /^[A-Za-z][\w-]*$/.test(i.id) && !/\d{3,}/.test(i.id)) return '#' + i.id;
    if (i.tag && i.nameAttr) return i.tag + '[name=' + quote(i.nameAttr) + ']';
    return i.tag || null;
  }

  /** Build a RecordedTarget (lib/contracts.ts) for a DOM element. */
  function describeElement(el) {
    if (!el) return null;
    const tag = tagOf(el);
    const role = roleOf(el);
    const name = accessibleName(el);
    const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
    // Never put a field's (possibly secret) value into "text".
    const text = isField ? null : nn(visibleText(el));
    const label = labelOf(el);
    const selector = buildSelector({
      tag,
      role,
      name,
      label,
      text,
      id: attr(el, 'id'),
      nameAttr: attr(el, 'name'),
    });
    return { tag, role, name, text, label, selector };
  }

  // ── click target resolution ──────────────────────────────────────────────

  const INTERACTIVE_SELECTOR =
    'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],' +
    '[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=checkbox],[role=radio],[role=switch],' +
    '[role=treeitem],[role=combobox],[role],[onclick],[contenteditable=""],[contenteditable=true]';

  /**
   * Nearest interactive ancestor (inclusive). A <label> for a control resolves to the
   * control itself (its click is what matters for replay), keeping the label as the name.
   */
  function resolveClickTarget(start) {
    let el = start;
    if (el && el.nodeType === 3) el = el.parentElement; // text node
    if (!el || typeof el.closest !== 'function') return null;
    let hit = el.closest(INTERACTIVE_SELECTOR);
    if (!hit) return null;
    // Generic containers with a role like "region"/"main" aren't click targets.
    const r = roleOf(hit);
    if (r && /^(region|main|navigation|complementary|banner|contentinfo|list|listitem|group|presentation|none|article|form|dialog|document|application|table|row|rowgroup)$/.test(r) && tagOf(hit) !== 'a' && tagOf(hit) !== 'button') {
      const parent = hit.parentElement && typeof hit.parentElement.closest === 'function' ? hit.parentElement.closest('a[href],button,[onclick]') : null;
      if (!parent) return null;
      hit = parent;
    }
    if (tagOf(hit) === 'label') {
      const control = hit.control || (attr(hit, 'for') && docOf(hit) ? docOf(hit).getElementById(attr(hit, 'for')) : null) ||
        (typeof hit.querySelector === 'function' ? hit.querySelector('input,select,textarea') : null);
      if (control) return control;
    }
    return hit;
  }

  /** Text fields get "type" actions; a click into them is just focus noise. */
  function isTextEntry(el) {
    const tag = tagOf(el);
    if (tag === 'textarea' || tag === 'select') return true;
    if (tag === 'input') {
      const t = inputType(el);
      return !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'range', 'color'].includes(t);
    }
    if (el && (el.isContentEditable || attr(el, 'contenteditable') === '' || attr(el, 'contenteditable') === 'true')) return true;
    return false;
  }

  // ── privacy ──────────────────────────────────────────────────────────────

  const SENSITIVE_HINT = /(pass(word|wd|code)?\b|pwd|card.?(num|no|number)|cc.?(num|number|no)|credit.?card|cvv|cvc|csc|cvn|security.?code|card.?(code|verification)|one.?time|otp|\bpin\b|ssn|social.?security|iban|routing|account.?number)/i;

  function looksLikeCardNumber(value) {
    const s = String(value == null ? '' : value).trim();
    if (!/^[\d\s-]+$/.test(s)) return false;
    const digits = s.replace(/[\s-]/g, '');
    return digits.length >= 13 && digits.length <= 19;
  }

  /**
   * Should this field's value be replaced with "[redacted]"?
   * info: { type, autocomplete, name, id, label, placeholder, ariaLabel }  value: the final value.
   */
  function shouldRedact(info, value) {
    const i = info || {};
    const type = String(i.type || '').toLowerCase();
    if (type === 'password') return true;
    const ac = String(i.autocomplete || '').toLowerCase().split(/\s+/);
    if (ac.some((t) => t.startsWith('cc-') || t === 'one-time-code' || t === 'current-password' || t === 'new-password')) return true;
    const hints = [i.name, i.id, i.label, i.placeholder, i.ariaLabel].filter(Boolean).join(' ');
    if (hints && SENSITIVE_HINT.test(hints)) return true;
    if (looksLikeCardNumber(value)) return true;
    return false;
  }

  function fieldInfo(el) {
    return {
      type: tagOf(el) === 'input' ? inputType(el) : tagOf(el),
      autocomplete: attr(el, 'autocomplete'),
      name: attr(el, 'name'),
      id: attr(el, 'id'),
      label: associatedLabelText(el),
      placeholder: attr(el, 'placeholder'),
      ariaLabel: attr(el, 'aria-label'),
    };
  }

  /** The value to record for a field: redacted when sensitive, never longer than 500 chars. */
  function safeValue(el, value) {
    const v = value == null ? '' : String(value);
    if (shouldRedact(fieldInfo(el), v)) return REDACTED;
    return v.length > 500 ? v.slice(0, 500) : v;
  }

  // ── human wording ────────────────────────────────────────────────────────

  function shortUrl(u) {
    try {
      const x = new URL(u);
      const p = x.pathname === '/' ? '' : x.pathname;
      return x.host + p;
    } catch (_) {
      return String(u || '');
    }
  }

  function targetWords(t) {
    if (!t) return null;
    return t.name || t.label || t.text || null;
  }

  /** 'Clicked "Billing"', 'Typed in "Email"', 'Chose "No longer needed"', … */
  function humanize(a) {
    if (!a) return '';
    const what = targetWords(a.target);
    switch (a.action) {
      case 'navigate':
        return 'Opened ' + shortUrl(a.url);
      case 'click':
        return what ? 'Clicked "' + truncate(what, 48) + '"' : 'Clicked ' + ((a.target && a.target.tag) || 'something');
      case 'type':
        return what ? 'Typed in "' + truncate(what, 48) + '"' : 'Typed in a field';
      case 'select':
        if (a.value) return 'Chose "' + truncate(a.value, 48) + '"';
        return what ? 'Chose an option in "' + truncate(what, 40) + '"' : 'Chose an option';
      case 'submit':
        return what ? 'Submitted "' + truncate(what, 48) + '"' : 'Submitted a form';
      default:
        return String(a.action || '');
    }
  }

  const api = {
    REDACTED,
    clean,
    truncate,
    tagOf,
    roleOf,
    implicitRole,
    accessibleName,
    labelOf,
    associatedLabelText,
    buildSelector,
    describeElement,
    resolveClickTarget,
    isTextEntry,
    looksLikeCardNumber,
    shouldRedact,
    fieldInfo,
    safeValue,
    humanize,
    shortUrl,
  };

  root.DoItOnceLib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

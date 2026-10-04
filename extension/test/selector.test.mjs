// Pure-helper tests for extension/lib.js. Run: node --test extension/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../lib.js', import.meta.url), 'utf8');
const ctx = { URL };
ctx.globalThis = ctx;
vm.runInNewContext(src, ctx);
const L = ctx.DoItOnceLib;

// ── a tiny fake DOM: just enough surface for lib.js ─────────────────────────
function makeDoc() {
  const byId = new Map();
  const labelsFor = new Map();
  const doc = {
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => {
      const m = /^label\[for="(.*)"\]$/.exec(sel);
      return m ? labelsFor.get(m[1]) || null : null;
    },
  };
  function el(tag, attrs = {}, opts = {}) {
    const node = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      ownerDocument: doc,
      parentElement: opts.parent || null,
      textContent: opts.text || '',
      value: opts.value,
      getAttribute: (n) => (n in attrs ? attrs[n] : null),
      closest: (s) => (s === 'label' ? findUp(node, 'LABEL') : null),
      querySelector: () => null,
    };
    if (attrs.id) byId.set(attrs.id, node);
    if (tag === 'label' && attrs.for) labelsFor.set(attrs.for, node);
    return node;
  }
  function findUp(n, tag) {
    for (let p = n; p; p = p.parentElement) if (p.tagName === tag) return p;
    return null;
  }
  return { doc, el };
}

test('implicit and explicit roles', () => {
  const { el } = makeDoc();
  assert.equal(L.roleOf(el('a', { href: '/account/billing' })), 'link');
  assert.equal(L.roleOf(el('a', {})), null);
  assert.equal(L.roleOf(el('button')), 'button');
  assert.equal(L.roleOf(el('input', { type: 'submit' })), 'button');
  assert.equal(L.roleOf(el('input', { type: 'checkbox' })), 'checkbox');
  assert.equal(L.roleOf(el('input', { type: 'email' })), 'textbox');
  assert.equal(L.roleOf(el('input', {})), 'textbox');
  assert.equal(L.roleOf(el('input', { type: 'password' })), null);
  assert.equal(L.roleOf(el('select')), 'combobox');
  assert.equal(L.roleOf(el('select', { multiple: '' })), 'listbox');
  assert.equal(L.roleOf(el('textarea')), 'textbox');
  assert.equal(L.roleOf(el('div', { role: 'tab menuitem' })), 'tab');
  assert.equal(L.roleOf(el('h2')), 'heading');
});

test('accessible name: aria-labelledby > aria-label > label > content > title', () => {
  const { el } = makeDoc();
  el('span', { id: 'l1' }, { text: 'Plan' });
  el('span', { id: 'l2' }, { text: ' & payments ' });
  assert.equal(L.accessibleName(el('button', { 'aria-labelledby': 'l1 l2' }, { text: 'x' })), 'Plan & payments');
  assert.equal(L.accessibleName(el('button', { 'aria-label': 'Close dialog' }, { text: '×' })), 'Close dialog');
  assert.equal(L.accessibleName(el('a', { href: '/b' }, { text: '\n   Billing \n' })), 'Billing');
  assert.equal(L.accessibleName(el('button', { title: 'Settings' })), 'Settings');
  assert.equal(L.accessibleName(el('img', { alt: 'Lumen+ logo' })), 'Lumen+ logo');
  assert.equal(L.accessibleName(el('input', { type: 'submit', value: 'Save changes' })), 'Save changes');
  assert.equal(L.accessibleName(el('input', { type: 'submit' })), 'Submit');
});

test('accessible name for fields: label[for], wrapping label, placeholder', () => {
  const { el } = makeDoc();
  el('label', { for: 'email' }, { text: 'Email address' });
  const email = el('input', { id: 'email', type: 'email' });
  assert.equal(L.accessibleName(email), 'Email address');
  assert.equal(L.labelOf(email), 'Email address');

  const wrap = el('label', {}, { text: 'Reason' });
  const reason = el('input', { type: 'text' }, { parent: wrap });
  assert.equal(L.accessibleName(reason), 'Reason');

  const q = el('input', { type: 'search', placeholder: 'Search titles' });
  assert.equal(L.accessibleName(q), 'Search titles');
  assert.equal(L.labelOf(q), 'Search titles');
});

test('selector preference: role+name, then label, then text, then fallbacks', () => {
  assert.equal(L.buildSelector({ tag: 'a', role: 'link', name: 'Billing' }), 'role=link[name="Billing"]');
  assert.equal(
    L.buildSelector({ tag: 'button', role: 'button', name: 'Say "no" thanks' }),
    'role=button[name="Say \\"no\\" thanks"]',
  );
  assert.equal(L.buildSelector({ tag: 'input', role: null, name: null, label: 'Password' }), 'internal:label="Password"i');
  assert.equal(L.buildSelector({ tag: 'div', role: null, name: null, label: null, text: 'Continue' }), 'text="Continue"');
  assert.equal(L.buildSelector({ tag: 'div', id: 'go' }), '#go');
  assert.equal(L.buildSelector({ tag: 'div', id: 'ember1234' }), 'div');
  assert.equal(L.buildSelector({ tag: 'input', nameAttr: 'q' }), 'input[name="q"]');
});

test('describeElement builds a RecordedTarget with exactly the contract keys', () => {
  const { el } = makeDoc();
  const t = L.describeElement(el('a', { href: '/account/membership' }, { text: '  Manage membership ' }));
  assert.deepEqual(Object.keys(t).sort(), ['label', 'name', 'role', 'selector', 'tag', 'text']);
  assert.deepEqual({ ...t }, {
    tag: 'a',
    role: 'link',
    name: 'Manage membership',
    text: 'Manage membership',
    label: null,
    selector: 'role=link[name="Manage membership"]',
  });
  const long = L.describeElement(el('button', {}, { text: 'x'.repeat(200) }));
  assert.ok(long.text.length <= 80);
  // Fields never expose their value via "text".
  const { el: el2 } = makeDoc();
  el2('label', { for: 'cc' }, { text: 'Card number' });
  const cc = L.describeElement(el2('input', { id: 'cc', type: 'text' }, { text: '', value: '4242424242424242' }));
  assert.equal(cc.text, null);
  assert.equal(cc.selector, 'role=textbox[name="Card number"]');
});

test('redaction: passwords, cc-* / one-time-code autocomplete, card numbers, CVV hints', () => {
  assert.equal(L.shouldRedact({ type: 'password' }, 'hunter2'), true);
  assert.equal(L.shouldRedact({ type: 'text', autocomplete: 'cc-number' }, '1'), true);
  assert.equal(L.shouldRedact({ type: 'text', autocomplete: 'section-pay billing cc-csc' }, '123'), true);
  assert.equal(L.shouldRedact({ type: 'text', autocomplete: 'one-time-code' }, '123456'), true);
  assert.equal(L.shouldRedact({ type: 'text', name: 'cvv' }, '123'), true);
  assert.equal(L.shouldRedact({ type: 'text', label: 'Security code' }, '1234'), true);
  assert.equal(L.shouldRedact({ type: 'text', name: 'note' }, '4242 4242 4242 4242'), true);
  assert.equal(L.shouldRedact({ type: 'text', name: 'note' }, '4242-4242-4242-4242'), true);
  assert.equal(L.shouldRedact({ type: 'email', name: 'email', label: 'Email' }, 'ali@example.com'), false);
  assert.equal(L.shouldRedact({ type: 'text', name: 'reason' }, 'Too expensive'), false);
  assert.equal(L.shouldRedact({ type: 'tel', name: 'phone' }, '415 555 0100'), false);
  assert.equal(L.looksLikeCardNumber('12345'), false);

  const { el } = makeDoc();
  assert.equal(L.safeValue(el('input', { type: 'password' }), 'secret'), '[redacted]');
  assert.equal(L.safeValue(el('input', { type: 'text', name: 'city' }), 'Seattle'), 'Seattle');
});

test('human wording for the popup list', () => {
  const t = (name, extra = {}) => ({ tag: 'a', role: 'link', name, text: name, label: null, selector: null, ...extra });
  assert.equal(L.humanize({ action: 'click', target: t('Billing') }), 'Clicked "Billing"');
  assert.equal(L.humanize({ action: 'type', target: t(null, { label: 'Email' }), value: 'x' }), 'Typed in "Email"');
  assert.equal(L.humanize({ action: 'select', target: t('Reason'), value: 'No longer needed' }), 'Chose "No longer needed"');
  assert.equal(L.humanize({ action: 'submit', target: null }), 'Submitted a form');
  assert.equal(L.humanize({ action: 'navigate', url: 'http://localhost:4011/account', target: null }), 'Opened localhost:4011/account');
  assert.equal(L.humanize({ action: 'click', target: { tag: 'div', role: null, name: null, text: null, label: null } }), 'Clicked div');
});

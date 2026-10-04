// Tests for extension/guide/guide-lib.js (Guide me). Run: node --test extension/test/guide.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ctx = { URL };
ctx.globalThis = ctx;
vm.runInNewContext(read('../lib.js'), ctx);
vm.runInNewContext(read('../guide/guide-lib.js'), ctx);
const L = ctx.DoItOnceLib;
const G = ctx.DoItOnceGuide;

// Minimal fake elements: enough for roleOf / accessibleName / describeElement. Each counts clicks.
let clicks = 0;
const doc = { getElementById: () => null, querySelector: () => null };
function el(tag, attrs = {}, text = '') {
  return {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    ownerDocument: doc,
    parentElement: null,
    textContent: text,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    closest: () => null,
    querySelector: () => null,
    contains: () => false,
    click: () => clicks++,
    dispatchEvent: () => clicks++,
  };
}

const billingHeading = el('h2', {}, 'Billing details');
const billing = el('a', { href: '/account/billing' }, 'Billing');
const billingHistory = el('a', { href: '/account/history' }, 'Billing history');
const plan = el('a', { href: '/account/plan' }, 'Plan & payments');
const confirm = el('button', { type: 'submit' }, 'Confirm cancellation');
const quiet = el('span', { onclick: 'x' }, 'Open the billing area here');

test('resolution order: locatorHint wins, exact name over substring', () => {
  const step = { locatorHint: 'role=link[name="Billing"]', matchText: 'Plan & payments', targetDescription: null };
  const hit = G.resolveStep(step, [billingHeading, billingHistory, billing, plan], L);
  assert.equal(hit.via, 'hint');
  assert.equal(hit.el, billing); // exact "Billing", not "Billing history"
});

test('resolution order: role+name from matchText when the hint is stale', () => {
  const step = { locatorHint: 'role=link[name="Billing"]', matchText: 'Plan & payments', targetDescription: 'Billing link' };
  const hit = G.resolveStep(step, [billingHeading, plan], L);
  assert.equal(hit.via, 'name');
  assert.equal(hit.el, plan);
});

test('resolution order: visible text last, null when nothing fits', () => {
  const step = { locatorHint: null, matchText: null, targetDescription: 'billing area' };
  const hit = G.resolveStep(step, [quiet], L);
  assert.equal(hit.via, 'text');
  assert.equal(hit.el, quiet);
  assert.equal(G.resolveStep({ locatorHint: 'role=link[name="Nope"]', matchText: 'Nope' }, [billing, plan], L), null);
});

test('parseSelector handles role, text, label, nth', () => {
  assert.deepEqual({ ...G.parseSelector('role=button[name="Confirm cancellation"]') }, { kind: 'role', role: 'button', name: 'Confirm cancellation', exact: false, nth: null });
  assert.equal(G.parseSelector('text="More options"').text, 'More options');
  assert.equal(G.parseSelector('internal:label="Email"i').label, 'Email');
  assert.equal(G.parseSelector('role=link[name="A"] >> nth=2').nth, 2);
  assert.equal(G.parseSelector('xpath=//a'), null);
});

test('advance: a click step needs the user to act, then expected text or a URL change', () => {
  const step = { actionType: 'click', expectedAfter: 'Manage membership|Manage plan' };
  const base = { step, pageText: 'Account. Manage membership', url: 'http://x/account' };
  assert.equal(G.shouldAdvance({ ...base, acted: null }), false); // text already there, but no action yet
  assert.equal(G.shouldAdvance({ ...base, acted: { url: 'http://x/account', onTarget: false } }), true);
  const noText = { step, pageText: 'Your plan', url: 'http://x/account/plan' };
  assert.equal(G.shouldAdvance({ ...noText, acted: { url: 'http://x/account', onTarget: true } }), true);
  assert.equal(G.shouldAdvance({ ...noText, acted: { url: 'http://x/account', onTarget: false } }), false);
  assert.equal(G.shouldAdvance({ ...noText, url: 'http://x/account#top', acted: { url: 'http://x/account', onTarget: true } }), false);
});

test('advance: a navigate step advances once its page is open', () => {
  const step = { actionType: 'navigate', expectedAfter: 'Welcome back' };
  assert.equal(G.shouldAdvance({ step, pageText: 'Welcome back, Ali', url: 'u', acted: null }), true);
  assert.equal(G.shouldAdvance({ step, pageText: 'Sign in', url: 'u', acted: null }), false);
});

test('verification: allOf + anyOf, empty spec never passes', () => {
  const spec = {
    allOf: [{ type: 'url_matches', value: '/account/membership(\\?|$)' }],
    anyOf: [{ type: 'text_contains', value: 'Membership canceled' }, { type: 'text_contains', value: 'Renews: No' }],
  };
  assert.equal(G.verify(spec, { url: 'http://h/account/membership?canceled=1', text: 'Membership canceled. Renews: No' }), true);
  assert.equal(G.verify(spec, { url: 'http://h/account/membership', text: 'Renews: Dec 1' }), false);
  assert.equal(G.verify(spec, { url: 'http://h/account/billing', text: 'Membership canceled' }), false);
  assert.equal(G.verify({ allOf: [{ type: 'text_absent', value: 'Active' }] }, { url: '', text: 'Canceled' }), true);
  assert.equal(G.verify({}, { url: '', text: 'x' }), false);
});

test('irreversible step gets the amber tooltip', () => {
  const skill = { steps: [{ intent: 'Open billing settings', requiresApproval: false, targetDescription: 'Billing link' }, { intent: 'Confirm the cancellation', requiresApproval: true }] };
  assert.deepEqual({ ...G.tooltipFor(skill, 0) }, { title: 'Step 1 of 2 · Open billing settings', note: 'Billing link', amber: false });
  const t = G.tooltipFor(skill, 1);
  assert.equal(t.amber, true);
  assert.equal(t.note, 'This is the irreversible step — your call.');
});

test('locate list: role/name/selector only, de-duplicated, never field values', () => {
  const email = el('input', { type: 'email', 'aria-label': 'Email' });
  email.value = 'secret@example.com';
  const twin = el('a', { href: '/b' }, 'Billing');
  const { list, map } = G.buildLocateList([billing, twin, email], L);
  assert.deepEqual([...list.map((x) => x.selector)], ['role=link[name="Billing"]', 'role=link[name="Billing"] >> nth=1', 'role=textbox[name="Email"]']);
  assert.equal(map.get('role=link[name="Billing"] >> nth=1'), twin);
  assert.ok(!JSON.stringify(list).includes('secret'));
  assert.equal(G.findBySelector('role=link[name="Billing"] >> nth=1', [billing, twin], L), twin);
});

test('hash parsing', () => {
  assert.equal(G.guideIdFromHash('#dio-guide=10000000-0000-4000-8000-000000000001'), '10000000-0000-4000-8000-000000000001');
  assert.equal(G.guideIdFromHash('#other'), null);
});

test('never clicks: resolving and advancing touch no element, and the scripts contain no click calls', () => {
  clicks = 0;
  const steps = [
    { actionType: 'click', locatorHint: 'role=link[name="Billing"]', matchText: 'Billing', expectedAfter: 'x' },
    { actionType: 'click', locatorHint: 'role=button[name="Confirm cancellation"]', matchText: 'Confirm cancellation', requiresApproval: true, expectedAfter: 'y' },
  ];
  for (const s of steps) {
    G.resolveStep(s, [billing, confirm, plan], L);
    G.shouldAdvance({ step: s, pageText: '', url: 'u', acted: null });
  }
  G.buildLocateList([billing, confirm], L);
  assert.equal(clicks, 0);
  for (const f of ['../guide/guide-lib.js', '../guide/guide.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.ok(!/\.click\s*\(|dispatchEvent\s*\(|\.submit\s*\(|requestSubmit\s*\(/.test(src), f + ' must never act for the user');
  }
});

// End-to-end check of the Lumen Store "return an online item" flow. Run: node demo-site/test-store.mjs
// Walks Orders → headphones order → Return or replace items → item + reason → refund / drop-off / label
// → review → Submit return → "Return started" with RMA, drop-off date, inline QR and a downloadable label.
import assert from 'node:assert/strict';
import { createServer } from './server.mjs';

process.env.DEMO_RESET_TOKEN = 'test-token';

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const textOf = (html) =>
  decode(html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const names = (html, tag) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => textOf(m[1]));
function uniqueRole(html, tag, name) {
  const hits = names(html, tag).filter((n) => n.toLowerCase().includes(name.toLowerCase()));
  assert.equal(hits.length, 1, `expected exactly one <${tag}> named "${name}", got ${JSON.stringify(hits)}`);
}
const hrefOf = (html, name) => {
  const m = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find((x) => textOf(x[2]) === name);
  assert.ok(m, `link "${name}" not found`);
  return decode(m[1]);
};
const attr = (tag, a) => (tag.match(new RegExp(`\\b${a}="([^"]*)"`)) || [])[1];
/** Finds the form control labelled exactly `text` (<label for>), checks the label is unique (case-insensitive
 *  substring, like Playwright getByLabel), and returns the control's name/value/type. */
function control(html, text) {
  const labels = [...html.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)].map((m) => ({ id: m[1], text: textOf(m[2]) }));
  const hits = labels.filter((l) => l.text.toLowerCase().includes(text.toLowerCase()));
  assert.equal(hits.length, 1, `expected exactly one label "${text}", got ${JSON.stringify(hits.map((h) => h.text))}`);
  assert.equal(hits[0].text, text, `label text should be exactly "${text}"`);
  const el = html.match(new RegExp(`<(input|select|textarea)\\b[^>]*\\bid="${hits[0].id}"[^>]*>`));
  assert.ok(el, `no control with id ${hits[0].id} for label "${text}"`);
  return { tag: el[1], type: attr(el[0], 'type'), name: attr(el[0], 'name'), value: attr(el[0], 'value') };
}
const optionValue = (html, selectName, optionText) => {
  const sel = html.match(new RegExp(`<select\\b[^>]*name="${selectName}"[^>]*>([\\s\\S]*?)</select>`));
  const opt = [...sel[1].matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].find((m) => textOf(m[2]) === optionText);
  assert.ok(opt, `option "${optionText}" not found`);
  return opt[1];
};
const formOf = (html, buttonText) => {
  const f = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find((m) => m[2].includes(`>${buttonText}</button>`));
  assert.ok(f, `form with button "${buttonText}" not found`);
  const hiddenFields = Object.fromEntries([...f[2].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], decode(m[2])]));
  return { method: attr(f[1], 'method'), action: attr(f[1], 'action'), hidden: hiddenFields };
};

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { res, html: await res.text() };
}
async function visit(path, expected) {
  const { res, html } = await get(path);
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  const text = textOf(html);
  for (const e of [].concat(expected)) assert.ok(text.includes(e), `${path} should contain "${e}"\n---\n${text.slice(0, 800)}`);
  return { html, text };
}
const postForm = (path, fields) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
const stateNow = async () => (await fetch(base + '/api/state')).json();

const in14 = new Date();
in14.setDate(in14.getDate() + 14);
const dropBy = in14.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
  assert.equal((await stateNow()).returns, undefined, 'no returns yet');

  // Header → Lumen Store → orders
  const home = await visit('/account', 'Welcome back');
  uniqueRole(home.html, 'a', 'Lumen Store');
  assert.equal(hrefOf(home.html, 'Lumen Store'), '/store');
  const shop = await visit('/store', ['Lumen Store', 'Gear made for Lumen+']);
  uniqueRole(shop.html, 'a', 'Your orders');
  assert.equal(hrefOf(shop.html, 'Your orders'), '/store/orders');
  ok('header "Lumen Store" → /store; store nav "Your orders" → /store/orders');

  const orders = await visit('/store/orders', [
    'Your orders',
    'Lumen Aura Wireless Headphones · $129.00 · Delivered Sep 28, 2026 · Eligible for return until Oct 28, 2026',
    'Lumen+ Digital Gift Card ($50)',
    'Not eligible for return',
    'Lumen Stream Stick 4K',
  ]);
  assert.equal((orders.html.match(/class="card order"/g) || []).length, 3, 'three orders');
  for (const n of ['Lumen Aura Wireless Headphones', 'View order #LS-20931', 'View order #LS-20877', 'View order #LS-20412', 'Your orders'])
    uniqueRole(orders.html, 'a', n);
  ok('orders page lists 3 orders incl. the headphones line and a non-returnable item');

  // Non-returnable order has no return button; its return URL bounces.
  const gift = await visit(hrefOf(orders.html, 'View order #LS-20877'), 'Not eligible for return');
  assert.ok(!gift.text.includes('Return or replace items'));
  assert.equal((await get('/store/orders/LS-20877/return')).res.status, 303);
  ok('non-returnable order: no "Return or replace items"; return URL redirects');

  // Headphones order → Return or replace items
  const orderHref = hrefOf(orders.html, 'Lumen Aura Wireless Headphones');
  assert.equal(orderHref, '/store/orders/LS-20931');
  const order = await visit(orderHref, ['Order details', 'Lumen Aura Wireless Headphones', 'Eligible for return until Oct 28, 2026', 'Visa •••• 4242']);
  uniqueRole(order.html, 'a', 'Return or replace items');
  const startHref = hrefOf(order.html, 'Return or replace items');
  assert.equal(startHref, '/store/orders/LS-20931/return');
  ok('order detail shows eligibility and "Return or replace items"');

  // Step 1: item + reason
  const start = await visit(startHref, ['Return or replace items', 'Which item are you returning?', 'Reason for return']);
  const item = control(start.html, 'Lumen Aura Wireless Headphones');
  assert.deepEqual([item.tag, item.type, item.name, item.value], ['input', 'checkbox', 'item', 'aura']);
  const reasonCtl = control(start.html, 'Reason for return');
  assert.equal(reasonCtl.tag, 'select');
  const reason = optionValue(start.html, 'reason', 'No longer needed');
  uniqueRole(start.html, 'button', 'Continue');
  const f1 = formOf(start.html, 'Continue');
  assert.equal(f1.method, 'post');
  const bad1 = await postForm(f1.action, { item: 'aura' });
  assert.equal(bad1.status, 422);
  assert.ok(textOf(await bad1.text()).includes('Choose a reason for the return.'));
  const p1 = await postForm(f1.action, { item: item.value, [reasonCtl.name]: reason, comments: '' });
  assert.equal(p1.status, 303);
  const optionsHref = p1.headers.get('location');
  assert.match(optionsHref, /^\/store\/orders\/LS-20931\/return\/options\?/);
  ok('step 1: labelled checkbox + reason <select>; missing reason → 422; POST → 303 to options');

  // Step 2: refund destination / drop-off / label format (radios, by label)
  const opts = await visit(optionsHref, ['Refund and drop-off', 'Refund destination', 'Return method', 'Label format']);
  const want = { 'Original payment method (Visa •••• 4242)': 'refund', 'Store credit': 'refund', 'UPS Store': 'dropoff', 'Schedule pickup': 'dropoff', 'QR code': 'label', 'Print label': 'label' };
  for (const [label, name] of Object.entries(want)) {
    const c = control(opts.html, label);
    assert.equal(c.type, 'radio', `${label} is a radio`);
    assert.equal(c.name, name);
  }
  assert.ok(!/type="radio"[^>]*checked/.test(opts.html), 'no option preselected');
  uniqueRole(opts.html, 'button', 'Continue to review');
  const f2 = formOf(opts.html, 'Continue to review');
  assert.equal(f2.hidden.item, 'aura');
  assert.equal(f2.hidden.reason, reason);
  const bad2 = await postForm(f2.action, { ...f2.hidden, refund: 'original' });
  assert.equal(bad2.status, 422);
  const choice = {
    refund: control(opts.html, 'Original payment method (Visa •••• 4242)').value,
    dropoff: control(opts.html, 'UPS Store').value,
    label: control(opts.html, 'QR code').value,
  };
  const p2 = await postForm(f2.action, { ...f2.hidden, ...choice });
  assert.equal(p2.status, 303);
  const reviewHref = p2.headers.get('location');
  assert.match(reviewHref, /^\/store\/orders\/LS-20931\/return\/review\?/);
  ok('step 2: six exactly-labelled radios; incomplete → 422; POST → 303 to review');

  // Step 3: review → Submit return
  const review = await visit(reviewHref, [
    'Review your return', 'Lumen Aura Wireless Headphones', 'No longer needed',
    'Original payment method (Visa •••• 4242)', '$129.00', 'UPS Store', 'QR code', `Drop off by ${dropBy}`,
  ]);
  uniqueRole(review.html, 'button', 'Submit return');
  const f3 = formOf(review.html, 'Submit return');
  assert.equal(f3.method, 'post');
  assert.equal(f3.action, '/store/orders/LS-20931/return/submit');
  assert.equal((await stateNow()).returns, undefined, 'nothing created before submit');
  ok('step 3: review summary; "Submit return" posts to /return/submit');

  const p3 = await postForm(f3.action, f3.hidden);
  assert.equal(p3.status, 303);
  const doneHref = p3.headers.get('location');
  const rma = doneHref.match(/^\/store\/returns\/(RMA-\d{8})$/)?.[1];
  assert.ok(rma, `unexpected location ${doneHref}`);
  const done = await visit(doneHref, ['Return started', rma, `Drop off by ${dropBy}`, 'UPS Store', 'Original payment method (Visa •••• 4242)', '$129.00']);
  assert.match(done.html, /<svg role="img" aria-label="Return QR code for RMA-\d{8}"[^>]*viewBox="0 0 (\d+) \1"[^>]*>[\s\S]*?<path d="M/, 'inline QR svg');
  uniqueRole(done.html, 'a', 'Download label');
  const labelHref = hrefOf(done.html, 'Download label');
  assert.equal(labelHref, `/store/returns/${rma}/label.svg`);
  ok(`submit → 303 → "Return started" with ${rma}, drop-off date and inline QR`);

  const label = await fetch(base + labelHref);
  assert.equal(label.status, 200);
  assert.match(label.headers.get('content-type'), /^image\/svg\+xml/);
  assert.match(label.headers.get('content-disposition'), new RegExp(`attachment; filename="lumen-return-${rma}.svg"`));
  const svg = await label.text();
  assert.ok(svg.startsWith('<?xml') && svg.includes('<svg xmlns="http://www.w3.org/2000/svg"') && svg.includes(rma));
  ok('label.svg downloads as an attachment with the RMA');

  // State
  const st = await stateNow();
  assert.equal(st.returns.length, 1);
  const r = st.returns[0];
  assert.equal(r.rma, rma);
  assert.equal(r.status, 'started');
  assert.equal(r.orderId, 'LS-20931');
  assert.equal(r.item, 'Lumen Aura Wireless Headphones');
  assert.equal(r.reason, 'No longer needed');
  assert.equal(r.refund, 'original');
  assert.equal(r.dropOff, 'ups_store');
  assert.equal(r.labelFormat, 'qr');
  assert.equal(r.refundAmount, '$129.00');
  assert.equal(r.dropOffBy, dropBy);
  assert.equal(r.labelUrl, labelHref);
  ok('/api/state.returns has the return with refund/drop-off/label choices');

  // Idempotent: the order now links to the return; re-submitting doesn't create a second one.
  const after = await visit('/store/orders/LS-20931', `Return started · ${rma}`);
  assert.ok(!after.text.includes('Return or replace items'));
  assert.equal((await get('/store/orders/LS-20931/return')).res.headers.get('location'), doneHref);
  assert.equal((await postForm(f3.action, f3.hidden)).headers.get('location'), doneHref);
  assert.equal((await stateNow()).returns.length, 1);
  assert.equal((await get('/store/returns/RMA-00000000')).res.status, 404);
  ok('order shows "Return started"; resubmit is idempotent; unknown RMA → 404');

  // Reset clears returns.
  assert.equal((await fetch(base + '/api/reset', { method: 'POST', headers: { 'x-reset-token': 'test-token' } })).status, 200);
  assert.equal((await stateNow()).returns, undefined);
  await visit('/store/orders/LS-20931', 'Return or replace items');
  assert.equal((await get(labelHref)).res.status, 404);
  ok('reset clears returns');

  console.log(`\nAll ${step} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

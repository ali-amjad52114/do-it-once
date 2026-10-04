// End-to-end check of the Lumen+ demo flow. Run: node demo-site/test.mjs
// Starts the server on a random port and walks the seeded "Cancel subscription" skill with fetch.
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
/** Accessible names of all elements with the given tag (links: <a>, buttons: <button>). */
const names = (html, tag) =>
  [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => textOf(m[1]));
/** Playwright's role name match is case-insensitive substring by default, so names must be unique that way. */
function uniqueRole(html, tag, name) {
  const hits = names(html, tag).filter((n) => n.toLowerCase().includes(name.toLowerCase()));
  assert.equal(hits.length, 1, `expected exactly one <${tag}> named "${name}", got ${JSON.stringify(hits)}`);
}
const hrefOf = (html, name) => {
  const m = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].find((x) => textOf(x[2]) === name);
  assert.ok(m, `link "${name}" not found`);
  return m[1];
};

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { res, html: await res.text() };
}
async function visit(path, expected) {
  const { res, html } = await get(path);
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  const text = textOf(html);
  for (const e of [].concat(expected)) assert.ok(text.includes(e), `${path} should contain "${e}"\n---\n${text.slice(0, 600)}`);
  return { html, text };
}

const dateRe = /[A-Z][a-z]{2} \d{1,2}, \d{4}/;
const tmr = new Date();
tmr.setDate(tmr.getDate() + 1);
const tomorrow = tmr.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
  // Fresh state
  let state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state, { status: 'active', renewsOn: tomorrow, endsOn: null, layout: 'v1' });
  ok(`initial state active, renews ${tomorrow}`);

  const home = await visit('/', 'Lumen');
  uniqueRole(home.html, 'a', 'Account');
  assert.equal(hrefOf(home.html, 'Account'), '/account');
  ok('home page has Account link → /account');

  // Step 1: navigate /account → expectedAfter "Welcome back"
  const acct = await visit('/account', ['Welcome back', 'Welcome back, Ali', 'Overview', 'Profile', 'Billing', 'Devices']);
  assert.ok(!acct.text.includes('Manage membership'), 'Manage membership must not appear before step 2');
  uniqueRole(acct.html, 'a', 'Billing');
  ok('step 1: /account shows "Welcome back, Ali" and sidebar');

  // Step 2: click Billing → expectedAfter "Manage membership"
  const billingHref = hrefOf(acct.html, 'Billing');
  assert.equal(billingHref, '/account/billing');
  const billing = await visit(billingHref, ['Manage membership', 'Visa •••• 4242', `Lumen+ Premium · $19/month · Renews tomorrow (${tomorrow})`]);
  assert.ok(!billing.text.includes('Cancel membership'), 'Cancel membership must not appear before step 3');
  assert.equal((billing.html.match(/<tr><td>/g) || []).length, 3, 'three invoices');
  uniqueRole(billing.html, 'a', 'Manage membership');
  ok('step 2: billing shows Visa, 3 invoices, renewal row, Manage membership link');

  // Step 3: click Manage membership → expectedAfter "Cancel membership"
  const memHref = hrefOf(billing.html, 'Manage membership');
  assert.equal(memHref, '/account/membership');
  const mem = await visit(memHref, ['Cancel membership', 'Lumen+ Premium', '$19/month', `Next renewal: ${tomorrow}`]);
  assert.ok(!mem.text.includes('Membership canceled'));
  uniqueRole(mem.html, 'a', 'Cancel membership');
  uniqueRole(mem.html, 'button', 'Change plan');
  assert.match(mem.html, /class="btn primary" type="submit">Change plan/, 'Change plan is the prominent action');
  assert.match(mem.html, /class="link-quiet" href="\/account\/membership\/cancel">Cancel membership/, 'Cancel is a quiet link');
  ok('step 3: membership page shows plan card, Change plan button, quiet Cancel membership link');

  // Step 4: click Cancel membership → expectedAfter "Before you go"
  const cancelHref = hrefOf(mem.html, 'Cancel membership');
  assert.equal(cancelHref, '/account/membership/cancel');
  const ret = await visit(cancelHref, ['Before you go', 'Before you go…', '50% off for 3 months', 'Accept offer']);
  uniqueRole(ret.html, 'button', 'Accept offer');
  uniqueRole(ret.html, 'a', 'No thanks, continue to cancel');
  const offer = await visit('/account/membership/cancel?offer=accepted', 'no changes were made');
  assert.ok(offer.text.includes('Before you go'));
  ok('step 4: retention page with 50% offer; Accept offer is a no-op notice');

  // Step 5: click No thanks → expectedAfter "Confirm cancellation"
  const confirmHref = hrefOf(ret.html, 'No thanks, continue to cancel');
  assert.equal(confirmHref, '/account/membership/cancel/confirm');
  const conf = await visit(confirmHref, ['Confirm cancellation', '$19/month', `You'll keep access until ${tomorrow}`]);
  assert.match(conf.html, /<form method="post"[^>]*>[\s\S]*<button[^>]*>Confirm cancellation<\/button>/);
  uniqueRole(conf.html, 'button', 'Confirm cancellation');
  assert.ok(dateRe.test(conf.text));
  ok('step 5: confirm page with POST form and Confirm cancellation button');

  // Still active until the POST
  assert.equal((await (await fetch(base + '/api/state')).json()).status, 'active');

  // Step 6: POST confirm → 303 → "Membership canceled"
  const post = await fetch(base + '/account/membership/cancel/confirm', { method: 'POST', redirect: 'manual' });
  assert.equal(post.status, 303);
  assert.equal(post.headers.get('location'), '/account/membership?canceled=1');
  const done = await visit(post.headers.get('location'), ['Membership canceled', 'Renews: No', `Access ends on ${tomorrow}`]);
  assert.ok(!done.text.includes('Cancel membership'), 'no cancel link once canceled');
  ok('step 6: POST → 303 → "Membership canceled", "Renews: No", "Access ends on <date>"');

  await visit('/account/billing', ['Renews: No', `Access ends on ${tomorrow}`]);
  const again = await get('/account/membership/cancel');
  assert.equal(again.res.status, 303, 'cancel flow redirects once canceled');
  state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state, { status: 'canceled', renewsOn: null, endsOn: tomorrow, layout: 'v1' });
  ok('/api/state reports canceled; billing shows Renews: No');

  // Reset
  const bad = await fetch(base + '/api/reset', { method: 'POST', headers: { 'x-reset-token': 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal((await (await fetch(base + '/api/state')).json()).status, 'canceled');
  const reset = await fetch(base + '/api/reset', { method: 'POST', headers: { 'x-reset-token': 'test-token' } });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).ok, true);
  state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state, { status: 'active', renewsOn: tomorrow, endsOn: null, layout: 'v1' });
  await visit('/account/membership', ['Cancel membership', `Next renewal: ${tomorrow}`]);
  ok('reset: wrong token → 401, right token → active again');

  delete process.env.DEMO_RESET_TOKEN;
  assert.equal((await fetch(base + '/api/reset', { method: 'POST' })).status, 200);
  ok('reset without DEMO_RESET_TOKEN set skips the token check');

  const nf = await get('/nope');
  assert.equal(nf.res.status, 404);
  ok('unknown path → 404');

  console.log(`\nAll ${step} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

// End-to-end check of layout v2 (the self-heal target). Run: node demo-site/test-v2.mjs
// Switches the server to v2, walks the NEW cancel path with fetch, and asserts every v1 name used by the
// seeded "Cancel subscription" skill (locatorHints + matchTexts) is absent.
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
  return m[1];
};

// v1 names from the seeded skill. Playwright role-name matching is case-insensitive substring,
// so none of these may appear in ANY link or button name on a v2 page.
const V1_ROLE_NAMES = ['Billing', 'Manage membership', 'Cancel membership', 'No thanks, continue to cancel', 'Confirm cancellation'];
// matchTexts / expectedAfter of steps 2–5 must not appear as visible text either.
const V1_TEXTS = ['Billing', 'Manage membership', 'Cancel membership', 'Before you go', 'No thanks', 'Confirm cancellation'];
function assertNoV1(html, where) {
  for (const tag of ['a', 'button', 'summary'])
    for (const n of names(html, tag))
      for (const v1 of V1_ROLE_NAMES)
        assert.ok(!n.toLowerCase().includes(v1.toLowerCase()), `${where}: <${tag}> "${n}" still matches v1 name "${v1}"`);
  const text = textOf(html);
  for (const t of V1_TEXTS) assert.ok(!text.includes(t), `${where}: v1 text "${t}" still visible`);
}

async function get(path) {
  const res = await fetch(base + path, { redirect: 'manual' });
  return { res, html: await res.text() };
}
async function visit(path, expected) {
  const { res, html } = await get(path);
  assert.equal(res.status, 200, `${path} → ${res.status}`);
  const text = textOf(html);
  for (const e of [].concat(expected)) assert.ok(text.includes(e), `${path} should contain "${e}"\n---\n${text.slice(0, 600)}`);
  assertNoV1(html, path);
  return { html, text };
}
const post = (path, body, headers = {}) =>
  fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
const stateNow = async () => (await fetch(base + '/api/state')).json();

const tmr = new Date();
tmr.setDate(tmr.getDate() + 1);
const tomorrow = tmr.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
let step = 0;
const ok = (msg) => console.log(`  ✓ ${++step}. ${msg}`);

try {
  assert.equal((await stateNow()).layout, 'v1');

  // One-off preview does not change the server mode.
  const preview = await visit('/account?layout=v2', ['Welcome back, Ali', 'Plan & payments']);
  assert.equal(hrefOf(preview.html, 'Plan & payments'), '/account/plan');
  assert.equal((await stateNow()).layout, 'v1');
  ok('?layout=v2 previews v2 without changing the server layout');

  // Switching layout: token rule + validation.
  assert.equal((await post('/api/layout', { layout: 'v2' }, { 'x-reset-token': 'nope' })).status, 401);
  assert.equal((await post('/api/layout', { layout: 'v9' }, { 'x-reset-token': 'test-token' })).status, 400);
  assert.equal((await post('/api/layout', {}, { 'x-reset-token': 'test-token' })).status, 400);
  const sw = await post('/api/layout', { layout: 'v2' }, { 'x-reset-token': 'test-token' });
  assert.equal(sw.status, 200);
  assert.equal((await sw.json()).layout, 'v2');
  assert.deepEqual(await stateNow(), { status: 'active', renewsOn: tomorrow, endsOn: null, layout: 'v2' });
  ok('POST /api/layout: bad token 401, bad layout 400, v2 → 200; /api/state.layout = v2');

  // Step 1 still works: navigate /account → "Welcome back"
  const acct = await visit('/account', ['Welcome back, Ali', 'Overview', 'Profile', 'Plan & payments', 'Devices']);
  uniqueRole(acct.html, 'a', 'Plan & payments');
  ok('step 1: /account shows "Welcome back, Ali"; sidebar has "Plan & payments", no "Billing"');

  // Old URLs are gone.
  assert.equal((await get('/account/billing')).res.status, 404);
  assert.equal((await get('/account/membership/cancel')).res.status, 404);
  assert.equal((await get('/account/membership/cancel/confirm')).res.status, 404);
  ok('old v1 URLs (/account/billing, /account/membership/cancel[/confirm]) → 404');

  // Plan & payments → Manage plan
  const planHref = hrefOf(acct.html, 'Plan & payments');
  assert.equal(planHref, '/account/plan');
  const plan = await visit(planHref, ['Plan & payments', 'Manage plan', 'Visa •••• 4242', `Lumen+ Premium · $19/month · Renews tomorrow (${tomorrow})`]);
  uniqueRole(plan.html, 'a', 'Manage plan');
  ok('v2 step 2: /account/plan shows payment method and a "Manage plan" link');

  // Manage plan → plan page; End membership is hidden inside a "More options" <details>.
  const manageHref = hrefOf(plan.html, 'Manage plan');
  assert.equal(manageHref, '/account/membership');
  const mem = await visit(manageHref, ['Your plan', 'Lumen+ Premium', '$19/month', `Next renewal: ${tomorrow}`, 'More options', 'End membership']);
  uniqueRole(mem.html, 'a', 'End membership');
  uniqueRole(mem.html, 'button', 'Change plan');
  assert.match(mem.html, /<details class="more">\s*<summary>More options<\/summary>[\s\S]*?href="\/account\/membership\/end">End membership<\/a>[\s\S]*?<\/details>/, 'End membership lives inside the More options disclosure');
  assert.ok(!/<details[^>]*\bopen\b/.test(mem.html), 'disclosure is closed by default');
  ok('v2 step 3: "Manage plan" → plan page; "End membership" inside a closed "More options" <details>');

  // End membership → retention
  const endHref = hrefOf(mem.html, 'End membership');
  assert.equal(endHref, '/account/membership/end');
  const ret = await visit(endHref, ['50% off for 3 months', 'Accept offer', 'Continue to end membership']);
  uniqueRole(ret.html, 'a', 'Continue to end membership');
  uniqueRole(ret.html, 'button', 'Accept offer');
  ok('v2 step 4: retention page with "Continue to end membership"');

  // Continue → confirm
  const confHref = hrefOf(ret.html, 'Continue to end membership');
  assert.equal(confHref, '/account/membership/end/confirm');
  const conf = await visit(confHref, ['Review and end membership', '$19/month', `You'll keep access until ${tomorrow}`, 'End my membership']);
  assert.match(conf.html, /<form method="post" action="\/account\/membership\/end\/confirm"[^>]*>[\s\S]*<button[^>]*>End my membership<\/button>/);
  uniqueRole(conf.html, 'button', 'End my membership');
  assert.equal((await stateNow()).status, 'active');
  ok('v2 step 5: confirm page with POST form and "End my membership" button');

  // POST → canceled; verification texts and URL regex still pass.
  const done = await fetch(base + confHref, { method: 'POST', redirect: 'manual' });
  assert.equal(done.status, 303);
  const loc = done.headers.get('location');
  assert.equal(loc, '/account/membership?canceled=1');
  assert.match(loc, /\/account\/membership(\?|$)/, 'seeded skill verification URL regex still matches');
  const fin = await visit(loc, ['Membership canceled', 'Renews: No', `Access ends on ${tomorrow}`]);
  assert.ok(!fin.text.includes('End membership'));
  assert.deepEqual(await stateNow(), { status: 'canceled', renewsOn: null, endsOn: tomorrow, layout: 'v2' });
  ok('v2 step 6: POST → 303 → "Membership canceled", "Renews: No"; URL matches /account/membership(\\?|$)');

  // Reset keeps the layout unless the body says otherwise.
  assert.equal((await post('/api/reset', null, { 'x-reset-token': 'nope' })).status, 401);
  assert.equal((await post('/api/reset', null, { 'x-reset-token': 'test-token' })).status, 200);
  assert.deepEqual(await stateNow(), { status: 'active', renewsOn: tomorrow, endsOn: null, layout: 'v2' });
  const r2 = await post('/api/reset', { layout: 'v1' }, { 'x-reset-token': 'test-token' });
  assert.equal(r2.status, 200);
  assert.deepEqual(await stateNow(), { status: 'active', renewsOn: tomorrow, endsOn: null, layout: 'v1' });
  const v1 = await get('/account');
  uniqueRole(v1.html, 'a', 'Billing');
  assert.equal((await get('/account/billing')).res.status, 200);
  assert.equal((await get('/account/plan')).res.status, 404);
  ok('reset keeps v2; reset {layout:"v1"} switches back and the v1 path works again');

  console.log(`\nAll ${step} checks passed.`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  process.exitCode = 1;
} finally {
  server.close();
}

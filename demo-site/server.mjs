// Lumen+ — a fictional streaming membership site used as the "Do It Once" demo target.
// Zero dependencies: node:http + server-rendered HTML with inline CSS. State is in memory.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const USER = { firstName: 'Ali', name: 'Ali Amjad', email: 'ali@example.com', initials: 'AA', memberSince: 'Mar 2024' };
const PLAN = { name: 'Lumen+ Premium', price: '$19/month', amount: '$19.00', quality: '4K Ultra HD + HDR', screens: 4 };

/** @type {{ status: 'active' | 'canceled', canceledAt: Date | null, endsOn: Date | null, layout: string }} */
const state = { status: 'active', canceledAt: null, endsOn: null, layout: 'v1' };

function resetState() {
  state.status = 'active';
  state.canceledAt = null;
  state.endsOn = null;
  state.layout = 'v1';
}

// ---------------------------------------------------------------------------
// Dates — renewal is always "tomorrow", formatted like "Nov 5, 2026"
// ---------------------------------------------------------------------------

const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function tomorrow() {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

function monthsBefore(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() - n);
  return d;
}

/** Renewal date (active) or access-end date (canceled). */
const renewalDate = () => (state.status === 'canceled' && state.endsOn ? state.endsOn : tomorrow());

// ---------------------------------------------------------------------------
// Layouts — all labels and navigation live here so a `?layout=v2` variant
// (e.g. Billing moved under "Plan & payments", renamed buttons) is a data change.
// ---------------------------------------------------------------------------

const LAYOUTS = {
  v1: {
    id: 'v1',
    siteNav: [
      { label: 'Home', href: '/' },
      { label: 'Originals', href: '/#originals' },
      { label: 'Live', href: '/#live' },
    ],
    headerAccount: 'Account',
    sidebar: [
      { key: 'overview', label: 'Overview', href: '/account' },
      { key: 'profile', label: 'Profile', href: '/account/profile' },
      { key: 'billing', label: 'Billing', href: '/account/billing' },
      { key: 'devices', label: 'Devices', href: '/account/devices' },
    ],
    // Which sidebar entry is highlighted on the membership flow pages.
    membershipSection: 'billing',
    labels: {
      billingTitle: 'Billing',
      manageMembership: 'Manage membership',
      membershipTitle: 'Membership',
      changePlan: 'Change plan',
      cancelMembership: 'Cancel membership',
      acceptOffer: 'Accept offer',
      declineOffer: 'No thanks, continue to cancel',
      confirmTitle: 'Confirm cancellation',
      confirmButton: 'Confirm cancellation',
      keepMembership: 'Keep my membership',
      resumeMembership: 'Resume membership',
      updatePayment: 'Update payment method',
    },
  },
};

function resolveLayout(url) {
  const requested = url.searchParams.get('layout');
  return LAYOUTS[requested] || LAYOUTS[state.layout] || LAYOUTS.v1;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LOGO_MARK = `<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7c5cff"/><stop offset=".55" stop-color="#ff4d8d"/><stop offset="1" stop-color="#ffb547"/>
  </linearGradient></defs>
  <rect width="32" height="32" rx="9" fill="url(#lg)"/>
  <path d="M12 9.5v13l10.5-6.5z" fill="#fff"/>
</svg>`;

const ICONS = {
  card: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/></svg>`,
  check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  gift: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="8" width="18" height="13" rx="2"/><path d="M12 8v13M3 12h18M12 8c-2-4-6-4-6-1.5S9 8 12 8zm0 0c2-4 6-4 6-1.5S15 8 12 8z"/></svg>`,
  info: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>`,
  alert: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4.5M12 17v.5"/></svg>`,
};

const CSS = `
*{box-sizing:border-box}
:root{--ink:#14141f;--muted:#5d6072;--faint:#8a8d9e;--line:#e6e7ee;--bg:#f5f6fa;--card:#fff;--brand:#6d4dff;--brand2:#ff4d8d;--ok:#0f9d6b;--warn:#b7791f;--danger:#c2410c}
html,body{margin:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;line-height:1.5}
a{color:inherit}
.topbar{background:#0c0c16;color:#fff;border-bottom:1px solid #1f1f33}
.topbar-inner{max-width:1180px;margin:0 auto;padding:0 28px;height:64px;display:flex;align-items:center;gap:32px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;font-weight:800;font-size:20px;letter-spacing:-.02em}
.brand span em{font-style:normal;background:linear-gradient(90deg,#a48bff,#ff6fa3);-webkit-background-clip:text;background-clip:text;color:transparent}
.sitenav{display:flex;gap:22px;font-size:14px}
.sitenav a{text-decoration:none;color:#b9bbd0}
.sitenav a:hover{color:#fff}
.top-right{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:14px}
.top-right .acct{text-decoration:none;color:#fff;font-weight:600;padding:7px 14px;border:1px solid #34344d;border-radius:999px}
.top-right .acct:hover{background:#1c1c2e}
.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:13px;color:#fff;background:linear-gradient(135deg,#7c5cff,#ff4d8d)}
.avatar.lg{width:56px;height:56px;font-size:19px}
.shell{max-width:1180px;margin:0 auto;padding:32px 28px 56px;display:grid;grid-template-columns:232px 1fr;gap:32px}
.side{align-self:start;position:sticky;top:24px}
.who{display:flex;align-items:center;gap:12px;padding:4px 6px 18px}
.who b{display:block;font-size:15px}
.who small{color:var(--muted);font-size:12.5px}
.side nav{display:flex;flex-direction:column;gap:2px}
.side nav a{text-decoration:none;padding:9px 12px;border-radius:9px;font-size:14.5px;color:#3b3e52;font-weight:500}
.side nav a:hover{background:#eceef5}
.side nav a[aria-current=page]{background:#fff;color:var(--ink);font-weight:650;box-shadow:0 1px 2px rgba(20,20,40,.06),0 0 0 1px var(--line)}
.side .help{margin-top:22px;padding:14px;border-radius:12px;background:#eef0ff;font-size:13px;color:#3d3a7a}
main{min-width:0}
.crumbs{font-size:13px;color:var(--faint);margin-bottom:6px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 6px}
h2{font-size:17px;margin:0 0 4px;letter-spacing:-.01em}
.sub{color:var(--muted);margin:0 0 26px;font-size:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:18px;box-shadow:0 1px 2px rgba(20,20,40,.04)}
.card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:14px}
.card-head p{margin:0;color:var(--muted);font-size:14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid var(--line);font-size:14.5px}
.row:first-of-type{border-top:0}
.row .k{color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700;letter-spacing:.02em;padding:4px 10px;border-radius:999px;text-transform:uppercase}
.badge.premium{background:linear-gradient(90deg,#ede8ff,#ffe6f0);color:#5b3fd6}
.badge.ok{background:#e3f6ee;color:var(--ok)}
.badge.muted{background:#eceef3;color:#6b6e80}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font:inherit;font-size:14.5px;font-weight:650;padding:11px 20px;border-radius:10px;border:1px solid transparent;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn.primary{background:var(--ink);color:#fff}
.btn.primary:hover{background:#2a2a3d}
.btn.brand{background:linear-gradient(90deg,#6d4dff,#e0428a);color:#fff}
.btn.secondary{background:#fff;color:var(--ink);border-color:#d6d8e2}
.btn.secondary:hover{background:#f4f5f9}
.btn.danger{background:#c2410c;color:#fff}
.btn.danger:hover{background:#a8370a}
.link-quiet{font-size:13.5px;color:var(--muted);text-decoration:underline;text-underline-offset:3px}
.link-quiet:hover{color:var(--ink)}
.actions{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:20px}
.plan{display:flex;gap:20px;align-items:center}
.plan-art{width:92px;height:92px;border-radius:18px;flex:none;background:radial-gradient(circle at 30% 25%,#ffb547 0,transparent 45%),linear-gradient(135deg,#6d4dff,#ff4d8d);display:grid;place-items:center;color:#fff;font-weight:800;font-size:22px;letter-spacing:-.02em}
.plan-art.off{filter:grayscale(1);opacity:.55}
.price{font-size:30px;font-weight:800;letter-spacing:-.02em}
.price small{font-size:15px;color:var(--muted);font-weight:500}
.perks{list-style:none;padding:0;margin:16px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:8px 18px;font-size:14px;color:#3b3e52}
.perks li{display:flex;gap:8px;align-items:center}
.perks svg{color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--faint);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;padding:0 0 10px}
td{padding:13px 0;border-top:1px solid var(--line)}
td.num{font-variant-numeric:tabular-nums}
.visa{display:flex;align-items:center;gap:14px}
.visa-logo{width:52px;height:34px;border-radius:6px;background:#1a1f71;color:#fff;font-weight:900;font-style:italic;font-size:14px;display:grid;place-items:center;letter-spacing:.02em}
.notice{display:flex;gap:10px;align-items:flex-start;padding:13px 16px;border-radius:12px;font-size:14px;margin-bottom:18px}
.notice.info{background:#eef0ff;color:#2f2b75}
.notice.warn{background:#fff4e0;color:#7a4a06}
.notice.done{background:#eceef3;color:#3b3e52}
.offer{background:linear-gradient(135deg,#1b1640,#3a1a4f);color:#fff;border:0}
.offer .pct{font-size:44px;font-weight:850;letter-spacing:-.03em;background:linear-gradient(90deg,#ffb547,#ff6fa3);-webkit-background-clip:text;background-clip:text;color:transparent}
.offer p{color:#d8d4f2}
.offer .btn.secondary{background:transparent;color:#fff;border-color:#5a4b85}
.offer .btn.secondary:hover{background:rgba(255,255,255,.06)}
.lose{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:8px;font-size:14px;color:#3b3e52}
.lose li::before{content:"–";color:var(--danger);font-weight:800;margin-right:8px}
.summary{max-width:620px}
.hero{background:radial-gradient(ellipse at 20% 0,#3b2a85 0,transparent 55%),radial-gradient(ellipse at 90% 30%,#6a1d4d 0,transparent 50%),#0c0c16;color:#fff;padding:96px 28px 110px}
.hero-inner{max-width:1180px;margin:0 auto}
.hero h1{font-size:56px;line-height:1.05;letter-spacing:-.035em;max-width:720px;margin:0 0 18px}
.hero p{font-size:19px;color:#c4c6dc;max-width:560px;margin:0 0 30px}
.tiles{max-width:1180px;margin:-56px auto 0;padding:0 28px 64px;display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.tile{height:220px;border-radius:16px;padding:18px;display:flex;align-items:flex-end;color:#fff;font-weight:750;font-size:18px;box-shadow:0 12px 30px rgba(10,10,30,.25)}
.tile small{display:block;font-weight:500;font-size:12.5px;opacity:.8}
footer{border-top:1px solid var(--line);background:#fff}
.foot{max-width:1180px;margin:0 auto;padding:26px 28px;display:flex;gap:22px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--faint)}
.foot nav{display:flex;gap:18px;flex-wrap:wrap}
.foot a{text-decoration:none;color:var(--muted)}
.foot a:hover{color:var(--ink)}
.foot .copy{margin-left:auto}
`;

function page({ title, layout, body }) {
  const nav = layout.siteNav.map((l) => `<a href="${l.href}">${esc(l.label)}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Lumen+</title>
<style>${CSS}</style>
</head><body>
<header class="topbar"><div class="topbar-inner">
  <a class="brand" href="/" aria-label="Lumen+ home">${LOGO_MARK}<span>Lumen<em>+</em></span></a>
  <nav class="sitenav" aria-label="Site">${nav}</nav>
  <div class="top-right">
    <a class="acct" href="/account">${esc(layout.headerAccount)}</a>
    <div class="avatar" title="${esc(USER.name)}" aria-hidden="true">${USER.initials}</div>
  </div>
</div></header>
${body}
<footer><div class="foot">
  <nav aria-label="Footer">
    <a href="/#help">Help Center</a><a href="/#privacy">Privacy</a><a href="/#terms">Terms of Use</a>
    <a href="/#cookies">Cookie preferences</a><a href="/#gift">Gift cards</a><a href="/#contact">Contact us</a>
  </nav>
  <span class="copy">© 2026 Lumen+ Media, Inc. (fictional demo)</span>
</div></footer>
</body></html>`;
}

function accountShell({ title, layout, active, body }) {
  const links = layout.sidebar
    .map((l) => `<a href="${l.href}"${l.key === active ? ' aria-current="page"' : ''}>${esc(l.label)}</a>`)
    .join('');
  return page({
    title,
    layout,
    body: `<div class="shell">
  <aside class="side">
    <div class="who"><div class="avatar lg" aria-hidden="true">${USER.initials}</div>
      <div><b>${esc(USER.name)}</b><small>Member since ${USER.memberSince}</small></div></div>
    <nav aria-label="Account">${links}</nav>
    <div class="help">Questions about your plan? Our support team is available 24/7.</div>
  </aside>
  <main>${body}</main>
</div>`,
  });
}

const statusBadge = () =>
  state.status === 'active'
    ? `<span class="badge ok">${ICONS.check} Active</span>`
    : `<span class="badge muted">Canceled</span>`;

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function homePage(layout) {
  const tiles = [
    ['Midnight Harbor', 'New season', 'linear-gradient(160deg,#1e3a8a,#0f172a)'],
    ['The Long Static', 'Lumen+ Original', 'linear-gradient(160deg,#9d174d,#1f0a1a)'],
    ['Saltwater Kings', 'Documentary', 'linear-gradient(160deg,#0f766e,#052e2b)'],
    ['Paper Moons', 'Award winner', 'linear-gradient(160deg,#b45309,#2b1405)'],
  ]
    .map(([t, s, bg]) => `<div class="tile" style="background:${bg}"><div><small>${s}</small>${t}</div></div>`)
    .join('');
  return page({
    title: 'Stream what moves you',
    layout,
    body: `<section class="hero"><div class="hero-inner">
  <span class="badge premium">Now in 4K HDR</span>
  <h1 style="margin-top:18px">Stories that stay with you.</h1>
  <p>Award-winning originals, live sports and thousands of films — on every screen, ad-free with Lumen+ Premium.</p>
  <a class="btn brand" href="/#originals">Start watching</a>
</div></section>
<section class="tiles" id="originals" aria-label="Featured">${tiles}</section>`,
  });
}

function overviewPage(layout) {
  const date = fmt(renewalDate());
  const membershipLine =
    state.status === 'active'
      ? `Your next payment of ${PLAN.amount} is on ${date}.`
      : `Your membership ends on ${date}.`;
  return accountShell({
    title: 'Account',
    layout,
    active: 'overview',
    body: `<h1>Welcome back, ${USER.firstName}</h1>
<p class="sub">Manage your profile, devices and payments in one place.</p>
<div class="grid2">
  <section class="card" aria-labelledby="plan-h">
    <div class="card-head"><div><h2 id="plan-h">Your plan</h2><p>${PLAN.name}</p></div>${statusBadge()}</div>
    <p style="margin:0;font-size:14.5px">${membershipLine}</p>
  </section>
  <section class="card" aria-labelledby="watch-h">
    <div class="card-head"><div><h2 id="watch-h">Continue watching</h2><p>Picked up on Living Room TV</p></div></div>
    <p style="margin:0;font-size:14.5px"><b>Midnight Harbor</b> · S2 E4 · 23 min left</p>
  </section>
</div>
<section class="card" aria-labelledby="acct-h">
  <div class="card-head"><div><h2 id="acct-h">Account details</h2><p>Signed in as ${esc(USER.email)}</p></div></div>
  <div class="row"><span class="k">Email</span><span>${esc(USER.email)}</span></div>
  <div class="row"><span class="k">Streaming quality</span><span>${PLAN.quality}</span></div>
  <div class="row"><span class="k">Screens at once</span><span>${PLAN.screens}</span></div>
</section>`,
  });
}

function profilePage(layout) {
  return accountShell({
    title: 'Profile',
    layout,
    active: 'profile',
    body: `<h1>Profile</h1><p class="sub">How you appear on Lumen+.</p>
<section class="card" aria-labelledby="p-h">
  <div class="card-head"><div><h2 id="p-h">Personal info</h2></div></div>
  <div class="row"><span class="k">Name</span><span>${esc(USER.name)}</span></div>
  <div class="row"><span class="k">Email</span><span>${esc(USER.email)}</span></div>
  <div class="row"><span class="k">Language</span><span>English (US)</span></div>
  <div class="row"><span class="k">Maturity rating</span><span>All maturity ratings</span></div>
</section>`,
  });
}

function devicesPage(layout) {
  const rows = [
    ['Living Room TV', 'Lumen+ app · Samsung Q80', 'Today'],
    ['MacBook Pro', 'Safari · Seattle, WA', 'Yesterday'],
    ['iPhone 15', 'Lumen+ app · iOS 19', '3 days ago'],
  ]
    .map(([d, m, w]) => `<tr><td><b>${d}</b><br><span style="color:var(--muted)">${m}</span></td><td>${w}</td></tr>`)
    .join('');
  return accountShell({
    title: 'Devices',
    layout,
    active: 'devices',
    body: `<h1>Devices</h1><p class="sub">Devices that recently streamed on your account.</p>
<section class="card" aria-labelledby="d-h"><div class="card-head"><div><h2 id="d-h">Signed-in devices</h2><p>3 of ${PLAN.screens} screens in use</p></div></div>
<table><thead><tr><th>Device</th><th>Last used</th></tr></thead><tbody>${rows}</tbody></table></section>`,
  });
}

function billingPage(layout) {
  const L = layout.labels;
  const renew = renewalDate();
  const date = fmt(renew);
  const membershipRow =
    state.status === 'active'
      ? `${PLAN.name} · ${PLAN.price} · Renews tomorrow (${date})`
      : `${PLAN.name} · ${PLAN.price} · Renews: No`;
  const invoices = [1, 2, 3]
    .map((n) => {
      const d = monthsBefore(renew, n);
      const no = `LMN-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}-${4180 + (3 - n) * 7}`;
      return `<tr><td>${fmt(d)}</td><td>${no}</td><td>${PLAN.name}</td><td class="num">${PLAN.amount}</td><td><span class="badge ok">Paid</span></td></tr>`;
    })
    .join('');
  return accountShell({
    title: L.billingTitle,
    layout,
    active: 'billing',
    body: `<div class="crumbs">Account / ${esc(L.billingTitle)}</div>
<h1>${esc(L.billingTitle)}</h1>
<p class="sub">Your membership, payment method and invoices.</p>
<section class="card" aria-labelledby="m-h">
  <div class="card-head"><div><h2 id="m-h">Membership</h2><p>${membershipRow}</p></div>${statusBadge()}</div>
  ${state.status === 'canceled' ? `<p style="margin:0 0 4px;font-size:14px;color:var(--muted)">Access ends on ${date}</p>` : ''}
  <div class="actions" style="margin-top:8px"><a class="btn primary" href="/account/membership">${esc(L.manageMembership)}</a></div>
</section>
<section class="card" aria-labelledby="pm-h">
  <div class="card-head"><div><h2 id="pm-h">Payment method</h2><p>Charged automatically on your billing date.</p></div></div>
  <div class="visa"><div class="visa-logo" aria-hidden="true">VISA</div>
    <div><b>Visa •••• 4242</b><br><span style="color:var(--muted);font-size:13.5px">Expires 08/2029 · ${esc(USER.name)}</span></div>
    <span style="margin-left:auto"><button class="btn secondary" type="button">${esc(L.updatePayment)}</button></span></div>
</section>
<section class="card" aria-labelledby="inv-h">
  <div class="card-head"><div><h2 id="inv-h">Invoices</h2><p>Your last three payments.</p></div></div>
  <table><thead><tr><th>Date</th><th>Invoice</th><th>Description</th><th>Amount</th><th>Status</th></tr></thead>
  <tbody>${invoices}</tbody></table>
</section>`,
  });
}

function membershipPage(layout, url) {
  const L = layout.labels;
  const date = fmt(renewalDate());
  const notice = url.searchParams.get('notice');
  let banner = '';
  if (url.searchParams.get('canceled') === '1' && state.status === 'canceled') {
    banner = `<div class="notice done" role="status">${ICONS.info}<span>Your cancellation is complete. A confirmation email is on its way to ${esc(USER.email)}.</span></div>`;
  } else if (notice === 'plan') {
    banner = `<div class="notice info" role="status">${ICONS.info}<span>You're already on our best plan. Other plans are coming soon.</span></div>`;
  } else if (notice === 'kept') {
    banner = `<div class="notice info" role="status">${ICONS.info}<span>Great — your membership stays active.</span></div>`;
  } else if (notice === 'resumed') {
    banner = `<div class="notice info" role="status">${ICONS.check}<span>Welcome back! Your membership will renew on ${date}.</span></div>`;
  }
  const perks = ['4K Ultra HD + HDR', `${PLAN.screens} screens at once`, 'Ad-free streaming', 'Downloads on 6 devices']
    .map((p) => `<li>${ICONS.check}${p}</li>`)
    .join('');

  const body =
    state.status === 'active'
      ? `<section class="card" aria-labelledby="plan-h">
  <div class="plan"><div class="plan-art" aria-hidden="true">L+</div>
    <div style="flex:1"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 id="plan-h" style="font-size:22px">${PLAN.name}</h2><span class="badge premium">Premium</span>${statusBadge()}</div>
      <div class="price">$19<small>/month</small></div>
      <p style="margin:2px 0 0;color:var(--muted);font-size:14.5px">${PLAN.price} · Next renewal: ${date}</p></div></div>
  <ul class="perks">${perks}</ul>
  <div class="actions">
    <form method="get" action="/account/membership" style="margin:0"><input type="hidden" name="notice" value="plan"><button class="btn primary" type="submit">${esc(L.changePlan)}</button></form>
  </div>
</section>
<section class="card" aria-labelledby="pay-h">
  <div class="card-head"><div><h2 id="pay-h">Billing details</h2><p>Visa •••• 4242 is charged ${PLAN.amount} on ${date}.</p></div></div>
  <div style="font-size:13.5px;color:var(--muted)">Not enjoying Lumen+? <a class="link-quiet" href="/account/membership/cancel">${esc(L.cancelMembership)}</a></div>
</section>`
      : `<section class="card" aria-labelledby="plan-h">
  <div class="plan"><div class="plan-art off" aria-hidden="true">L+</div>
    <div style="flex:1"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 id="plan-h" style="font-size:22px">Membership canceled</h2>${statusBadge()}</div>
      <p style="margin:4px 0 0;font-size:15px">${PLAN.name} · ${PLAN.price}</p>
      <p style="margin:2px 0 0;color:var(--muted);font-size:14.5px">Renews: No · Access ends on ${date}</p></div></div>
  <div class="row" style="margin-top:14px;border-top:1px solid var(--line)"><span class="k">Renews</span><span>Renews: No</span></div>
  <div class="row"><span class="k">Access</span><span>Access ends on ${date}</span></div>
  <div class="row"><span class="k">Future charges</span><span>None — Visa •••• 4242 won't be charged again</span></div>
  <div class="actions">
    <form method="post" action="/account/membership/resume" style="margin:0"><button class="btn secondary" type="submit">${esc(L.resumeMembership)}</button></form>
  </div>
</section>`;

  return accountShell({
    title: L.membershipTitle,
    layout,
    active: layout.membershipSection,
    body: `<div class="crumbs">Account / ${esc(L.billingTitle)} / ${esc(L.membershipTitle)}</div>
<h1>${esc(L.membershipTitle)}</h1>
<p class="sub">Your plan and renewal settings.</p>
${banner}${body}`,
  });
}

function retentionPage(layout, url) {
  const L = layout.labels;
  const accepted = url.searchParams.get('offer') === 'accepted';
  const perksLost = ['Lumen+ Originals and early premieres', '4K Ultra HD + HDR on 4 screens', 'Your watchlist and recommendations', 'Downloads for offline viewing']
    .map((p) => `<li>${p}</li>`)
    .join('');
  return accountShell({
    title: 'Before you go',
    layout,
    active: layout.membershipSection,
    body: `<div class="crumbs">Account / ${esc(L.membershipTitle)} / ${esc(L.cancelMembership)}</div>
<h1>Before you go…</h1>
<p class="sub">We'd hate to see you leave, ${USER.firstName}. Here's something to make staying easier.</p>
${accepted ? `<div class="notice info" role="status">${ICONS.info}<span>Thanks! This offer can't be applied in this demo, so no changes were made to your plan.</span></div>` : ''}
<section class="card offer" aria-labelledby="offer-h">
  <div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
    <div class="pct" aria-hidden="true">50%</div>
    <div style="flex:1;min-width:260px"><h2 id="offer-h" style="font-size:20px">Get 50% off for 3 months</h2>
      <p style="margin:4px 0 0">Stay on ${PLAN.name} for $9.50/month for your next 3 months, then ${PLAN.price}. Cancel anytime.</p></div>
  </div>
  <div class="actions">
    <form method="get" action="/account/membership/cancel" style="margin:0"><input type="hidden" name="offer" value="accepted"><button class="btn brand" type="submit">${esc(L.acceptOffer)}</button></form>
    <a class="btn secondary" href="/account/membership/cancel/confirm">${esc(L.declineOffer)}</a>
  </div>
</section>
<section class="card" aria-labelledby="lose-h">
  <h2 id="lose-h">What you'll lose</h2>
  <ul class="lose">${perksLost}</ul>
</section>`,
  });
}

function confirmPage(layout) {
  const L = layout.labels;
  const date = fmt(renewalDate());
  return accountShell({
    title: L.confirmTitle,
    layout,
    active: layout.membershipSection,
    body: `<div class="crumbs">Account / ${esc(L.membershipTitle)} / ${esc(L.cancelMembership)}</div>
<h1>${esc(L.confirmTitle)}</h1>
<p class="sub">Please review the details below.</p>
<section class="card summary" aria-labelledby="sum-h">
  <h2 id="sum-h">${PLAN.name}</h2>
  <div class="row" style="border-top:0"><span class="k">Price</span><span><b>${PLAN.price}</b></span></div>
  <div class="row"><span class="k">Payment method</span><span>Visa •••• 4242</span></div>
  <div class="row"><span class="k">Access</span><span>You'll keep access until ${date}</span></div>
  <div class="notice warn" style="margin:14px 0 0">${ICONS.alert}<span>After ${date} you won't be charged again, and your profiles, watchlist and downloads will be removed after 10 months.</span></div>
  <form method="post" action="/account/membership/cancel/confirm" class="actions">
    <button class="btn danger" type="submit">${esc(L.confirmButton)}</button>
    <a class="link-quiet" href="/account/membership?notice=kept">${esc(L.keepMembership)}</a>
  </form>
</section>`,
  });
}

function notFoundPage(layout) {
  return page({
    title: 'Page not found',
    layout,
    body: `<div class="shell" style="display:block;min-height:50vh"><main><h1>Page not found</h1><p class="sub">The page you're looking for doesn't exist.</p><a class="btn primary" href="/account">Go to your account</a></main></div>`,
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}
const html = (res, body, status = 200) => send(res, status, body, { 'content-type': 'text/html; charset=utf-8' });
const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
const redirect = (res, location) => send(res, 303, '', { location });

function apiState() {
  const date = fmt(renewalDate());
  return {
    status: state.status,
    renewsOn: state.status === 'active' ? date : null,
    endsOn: state.status === 'canceled' ? date : null,
    layout: state.layout,
  };
}

function drain(req) {
  return new Promise((resolve) => {
    req.on('data', () => {});
    req.on('end', resolve);
    req.on('error', resolve);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    const layout = resolveLayout(url);

    try {
      if (method === 'POST') {
        await drain(req);
        if (path === '/account/membership/cancel/confirm') {
          if (state.status !== 'canceled') {
            state.status = 'canceled';
            state.canceledAt = new Date();
            state.endsOn = tomorrow();
          }
          return redirect(res, '/account/membership?canceled=1');
        }
        if (path === '/account/membership/resume') {
          resetState();
          return redirect(res, '/account/membership?notice=resumed');
        }
        if (path === '/api/reset') {
          const token = process.env.DEMO_RESET_TOKEN;
          if (token && req.headers['x-reset-token'] !== token) return json(res, { error: 'invalid reset token' }, 401);
          resetState();
          return json(res, { ok: true, ...apiState() });
        }
        return json(res, { error: 'not found' }, 404);
      }

      if (method !== 'GET' && method !== 'HEAD') return json(res, { error: 'method not allowed' }, 405);

      switch (path) {
        case '/': return html(res, homePage(layout));
        case '/healthz': return json(res, { ok: true });
        case '/api/state': return json(res, apiState());
        case '/account': return html(res, overviewPage(layout));
        case '/account/profile': return html(res, profilePage(layout));
        case '/account/devices': return html(res, devicesPage(layout));
        case '/account/billing': return html(res, billingPage(layout));
        case '/account/membership': return html(res, membershipPage(layout, url));
        case '/account/membership/cancel':
          if (state.status === 'canceled') return redirect(res, '/account/membership');
          return html(res, retentionPage(layout, url));
        case '/account/membership/cancel/confirm':
          if (state.status === 'canceled') return redirect(res, '/account/membership');
          return html(res, confirmPage(layout));
        default: return html(res, notFoundPage(layout), 404);
      }
    } catch (err) {
      console.error(err);
      return json(res, { error: 'internal error' }, 500);
    }
  });
}

export { resetState };

const isMain = !!process.argv[1] && resolve(fileURLToPath(import.meta.url)).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (isMain) {
  const port = Number(process.env.PORT) || 4000;
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Lumen+ demo site listening on http://localhost:${port}`);
  });
}

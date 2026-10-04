// Lumen+ — a fictional streaming membership site used as the "Do It Once" demo target.
// Zero dependencies: node:http + server-rendered HTML with inline CSS. State is in memory.
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { qrSvg, qrPath } from './qr.mjs';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const USER = { firstName: 'Ali', name: 'Ali Amjad', email: 'ali@example.com', initials: 'AA', memberSince: 'Mar 2024' };
const PLAN = { name: 'Lumen+ Premium', price: '$19/month', amount: '$19.00', quality: '4K Ultra HD + HDR', screens: 4 };

/** @type {{ status: 'active' | 'canceled', canceledAt: Date | null, endsOn: Date | null, layout: string, returns: any[] }} */
const state = { status: 'active', canceledAt: null, endsOn: null, layout: 'v1', returns: [] };

function resetMembership() {
  state.status = 'active';
  state.canceledAt = null;
  state.endsOn = null;
}

/** Full demo reset: membership active, no returns. Keeps the current layout unless one is given. */
function resetState(layout) {
  resetMembership();
  state.returns = [];
  if (layout && LAYOUTS[layout]) state.layout = layout;
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
      { label: 'Lumen Store', href: '/store' },
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
    paths: {
      billing: '/account/billing',
      membership: '/account/membership',
      cancel: '/account/membership/cancel',
      confirm: '/account/membership/cancel/confirm',
    },
    // v1: a quiet "Cancel membership" link in the Billing details card. v2: inside a "More options" disclosure.
    cancelInDisclosure: false,
    labels: {
      billingTitle: 'Billing',
      billingSub: 'Your membership, payment method and invoices.',
      manageMembership: 'Manage membership',
      membershipTitle: 'Membership',
      paymentDetailsTitle: 'Billing details',
      changePlan: 'Change plan',
      cancelMembership: 'Cancel membership',
      retentionPageTitle: 'Before you go',
      retentionTitle: 'Before you go…',
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

// v2 — the "redesign" that breaks the stored v1 path (self-heal demo). Every v1 link/button name and
// matchText on the cancel path is gone; the new path is discoverable from visible text.
LAYOUTS.v2 = {
  ...LAYOUTS.v1,
  id: 'v2',
  sidebar: [
    { key: 'overview', label: 'Overview', href: '/account' },
    { key: 'profile', label: 'Profile', href: '/account/profile' },
    { key: 'billing', label: 'Plan & payments', href: '/account/plan' },
    { key: 'devices', label: 'Devices', href: '/account/devices' },
  ],
  paths: {
    billing: '/account/plan',
    membership: '/account/membership',
    cancel: '/account/membership/end',
    confirm: '/account/membership/end/confirm',
  },
  cancelInDisclosure: true,
  labels: {
    billingTitle: 'Plan & payments',
    billingSub: 'Your plan, payment method and receipts.',
    manageMembership: 'Manage plan',
    membershipTitle: 'Your plan',
    paymentDetailsTitle: 'Payment details',
    changePlan: 'Change plan',
    moreOptions: 'More options',
    cancelMembership: 'End membership',
    retentionPageTitle: 'Stay with Lumen+',
    retentionTitle: 'Wait — a better deal for you',
    acceptOffer: 'Accept offer',
    declineOffer: 'Continue to end membership',
    confirmTitle: 'Review and end membership',
    confirmButton: 'End my membership',
    keepMembership: 'Keep my membership',
    resumeMembership: 'Resume membership',
    updatePayment: 'Update payment method',
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

// Extra CSS only emitted on v2 and store pages, so v1 pages keep their exact markup.
const EXTRA_CSS = `
.more{margin-top:4px;border-top:1px solid var(--line);padding-top:12px}
.more summary{cursor:pointer;font-size:14px;font-weight:600;color:#3b3e52;list-style:none;display:inline-flex;align-items:center;gap:8px;padding:6px 10px;margin-left:-10px;border-radius:8px}
.more summary::-webkit-details-marker{display:none}
.more summary::after{content:"";width:7px;height:7px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .15s}
.more[open] summary::after{transform:rotate(-135deg) translateY(-2px)}
.more summary:hover{background:#f1f2f7}
.more-body{padding:10px 0 2px;font-size:13.5px;color:var(--muted);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.storebar{background:#fff;border-bottom:1px solid var(--line)}
.storebar-inner{max-width:1180px;margin:0 auto;padding:0 28px;height:54px;display:flex;align-items:center;gap:26px;font-size:14px}
.storebar .sb-brand{display:flex;align-items:center;gap:9px;font-weight:800;font-size:16px;letter-spacing:-.01em;text-decoration:none}
.storebar .sb-brand i{font-style:normal;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5b3fd6;background:#efeaff;padding:3px 8px;border-radius:999px}
.storebar nav{display:flex;gap:4px}
.storebar nav a{text-decoration:none;color:#3b3e52;font-weight:550;padding:7px 12px;border-radius:8px}
.storebar nav a:hover{background:#f1f2f7}
.storebar nav a[aria-current=page]{background:#f1f2f7;color:var(--ink)}
.storebar .sb-right{margin-left:auto;color:var(--muted);font-size:13px}
.wrap{max-width:1180px;margin:0 auto;padding:30px 28px 64px}
.wrap.narrow{max-width:860px}
.order{padding:0;overflow:hidden}
.order-top{display:flex;gap:28px;flex-wrap:wrap;padding:14px 24px;background:#f8f9fc;border-bottom:1px solid var(--line);font-size:12.5px;color:var(--muted)}
.order-top b{display:block;color:var(--ink);font-size:13.5px;font-weight:600}
.order-top .ono{margin-left:auto;text-align:right}
.order-body{display:flex;gap:20px;align-items:center;padding:20px 24px}
.order-body .info{flex:1;min-width:0}
.order-body .title{font-weight:700;font-size:16px;text-decoration:none;color:var(--ink)}
.order-body a.title:hover{text-decoration:underline}
.order-body p{margin:3px 0 0;font-size:14px;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;margin-top:8px}
.pill.ok{color:var(--ok)}
.pill.no{color:#8a5a00}
.pill.na{color:var(--faint)}
.thumb{width:84px;height:84px;border-radius:14px;flex:none;display:grid;place-items:center}
.thumb.lg{width:120px;height:120px;border-radius:18px}
.thumb svg{width:60%;height:60%}
.t-aura{background:linear-gradient(145deg,#ece8ff,#ffe3ef)}
.t-gift{background:linear-gradient(145deg,#6d4dff,#ff4d8d);color:#fff}
.t-stick{background:linear-gradient(145deg,#e6f4f1,#dfe7ff)}
.products{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}
.product{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px}
.product .thumb{width:100%;height:150px;border-radius:12px;margin-bottom:12px}
.product b{display:block;font-size:14.5px}
.product span{font-size:14px;color:var(--muted)}
.store-hero{background:radial-gradient(ellipse at 15% 0,#3b2a85 0,transparent 55%),radial-gradient(ellipse at 85% 40%,#6a1d4d 0,transparent 50%),#0c0c16;color:#fff;border-radius:20px;padding:40px 44px;margin-bottom:28px;display:flex;align-items:center;gap:30px}
.store-hero h1{font-size:36px;margin:10px 0 8px}
.store-hero p{color:#c4c6dc;margin:0 0 20px;max-width:520px}
.steps{display:flex;gap:8px;margin:0 0 22px;padding:0;list-style:none;font-size:13px;color:var(--faint);flex-wrap:wrap}
.steps li{display:flex;align-items:center;gap:8px}
.steps li+li::before{content:"";width:22px;height:1px;background:#cfd2de}
.steps .n{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:12px;background:#eceef3;color:#6b6e80}
.steps .cur{color:var(--ink);font-weight:600}
.steps .cur .n{background:var(--ink);color:#fff}
.steps .done .n{background:#e3f6ee;color:var(--ok)}
fieldset{border:0;padding:0;margin:0 0 22px}
legend{font-weight:700;font-size:15px;margin-bottom:10px;padding:0}
.choice{display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border:1px solid #d9dbe5;border-radius:12px;margin-bottom:10px;cursor:pointer;background:#fff}
.choice:hover{border-color:#b9bccd}
.choice:has(input:checked){border-color:var(--brand);box-shadow:0 0 0 3px rgba(109,77,255,.14);background:#fbfaff}
.choice input{margin:3px 0 0;accent-color:var(--brand);width:17px;height:17px;flex:none}
.choice .c-main{flex:1}
.choice label{font-weight:650;font-size:14.5px;cursor:pointer;display:block}
.choice .hint{font-size:13px;color:var(--muted);margin-top:2px}
.choice .c-side{font-size:13px;color:var(--muted);white-space:nowrap}
.field{margin-bottom:20px}
.field label{display:block;font-weight:700;font-size:15px;margin-bottom:8px}
.field .hint{font-size:13px;color:var(--muted);margin:-4px 0 8px}
select,textarea{font:inherit;font-size:14.5px;width:100%;max-width:420px;padding:10px 12px;border:1px solid #cfd2de;border-radius:10px;background:#fff;color:var(--ink)}
textarea{max-width:100%;min-height:76px;resize:vertical}
select:focus,textarea:focus{outline:2px solid rgba(109,77,255,.35);border-color:var(--brand)}
.notice.err{background:#fdecea;color:#8a1c12}
.notice.ok{background:#e3f6ee;color:#0b5e41}
.split{display:grid;grid-template-columns:1fr 300px;gap:24px;align-items:start}
.aside-card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px}
.aside-card h2{font-size:15px;margin-bottom:10px}
.aside-card .row{padding:9px 0;font-size:13.5px}
.qrbox{display:flex;gap:26px;align-items:center;flex-wrap:wrap}
.qrbox .qr{padding:10px;border:1px solid var(--line);border-radius:14px;background:#fff;line-height:0}
.rma{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;font-size:18px;letter-spacing:.04em}
`;

function page({ title, layout, body, extra = layout.id !== 'v1' }) {
  const nav = layout.siteNav.map((l) => `<a href="${l.href}">${esc(l.label)}</a>`).join('');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Lumen+</title>
<style>${CSS}${extra ? EXTRA_CSS : ''}</style>
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

/** Entry point to the cancel flow on the membership page — a quiet link (v1) or a disclosure (v2). */
function cancelEntry(layout) {
  const L = layout.labels;
  if (!layout.cancelInDisclosure)
    return `<div style="font-size:13.5px;color:var(--muted)">Not enjoying Lumen+? <a class="link-quiet" href="${layout.paths.cancel}">${esc(L.cancelMembership)}</a></div>`;
  return `<details class="more">
    <summary>${esc(L.moreOptions)}</summary>
    <div class="more-body"><span>Taking a break? You can end your membership at any time and keep access until your renewal date.</span>
      <a class="link-quiet" href="${layout.paths.cancel}">${esc(L.cancelMembership)}</a></div>
  </details>`;
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
<p class="sub">${esc(L.billingSub)}</p>
<section class="card" aria-labelledby="m-h">
  <div class="card-head"><div><h2 id="m-h">Membership</h2><p>${membershipRow}</p></div>${statusBadge()}</div>
  ${state.status === 'canceled' ? `<p style="margin:0 0 4px;font-size:14px;color:var(--muted)">Access ends on ${date}</p>` : ''}
  <div class="actions" style="margin-top:8px"><a class="btn primary" href="${layout.paths.membership}">${esc(L.manageMembership)}</a></div>
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
    <form method="get" action="${layout.paths.membership}" style="margin:0"><input type="hidden" name="notice" value="plan"><button class="btn primary" type="submit">${esc(L.changePlan)}</button></form>
  </div>
</section>
<section class="card" aria-labelledby="pay-h">
  <div class="card-head"><div><h2 id="pay-h">${esc(L.paymentDetailsTitle)}</h2><p>Visa •••• 4242 is charged ${PLAN.amount} on ${date}.</p></div></div>
  ${cancelEntry(layout)}
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
    title: L.retentionPageTitle,
    layout,
    active: layout.membershipSection,
    body: `<div class="crumbs">Account / ${esc(L.membershipTitle)} / ${esc(L.cancelMembership)}</div>
<h1>${esc(L.retentionTitle)}</h1>
<p class="sub">We'd hate to see you leave, ${USER.firstName}. Here's something to make staying easier.</p>
${accepted ? `<div class="notice info" role="status">${ICONS.info}<span>Thanks! This offer can't be applied in this demo, so no changes were made to your plan.</span></div>` : ''}
<section class="card offer" aria-labelledby="offer-h">
  <div style="display:flex;gap:22px;align-items:center;flex-wrap:wrap">
    <div class="pct" aria-hidden="true">50%</div>
    <div style="flex:1;min-width:260px"><h2 id="offer-h" style="font-size:20px">Get 50% off for 3 months</h2>
      <p style="margin:4px 0 0">Stay on ${PLAN.name} for $9.50/month for your next 3 months, then ${PLAN.price}. Cancel anytime.</p></div>
  </div>
  <div class="actions">
    <form method="get" action="${layout.paths.cancel}" style="margin:0"><input type="hidden" name="offer" value="accepted"><button class="btn brand" type="submit">${esc(L.acceptOffer)}</button></form>
    <a class="btn secondary" href="${layout.paths.confirm}">${esc(L.declineOffer)}</a>
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
  <form method="post" action="${layout.paths.confirm}" class="actions">
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
// Lumen Store — gear orders and the "Return an online item" flow (S6 X3)
// ---------------------------------------------------------------------------

const SHIP_TO = { name: USER.name, line1: '418 Alder St, Apt 5', city: 'Seattle, WA 98101' };

const ORDERS = [
  {
    id: 'LS-20931', placed: 'Sep 25, 2026', status: 'Delivered Sep 28, 2026', total: '$129.00',
    items: [{
      id: 'aura', name: 'Lumen Aura Wireless Headphones', variant: 'Midnight · Over-ear · Active noise cancelling',
      price: '$129.00', thumb: 'aura', delivered: 'Delivered Sep 28, 2026',
      returnable: true, eligibility: 'Eligible for return until Oct 28, 2026',
    }],
  },
  {
    id: 'LS-20877', placed: 'Sep 10, 2026', status: 'Delivered by email Sep 10, 2026', total: '$50.00',
    items: [{
      id: 'gift', name: 'Lumen+ Digital Gift Card ($50)', variant: 'Sent to ali@example.com',
      price: '$50.00', thumb: 'gift', delivered: 'Delivered by email Sep 10, 2026',
      returnable: false, eligibility: 'Not eligible for return (digital gift card)',
    }],
  },
  {
    id: 'LS-20412', placed: 'Jul 27, 2026', status: 'Delivered Jul 30, 2026', total: '$49.00',
    items: [{
      id: 'stick', name: 'Lumen Stream Stick 4K', variant: 'HDR10+ · Voice remote',
      price: '$49.00', thumb: 'stick', delivered: 'Delivered Jul 30, 2026',
      returnable: false, eligibility: 'Return window closed on Aug 29, 2026',
    }],
  },
];

const RETURN_REASONS = [
  ['no_longer_needed', 'No longer needed'],
  ['bought_by_mistake', 'Bought by mistake'],
  ['better_price', 'Better price available'],
  ['defective', "Item defective or doesn't work"],
  ['damaged', 'Arrived damaged'],
  ['wrong_item', 'Wrong item was sent'],
];
const REFUND_OPTIONS = [
  ['original', 'Original payment method (Visa •••• 4242)', '3–5 business days after the package is scanned.'],
  ['store_credit', 'Store credit', 'Added to your Lumen Store balance as soon as the carrier scans your package.'],
];
const DROPOFF_OPTIONS = [
  ['ups_store', 'UPS Store', 'Drop it off at any UPS Store location. No box or tape needed.'],
  ['pickup', 'Schedule pickup', `A UPS driver collects the package from ${SHIP_TO.line1}.`],
];
const LABEL_OPTIONS = [
  ['qr', 'QR code', 'Show a QR code on your phone and the UPS Store prints the label for you.'],
  ['print', 'Print label', 'Download a shipping label, print it and tape it to the package.'],
];
const optLabel = (opts, v) => (opts.find(([k]) => k === v) || [])[1];

const THUMBS = {
  aura: `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M14 38V32a18 18 0 0 1 36 0v6" stroke="#5b3fd6" stroke-width="4" stroke-linecap="round"/><rect x="9" y="35" width="11" height="18" rx="5" fill="#6d4dff"/><rect x="44" y="35" width="11" height="18" rx="5" fill="#ff4d8d"/></svg>`,
  gift: `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="8" y="18" width="48" height="30" rx="5" fill="rgba(255,255,255,.18)" stroke="#fff" stroke-width="2.5"/><path d="M26 26.5v13l10.5-6.5z" fill="#fff"/></svg>`,
  stick: `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="12" y="26" width="34" height="13" rx="4" fill="#0f766e"/><rect x="46" y="29" width="7" height="7" rx="1.5" fill="#1e3a8a"/><circle cx="20" cy="32.5" r="2" fill="#a7f3d0"/></svg>`,
  stand: `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><rect x="20" y="10" width="24" height="36" rx="4" fill="#1e293b"/><path d="M14 54h36l-6-10H20z" fill="#94a3b8"/></svg>`,
};
const thumb = (k, cls = '') => `<div class="thumb ${cls} t-${k === 'stand' ? 'stick' : k}">${THUMBS[k]}</div>`;

const findOrder = (id) => ORDERS.find((o) => o.id === id);
const returnFor = (orderId, itemId) => state.returns.find((r) => r.orderId === orderId && r.itemId === itemId);
const findReturn = (rma) => state.returns.find((r) => r.rma === rma);

function daysFromNow(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}
function nextWeekday() {
  const d = daysFromNow(1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

function storeShell({ title, section, body, narrow = false }) {
  const nav = [['shop', 'Shop', '/store'], ['orders', 'Your orders', '/store/orders']]
    .map(([k, label, href]) => `<a href="${href}"${k === section ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  return page({
    title: `${title} · Lumen Store`,
    layout: LAYOUTS[state.layout] || LAYOUTS.v1,
    extra: true,
    body: `<div class="storebar"><div class="storebar-inner">
  <span class="sb-brand">Lumen Store <i>Gear</i></span>
  <nav aria-label="Store">${nav}</nav>
  <span class="sb-right">Free returns within 30 days · Ships to ${esc(SHIP_TO.city)}</span>
</div></div>
<div class="wrap${narrow ? ' narrow' : ''}">${body}</div>`,
  });
}

function storeHomePage() {
  const products = [
    ['aura', 'Lumen Aura Wireless Headphones', '$129.00'],
    ['stick', 'Lumen Stream Stick 4K', '$49.00'],
    ['gift', 'Lumen+ Digital Gift Card', 'From $25.00'],
    ['stand', 'Lumen Charging Dock', '$39.00'],
  ]
    .map(([k, n, p]) => `<div class="product">${thumb(k)}<b>${n}</b><span>${p}</span></div>`)
    .join('');
  return storeShell({
    title: 'Shop',
    section: 'shop',
    body: `<section class="store-hero"><div style="flex:1">
  <span class="badge premium">Members save 10%</span>
  <h1>Gear made for Lumen+</h1>
  <p>Headphones, streaming sticks and accessories tuned for 4K HDR and spatial audio. Free shipping and free 30-day returns.</p>
  <a class="btn brand" href="/store/orders">See order history</a>
</div><div class="thumb lg t-aura" style="width:170px;height:170px">${THUMBS.aura}</div></section>
<h2 style="margin-bottom:14px">Popular right now</h2>
<div class="products">${products}</div>`,
  });
}

function itemStatus(order, item) {
  const ret = returnFor(order.id, item.id);
  if (ret) return `<span class="pill ok">${ICONS.check} Return started · ${ret.rma}</span>`;
  return item.returnable
    ? `<span class="pill ok">${ICONS.check} Free return available</span>`
    : `<span class="pill na">${ICONS.info} Not returnable</span>`;
}

function ordersPage() {
  const cards = ORDERS.map((o) => {
    const items = o.items
      .map((it) => `<div class="order-body">${thumb(it.thumb)}
      <div class="info"><a class="title" href="/store/orders/${o.id}">${esc(it.name)}</a><span class="meta" style="color:var(--muted);font-size:14px"> · ${it.price} · ${it.delivered} · ${esc(it.eligibility)}</span>
        <p>${esc(it.variant)}</p>${itemStatus(o, it)}</div>
      <a class="btn secondary" href="/store/orders/${o.id}">View order #${o.id}</a></div>`)
      .join('');
    return `<section class="card order" aria-label="Order ${o.id}">
  <div class="order-top"><span>Order placed<b>${o.placed}</b></span><span>Total<b>${o.total}</b></span><span>Ship to<b>${esc(SHIP_TO.name)}</b></span><span class="ono">Order #<b>${o.id}</b></span></div>
  ${items}
</section>`;
  }).join('');
  return storeShell({
    title: 'Your orders',
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders</div>
<h1>Your orders</h1>
<p class="sub">${ORDERS.length} orders placed in the last 3 months.</p>
${cards}`,
  });
}

function orderDetailPage(order) {
  const it = order.items[0];
  const ret = returnFor(order.id, it.id);
  let action;
  if (ret) action = `<a class="btn primary" href="/store/returns/${ret.rma}">View return ${ret.rma}</a>`;
  else if (it.returnable) action = `<a class="btn primary" href="/store/orders/${order.id}/return">Return or replace items</a>`;
  else action = `<span class="pill na" style="margin:0">${ICONS.info} ${esc(it.eligibility)}</span>`;
  return storeShell({
    title: `Order #${order.id}`,
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders / Order #${order.id}</div>
<h1>Order details</h1>
<p class="sub">Order #${order.id} · Placed ${order.placed}</p>
<div class="split">
<div>
  <section class="card" aria-labelledby="st-h">
    <div class="card-head"><div><h2 id="st-h">${esc(order.status)}</h2><p>${ret ? `Return started · ${ret.rma}` : esc(it.eligibility)}</p></div>${ret ? '<span class="badge muted">Return started</span>' : '<span class="badge ok">Delivered</span>'}</div>
    <div class="order-body" style="padding:6px 0 0">${thumb(it.thumb, 'lg')}
      <div class="info"><b style="font-size:17px">${esc(it.name)}</b><p>${esc(it.variant)}</p><p>Qty 1 · <b style="color:var(--ink)">${it.price}</b></p></div></div>
    <div class="actions">${action}</div>
  </section>
</div>
<aside class="aside-card" aria-labelledby="sum-h">
  <h2 id="sum-h">Order summary</h2>
  <div class="row" style="border-top:0"><span class="k">Item subtotal</span><span>${it.price}</span></div>
  <div class="row"><span class="k">Shipping</span><span>Free</span></div>
  <div class="row"><span class="k">Total</span><span><b>${order.total}</b></span></div>
  <div class="row"><span class="k">Paid with</span><span>Visa •••• 4242</span></div>
  <div class="row"><span class="k">Ship to</span><span style="text-align:right">${esc(SHIP_TO.name)}<br>${esc(SHIP_TO.line1)}<br>${esc(SHIP_TO.city)}</span></div>
</aside>
</div>`,
  });
}

function stepsBar(cur) {
  return `<ol class="steps" aria-label="Return progress">${['Choose items', 'Refund & drop-off', 'Review']
    .map((s, i) => `<li class="${i + 1 === cur ? 'cur' : i + 1 < cur ? 'done' : ''}"${i + 1 === cur ? ' aria-current="step"' : ''}><span class="n">${i + 1 < cur ? '✓' : i + 1}</span>${s}</li>`)
    .join('')}</ol>`;
}
const errBox = (msg) => (msg ? `<div class="notice err" role="alert">${ICONS.alert}<span>${esc(msg)}</span></div>` : '');
const hidden = (fields) => Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v ?? '')}">`).join('');
const radioGroup = (name, legend, opts, selected, side = '') =>
  `<fieldset><legend>${legend}</legend>${opts
    .map(([v, label, hint]) => `<div class="choice"><input type="radio" id="${name}-${v}" name="${name}" value="${v}" aria-describedby="${name}-${v}-hint" required${selected === v ? ' checked' : ''}>
      <div class="c-main"><label for="${name}-${v}">${esc(label)}</label><div class="hint" id="${name}-${v}-hint">${esc(hint)}</div></div>${side ? `<span class="c-side">${side}</span>` : ''}</div>`)
    .join('')}</fieldset>`;

function itemAside(order, it) {
  return `<aside class="aside-card" aria-labelledby="ret-item-h">
  <h2 id="ret-item-h">Returning</h2>
  <div style="display:flex;gap:12px;align-items:center">${thumb(it.thumb)}<div><b style="font-size:14px">${esc(it.name)}</b><div style="font-size:13px;color:var(--muted)">Order #${order.id} · ${it.price}</div></div></div>
  <div class="row" style="margin-top:10px"><span class="k">Return window</span><span>Until Oct 28, 2026</span></div>
  <div class="row"><span class="k">Return shipping</span><span>Free</span></div>
</aside>`;
}

/** Step 1: choose the item and a reason. */
function returnStartPage(order, values = {}, error = '') {
  const items = order.items
    .filter((it) => it.returnable)
    .map((it) => `<div class="choice"><input type="checkbox" id="item-${it.id}" name="item" value="${it.id}"${values.item === it.id ? ' checked' : ''}>
      <div class="c-main"><label for="item-${it.id}">${esc(it.name)}</label><div class="hint">${esc(it.variant)} · ${it.delivered}</div></div><span class="c-side">${it.price}</span></div>`)
    .join('');
  const reasons = RETURN_REASONS.map(([v, l]) => `<option value="${v}"${values.reason === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return storeShell({
    title: 'Return or replace items',
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders / Order #${order.id} / Return</div>
<h1>Return or replace items</h1>
<p class="sub">Choose what you're sending back from order #${order.id}.</p>
${stepsBar(1)}
<div class="split"><form method="post" action="/store/orders/${order.id}/return" class="card">
  ${errBox(error)}
  <fieldset><legend>Which item are you returning?</legend>${items}</fieldset>
  <div class="field"><label for="reason">Reason for return</label>
    <select id="reason" name="reason" required><option value="">Choose a reason</option>${reasons}</select></div>
  <div class="field"><label for="comments">Comments (optional)</label>
    <textarea id="comments" name="comments" placeholder="Anything we should know?">${esc(values.comments || '')}</textarea></div>
  <div class="actions"><button class="btn primary" type="submit">Continue</button><a class="link-quiet" href="/store/orders/${order.id}">Back to order details</a></div>
</form>${itemAside(order, order.items[0])}</div>`,
  });
}

/** Step 2: refund destination, drop-off method and label format. */
function returnOptionsPage(order, v, error = '') {
  const it = order.items.find((x) => x.id === v.item);
  return storeShell({
    title: 'Refund and drop-off',
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders / Order #${order.id} / Return</div>
<h1>Refund and drop-off</h1>
<p class="sub">Choose where your refund goes and how you'll send the item back.</p>
${stepsBar(2)}
<div class="split"><form method="post" action="/store/orders/${order.id}/return/options" class="card">
  ${errBox(error)}
  ${hidden({ item: v.item, reason: v.reason, comments: v.comments })}
  ${radioGroup('refund', 'Refund destination', REFUND_OPTIONS, v.refund, it.price)}
  ${radioGroup('dropoff', 'Return method', DROPOFF_OPTIONS, v.dropoff, 'Free')}
  ${radioGroup('label', 'Label format', LABEL_OPTIONS, v.label)}
  <div class="actions"><button class="btn primary" type="submit">Continue to review</button><a class="link-quiet" href="/store/orders/${order.id}/return">Back to item selection</a></div>
</form>${itemAside(order, it)}</div>`,
  });
}

/** Step 3: review summary + the irreversible "Submit return" button. */
function returnReviewPage(order, v) {
  const it = order.items.find((x) => x.id === v.item);
  const dropBy = fmt(daysFromNow(14));
  return storeShell({
    title: 'Review your return',
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders / Order #${order.id} / Return</div>
<h1>Review your return</h1>
<p class="sub">Check the details below, then submit your return.</p>
${stepsBar(3)}
<div class="split"><section class="card" aria-labelledby="rv-h">
  <h2 id="rv-h">Return summary</h2>
  <div class="row" style="border-top:0"><span class="k">Item</span><span>${esc(it.name)}</span></div>
  <div class="row"><span class="k">Order</span><span>#${order.id}</span></div>
  <div class="row"><span class="k">Reason</span><span>${esc(optLabel(RETURN_REASONS, v.reason))}</span></div>
  <div class="row"><span class="k">Refund to</span><span>${esc(optLabel(REFUND_OPTIONS, v.refund))}</span></div>
  <div class="row"><span class="k">Refund amount</span><span><b>${it.price}</b></span></div>
  <div class="row"><span class="k">Return method</span><span>${esc(optLabel(DROPOFF_OPTIONS, v.dropoff))}</span></div>
  <div class="row"><span class="k">Label format</span><span>${esc(optLabel(LABEL_OPTIONS, v.label))}</span></div>
  <div class="row"><span class="k">Drop off by</span><span>${dropBy}</span></div>
  <div class="notice warn" style="margin:14px 0 0">${ICONS.alert}<span>Once you submit, the return can't be edited. Your refund is issued after the carrier scans the package.</span></div>
  <form method="post" action="/store/orders/${order.id}/return/submit" class="actions">
    ${hidden({ item: v.item, reason: v.reason, comments: v.comments, refund: v.refund, dropoff: v.dropoff, label: v.label })}
    <button class="btn brand" type="submit">Submit return</button>
    <a class="link-quiet" href="/store/orders/${order.id}/return/options?${new URLSearchParams({ item: v.item, reason: v.reason, comments: v.comments || '', refund: v.refund, dropoff: v.dropoff, label: v.label })}">Edit refund and drop-off</a>
  </form>
</section>${itemAside(order, it)}</div>`,
  });
}

const qrPayload = (r) => `LUMEN-RETURN:${r.rma}:${r.orderId}:${r.dropOff === 'pickup' ? 'PICKUP' : 'UPS-STORE'}`;

function returnConfirmationPage(r) {
  const order = findOrder(r.orderId);
  const it = order.items.find((x) => x.id === r.itemId);
  const how =
    r.dropOff === 'pickup'
      ? `A UPS driver will pick up the package on ${r.pickupOn} between 9 AM and 7 PM.`
      : r.labelFormat === 'qr'
        ? 'Show this QR code at any UPS Store. They’ll print the label and pack the item for you.'
        : 'Print the label, tape it to the package and drop it off at any UPS Store.';
  return storeShell({
    title: 'Return started',
    section: 'orders',
    body: `<div class="crumbs">Lumen Store / Your orders / Order #${order.id} / Return</div>
<div class="notice ok" role="status">${ICONS.check}<span>Return started. We emailed the details to ${esc(USER.email)}.</span></div>
<h1>Return started</h1>
<p class="sub">${esc(it.name)} · Order #${order.id}</p>
<div class="split"><section class="card" aria-labelledby="lbl-h">
  <div class="qrbox">
    <div class="qr">${qrSvg(qrPayload(r), { size: 196, title: `Return QR code for ${r.rma}`, standalone: false })}</div>
    <div style="flex:1;min-width:240px">
      <h2 id="lbl-h">${r.labelFormat === 'qr' ? 'Your return QR code' : 'Your return label'}</h2>
      <p style="margin:2px 0 12px;color:var(--muted);font-size:14.5px">${esc(how)}</p>
      <div style="font-size:13px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;font-weight:600">RMA number</div>
      <div class="rma">${r.rma}</div>
      <div class="actions" style="margin-top:14px"><a class="btn primary" href="${r.labelUrl}" download="lumen-return-${r.rma}.svg">Download label</a></div>
    </div>
  </div>
  <div class="row" style="margin-top:18px;border-top:1px solid var(--line)"><span class="k">Drop off by</span><span><b>${r.dropOffBy}</b></span></div>
  <div class="row"><span class="k">Return method</span><span>${esc(r.dropOffLabel)}</span></div>
  <div class="row"><span class="k">Refund to</span><span>${esc(r.refundLabel)}</span></div>
  <div class="row"><span class="k">Refund amount</span><span>${r.refundAmount}</span></div>
  <div class="row"><span class="k">Reason</span><span>${esc(r.reason)}</span></div>
</section>
<aside class="aside-card" aria-labelledby="next-h">
  <h2 id="next-h">What happens next</h2>
  <div class="row" style="border-top:0"><span>1. ${r.dropOff === 'pickup' ? `UPS picks up on ${r.pickupOn}` : `Drop off at a UPS Store by ${r.dropOffBy}`}</span></div>
  <div class="row"><span>2. We email you when the package is scanned</span></div>
  <div class="row"><span>3. Refund of ${r.refundAmount} to ${r.refund === 'original' ? 'Visa •••• 4242' : 'store credit'}</span></div>
  <div class="actions"><a class="link-quiet" href="/store/orders">View all orders</a></div>
</aside></div>`,
  });
}

/** 4×6 shipping label as a standalone SVG. */
function labelSvg(r) {
  const { d, modules } = qrPath(qrPayload(r));
  const scale = 150 / modules;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="4in" height="6in" viewBox="0 0 400 600" font-family="Helvetica, Arial, sans-serif">
<title>Lumen Store return label ${r.rma}</title>
<rect width="400" height="600" fill="#fff"/><rect x="8" y="8" width="384" height="584" fill="none" stroke="#111" stroke-width="3"/>
<text x="24" y="44" font-size="22" font-weight="700">Lumen Store Returns</text>
<text x="24" y="66" font-size="12">PREPAID RETURN · UPS GROUND · ${r.rma}</text>
<line x1="8" y1="82" x2="392" y2="82" stroke="#111" stroke-width="2"/>
<text x="24" y="104" font-size="10" font-weight="700">FROM</text>
<text x="24" y="120" font-size="13">${esc(SHIP_TO.name)}</text><text x="24" y="136" font-size="13">${esc(SHIP_TO.line1)}</text><text x="24" y="152" font-size="13">${esc(SHIP_TO.city)}</text>
<text x="24" y="186" font-size="10" font-weight="700">SHIP TO</text>
<text x="24" y="208" font-size="18" font-weight="700">LUMEN STORE RETURNS CENTER</text>
<text x="24" y="228" font-size="16">1200 Harbor Way, Dock 4</text><text x="24" y="248" font-size="16">Reno, NV 89502</text>
<line x1="8" y1="268" x2="392" y2="268" stroke="#111" stroke-width="2"/>
<g transform="translate(125 285) scale(${scale})"><path d="${d}" fill="#111"/></g>
<text x="200" y="460" font-size="12" text-anchor="middle">Scan at drop-off</text>
<line x1="8" y1="476" x2="392" y2="476" stroke="#111" stroke-width="2"/>
<text x="24" y="500" font-size="12">Order #${r.orderId} · ${esc(r.item)}</text>
<text x="24" y="520" font-size="12">Refund: ${esc(r.refundLabel)} · ${r.refundAmount}</text>
<text x="24" y="540" font-size="12">${r.dropOff === 'pickup' ? `UPS pickup on ${r.pickupOn}` : `Drop off at a UPS Store by ${r.dropOffBy}`}</text>
<text x="24" y="572" font-size="10" fill="#555">Lumen Store (fictional demo). Not a real shipping label.</text>
</svg>`;
}

function newRma() {
  for (;;) {
    const rma = `RMA-${Math.floor(10000000 + Math.random() * 90000000)}`;
    if (!findReturn(rma)) return rma;
  }
}

/** Validates the return form values for a given step; returns an error message or ''. */
function validateReturn(order, v, step) {
  const it = order.items.find((x) => x.id === v.item && x.returnable);
  if (!it) return 'Choose the item you want to return.';
  if (!RETURN_REASONS.some(([k]) => k === v.reason)) return 'Choose a reason for the return.';
  if (step < 2) return '';
  if (!REFUND_OPTIONS.some(([k]) => k === v.refund)) return 'Choose where your refund should go.';
  if (!DROPOFF_OPTIONS.some(([k]) => k === v.dropoff)) return 'Choose how you will send the item back.';
  if (!LABEL_OPTIONS.some(([k]) => k === v.label)) return 'Choose a label format.';
  return '';
}

const returnValues = (params) => {
  const o = {};
  for (const k of ['item', 'reason', 'comments', 'refund', 'dropoff', 'label']) o[k] = params.get(k) || '';
  return o;
};

function createReturn(order, v) {
  const it = order.items.find((x) => x.id === v.item);
  const existing = returnFor(order.id, it.id);
  if (existing) return existing;
  const rma = newRma();
  const r = {
    rma,
    status: 'started',
    orderId: order.id,
    itemId: it.id,
    item: it.name,
    reasonCode: v.reason,
    reason: optLabel(RETURN_REASONS, v.reason),
    comments: v.comments || '',
    refund: v.refund,
    refundLabel: optLabel(REFUND_OPTIONS, v.refund),
    refundAmount: it.price,
    dropOff: v.dropoff,
    dropOffLabel: optLabel(DROPOFF_OPTIONS, v.dropoff),
    labelFormat: v.label,
    labelFormatLabel: optLabel(LABEL_OPTIONS, v.label),
    dropOffBy: fmt(daysFromNow(14)),
    pickupOn: v.dropoff === 'pickup' ? fmt(nextWeekday()) : null,
    labelUrl: `/store/returns/${rma}/label.svg`,
    createdAt: new Date().toISOString(),
  };
  state.returns.push(r);
  return r;
}

/** Handles all /store routes. Returns true if handled. */
function handleStore(req, res, method, path, url, params) {
  if (!path.startsWith('/store')) return false;
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/store') return html(res, storeHomePage()), true;
    if (path === '/store/orders') return html(res, ordersPage()), true;
    let m = path.match(/^\/store\/returns\/(RMA-\d+)(\/label\.svg)?$/);
    if (m) {
      const r = findReturn(m[1]);
      if (!r) return false;
      if (m[2])
        return send(res, 200, labelSvg(r), {
          'content-type': 'image/svg+xml; charset=utf-8',
          'content-disposition': `${url.searchParams.get('inline') ? 'inline' : 'attachment'}; filename="lumen-return-${r.rma}.svg"`,
        }), true;
      return html(res, returnConfirmationPage(r)), true;
    }
    m = path.match(/^\/store\/orders\/(LS-\d+)(\/return(?:\/(options|review))?)?$/);
    const order = m && findOrder(m[1]);
    if (!order) return false;
    if (!m[2]) return html(res, orderDetailPage(order)), true;
    const it = order.items[0];
    if (!it.returnable) return redirect(res, `/store/orders/${order.id}`), true;
    const existing = returnFor(order.id, it.id);
    if (existing) return redirect(res, `/store/returns/${existing.rma}`), true;
    const v = returnValues(url.searchParams);
    if (!m[3]) return html(res, returnStartPage(order, v)), true;
    if (validateReturn(order, v, 1)) return redirect(res, `/store/orders/${order.id}/return`), true;
    if (m[3] === 'options') return html(res, returnOptionsPage(order, v)), true;
    if (validateReturn(order, v, 2)) return redirect(res, `/store/orders/${order.id}/return/options?${new URLSearchParams(v)}`), true;
    return html(res, returnReviewPage(order, v)), true;
  }
  if (method === 'POST') {
    const m = path.match(/^\/store\/orders\/(LS-\d+)\/return(?:\/(options|submit))?$/);
    const order = m && findOrder(m[1]);
    if (!order) return false;
    const v = returnValues(params);
    if (!m[2]) {
      const err = validateReturn(order, v, 1);
      if (err) return html(res, returnStartPage(order, v, err), 422), true;
      return redirect(res, `/store/orders/${order.id}/return/options?${new URLSearchParams({ item: v.item, reason: v.reason, comments: v.comments })}`), true;
    }
    if (m[2] === 'options') {
      const err = validateReturn(order, v, 2);
      if (err) {
        if (validateReturn(order, v, 1)) return redirect(res, `/store/orders/${order.id}/return`), true;
        return html(res, returnOptionsPage(order, v, err), 422), true;
      }
      return redirect(res, `/store/orders/${order.id}/return/review?${new URLSearchParams(v)}`), true;
    }
    // submit — the irreversible step
    if (validateReturn(order, v, 2)) return redirect(res, `/store/orders/${order.id}/return`), true;
    const r = createReturn(order, v);
    return redirect(res, `/store/returns/${r.rma}`), true;
  }
  return false;
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
  const s = {
    status: state.status,
    renewsOn: state.status === 'active' ? date : null,
    endsOn: state.status === 'canceled' ? date : null,
    layout: state.layout,
  };
  // `returns` is only present once a return exists, so the v1 state shape stays exactly as before.
  if (state.returns.length) s.returns = state.returns;
  return s;
}

/** Reads a request body (max 64 KB) and parses JSON or url-encoded forms into URLSearchParams. */
function readParams(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      const type = String(req.headers['content-type'] || '');
      if (type.includes('json') || /^\s*\{/.test(body)) {
        try {
          const obj = JSON.parse(body || '{}');
          return resolve(new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)])));
        } catch {
          return resolve(new URLSearchParams());
        }
      }
      resolve(new URLSearchParams(body));
    });
    req.on('error', () => resolve(new URLSearchParams()));
  });
}

const tokenOk = (req) => {
  const token = process.env.DEMO_RESET_TOKEN;
  return !token || req.headers['x-reset-token'] === token;
};

function cancelMembership() {
  if (state.status !== 'canceled') {
    state.status = 'canceled';
    state.canceledAt = new Date();
    state.endsOn = tomorrow();
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';
    const layout = resolveLayout(url);

    try {
      if (method === 'POST') {
        const params = await readParams(req);
        // Both layouts' confirm endpoints cancel, whichever layout is active.
        if (path === LAYOUTS.v1.paths.confirm || path === LAYOUTS.v2.paths.confirm) {
          cancelMembership();
          return redirect(res, '/account/membership?canceled=1');
        }
        if (path === '/account/membership/resume') {
          resetMembership();
          return redirect(res, '/account/membership?notice=resumed');
        }
        if (path === '/api/reset' || path === '/api/layout') {
          if (!tokenOk(req)) return json(res, { error: 'invalid reset token' }, 401);
          const requested = params.get('layout');
          if (requested && !LAYOUTS[requested]) return json(res, { error: `unknown layout "${requested}" (use v1 or v2)` }, 400);
          if (path === '/api/layout') {
            if (!requested) return json(res, { error: 'body must include layout: "v1" | "v2"' }, 400);
            state.layout = requested;
          } else {
            resetState(requested);
          }
          return json(res, { ok: true, ...apiState() });
        }
        if (handleStore(req, res, method, path, url, params)) return;
        return json(res, { error: 'not found' }, 404);
      }

      if (method !== 'GET' && method !== 'HEAD') return json(res, { error: 'method not allowed' }, 405);

      const P = layout.paths;
      switch (path) {
        case '/': return html(res, homePage(layout));
        case '/healthz': return json(res, { ok: true });
        case '/api/state': return json(res, apiState());
        case '/account': return html(res, overviewPage(layout));
        case '/account/profile': return html(res, profilePage(layout));
        case '/account/devices': return html(res, devicesPage(layout));
        case P.billing: return html(res, billingPage(layout));
        case P.membership: return html(res, membershipPage(layout, url));
        case P.cancel:
          if (state.status === 'canceled') return redirect(res, P.membership);
          return html(res, retentionPage(layout, url));
        case P.confirm:
          if (state.status === 'canceled') return redirect(res, P.membership);
          return html(res, confirmPage(layout));
      }
      if (handleStore(req, res, method, path, url, url.searchParams)) return;
      return html(res, notFoundPage(layout), 404);
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

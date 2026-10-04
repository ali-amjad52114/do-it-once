/*
 * Do It Once — Teach Mode recorder (content script, every frame).
 *
 * Dormant until the background worker confirms this tab is being recorded. Then it
 * captures clicks, final input values, select changes and form submits, describes the
 * target element (lib.js) and sends RecordedAction objects to the background worker.
 * It never records keystrokes — only the value a field ends up with.
 */
(function () {
  'use strict';
  if (window.__doItOnceRecorder) return; // injected twice (registered + executeScript)
  const L = globalThis.DoItOnceLib;
  if (!L) return;

  const isTop = window === window.top;
  const INPUT_DEBOUNCE_MS = 1200;
  const PILL_ID = 'do-it-once-recording-pill';

  let active = false;
  const pending = new Map(); // element → timer for debounced input
  const lastSent = new WeakMap(); // element → last recorded value
  let lastClick = { el: null, t: 0 };

  function send(action) {
    try {
      chrome.runtime.sendMessage({ type: 'dio:action', action }, () => void chrome.runtime.lastError);
    } catch (_) {
      // Extension reloaded / context invalidated: stop quietly.
      detach();
    }
  }

  function base(action, el, value) {
    return {
      at: new Date().toISOString(),
      url: location.href,
      pageTitle: document.title || '',
      action,
      target: el ? L.describeElement(el) : null,
      value: value == null ? null : value,
    };
  }

  function insidePill(node) {
    const pill = document.getElementById(PILL_ID);
    return !!(pill && node && (node === pill || (typeof pill.contains === 'function' && pill.contains(node))));
  }

  // ── clicks ───────────────────────────────────────────────────────────────

  function onClick(ev) {
    if (!active || insidePill(ev.target)) return;
    const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
    const start = path.length && path[0] && path[0].nodeType === 1 ? path[0] : ev.target;
    const el = L.resolveClickTarget(start);
    if (!el || L.isTextEntry(el)) return;
    const now = Date.now();
    // A click on a <label> also dispatches a synthetic click on its control: keep one.
    if (lastClick.el === el && now - lastClick.t < 400) return;
    lastClick = { el, t: now };
    flushAll(); // a field the user typed into before clicking comes first
    send(base('click', el, null));
  }

  // ── text input (debounced, final value only) ─────────────────────────────

  function recordValue(el) {
    clearTimeout(pending.get(el));
    pending.delete(el);
    const raw = el.isContentEditable ? el.innerText : el.value;
    const value = L.safeValue(el, raw);
    if (lastSent.get(el) === value) return;
    lastSent.set(el, value);
    send(base('type', el, value));
  }

  function onInput(ev) {
    if (!active) return;
    const el = ev.target;
    if (!el || !L.isTextEntry(el) || L.tagOf(el) === 'select') return;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => recordValue(el), INPUT_DEBOUNCE_MS));
  }

  function onChange(ev) {
    if (!active) return;
    const el = ev.target;
    if (!el) return;
    const tag = L.tagOf(el);
    if (tag === 'select') {
      const opts = Array.from(el.selectedOptions || []);
      const raw = opts.length ? opts.map((o) => L.clean(o.label || o.text)).join(', ') : el.value;
      const value = L.safeValue(el, raw);
      send(base('select', el, value));
      return;
    }
    if (L.isTextEntry(el)) recordValue(el);
  }

  function onBlur(ev) {
    if (!active) return;
    const el = ev.target;
    if (el && pending.has(el)) recordValue(el);
  }

  function flushAll() {
    for (const el of Array.from(pending.keys())) recordValue(el);
  }

  // ── submits ──────────────────────────────────────────────────────────────

  function onSubmit(ev) {
    if (!active) return;
    flushAll();
    const form = ev.target;
    const submitter = ev.submitter || null;
    // The user clicked the submit button: that click already carries the intent.
    if (submitter && lastClick.el === submitter && Date.now() - lastClick.t < 1500) return;
    send(base('submit', submitter || form, null));
  }

  // ── on-page indicator ────────────────────────────────────────────────────

  function showPill() {
    if (!isTop || document.getElementById(PILL_ID)) return;
    const host = document.createElement('div');
    host.id = PILL_ID;
    host.setAttribute('aria-live', 'polite');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<style>' +
      '.p{display:inline-flex;align-items:center;gap:8px;padding:8px 14px 8px 12px;border-radius:999px;' +
      'background:#1b1a17;color:#faf8f5;font:600 12.5px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'letter-spacing:.01em;box-shadow:0 2px 4px rgba(27,26,23,.12),0 12px 28px -10px rgba(27,26,23,.45)}' +
      '.d{color:#ef4444;font-size:13px;animation:b 1.6s ease-in-out infinite}' +
      '@keyframes b{0%,100%{opacity:1}50%{opacity:.35}}' +
      '</style><span class="p" role="status"><span class="d">●</span>Recording — Do It Once</span>';
    (document.body || document.documentElement).appendChild(host);
  }

  function hidePill() {
    const p = document.getElementById(PILL_ID);
    if (p) p.remove();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  function attach() {
    if (active) return;
    active = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('blur', onBlur, true);
    document.addEventListener('submit', onSubmit, true);
    window.addEventListener('pagehide', flushAll, true);
    if (document.body) showPill();
    else document.addEventListener('DOMContentLoaded', showPill, { once: true });
  }

  function detach() {
    if (!active) return;
    flushAll();
    active = false;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('blur', onBlur, true);
    document.removeEventListener('submit', onSubmit, true);
    window.removeEventListener('pagehide', flushAll, true);
    hidePill();
  }

  window.__doItOnceRecorder = { attach, detach, isActive: () => active };

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'dio:attach') attach();
      if (msg.type === 'dio:detach') detach();
    });
    chrome.runtime.sendMessage({ type: 'dio:hello' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.recording) attach();
    });
  } catch (_) {
    // Not running as an extension content script (e.g. injected in a test page).
  }
})();

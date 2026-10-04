/*
 * Do It Once — Guide me content script (top frame).
 *
 * Highlights the next element of a stored skill in the user's own browser and waits for the
 * user to act. It NEVER clicks, types or submits anything itself: it only draws an overlay
 * (pointer-events: none) and listens. State lives in the background worker
 * (chrome.storage.session), so it survives page loads.
 *
 * Starts from the popup's Guide tab or from '#dio-guide=<skillId>' on any page.
 */
(function () {
  'use strict';
  if (window.top !== window) return; // top frame only
  if (window.__dioGuideLoaded) return;
  window.__dioGuideLoaded = true;

  const L = globalThis.DoItOnceLib;
  const G = globalThis.DoItOnceGuide;
  if (!L || !G) return;

  const TICK_MS = 400;
  const CANDIDATES =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],[onclick]';

  let state = null; // { skill, index, acted, status, verified }
  let ui = null;
  let current = null; // element highlighted for the current step
  let located = null; // { index, el, reason } from "I can't find it"
  let timer = null;
  let busy = false;

  function send(type, extra) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...(extra || {}) }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'No response' });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  function save(patch) {
    state = { ...state, ...patch };
    return send('dio:guide-set', { patch });
  }

  // ── page reading (never input values) ───────────────────────────────────

  function isOurs(el) {
    return !!(ui && el && (el === ui.host || ui.host.contains(el)));
  }

  function visible(el) {
    if (!el || isOurs(el) || !el.getClientRects || !el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function candidates() {
    return Array.from(document.querySelectorAll(CANDIDATES)).filter(visible);
  }

  // Our overlay sits in a shadow root, which body.innerText does not include.
  function pageText() {
    return (document.body && document.body.innerText) || '';
  }

  // ── overlay ─────────────────────────────────────────────────────────────

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mountUi() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'dio-guide-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('guide/guide.css');
    const layer = el('div', 'layer');
    const box = el('div', 'box');
    const tip = el('div', 'tip');
    const tipTitle = el('b');
    const tipNote = el('span');
    tip.append(tipTitle, tipNote);
    const panel = el('div', 'panel');
    const eyebrow = el('div', 'eyebrow');
    eyebrow.append(el('span', 'mark'), document.createTextNode('Guide me · Do It Once'));
    const title = el('div', 'title');
    const note = el('p', 'note');
    const msg = el('p', 'msg');
    const row = el('div', 'row');
    const find = el('button', 'primary', "I can't find it");
    find.type = 'button';
    const stop = el('button', '', 'Stop guiding');
    stop.type = 'button';
    row.append(find, stop);
    panel.append(eyebrow, title, note, msg, row);
    layer.append(box, tip, panel);
    shadow.append(link, layer);
    (document.body || document.documentElement).appendChild(host);
    find.addEventListener('click', onCantFind);
    stop.addEventListener('click', onStop);
    ui = { host, box, tip, tipTitle, tipNote, panel, title, note, msg, find, stop };
    return ui;
  }

  function unmountUi() {
    if (ui) ui.host.remove();
    ui = null;
  }

  function setMsg(text) {
    ui.msg.textContent = text || '';
    ui.msg.hidden = !text;
  }

  function drawStep(target) {
    const t = G.tooltipFor(state.skill, state.index);
    ui.title.textContent = t.title;
    ui.note.textContent = t.note;
    ui.note.className = 'note' + (t.amber ? ' amber' : '');
    ui.note.hidden = !t.note;
    ui.find.hidden = false;
    ui.find.textContent = "I can't find it";
    ui.stop.textContent = 'Stop guiding';
    const step = state.skill.steps[state.index];
    if (!target) {
      ui.box.hidden = true;
      ui.tip.hidden = true;
      if (step && step.actionType === 'navigate') setMsg('Open the page for this step to continue.');
      else if (!ui.msg.dataset.sticky) setMsg("Can't see it on this page. Scroll, or press “I can't find it”.");
      return;
    }
    if (!ui.msg.dataset.sticky) setMsg('');
    const r = target.getBoundingClientRect();
    const pad = 5;
    Object.assign(ui.box.style, {
      top: r.top - pad + 'px',
      left: r.left - pad + 'px',
      width: r.width + pad * 2 + 'px',
      height: r.height + pad * 2 + 'px',
    });
    ui.box.className = 'box' + (t.amber ? ' amber' : '');
    ui.box.hidden = false;
    ui.tipTitle.textContent = t.title;
    ui.tipNote.textContent = t.amber ? G.IRREVERSIBLE : '';
    ui.tipNote.hidden = !t.amber;
    ui.tip.className = 'tip' + (t.amber ? ' amber' : '');
    ui.tip.hidden = false;
    const tipH = ui.tip.offsetHeight || 44;
    const above = r.top - pad - tipH - 10;
    ui.tip.style.top = (above > 8 ? above : r.bottom + pad + 10) + 'px';
    ui.tip.style.left = Math.max(8, Math.min(r.left - pad, window.innerWidth - 336)) + 'px';
  }

  function drawDone() {
    ui.box.hidden = true;
    ui.tip.hidden = true;
    ui.title.textContent = state.skill.title;
    ui.note.hidden = false;
    ui.note.textContent = state.verified ? 'Done ✓ verified' : "Couldn't verify";
    ui.note.className = 'note ' + (state.verified ? 'ok' : 'bad');
    setMsg(state.verified ? 'Every check passed on this page.' : 'The page does not show the expected result yet.');
    ui.find.hidden = true;
    ui.stop.textContent = 'Close';
  }

  // ── the loop ────────────────────────────────────────────────────────────

  async function tick() {
    if (!state || busy) return;
    busy = true;
    try {
      mountUi();
      const steps = state.skill.steps || [];
      if (state.status === 'done') return drawDone();
      // Advance as far as the page allows (navigate steps whose page is already open, etc.).
      let guard = 0;
      while (state.index < steps.length && guard++ < steps.length) {
        const ok = G.shouldAdvance({ step: steps[state.index], pageText: pageText(), url: location.href, acted: state.acted });
        if (!ok) break;
        located = null;
        delete ui.msg.dataset.sticky;
        await save({ index: state.index + 1, acted: null });
      }
      if (state.index >= steps.length) {
        const verified = G.verify(state.skill.verification, { text: pageText(), url: location.href });
        await save({ status: 'done', verified });
        return drawDone();
      }
      const step = steps[state.index];
      let target = null;
      if (located && located.index === state.index && located.el.isConnected && visible(located.el)) target = located.el;
      else if (step.actionType !== 'navigate') {
        const hit = G.resolveStep(step, candidates(), L);
        target = hit ? hit.el : null;
      }
      current = target;
      drawStep(target);
    } finally {
      busy = false;
    }
  }

  function startLoop() {
    if (timer) return;
    tick();
    timer = setInterval(tick, TICK_MS);
    window.addEventListener('scroll', tick, true);
    window.addEventListener('resize', tick);
  }

  function stopLoop() {
    if (timer) clearInterval(timer);
    timer = null;
    window.removeEventListener('scroll', tick, true);
    window.removeEventListener('resize', tick);
    state = null;
    current = null;
    located = null;
    unmountUi();
  }

  // ── the user's own actions (observed, never performed) ──────────────────

  function noteAction(rawTarget) {
    if (!state || state.status !== 'active' || isOurs(rawTarget)) return;
    const t = L.resolveClickTarget(rawTarget);
    if (!t) return;
    const onTarget = !!(current && (current === t || current.contains(t) || t.contains(current)));
    save({ acted: { url: location.href, onTarget } });
  }

  document.addEventListener('click', (e) => noteAction(e.target), true);
  document.addEventListener('submit', (e) => noteAction(e.submitter || e.target), true);

  // ── buttons ─────────────────────────────────────────────────────────────

  async function onCantFind() {
    if (!state) return;
    const step = state.skill.steps[state.index];
    if (!step) return;
    ui.find.disabled = true;
    ui.find.textContent = 'Looking…';
    ui.msg.dataset.sticky = '1';
    setMsg('Reading the buttons and links on this page…');
    const { list, map } = G.buildLocateList(candidates(), L, 200);
    const res = await send('dio:guide-locate', {
      body: {
        stepIntent: step.intent,
        targetDescription: step.targetDescription,
        elements: list,
        pageText: pageText().slice(0, 8000),
      },
    });
    ui.find.disabled = false;
    ui.find.textContent = "I can't find it";
    const sel = res.ok && res.value && res.value.selector;
    const hit = sel ? map.get(sel) : null;
    if (hit) {
      located = { index: state.index, el: hit, reason: res.value.reason };
      setMsg('Found it: ' + (res.value.reason || sel));
      hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      setMsg(res.ok ? 'No match on this page. ' + ((res.value && res.value.reason) || '') : "Couldn't reach Do It Once: " + res.error);
    }
    tick();
  }

  async function onStop() {
    await send('dio:guide-end');
    stopLoop();
  }

  // ── start ───────────────────────────────────────────────────────────────

  async function boot() {
    const fromHash = G.guideIdFromHash(location.hash);
    if (fromHash) {
      history.replaceState(null, '', location.href.replace(/#.*$/, ''));
      const res = await send('dio:guide-begin', { skillId: fromHash });
      if (!res.ok) {
        console.warn('[Do It Once] Guide could not start:', res.error);
        return;
      }
    }
    const got = await send('dio:guide-get');
    if (got.ok && got.value && got.value.skill) {
      state = got.value;
      startLoop();
    }
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'dio:guide-refresh') {
      stopLoop();
      boot();
    }
  });

  boot();
})();

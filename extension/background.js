/*
 * Do It Once — Teach Mode background service worker.
 *
 * Owns the recording session in chrome.storage.session so it survives navigations and
 * service-worker restarts:
 *   { status: 'idle' | 'recording' | 'stopped', tabId, lastUrl, lastInteractionAt, recording }
 * where `recording` is a Recording (lib/contracts.ts).
 */
'use strict';

const KEY = 'dio';
const SCRIPT_ID = 'do-it-once-recorder';
const FILES = ['lib.js', 'recorder.js'];
const CLICK_NAV_WINDOW_MS = 4000; // a navigation this soon after a click/submit is caused by it

const EMPTY = { status: 'idle', tabId: null, lastUrl: null, lastInteractionAt: 0, recording: null };

// ── serialized state access (messages from many frames arrive concurrently) ──

let queue = Promise.resolve();
function withState(fn) {
  const run = queue.then(async () => {
    const got = await chrome.storage.session.get(KEY);
    const state = { ...EMPTY, ...(got[KEY] || {}) };
    const result = await fn(state);
    if (result && result.save) await chrome.storage.session.set({ [KEY]: result.state });
    return result ? result.value : undefined;
  });
  queue = run.catch(() => {});
  return run;
}

async function getState() {
  const got = await chrome.storage.session.get(KEY);
  return { ...EMPTY, ...(got[KEY] || {}) };
}

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => {});
}

// ── recording control ─────────────────────────────────────────────────────

async function registerScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {
    /* not registered */
  }
  await chrome.scripting.registerContentScripts([
    {
      id: SCRIPT_ID,
      js: FILES,
      matches: ['<all_urls>'],
      allFrames: true,
      runAt: 'document_start',
      persistAcrossSessions: false,
    },
  ]);
}

async function unregisterScripts() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {
    /* already gone */
  }
}

async function start(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:|^file:/.test(tab.url)) {
    throw new Error("This page can't be recorded. Open the website you want to teach first.");
  }
  await withState(() => ({
    save: true,
    state: {
      status: 'recording',
      tabId,
      lastUrl: tab.url,
      lastInteractionAt: 0,
      recording: { startedAt: new Date().toISOString(), endedAt: '', startUrl: tab.url, actions: [] },
    },
  }));
  await registerScripts();
  // Pages already loaded before Start need a one-off injection (guarded against doubles).
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: FILES });
  } catch (_) {
    /* some frames may be off-limits; the registered script covers new documents */
  }
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'dio:attach' });
  } catch (_) {
    /* frame not ready yet: it will say hello */
  }
  setBadge(true);
}

async function stop() {
  const st = await withState((s) => {
    if (s.status !== 'recording') return { value: s };
    const next = { ...s, status: 'stopped', recording: { ...s.recording, endedAt: new Date().toISOString() } };
    return { save: true, state: next, value: next };
  });
  await unregisterScripts();
  if (st && st.tabId != null) {
    try {
      await chrome.tabs.sendMessage(st.tabId, { type: 'dio:detach' });
    } catch (_) {
      /* tab gone */
    }
  }
  setBadge(false);
  return st;
}

async function reset() {
  await stop();
  await chrome.storage.session.set({ [KEY]: { ...EMPTY } });
}

// ── action intake ─────────────────────────────────────────────────────────

function sameTarget(a, b) {
  return !!(a && b && a.selector && a.selector === b.selector && a.tag === b.tag);
}

function appendAction(s, action) {
  const actions = s.recording.actions.slice();
  const prev = actions[actions.length - 1];
  // Typing then refining the same field: keep only the final value.
  if (action.action === 'type' && prev && prev.action === 'type' && prev.url === action.url && sameTarget(prev.target, action.target)) {
    actions[actions.length - 1] = action;
  } else {
    actions.push(action);
  }
  return actions;
}

function sanitize(a) {
  const allowed = ['navigate', 'click', 'type', 'select', 'submit'];
  if (!a || !allowed.includes(a.action)) return null;
  const str = (v, n) => (v == null ? null : String(v).slice(0, n || 500));
  const t = a.target;
  return {
    at: str(a.at, 40) || new Date().toISOString(),
    url: str(a.url, 2000) || '',
    pageTitle: str(a.pageTitle, 300) || '',
    action: a.action,
    target: t
      ? {
          tag: str(t.tag, 40) || '',
          role: str(t.role, 40),
          name: str(t.name, 200),
          text: str(t.text, 80),
          label: str(t.label, 200),
          selector: str(t.selector, 400),
        }
      : null,
    value: str(a.value, 500),
  };
}

function onAction(raw, sender) {
  const action = sanitize(raw);
  if (!action) return Promise.resolve(false);
  return withState((s) => {
    if (s.status !== 'recording' || !sender.tab || sender.tab.id !== s.tabId) return { value: false };
    const actions = appendAction(s, action);
    const interaction = action.action === 'click' || action.action === 'submit';
    return {
      save: true,
      value: true,
      state: {
        ...s,
        lastInteractionAt: interaction ? Date.now() : s.lastInteractionAt,
        recording: { ...s.recording, actions },
      },
    };
  });
}

// ── navigations (top frame only) ──────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info.url && info.status !== 'complete') return;
  withState((s) => {
    if (s.status !== 'recording' || tabId !== s.tabId) return null;
    const actions = s.recording.actions.slice();
    if (info.url) {
      if (info.url === s.lastUrl) return null;
      const clickCaused = Date.now() - s.lastInteractionAt < CLICK_NAV_WINDOW_MS;
      if (!clickCaused) {
        actions.push({
          at: new Date().toISOString(),
          url: info.url,
          pageTitle: tab.title || '',
          action: 'navigate',
          target: null,
          value: null,
        });
      }
      return { save: true, state: { ...s, lastUrl: info.url, recording: { ...s.recording, actions } } };
    }
    // Load finished: fill in the real title of a navigate we just recorded.
    const last = actions[actions.length - 1];
    if (last && last.action === 'navigate' && last.url === tab.url && tab.title && last.pageTitle !== tab.title) {
      actions[actions.length - 1] = { ...last, pageTitle: tab.title };
      return { save: true, state: { ...s, recording: { ...s.recording, actions } } };
    }
    return null;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  getState().then((s) => {
    if (s.status === 'recording' && s.tabId === tabId) stop();
  });
});

// ── messages ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const reply = (p) => {
    p.then(
      (value) => sendResponse({ ok: true, value }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
    );
    return true; // async response
  };
  switch (msg.type) {
    case 'dio:hello':
      getState().then((s) =>
        sendResponse({ recording: s.status === 'recording' && !!sender.tab && sender.tab.id === s.tabId }),
      );
      return true;
    case 'dio:action':
      return reply(onAction(msg.action, sender));
    case 'dio:start':
      return reply(start(msg.tabId));
    case 'dio:stop':
      return reply(stop());
    case 'dio:reset':
      return reply(reset());
    default:
      return false;
  }
});

// Restore badge after a worker restart.
getState().then((s) => setBadge(s.status === 'recording'));

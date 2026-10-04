/* Do It Once — Teach Mode popup. */
'use strict';

const L = globalThis.DoItOnceLib;
const DEFAULT_APP_URL = 'http://localhost:3000';
const $ = (id) => document.getElementById(id);

let state = null;

function send(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(extra || {}) }, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'No response' });
    });
  });
}

function msg(text, kind) {
  const el = $('msg');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.className = 'msg ' + (kind || 'ok');
  el.hidden = false;
}

/** Only the contract fields — exactly a Recording (lib/contracts.ts). */
function exportRecording(r) {
  return {
    startedAt: r.startedAt,
    endedAt: r.endedAt || new Date().toISOString(),
    startUrl: r.startUrl,
    actions: r.actions,
  };
}

function render() {
  const s = state || { status: 'idle' };
  const recording = s.status === 'recording';
  const stopped = s.status === 'stopped' && s.recording;
  $('view-idle').hidden = recording || stopped;
  $('view-session').hidden = !(recording || stopped);
  $('lede').textContent = recording
    ? 'Do the chore as you normally would. Passwords and card numbers are never kept.'
    : stopped
      ? 'Nice. Send it to Do It Once and your agent will learn the steps.'
      : "Do the chore yourself once. We'll watch the clicks, not the keystrokes.";
  if (!recording && !stopped) return;

  const actions = s.recording.actions || [];
  const chip = $('status-chip');
  chip.className = 'chip ' + (recording ? 'recording' : 'stopped');
  chip.textContent = recording ? 'Recording' : 'Stopped';
  $('count').textContent = String(actions.length);
  $('count-word').textContent = actions.length === 1 ? 'action' : 'actions';

  const list = $('actions');
  list.textContent = '';
  const startIdx = Math.max(0, actions.length - 5);
  if (startIdx > 0) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = startIdx + ' earlier ' + (startIdx === 1 ? 'action' : 'actions');
    list.appendChild(li);
  }
  actions.slice(startIdx).forEach((a, i) => {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(startIdx + i + 1);
    const w = document.createElement('span');
    w.className = 'w';
    w.textContent = L.humanize(a);
    w.title = L.humanize(a) + (a.value && a.action !== 'select' ? ' — ' + a.value : '');
    li.append(n, w);
    list.appendChild(li);
  });
  list.hidden = actions.length === 0;
  $('empty').hidden = actions.length !== 0;
  $('controls-recording').hidden = !recording;
  $('controls-stopped').hidden = !stopped;
  $('send').disabled = !stopped || actions.length === 0;
  $('download').disabled = !stopped;
}

async function load() {
  const got = await chrome.storage.session.get('dio');
  state = got.dio || { status: 'idle' };
  render();
}

async function appUrl() {
  const got = await chrome.storage.local.get('appUrl');
  return String(got.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
}

// ── buttons ───────────────────────────────────────────────────────────────

$('start').addEventListener('click', async () => {
  msg('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return msg('No active tab.', 'err');
  $('start').disabled = true;
  const res = await send('dio:start', { tabId: tab.id });
  $('start').disabled = false;
  if (!res.ok) msg(res.error || 'Could not start recording.', 'err');
});

$('stop').addEventListener('click', async () => {
  const res = await send('dio:stop');
  if (!res.ok) msg(res.error || 'Could not stop.', 'err');
});

$('again').addEventListener('click', async () => {
  msg('');
  await send('dio:reset');
});

$('download').addEventListener('click', () => {
  if (!state || !state.recording) return;
  const data = JSON.stringify(exportRecording(state.recording), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'do-it-once-recording-' + state.recording.startedAt.replace(/[:.]/g, '-') + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('send').addEventListener('click', async () => {
  if (!state || !state.recording) return;
  const base = await appUrl();
  const btn = $('send');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg('');
  try {
    const res = await fetch(base + '/api/teach/recordings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(exportRecording(state.recording)),
    });
    if (res.ok) {
      msg('Sent. Your agent is learning this chore. Finish it in the Do It Once app.', 'ok');
    } else if (res.status === 404) {
      msg("Do It Once can't receive recordings yet (that part is coming soon). Use Download JSON for now.", 'warn');
    } else {
      msg('Do It Once answered ' + res.status + '. Try again, or use Download JSON.', 'err');
    }
  } catch (_) {
    msg("Couldn't reach Do It Once at " + base + '. Is the app running? You can still Download JSON.', 'err');
  } finally {
    btn.textContent = 'Send to Do It Once';
    btn.disabled = false;
  }
});

$('save-url').addEventListener('click', async () => {
  const v = $('app-url').value.trim() || DEFAULT_APP_URL;
  let u;
  try {
    u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  } catch (_) {
    return msg('Enter a full URL, like http://localhost:3000', 'err');
  }
  const clean = u.origin + u.pathname.replace(/\/+$/, '');
  await chrome.storage.local.set({ appUrl: clean });
  $('app-url').value = clean;
  msg('Saved. Recordings will go to ' + clean, 'ok');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.dio) {
    state = changes.dio.newValue || { status: 'idle' };
    render();
  }
});

appUrl().then((u) => ($('app-url').value = u));
load();

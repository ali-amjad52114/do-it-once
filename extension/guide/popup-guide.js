/* Do It Once — popup "Guide" tab (A1 Guide me). Loaded after popup.js. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEFAULT_APP_URL = 'http://localhost:3000';
  let loaded = false;

  function note(text, kind) {
    const el = $('msg');
    el.textContent = text || '';
    el.className = 'msg ' + (kind || 'ok');
    el.hidden = !text;
  }

  function select(which) {
    const guide = which === 'guide';
    $('tab-teach').setAttribute('aria-selected', String(!guide));
    $('tab-guide').setAttribute('aria-selected', String(guide));
    $('teach-pane').hidden = guide;
    $('view-guide').hidden = !guide;
    $('lede').hidden = guide;
    document.querySelector('h1').textContent = guide ? 'Guide me' : 'Teach your agent';
    note('');
    try {
      localStorage.setItem('dioTab', which);
    } catch (_) {
      /* ignore */
    }
    if (guide && !loaded) loadSkills();
  }

  async function base() {
    const got = await chrome.storage.local.get('appUrl');
    return String(got.appUrl || DEFAULT_APP_URL).replace(/\/+$/, '');
  }

  async function loadSkills() {
    const list = $('guide-skills');
    list.textContent = '';
    const url = await base();
    let skills = [];
    try {
      const res = await fetch(url + '/api/guide/skills');
      if (res.status === 404) return note('Guide me is off in this Do It Once app (ADDON_GUIDE).', 'warn');
      if (!res.ok) return note('Do It Once answered ' + res.status + '.', 'err');
      skills = (await res.json()).skills || [];
      loaded = true;
    } catch (_) {
      return note("Couldn't reach Do It Once at " + url + '. Is the app running?', 'err');
    }
    $('guide-empty').hidden = skills.length !== 0;
    list.hidden = skills.length === 0;
    for (const s of skills) {
      const li = document.createElement('li');
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = s.title;
      const go = document.createElement('span');
      go.className = 'go';
      go.textContent = 'Guide me →';
      li.append(w, go);
      li.tabIndex = 0;
      li.addEventListener('click', () => start(s));
      li.addEventListener('keydown', (e) => e.key === 'Enter' && start(s));
      list.appendChild(li);
    }
  }

  async function start(skill) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return note('No active tab.', 'err');
    chrome.runtime.sendMessage({ type: 'dio:guide-start', tabId: tab.id, skillId: skill.id }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        return note((res && res.error) || 'Could not start the guide.', 'err');
      }
      window.close();
    });
  }

  $('tab-teach').addEventListener('click', () => select('teach'));
  $('tab-guide').addEventListener('click', () => select('guide'));
  let initial = 'teach';
  try {
    initial = localStorage.getItem('dioTab') || 'teach';
  } catch (_) {
    /* ignore */
  }
  // While recording, always open on Teach.
  chrome.storage.session.get('dio').then((got) => {
    const recording = got.dio && got.dio.status !== 'idle';
    select(recording ? 'teach' : initial);
  });
})();

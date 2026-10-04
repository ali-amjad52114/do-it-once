// Kernel cloud-browser implementation of BrowserAdapter. SERVER-ONLY.
// Playwright connects over CDP; connections are cached per Kernel session id and rebuilt via
// kernel.browsers.retrieve() after a server restart.
import Kernel, { ConflictError, NotFoundError } from '@onkernel/sdk';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import type { ActionOutcome, BrowserAdapter, BrowserSession, ElementTarget, InteractiveElement, PageState } from '@/lib/contracts';
import { nameFromLocator, toInteractive, type RawInteractive } from './interactive';
import {
  CLICK_ROLES,
  SELECT_ROLES,
  TYPE_ROLES,
  collapseText,
  keywordsFromDescription,
  roleLocator,
  roleRegexLocator,
  textContainsAny,
  textLocator,
} from './selectors';

if (typeof window !== 'undefined') {
  throw new Error('lib/kernel is server-only and must not be imported from client code');
}

/** Thrown when the Kernel browser behind a session id no longer exists (deleted or timed out). */
export class BrowserSessionGoneError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, detail?: string) {
    super(`Kernel browser session ${sessionId} no longer exists${detail ? `: ${detail}` : ''}`);
    this.name = 'BrowserSessionGoneError';
    this.sessionId = sessionId;
  }
}

export interface KernelAdapterOptions {
  timeoutSeconds?: number;
  viewport?: { width: number; height: number };
}

interface Conn {
  browser: Browser;
  page: Page;
}

type Kind = 'click' | 'type' | 'select';
type Candidate = { locator: string; resolve: (page: Page) => Locator };

const FIND_DEADLINE_MS = 4000;
const ACTION_TIMEOUT_MS = 10_000;

export class KernelBrowserAdapter implements BrowserAdapter {
  private kernelClient: Kernel | null = null;
  /** Open connections by Kernel session id. Exposed read-only for the smoke test. */
  readonly connections = new Map<string, Conn>();
  private pending = new Map<string, Promise<Conn>>();
  private closed = new Set<string>();

  constructor(private readonly opts: KernelAdapterOptions = {}) {}

  private get kernel(): Kernel {
    if (!this.kernelClient) {
      const apiKey = process.env.KERNEL_API_KEY;
      if (!apiKey) throw new Error('Missing env var KERNEL_API_KEY');
      this.kernelClient = new Kernel({ apiKey });
    }
    return this.kernelClient;
  }

  // ───────────── lifecycle ─────────────

  async open(opts: { startUrl?: string; profileName?: string; saveProfile?: boolean } = {}): Promise<BrowserSession> {
    if (opts.profileName) await this.ensureProfile(opts.profileName);
    const vp = this.opts.viewport ?? { width: 1280, height: 800 };
    const session = await this.kernel.browsers.create({
      headless: false,
      stealth: false,
      timeout_seconds: this.opts.timeoutSeconds ?? 1800,
      viewport: { width: vp.width, height: vp.height },
      ...(opts.profileName ? { profile: { name: opts.profileName, save_changes: opts.saveProfile === true } } : {}),
    });
    const id = session.session_id;
    try {
      const conn = await this.connect(id, session.cdp_ws_url);
      this.connections.set(id, conn);
      if (opts.startUrl) {
        await conn.page.goto(opts.startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await settle(conn.page);
      }
    } catch (err) {
      // Never leak a paid browser if setup fails.
      await this.close(id).catch(() => {});
      throw err;
    }
    return { id, liveViewUrl: session.browser_live_view_url ?? null };
  }

  async close(sessionId: string): Promise<void> {
    const conn = this.connections.get(sessionId);
    this.connections.delete(sessionId);
    this.pending.delete(sessionId);
    if (conn) await conn.browser.close().catch(() => {}); // disconnects CDP only
    if (this.closed.has(sessionId)) return;
    try {
      await this.kernel.browsers.deleteByID(sessionId);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    this.closed.add(sessionId);
  }

  /** Close every browser this process still holds (for scripts and shutdown hooks). */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.close(id)));
  }

  // ───────────── actions ─────────────

  async goto(sessionId: string, url: string): Promise<ActionOutcome> {
    return this.act(sessionId, async (page) => {
      // Already there (e.g. open() loaded the start URL): skip the redundant page load.
      if (sameUrl(page.url(), url)) return { usedLocator: null };
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await settle(page);
      if (res && res.status() >= 400) return { usedLocator: null, error: `HTTP ${res.status()} for ${url}` };
      return { usedLocator: null };
    });
  }

  async click(sessionId: string, target: ElementTarget): Promise<ActionOutcome> {
    return this.act(sessionId, async (page) => {
      // A target hidden inside a closed <details> ("More options") is revealed first.
      await revealInDetails(page, target).catch(() => false);
      const found = await findElement(page, target, 'click');
      if (!found) return { usedLocator: null, error: notFound(target) };
      // Clicking the summary of an already open <details> would close it: treat as done.
      const openSummary = await found.el
        .evaluate((e) => e.tagName === 'SUMMARY' && !!(e.parentElement as HTMLDetailsElement | null)?.open)
        .catch(() => false);
      if (openSummary) return { usedLocator: found.locator };
      // click() scrolls into view itself and waits for a triggered navigation to commit.
      await found.el.click({ timeout: ACTION_TIMEOUT_MS });
      await settle(this.connections.get(sessionId)?.page ?? page);
      return { usedLocator: found.locator };
    });
  }

  async type(sessionId: string, target: ElementTarget, text: string): Promise<ActionOutcome> {
    return this.act(sessionId, async (page) => {
      const found = await findElement(page, target, 'type');
      if (!found) return { usedLocator: null, error: notFound(target) };
      await found.el.fill(text, { timeout: ACTION_TIMEOUT_MS });
      return { usedLocator: found.locator };
    });
  }

  async select(sessionId: string, target: ElementTarget, option: string): Promise<ActionOutcome> {
    return this.act(sessionId, async (page) => {
      const found = await findElement(page, target, 'select');
      if (!found) return { usedLocator: null, error: notFound(target) };
      try {
        await found.el.selectOption({ label: option }, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        await found.el.selectOption(option, { timeout: ACTION_TIMEOUT_MS });
      }
      await settle(page);
      return { usedLocator: found.locator };
    });
  }

  /** `text` may hold "|"-separated alternatives; matching is case-insensitive. */
  async waitForText(sessionId: string, text: string, timeoutMs = 8000): Promise<ActionOutcome> {
    return this.act(sessionId, async () => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const page = (await this.getConn(sessionId)).page;
        const state = await readState(page);
        if (textContainsAny(state.text, text)) return { usedLocator: null };
        if (Date.now() >= deadline) return { usedLocator: null, error: `Timed out after ${timeoutMs} ms waiting for "${text}"` };
        await page.waitForTimeout(Math.min(400, Math.max(0, deadline - Date.now())));
      }
    });
  }

  async readPage(sessionId: string): Promise<PageState> {
    const conn = await this.getConn(sessionId);
    try {
      return await readState(conn.page);
    } catch (err) {
      await this.assertAlive(sessionId, err);
      throw err;
    }
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const conn = await this.getConn(sessionId);
    try {
      return await conn.page.screenshot({ type: 'png', timeout: 15_000 });
    } catch (err) {
      await this.assertAlive(sessionId, err);
      throw err;
    }
  }

  /** Visible interactive elements (links, buttons, summaries, inputs, selects); ones inside closed <details> are marked hidden. */
  async listInteractive(sessionId: string): Promise<InteractiveElement[]> {
    const conn = await this.getConn(sessionId);
    try {
      const raw = (await conn.page.evaluate(COLLECT_INTERACTIVE_JS)) as RawInteractive[];
      return toInteractive(raw);
    } catch (err) {
      await this.assertAlive(sessionId, err);
      throw err;
    }
  }

  // ───────────── internals ─────────────

  private async act(
    sessionId: string,
    fn: (page: Page) => Promise<{ usedLocator: string | null; error?: string }>,
  ): Promise<ActionOutcome> {
    const conn = await this.getConn(sessionId);
    let result: { usedLocator: string | null; error?: string };
    try {
      result = await fn(conn.page);
    } catch (err) {
      await this.assertAlive(sessionId, err);
      result = { usedLocator: null, error: errMsg(err) };
    }
    const page = this.connections.get(sessionId)?.page ?? conn.page;
    const state = await readState(page).catch(() => ({ url: safeUrl(page), title: '', text: '' }));
    return result.error
      ? { ok: false, usedLocator: result.usedLocator, page: state, error: result.error }
      : { ok: true, usedLocator: result.usedLocator, page: state };
  }

  /** After a Playwright error: if the CDP link dropped, find out whether the Kernel browser is gone. */
  private async assertAlive(sessionId: string, cause: unknown): Promise<void> {
    const conn = this.connections.get(sessionId);
    if (conn && conn.browser.isConnected() && !conn.page.isClosed()) return;
    this.connections.delete(sessionId);
    await this.retrieveLive(sessionId, cause); // throws BrowserSessionGoneError when gone
  }

  private async getConn(sessionId: string): Promise<Conn> {
    if (this.closed.has(sessionId)) throw new BrowserSessionGoneError(sessionId, 'closed by this adapter');
    const cached = this.connections.get(sessionId);
    if (cached && cached.browser.isConnected()) {
      if (cached.page.isClosed()) cached.page = await pickPage(cached.browser);
      return cached;
    }
    if (cached) this.connections.delete(sessionId);
    let p = this.pending.get(sessionId);
    if (!p) {
      p = (async () => {
        const cdpUrl = await this.retrieveLive(sessionId);
        const conn = await this.connect(sessionId, cdpUrl);
        this.connections.set(sessionId, conn);
        return conn;
      })().finally(() => this.pending.delete(sessionId));
      this.pending.set(sessionId, p);
    }
    return p;
  }

  /** Returns the CDP URL of a live session, or throws BrowserSessionGoneError. */
  private async retrieveLive(sessionId: string, cause?: unknown): Promise<string> {
    try {
      const s = await this.kernel.browsers.retrieve(sessionId);
      if (s.deleted_at) throw new BrowserSessionGoneError(sessionId, `deleted at ${s.deleted_at}`);
      return s.cdp_ws_url;
    } catch (err) {
      if (err instanceof BrowserSessionGoneError) throw err;
      if (err instanceof NotFoundError) {
        throw new BrowserSessionGoneError(sessionId, cause ? errMsg(cause) : 'not found');
      }
      throw err;
    }
  }

  private async connect(sessionId: string, cdpUrl: string): Promise<Conn> {
    const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
    const page = await pickPage(browser);
    const conn: Conn = { browser, page };
    // Follow new tabs (target=_blank) so actions and the live view stay on the active page.
    browser.contexts()[0]?.on('page', (p) => {
      conn.page = p;
      p.bringToFront().catch(() => {});
    });
    browser.on('disconnected', () => {
      if (this.connections.get(sessionId) === conn) this.connections.delete(sessionId);
    });
    return conn;
  }

  private async ensureProfile(name: string): Promise<void> {
    try {
      await this.kernel.profiles.retrieve(name);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      try {
        await this.kernel.profiles.create({ name });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }
}

// ───────────── element resolution ─────────────

function candidates(target: ElementTarget, kind: Kind): Candidate[] {
  const out: Candidate[] = [];
  const roles: readonly string[] = kind === 'click' ? CLICK_ROLES : kind === 'type' ? TYPE_ROLES : SELECT_ROLES;
  if (target.locatorHint) {
    const hint = target.locatorHint;
    out.push({ locator: hint, resolve: (p) => p.locator(hint) });
  }
  const mt = target.matchText?.trim();
  if (mt) {
    for (const exact of [true, false]) {
      for (const role of roles) {
        out.push({ locator: roleLocator(role, mt), resolve: (p) => p.getByRole(role as never, { name: mt, exact }) });
      }
    }
    if (kind !== 'click') {
      out.push({ locator: `internal:label=${JSON.stringify(mt)}i`, resolve: (p) => p.getByLabel(mt) });
      if (kind === 'type') out.push({ locator: `internal:attr=[placeholder=${JSON.stringify(mt)}i]`, resolve: (p) => p.getByPlaceholder(mt) });
    }
    out.push({ locator: textLocator(mt, true), resolve: (p) => p.getByText(mt, { exact: true }) });
    out.push({ locator: textLocator(mt), resolve: (p) => p.getByText(mt) });
  }
  for (const kw of keywordsFromDescription(target.description)) {
    if (mt && kw.toLowerCase() === mt.toLowerCase()) continue;
    for (const role of roles) {
      const sel = roleRegexLocator(role, kw);
      out.push({ locator: sel, resolve: (p) => p.locator(sel) });
    }
    out.push({ locator: textLocator(kw), resolve: (p) => p.getByText(kw) });
  }
  return out;
}

async function firstVisible(loc: Locator): Promise<Locator | null> {
  // Fast path: the first match is usually the one (saves a count() round trip).
  const first = loc.first();
  if (await first.isVisible().catch(() => false)) return first;
  const n = Math.min(await loc.count(), 10);
  for (let i = 1; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

async function findElement(page: Page, target: ElementTarget, kind: Kind): Promise<{ el: Locator; locator: string } | null> {
  const list = candidates(target, kind);
  const deadline = Date.now() + FIND_DEADLINE_MS;
  for (;;) {
    for (const c of list) {
      let el: Locator | null = null;
      try {
        el = await firstVisible(c.resolve(page));
      } catch {
        // invalid selector string (e.g. a malformed locatorHint) – try the next candidate
      }
      if (el) return { el, locator: c.locator };
    }
    if (Date.now() >= deadline) return null;
    await page.waitForTimeout(500);
  }
}

// ───────────── <details> + interactive listing ─────────────

/** Opens a closed <details> whose hidden content holds a link/button named like the target. */
async function revealInDetails(page: Page, target: ElementTarget): Promise<boolean> {
  const name = (target.matchText ?? nameFromLocator(target.locatorHint) ?? '').trim();
  if (!name) return false;
  return page.evaluate((needle) => {
    const n = needle.toLowerCase();
    for (const d of Array.from(document.querySelectorAll('details:not([open])'))) {
      const hit = Array.from(d.querySelectorAll('a,button,[role=button],[role=link]')).some((e) =>
        ((e as HTMLElement).innerText || e.textContent || '').trim().toLowerCase().includes(n),
      );
      if (hit) {
        const summary = d.querySelector('summary') as HTMLElement | null;
        if (summary) summary.click();
        else (d as HTMLDetailsElement).open = true;
        return true;
      }
    }
    return false;
  }, name);
}

/** Runs in the page. A plain JS string: tsx/esbuild would inject `__name` helpers into a serialized function. */
const COLLECT_INTERACTIVE_JS = `(() => {
  const out = [];
  const els = Array.from(
    document.querySelectorAll(
      'a[href],button,summary,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=radio]',
    ),
  );
  const labelFor = (e) => {
    const aria = e.getAttribute('aria-label');
    if (aria) return aria;
    const by = e.getAttribute('aria-labelledby');
    if (by) return by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    if (e.id) {
      const l = document.querySelector(\`label[for="\${CSS.escape(e.id)}"]\`);
      if (l) return l.textContent ?? '';
    }
    const wrap = e.closest('label');
    if (wrap) return wrap.textContent ?? '';
    return '';
  };
  for (const e of els) {
    const tag = e.tagName.toLowerCase();
    const type = (e.getAttribute('type') ?? '').toLowerCase();
    const closed = e.closest('details:not([open])');
    const inClosedDetails = !!closed && !(tag === 'summary' && e.parentElement === closed);
    const rect = e.getBoundingClientRect();
    const style = getComputedStyle(e);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    if (!visible && !inClosedDetails) continue;
    const isField = tag === 'input' || tag === 'select' || tag === 'textarea';
    const text = isField
      ? labelFor(e) || e.getAttribute('placeholder') || e.getAttribute('name') || ''
      : labelFor(e) || e.innerText || e.textContent || e.value || e.getAttribute('title') || '';
    out.push({ tag, type, role: e.getAttribute('role'), text, hidden: inClosedDetails });
    if (out.length >= 80) break;
  }
  return out;
})()`;

// ───────────── page helpers ─────────────

async function pickPage(browser: Browser): Promise<Page> {
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Kernel browser has no default context');
  const pages = ctx.pages().filter((p) => !p.isClosed());
  return pages[pages.length - 1] ?? (await ctx.newPage());
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
}

async function readState(page: Page): Promise<PageState> {
  let raw = '';
  let title = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // One round trip for text + title.
      ({ raw, title } = await page.evaluate(() => ({ raw: document.body?.innerText ?? '', title: document.title ?? '' })));
      break;
    } catch (err) {
      // "Execution context was destroyed" during a navigation: wait and retry.
      if (attempt === 2 || page.isClosed()) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }
  }
  return { url: page.url(), title, text: collapseText(raw) };
}

function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/$/, '');
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function notFound(t: ElementTarget): string {
  const bits = [t.locatorHint && `hint ${t.locatorHint}`, t.matchText && `text "${t.matchText}"`, `"${t.description}"`];
  return `Element not found: ${bits.filter(Boolean).join(', ')}`;
}

function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0].slice(0, 500);
}

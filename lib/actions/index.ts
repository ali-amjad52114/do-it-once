// Post-actions after a verified success (agent R). Server-only.
// API available → Executor (calendar). Files → the agent's Fly Sprite workspace (Neon artifact fallback).
// A post-action failure never fails the run: it is logged as an event and the run stays succeeded.
import type { Artifact, ArtifactType, BrowserAdapter, EventType, PostAction, SkillDetail, ToolAdapter } from '@/lib/contracts';

export interface PostActionRepo {
  appendEvent(runId: string, type: EventType, message: string, metadata?: Record<string, unknown>): Promise<unknown>;
  createArtifact(input: {
    runId: string;
    type: ArtifactType;
    mimeType: string;
    bytes?: Buffer;
    location?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Artifact>;
}

export interface WorkspaceSaver {
  /** Saves into <root>/<folder>/<fileName> in the Sprite. */
  save(folder: string, fileName: string, bytes: Buffer): Promise<{ path: string; location: string }>;
}

export interface PostActionDeps {
  repo: PostActionRepo;
  /** null → "Sprite not configured" → the file is kept as a Neon artifact. */
  workspace: WorkspaceSaver | null;
  tools: ToolAdapter;
  fetch?: typeof fetch;
  /** Optional: a still-open browser session (adapter.download is used when present). */
  browser?: BrowserAdapter | null;
  sessionId?: string | null;
}

export interface PostActionContext {
  runId: string;
  skill: Pick<SkillDetail, 'title' | 'postActions'>;
  finalUrl: string;
}

export interface PostActionOutcome {
  type: PostAction['type'];
  ok: boolean;
  message: string;
  metadata: Record<string, unknown>;
}

/** Optional per-action tracing hook (the workflow wires it to Mastra child spans). */
export type PostActionTracer = (action: PostAction) => { end(o: PostActionOutcome): void };

// ───────────── HTML helpers (pure) ─────────────

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** Visible-ish text of an HTML page, whitespace collapsed. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** First <a> whose text contains linkText: its href (resolved against baseUrl) and download attribute. */
export function findLink(html: string, linkText: string, baseUrl: string): { href: string; download: string | null } | null {
  const want = linkText.toLowerCase();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const text = htmlToText(m[2]).toLowerCase();
    if (!text.includes(want)) continue;
    const href = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i.exec(m[1]);
    if (!href) continue;
    const dl = /\bdownload\s*=\s*"([^"]*)"/i.exec(m[1]);
    return { href: new URL(decode(href[1] ?? href[2]), baseUrl).toString(), download: dl ? decode(dl[1]) : null };
  }
  return null;
}

/** Parses "Oct 18, 2026" (capture group 1 of `pattern`) from text → local date, or null. */
export function dateFromText(text: string, pattern: string): { label: string; date: Date } | null {
  const m = new RegExp(pattern).exec(text);
  if (!m?.[1]) return null;
  const d = new Date(`${m[1]} 10:00`);
  return Number.isNaN(d.getTime()) ? null : { label: m[1], date: d };
}

export function fillTemplate(t: string, vars: Record<string, string | null>): string {
  return t.replace(/\{(\w+)\}/g, (all, k) => vars[k] ?? all);
}

function fileNameFrom(res: Response, url: string, download: string | null): string {
  if (download) return download;
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  if (m) return decodeURIComponent(m[1]);
  return new URL(url).pathname.split('/').filter(Boolean).pop() || `download-${Date.now()}`;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

// ───────────── Runner ─────────────

export async function runPostActions(ctx: PostActionContext, deps: PostActionDeps, tracer?: PostActionTracer): Promise<PostActionOutcome[]> {
  const actions = ctx.skill.postActions ?? [];
  const outcomes: PostActionOutcome[] = [];
  if (!actions.length) return outcomes;
  const doFetch = deps.fetch ?? fetch;
  const emit = (type: EventType, message: string, metadata: Record<string, unknown> = {}) =>
    deps.repo.appendEvent(ctx.runId, type, message, { postAction: true, ...metadata }).catch(() => undefined);

  // The final page, read server-side (the run's browser is closed after verification).
  let page: { html: string; text: string } | null = null;
  const getPage = async () => {
    if (page) return page;
    const res = await doFetch(ctx.finalUrl, { headers: { accept: 'text/html' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} reading ${ctx.finalUrl}`);
    const html = await res.text();
    page = { html, text: htmlToText(html) };
    return page;
  };

  for (const action of actions) {
    const span = tracer?.(action);
    let outcome: PostActionOutcome;
    try {
      outcome = action.type === 'save_download' ? await saveDownload(action) : await calendarEvent(action);
    } catch (err) {
      outcome = { type: action.type, ok: false, message: errMsg(err), metadata: {} };
      await emit('log', `Follow-up didn’t work (${action.type === 'save_download' ? 'save file' : 'calendar'}): ${outcome.message}. The ${ctx.skill.title.toLowerCase()} itself is done.`, {
        postActionType: action.type,
        error: outcome.message,
      });
    }
    span?.end(outcome);
    outcomes.push(outcome);
  }
  const ok = outcomes.filter((o) => o.ok).length;
  await emit('log', `Follow-ups finished: ${ok} of ${outcomes.length} done`, { postActionsDone: true, ok, total: outcomes.length });
  return outcomes;

  async function saveDownload(action: Extract<PostAction, { type: 'save_download' }>): Promise<PostActionOutcome> {
    let file: { fileName: string; mimeType: string; bytes: Buffer; source: string } | null = null;
    if (deps.browser?.download && deps.sessionId) {
      const got = await deps.browser
        .download(deps.sessionId, { description: `${action.linkText} link`, matchText: action.linkText })
        .catch(() => null);
      if (got) file = { ...got, source: 'browser' };
    }
    if (!file) {
      const { html } = await getPage();
      const link = findLink(html, action.linkText, ctx.finalUrl);
      if (!link) throw new Error(`no "${action.linkText}" link on the final page`);
      const res = await doFetch(link.href, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${link.href}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const mimeType = (res.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim();
      file = { fileName: fileNameFrom(res, link.href, link.download), mimeType, bytes, source: link.href };
    }

    const type: ArtifactType = action.folder === 'return-labels' ? 'label' : 'file';
    const base = { folder: action.folder, fileName: file.fileName, source: file.source, sizeBytes: file.bytes.length };
    if (deps.workspace) {
      const saved = await deps.workspace.save(action.folder, file.fileName, file.bytes);
      // Keep a copy in Neon so the UI can preview it instantly; the Sprite file is the agent's own copy.
      const artifact = await deps.repo.createArtifact({
        runId: ctx.runId,
        type,
        mimeType: file.mimeType,
        bytes: file.bytes,
        metadata: { ...base, spritePath: saved.path, spriteLocation: saved.location, purpose: 'post-action' },
      });
      const metadata = { ...base, path: saved.path, location: 'sprite', spriteLocation: saved.location, artifactId: artifact.id };
      await emit('workspace.saved', `Saved ${file.fileName} to your agent’s workspace: ${saved.path}`, metadata);
      return { type: action.type, ok: true, message: saved.path, metadata };
    }
    const artifact = await deps.repo.createArtifact({
      runId: ctx.runId,
      type,
      mimeType: file.mimeType,
      bytes: file.bytes,
      metadata: { ...base, purpose: 'post-action', note: 'Sprite not configured' },
    });
    const metadata = { ...base, path: `neon:${artifact.id}`, location: 'neon', artifactId: artifact.id, note: 'Sprite not configured' };
    await emit('workspace.saved', `Saved ${file.fileName} (Sprite not configured, kept in Neon)`, metadata);
    return { type: action.type, ok: true, message: `neon:${artifact.id}`, metadata };
  }

  async function calendarEvent(action: Extract<PostAction, { type: 'calendar_event' }>): Promise<PostActionOutcome> {
    const { text } = await getPage();
    const when = dateFromText(text, action.dateFromPage);
    if (!when) throw new Error(`no date matching /${action.dateFromPage}/ on the final page`);
    const rma = /\bRMA-[A-Za-z0-9]+/.exec(text)?.[0] ?? null;
    const title = fillTemplate(action.title, { rma, merchant: null, item: null });
    const start = when.date;
    const end = new Date(start.getTime() + action.durationMinutes * 60_000);
    const result = await deps.tools.createCalendarEvent({
      title,
      start: start.toISOString(),
      end: end.toISOString(),
      location: action.location ?? null,
      description: [rma && `Return ${rma}`, `Created by Do It Once after: ${ctx.skill.title}`, ctx.finalUrl].filter(Boolean).join('\n'),
    });
    let artifactId: string | null = null;
    if (result.via === 'ics' && result.icsContent) {
      const art = await deps.repo.createArtifact({
        runId: ctx.runId,
        type: 'file',
        mimeType: 'text/calendar',
        bytes: Buffer.from(result.icsContent, 'utf8'),
        metadata: { fileName: 'drop-off.ics', purpose: 'calendar', title },
      });
      artifactId = art.id;
    }
    const metadata = { via: result.via, detail: result.detail, url: result.url ?? null, title, start: start.toISOString(), dateLabel: when.label, artifactId };
    const msg = result.via === 'executor' ? `Added “${title}” on ${when.label} to Google Calendar (Executor)` : `Calendar file ready: “${title}” on ${when.label}`;
    await emit('tool.called', msg, metadata);
    return { type: action.type, ok: result.ok, message: msg, metadata };
  }
}

/** Real dependencies: Fly Sprite workspace (if SPRITES_TOKEN), Executor tools, Neon repo. Lazy imports keep tests light. */
export async function defaultPostActionDeps(repo: PostActionRepo): Promise<PostActionDeps> {
  const fly = await import('@/lib/fly');
  const { getToolAdapter } = await import('@/lib/executor');
  const workspace: WorkspaceSaver | null = fly.hasSpritesToken()
    ? {
        async save(folder, fileName, bytes) {
          if (!fly.isWorkspaceKind(folder)) throw new Error(`Unknown workspace folder "${folder}"`);
          await fly.getWorkspace().ensure();
          return fly.saveArtifact(folder, fileName, bytes);
        },
      }
    : null;
  return { repo, workspace, tools: getToolAdapter() };
}

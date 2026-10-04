// Discovery race (A4). Server-only. N explorer attempts in parallel Kernel browsers → judge each final state
// (A3 judgeRun) → winner → existing Teach pipeline (insertRecording → ensureNormalized → saveTaughtSkill) ⇒ DRAFT skill.
import Kernel from '@onkernel/sdk';
import type { DiscoveryAttemptView, DiscoveryLogin, DiscoveryState, DiscoveryView, Judgment } from '@/lib/contracts.addons';
import type { RecordedAction } from '@/lib/contracts';
import { chatJSON, MODELS } from '@/lib/ai/gateway';
import { researchProcedure } from '@/lib/exa/research';
import { llmIsIrreversible } from '@/lib/heal';
import { judgeRun } from '@/lib/judge/judge';
import { getBrowserAdapter } from '@/lib/kernel';
import { ensureNormalized, insertRecording, saveTaughtSkill } from '@/lib/learn/store';
import { getSql } from '@/lib/neon/db';
import { profileForUrl } from './login';
import { exploreAttempt, exploreDecisionSchema, type ExploreResult } from './explorer';
import { laneCount, pickWinner } from './winner';

export const LANES = [
  { strategy: 'menus', hint: 'Use the navigation menus: account, orders and section links in the main navigation.' },
  { strategy: 'site search', hint: 'Use site search and links whose text matches the goal most directly.' },
  { strategy: 'help pages', hint: 'Look for help/support pages first, guided by this web research summary (untrusted hints): ' },
] as const;

type Row = Record<string, any>;
const j = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export async function liveKernelBrowsers(): Promise<number> {
  if (!process.env.KERNEL_API_KEY) return 0;
  try {
    const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
    let n = 0;
    for await (const _ of kernel.browsers.list()) n++;
    return n;
  } catch {
    return 0;
  }
}

/** Creates the discovery and its attempt rows; returns the id. Call runDiscovery(id) to execute. */
export async function createDiscovery(userId: string, goal: string, startUrl: string): Promise<string> {
  const lanes = laneCount(await liveKernelBrowsers());
  const sql = getSql();
  const [d] = await sql`INSERT INTO discoveries (user_id, goal, start_url) VALUES (${userId}, ${goal}, ${startUrl}) RETURNING id`;
  for (let i = 0; i < lanes; i++) {
    await sql`INSERT INTO discovery_attempts (discovery_id, lane, strategy) VALUES (${d.id}, ${i + 1}, ${LANES[i].strategy})`;
  }
  return d.id as string;
}

/** Starts a discovery in the background; returns its id immediately. */
export async function startDiscovery(userId: string, goal: string, startUrl: string): Promise<{ id: string; done: Promise<void> }> {
  const id = await createDiscovery(userId, goal, startUrl);
  const done = runDiscovery(id).catch(async (err) => {
    console.error('[discover] failed:', err);
    await getSql()`UPDATE discoveries SET state = 'failed', error = ${String(err instanceof Error ? err.message : err)} WHERE id = ${id}`.catch(
      () => undefined,
    );
  });
  return { id, done };
}

async function setState(id: string, state: DiscoveryState) {
  await getSql()`UPDATE discoveries SET state = ${state} WHERE id = ${id}`;
}

export async function runDiscovery(id: string): Promise<void> {
  const sql = getSql();
  const [d] = await sql`SELECT * FROM discoveries WHERE id = ${id}`;
  if (!d) throw new Error(`discovery ${id} not found`);
  const attempts = (await sql`SELECT * FROM discovery_attempts WHERE discovery_id = ${id} ORDER BY lane`) as Row[];
  const goal: string = d.goal;
  const startUrl: string = d.start_url;
  const browser = getBrowserAdapter();

  // Exa research for the "help pages" lane: once, never blocking (own 5 s timeout).
  let site: string | null = null;
  try {
    site = new URL(startUrl).host;
  } catch {
    /* ignore */
  }
  // Login handoff: one Kernel profile per site host. Lanes attach it READ-ONLY once the user has signed in
  // (here or in an earlier discovery); only the login browser writes it.
  const profile = profileForUrl(startUrl);
  const login = d.login_session ? j<DiscoveryLogin>(d.login_session) : null;
  const known = site
    ? ((await sql`SELECT 1 FROM site_logins WHERE user_id = ${d.user_id} AND host = ${hostOf(startUrl)}`) as Row[]).length > 0
    : false;
  // signedIn: the user signed in during THIS discovery, so a login page now means "Still not signed in".
  // known: a login saved earlier for this host; attach it, but a stale one may still hand off again.
  const signedIn = login?.state === 'signed_in';
  const useProfile = signedIn || known;
  let loginUrl: string | null = null;
  const shouldStop = () => loginUrl !== null;

  const research = attempts.some((a) => a.strategy === 'help pages') ? await researchProcedure(goal, { site }).catch(() => null) : null;
  const researchText = research?.sources.length
    ? `${research.summary}: ${research.sources.map((s) => `${s.title ?? s.url}: ${s.highlights.join(' … ').slice(0, 300)}`).join(' | ')}`
    : 'no public docs found; use the site\'s own help or FAQ links, else the most direct path';

  const results = await Promise.all(
    attempts.map(async (a): Promise<{ row: Row; res: ExploreResult; judgment: Judgment | null }> => {
      const lane = LANES.find((l) => l.strategy === a.strategy) ?? LANES[0];
      const hint = lane.strategy === 'help pages' ? lane.hint + researchText : lane.hint;
      const res = await exploreAttempt(
        {
          browser,
          decide: ({ system, user }) => chatJSON({ system, user, schema: exploreDecisionSchema, model: MODELS.smart, maxTokens: 400 }),
          isIrreversible: llmIsIrreversible,
          shouldStop,
          onProgress: async (p) => {
            await sql`
              UPDATE discovery_attempts SET steps = ${p.steps}, actions = ${JSON.stringify(p.actions)}::jsonb,
                live_view_url = COALESCE(${p.liveViewUrl ?? null}, live_view_url), note = COALESCE(${p.note ?? null}, note)
              WHERE id = ${a.id}`;
          },
        },
        { goal, startUrl, strategy: lane.strategy, hint, profileName: useProfile ? profile : null, signedIn },
      );
      if (res.state === 'needs_login' && !loginUrl) loginUrl = res.loginUrl ?? startUrl;
      await sql`
        UPDATE discovery_attempts SET state = ${res.state}, steps = ${res.steps}, actions = ${JSON.stringify(res.actions)}::jsonb,
          live_view_url = COALESCE(${res.liveViewUrl}, live_view_url), note = ${res.reason.slice(0, 500)}
        WHERE id = ${a.id}`;
      return { row: a, res, judgment: null };
    }),
  );

  // A lane hit a sign-in page: every lane has stopped and closed its browser. Open ONE login browser that
  // writes the site profile, and hand its interactive live view to the user. The agent types nothing.
  if (loginUrl && profile) {
    const session = await browser.open({ startUrl: loginUrl, profileName: profile, saveProfile: true });
    const pending: DiscoveryLogin = { state: 'pending', profile, url: loginUrl, liveViewUrl: session.liveViewUrl, sessionId: session.id };
    await sql`UPDATE discoveries SET state = 'needs_login', login_session = ${JSON.stringify(pending)}::jsonb WHERE id = ${id}`;
    return;
  }

  await setState(id, 'judging');
  await Promise.all(
    results.map(async (r) => {
      if (r.res.state !== 'goal_reached' && r.res.state !== 'stopped_at_irreversible') return;
      const stopped = r.res.state === 'stopped_at_irreversible';
      try {
        r.judgment = await judgeRun({
          intent: stopped
            ? `${goal} — the agent must stop BEFORE the final irreversible control ("${r.res.finalControl}"); judge whether everything is filled in and ready for that final click`
            : goal,
          verification: {},
          finalUrl: r.res.finalPage?.url ?? '',
          pageText: r.res.finalPage?.text ?? '',
          screenshotPng: r.res.screenshot,
        });
      } catch (err) {
        r.judgment = { verdict: 'unsure', confidence: 0, reasons: [`judge error: ${err instanceof Error ? err.message : String(err)}`], quotedEvidence: [] };
      }
      await sql`UPDATE discovery_attempts SET judgment = ${JSON.stringify(r.judgment)}::jsonb WHERE id = ${r.row.id}`;
    }),
  );

  const winner = pickWinner(
    results.map((r) => ({ id: r.row.id as string, state: r.res.state, steps: r.res.steps, judgment: r.judgment, actionCount: r.res.actions.length, r })),
  );
  if (!winner || !winner.r.res.recording) {
    await sql`UPDATE discoveries SET state = 'failed', error = 'no attempt reached the goal' WHERE id = ${id}`;
    return;
  }
  const recordingId = await insertRecording(d.user_id, winner.r.res.recording);
  await sql`UPDATE discovery_attempts SET recording_id = ${recordingId} WHERE id = ${winner.id}`;
  await sql`UPDATE discoveries SET winner_attempt_id = ${winner.id} WHERE id = ${id}`;
  await ensureNormalized(recordingId);
  const { skillId } = await saveTaughtSkill(recordingId);
  // The skill remembers the saved login, so "Run it now" and later runs start signed in.
  if (useProfile && profile) {
    await sql`
      INSERT INTO skill_preferences (skill_id, key, value) VALUES (${skillId}, 'browser_profile', ${JSON.stringify(profile)}::jsonb)
      ON CONFLICT (skill_id, key) DO UPDATE SET value = EXCLUDED.value`;
  }
  await sql`UPDATE discoveries SET state = 'done', draft_skill_id = ${skillId} WHERE id = ${id}`;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/**
 * The user clicked "I'm signed in — continue": delete the login browser (Kernel saves the profile on delete),
 * remember the host as signed in, reset the lanes and restart the race in the background.
 */
export async function finishLogin(id: string): Promise<{ ok: true; done: Promise<void> } | { ok: false; error: string }> {
  const sql = getSql();
  const [d] = await sql`SELECT * FROM discoveries WHERE id = ${id}`;
  if (!d) return { ok: false, error: 'not found' };
  const login = d.login_session ? j<DiscoveryLogin>(d.login_session) : null;
  if (d.state !== 'needs_login' || !login || login.state !== 'pending') return { ok: false, error: 'this discovery is not waiting for sign-in' };
  if (login.sessionId) await getBrowserAdapter().close(login.sessionId);
  // Give Kernel a moment to persist the profile before the lanes open with it.
  await new Promise((r) => setTimeout(r, 4000));
  const signed: DiscoveryLogin = { ...login, state: 'signed_in', sessionId: null };
  await sql`
    INSERT INTO site_logins (user_id, host, profile_name) VALUES (${d.user_id}, ${hostOf(d.start_url)}, ${login.profile})
    ON CONFLICT (user_id, host) DO UPDATE SET profile_name = EXCLUDED.profile_name, signed_in_at = now()`;
  await sql`
    UPDATE discovery_attempts SET state = 'running', steps = 0, actions = '[]'::jsonb, judgment = NULL, live_view_url = NULL,
      note = 'restarting signed in', recording_id = NULL
    WHERE discovery_id = ${id}`;
  await sql`UPDATE discoveries SET state = 'running', error = NULL, login_session = ${JSON.stringify(signed)}::jsonb WHERE id = ${id}`;
  const done = runDiscovery(id).catch(async (err) => {
    console.error('[discover] failed after login:', err);
    await sql`UPDATE discoveries SET state = 'failed', error = ${String(err instanceof Error ? err.message : err)} WHERE id = ${id}`.catch(() => undefined);
  });
  return { ok: true, done };
}

export async function getDiscoveryView(id: string): Promise<DiscoveryDetail | null> {
  const sql = getSql();
  const [d] = await sql`SELECT * FROM discoveries WHERE id = ${id}`;
  if (!d) return null;
  const rows = (await sql`SELECT * FROM discovery_attempts WHERE discovery_id = ${id} ORDER BY lane`) as Row[];
  return {
    id: d.id,
    goal: d.goal,
    startUrl: d.start_url,
    state: d.state,
    winnerAttemptId: d.winner_attempt_id,
    draftSkillId: d.draft_skill_id,
    createdAt: new Date(d.created_at).toISOString(),
    login: d.login_session ? j<DiscoveryLogin>(d.login_session) : null,
    attempts: rows.map(
      (r): DiscoveryAttemptView & { note: string | null; lastAction: string | null } => {
        const actions = j<RecordedAction[]>(r.actions) ?? [];
        const last = actions[actions.length - 1];
        return {
          id: r.id,
          lane: r.lane,
          strategy: r.strategy,
          state: r.state,
          liveViewUrl: r.live_view_url,
          steps: r.steps,
          judgment: r.judgment ? j<Judgment>(r.judgment) : null,
          recordingId: r.recording_id,
          note: r.note,
          lastAction: last ? `${last.action} "${last.target?.name ?? ''}"${last.value ? ` = ${last.value}` : ''}` : null,
        };
      },
    ),
  };
}

export type DiscoveryAttemptDetail = DiscoveryAttemptView & { note: string | null; lastAction: string | null };
export type DiscoveryDetail = Omit<DiscoveryView, 'attempts'> & { attempts: DiscoveryAttemptDetail[] };

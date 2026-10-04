// Run engine (B3): executes a skill's steps through a BrowserAdapter, writes execution events,
// pauses before irreversible steps, resumes after approval and verifies the final page.
// Server-only. See docs/CONTRACTS.md "Run engine semantics (B3)".
import type {
  ActionOutcome,
  Approval,
  BrowserAdapter,
  EventType,
  PageState,
  RunEngine,
  RunResult,
  SkillDetail,
  SkillRun,
  SkillStep,
} from '@/lib/contracts';
import { TERMINAL_STATES } from '@/lib/contracts';
import type { verifyPage } from '@/lib/engine/verify';
import type { extractApprovalPayload } from '@/lib/engine/extract';

type RepoModule = typeof import('@/lib/neon/repo');

/** The subset of lib/neon/repo the engine uses. */
export type EngineRepo = Pick<
  RepoModule,
  | 'getSkill'
  | 'updateStepLocator'
  | 'recordSkillOutcome'
  | 'createRun'
  | 'getRun'
  | 'updateRun'
  | 'appendEvent'
  | 'createApproval'
  | 'getLatestApproval'
  | 'decideApproval'
  | 'createArtifact'
  | 'setTriggerState'
>;

export interface RunEngineDeps {
  repo: EngineRepo;
  browser: BrowserAdapter;
  verify: typeof verifyPage;
  extract: typeof extractApprovalPayload;
  now?: () => Date;
}

/** RunEngine plus a test helper that resolves once the background work for a run has settled. */
export interface RunEngineWithIdle extends RunEngine {
  whenIdle(runId: string): Promise<void>;
}

const WAIT_FOR_TEXT_MS = 8000;

/** Raised to abort the background loop with a readable message (already the run's error). */
class RunAbort extends Error {}

function isSessionGone(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'BrowserSessionGoneError';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

function alternatives(expected: string | null): string[] {
  if (!expected) return [];
  return expected
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
}

function findAlternative(text: string, alts: string[]): string | null {
  const hay = text.toLowerCase();
  return alts.find((a) => hay.includes(a.toLowerCase())) ?? null;
}

export function createRunEngine(deps: RunEngineDeps): RunEngineWithIdle {
  const { repo, browser, verify, extract } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();

  /** Runs with background work in flight (or being set up). Guards against double execution. */
  const active = new Set<string>();
  const stopRequested = new Set<string>();
  const tasks = new Map<string, Promise<void>>();

  const emit = (runId: string, type: EventType, message: string, metadata: Record<string, unknown> = {}) =>
    repo.appendEvent(runId, type, message, metadata);

  async function closeQuietly(sessionId: string | null | undefined) {
    if (!sessionId) return;
    try {
      await browser.close(sessionId);
    } catch {
      /* already gone */
    }
  }

  /** Starts background execution. Caller must already hold the `active` slot for runId. */
  function launch(runId: string) {
    const task = (async () => {
      try {
        await execute(runId);
      } catch (err) {
        await handleUnexpected(runId, err);
      } finally {
        // Safety net: if a stop raced with a browser reopen, close whatever session the run holds now.
        if (stopRequested.has(runId)) {
          const latest = await repo.getRun(runId).catch(() => null);
          await closeQuietly(latest?.browserSessionId);
        }
        active.delete(runId);
        stopRequested.delete(runId);
      }
    })().catch(() => {
      /* handleUnexpected never rethrows, but never let a rejection escape */
    });
    tasks.set(runId, task);
  }

  async function handleUnexpected(runId: string, err: unknown) {
    if (err instanceof RunAbort) return;
    try {
      const run = await repo.getRun(runId);
      if (!run || TERMINAL_STATES.includes(run.state)) return;
      await failRun(run, `Something went wrong: ${errorMessage(err)}`);
    } catch {
      /* nothing more we can do */
    }
  }

  async function failRun(run: SkillRun, message: string, result: RunResult | null = null) {
    await emit(run.id, 'run.failed', message, { stepSequence: run.currentStep });
    await repo.updateRun(run.id, {
      state: 'failed',
      error: message,
      completedAt: iso(),
      ...(result ? { result } : {}),
    });
    await closeQuietly(run.browserSessionId);
    await repo.recordSkillOutcome(run.skillId, false);
    if (run.triggerId) await repo.setTriggerState(run.triggerId, 'pending');
  }

  async function execute(runId: string) {
    let run = await repo.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (TERMINAL_STATES.includes(run.state)) return;
    const skill = await repo.getSkill(run.skillId);
    if (!skill) throw new Error('The skill for this run no longer exists');

    const steps = [...skill.steps].sort((a, b) => a.sequence - b.sequence);
    const resuming = run.state === 'resumed';

    if (!resuming) {
      run = await repo.updateRun(runId, { state: 'running' });
      await emit(runId, 'run.started', `Starting: ${skill.title}`, {});
    }

    const ctx: ExecCtx = { run, skill, steps, sessionId: run.browserSessionId, lastUrl: null, recovered: false };

    const from = Math.max(run.currentStep, 1);
    const found = steps.findIndex((s) => s.sequence >= from);
    const startIndex = found === -1 ? steps.length : found;

    if (!ctx.sessionId) {
      await openBrowser(ctx);
      if (startIndex > 0) await catchUp(ctx, startIndex);
    }

    for (let i = startIndex; i < steps.length; i++) {
      const step = steps[i];
      if (stopRequested.has(runId)) return;
      ctx.run = await repo.updateRun(runId, { currentStep: step.sequence });

      if (step.requiresApproval) {
        const latest = await repo.getLatestApproval(runId);
        const approved = latest && latest.stepSequence === step.sequence && latest.status === 'approved';
        if (!approved) {
          await requestApproval(ctx, step, i);
          return; // browser stays open
        }
      }

      const urlBefore = ctx.lastUrl;
      await emit(runId, 'step.started', step.intent, { stepSequence: step.sequence, url: urlBefore, usedLocator: null });

      const outcome = await withRecovery(ctx, i, () => performStep(ctx, step));
      if (stopRequested.has(runId)) return;
      if (outcome.page?.url) ctx.lastUrl = outcome.page.url;

      if (!outcome.ok) {
        const reason = outcome.error ?? 'the step did not work';
        const message = `Couldn't ${lowerFirst(step.intent)}: ${reason}`;
        await emit(runId, 'step.failed', message, {
          stepSequence: step.sequence,
          url: ctx.lastUrl,
          usedLocator: outcome.usedLocator,
        });
        await failRun(ctx.run, message);
        return;
      }

      if (outcome.usedLocator && outcome.usedLocator !== step.locatorHint) {
        await repo.updateStepLocator(step.id, outcome.usedLocator);
        step.locatorHint = outcome.usedLocator;
      }
      await emit(runId, 'step.succeeded', `${step.intent} — done`, {
        stepSequence: step.sequence,
        url: ctx.lastUrl,
        usedLocator: outcome.usedLocator,
      });
    }

    if (stopRequested.has(runId)) return;
    await verifyAndFinish(ctx);
  }

  interface ExecCtx {
    run: SkillRun;
    skill: SkillDetail;
    steps: SkillStep[];
    sessionId: string | null;
    lastUrl: string | null;
    recovered: boolean;
  }

  async function openBrowser(ctx: ExecCtx) {
    const session = await browser.open({ startUrl: ctx.skill.startUrl ?? undefined });
    ctx.sessionId = session.id;
    ctx.run = await repo.updateRun(ctx.run.id, { browserSessionId: session.id, liveViewUrl: session.liveViewUrl });
    await emit(ctx.run.id, 'browser.opened', 'Opened a secure cloud browser', {
      browserSessionId: session.id,
      liveViewUrl: session.liveViewUrl,
    });
  }

  /** Runs `fn`; if the browser session is gone, reopens once, fast-replays steps before `index`, retries. */
  async function withRecovery<T>(ctx: ExecCtx, index: number, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isSessionGone(err) || ctx.recovered) throw err;
      // A Stop closes the browser; never reopen (and pay for) a new one after that.
      if (stopRequested.has(ctx.run.id)) throw new RunAbort('stopped');
      ctx.recovered = true;
      await emit(ctx.run.id, 'log', 'Browser session expired — reopening and catching up', {
        stepSequence: ctx.steps[index]?.sequence ?? ctx.run.currentStep,
      });
      await closeQuietly(ctx.sessionId);
      await openBrowser(ctx);
      await catchUp(ctx, index);
      if (stopRequested.has(ctx.run.id)) {
        await closeQuietly(ctx.sessionId);
        throw new RunAbort('stopped');
      }
      return await fn();
    }
  }

  /** Re-executes steps [0, index) quietly in the current browser to get back to where the run was. */
  async function catchUp(ctx: ExecCtx, index: number) {
    for (let i = 0; i < index; i++) {
      const step = ctx.steps[i];
      if (step.requiresApproval) {
        throw new Error(`Can't safely repeat "${step.intent}" to catch up — it is irreversible`);
      }
      if (stopRequested.has(ctx.run.id)) throw new RunAbort('stopped');
      // Visible progress so the UI doesn't look stalled while catching up.
      await emit(ctx.run.id, 'log', `Catching up: ${step.intent}`, { stepSequence: step.sequence, catchUp: true });
      const outcome = await performStep(ctx, step);
      if (outcome.page?.url) ctx.lastUrl = outcome.page.url;
      if (!outcome.ok) {
        throw new Error(`Couldn't catch up at "${step.intent}": ${outcome.error ?? 'the step did not work'}`);
      }
    }
  }

  async function requestApproval(ctx: ExecCtx, step: SkillStep, index: number) {
    const page = await withRecovery(ctx, index, () => browser.readPage(ctx.sessionId!));
    ctx.lastUrl = page.url;
    const payload: Approval['payload'] = { ...extract(page), pageUrl: page.url };
    const title = step.config.approval?.title ?? `${step.intent}?`;
    const description = step.config.approval?.description ?? `The next step is irreversible: ${lowerFirst(step.intent)}.`;
    if (stopRequested.has(ctx.run.id)) return;
    const approval = await repo.createApproval({
      runId: ctx.run.id,
      stepSequence: step.sequence,
      title,
      description,
      payload,
    });
    ctx.run = await repo.updateRun(ctx.run.id, { state: 'waiting_approval' });
    await emit(ctx.run.id, 'approval.requested', `Waiting for your approval: ${title}`, {
      stepSequence: step.sequence,
      url: page.url,
      usedLocator: null,
      approvalId: approval.id,
    });
  }

  function resolveUrl(skill: SkillDetail, source: string): string {
    const raw = source.startsWith('url:') ? source.slice(4) : source;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!skill.startUrl) throw new Error(`no start URL to resolve "${raw}" against`);
    return new URL(raw, new URL(skill.startUrl).origin).toString();
  }

  function resolveInput(skill: SkillDetail, source: string | null): string {
    if (!source) return '';
    if (source.startsWith('literal:')) return source.slice('literal:'.length);
    if (source.startsWith('pref:')) {
      const v = skill.preferences?.[source.slice('pref:'.length)];
      return v == null ? '' : String(v);
    }
    return source;
  }

  /** Performs the step's action and checks expectedAfter. Rethrows only BrowserSessionGoneError. */
  async function performStep(ctx: ExecCtx, step: SkillStep): Promise<ActionOutcome> {
    const sid = ctx.sessionId!;
    const target = {
      description: step.targetDescription ?? step.config.matchText ?? step.intent,
      matchText: step.config.matchText ?? null,
      locatorHint: step.locatorHint,
    };
    try {
      let outcome: ActionOutcome;
      switch (step.actionType) {
        case 'navigate': {
          const src = step.inputSource ?? (typeof step.config.url === 'string' ? step.config.url : null);
          if (!src) throw new Error('no URL to open');
          outcome = await browser.goto(sid, resolveUrl(ctx.skill, src));
          break;
        }
        case 'click':
          outcome = await browser.click(sid, target);
          break;
        case 'type':
          outcome = await browser.type(sid, target, resolveInput(ctx.skill, step.inputSource));
          break;
        case 'select':
          outcome = await browser.select(sid, target, resolveInput(ctx.skill, step.inputSource));
          break;
        case 'wait': {
          const first = alternatives(step.expectedAfter)[0];
          outcome = first
            ? await browser.waitForText(sid, first, WAIT_FOR_TEXT_MS)
            : { ok: true, usedLocator: null, page: await browser.readPage(sid) };
          break;
        }
        case 'screenshot': {
          const bytes = await browser.screenshot(sid);
          const page = await browser.readPage(sid);
          const artifact = await repo.createArtifact({
            runId: ctx.run.id,
            type: 'screenshot',
            mimeType: 'image/png',
            bytes,
            metadata: { url: page.url, stepSequence: step.sequence },
          });
          await emit(ctx.run.id, 'artifact.saved', 'Saved a screenshot', { artifactId: artifact.id });
          outcome = { ok: true, usedLocator: null, page };
          break;
        }
        case 'extract':
        default:
          outcome = { ok: true, usedLocator: null, page: await browser.readPage(sid) };
          break;
      }
      if (!outcome.ok) return outcome;

      const alts = alternatives(step.expectedAfter);
      if (alts.length === 0) return outcome;
      if (findAlternative(outcome.page?.text ?? '', alts)) return outcome;
      const waited = await browser.waitForText(sid, alts[0], WAIT_FOR_TEXT_MS);
      const page = waited.page ?? outcome.page;
      if (findAlternative(page?.text ?? '', alts)) return { ...outcome, page };
      return {
        ok: false,
        usedLocator: outcome.usedLocator,
        page,
        error: `expected to see "${alts.join('" or "')}" but it never appeared`,
      };
    } catch (err) {
      if (isSessionGone(err)) throw err;
      return {
        ok: false,
        usedLocator: null,
        page: { url: ctx.lastUrl ?? '', title: '', text: '' },
        error: errorMessage(err),
      };
    }
  }

  function successSummary(skill: SkillDetail, merchant: string | null): string {
    if (skill.icon === 'subscription') {
      return `${merchant ?? 'Your'} membership canceled. Verified on the website.`;
    }
    return `${skill.title} done. Verified on the website.`;
  }

  async function verifyAndFinish(ctx: ExecCtx) {
    const runId = ctx.run.id;
    ctx.run = await repo.updateRun(runId, { state: 'verifying' });
    await emit(runId, 'verify.started', 'Checking the website to confirm it worked', { url: ctx.lastUrl });

    const capture = async () => {
      const page = await browser.readPage(ctx.sessionId!);
      const shot = await browser.screenshot(ctx.sessionId!);
      return { page, shot };
    };
    let captured: { page: PageState; shot: Buffer };
    try {
      captured = await capture();
    } catch (err) {
      if (!isSessionGone(err) || ctx.recovered) throw err;
      // Can't replay past an irreversible step: reopen and look at the last page we were on.
      ctx.recovered = true;
      await emit(runId, 'log', 'Browser session expired — reopening to check the result', {});
      await openBrowser(ctx);
      if (ctx.lastUrl) await browser.goto(ctx.sessionId!, ctx.lastUrl);
      captured = await capture();
    }
    const { page, shot } = captured;

    const artifact = await repo.createArtifact({
      runId,
      type: 'screenshot',
      mimeType: 'image/png',
      bytes: shot,
      metadata: { url: page.url, purpose: 'verification' },
    });
    await emit(runId, 'artifact.saved', 'Saved a screenshot of the final page as proof', { artifactId: artifact.id });

    const vr = verify(ctx.skill.verification, page);
    const latest = await repo.getLatestApproval(runId);
    const merchant = typeof latest?.payload?.merchant === 'string' ? latest.payload.merchant : null;
    const base = {
      evidenceText: vr.matched,
      finalUrl: page.url,
      screenshotArtifactId: artifact.id,
      verifiedAt: iso(),
      valuePerYear: ctx.skill.valuePerYear,
    };

    if (stopRequested.has(runId)) return;

    if (vr.passed) {
      const summary = successSummary(ctx.skill, merchant);
      const result: RunResult = { success: true, summary, ...base };
      await emit(runId, 'verify.passed', `Verified: ${vr.matched.find((m) => !/^https?:/.test(m)) ?? vr.matched[0] ?? 'the website confirms it'}`, {
        url: page.url,
        evidence: vr.matched,
      });
      await emit(runId, 'run.succeeded', summary, { url: page.url, valuePerYear: ctx.skill.valuePerYear });
      await repo.updateRun(runId, { state: 'succeeded', result, completedAt: iso(), error: null });
      await repo.recordSkillOutcome(ctx.skill.id, true);
      if (ctx.run.triggerId) await repo.setTriggerState(ctx.run.triggerId, 'done');
      await closeQuietly(ctx.sessionId);
    } else {
      const summary = `Couldn't confirm on the website that "${ctx.skill.title}" worked.`;
      const result: RunResult = { success: false, summary, ...base };
      const detail = vr.failedRules.map((r) => `${r.type.replace('_', ' ')} "${r.value}"`).join(', ');
      await emit(runId, 'verify.failed', `Verification failed${detail ? `: ${detail}` : ''}`, {
        url: page.url,
        failedRules: vr.failedRules,
      });
      ctx.run = { ...ctx.run, browserSessionId: ctx.sessionId };
      await failRun(ctx.run, summary, result);
    }
  }

  return {
    async startRun(input) {
      const run = await repo.createRun({ skillId: input.skillId, userId: input.userId, triggerId: input.triggerId ?? null });
      if (run.triggerId) await repo.setTriggerState(run.triggerId, 'running');
      if (!active.has(run.id)) {
        active.add(run.id);
        launch(run.id);
      }
      return { runId: run.id };
    },

    async approve(runId) {
      if (active.has(runId)) return; // already executing (double click / concurrent approve)
      active.add(runId);
      try {
        const run = await repo.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.state !== 'waiting_approval') throw new Error(`Run is not waiting for approval (state: ${run.state})`);
        const approval = await repo.getLatestApproval(runId);
        if (!approval || approval.status !== 'pending') throw new Error('There is no pending approval for this run');
        await repo.decideApproval(approval.id, 'approved');
        await emit(runId, 'approval.granted', `You approved: ${approval.title}`, {
          stepSequence: approval.stepSequence,
          approvalId: approval.id,
        });
        await repo.updateRun(runId, { state: 'resumed' });
      } catch (err) {
        active.delete(runId);
        throw err;
      }
      launch(runId);
    },

    async stop(runId) {
      const run = await repo.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (TERMINAL_STATES.includes(run.state)) return;
      stopRequested.add(runId);
      const approval = await repo.getLatestApproval(runId);
      if (approval && approval.status === 'pending') {
        await repo.decideApproval(approval.id, 'denied');
        await emit(runId, 'approval.denied', `You declined: ${approval.title}`, {
          stepSequence: approval.stepSequence,
          approvalId: approval.id,
        });
      }
      await emit(runId, 'run.stopped', 'Stopped. Nothing else will happen.', { stepSequence: run.currentStep });
      await repo.updateRun(runId, { state: 'stopped', completedAt: iso() });
      if (run.triggerId) await repo.setTriggerState(run.triggerId, 'pending');
      // Close the paid browser in the background so the Stop button answers instantly.
      void closeQuietly(run.browserSessionId);
      // If no background work holds the run, clear the flag now; otherwise the loop clears it.
      if (!active.has(runId)) stopRequested.delete(runId);
    },

    whenIdle(runId) {
      return tasks.get(runId) ?? Promise.resolve();
    },
  };
}

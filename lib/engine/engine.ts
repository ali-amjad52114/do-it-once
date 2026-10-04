// Run engine: executes a skill's steps through a BrowserAdapter, writes execution events,
// pauses before irreversible steps, resumes after approval and verifies the final page.
// Server-only. See docs/CONTRACTS.md "Run engine semantics" + Wave A "M1".
//
// Orchestration is a Mastra workflow (`choreRun`, lib/mastra/workflows/chore-run.ts):
//   prepare → loop[ execute-steps → approval (suspend/resume) ] → verify → complete
// This file holds (1) the run *core*: the step logic the workflow steps call (Kernel actions,
// recovery, events, approvals, verification), and (2) the `RunEngine` facade that maps
// startRun / approve / stop onto Mastra `createRun().start()`, `resume()` and `cancel()`.
// The Mastra workflow runId is our skill_runs.id, so nothing extra has to be stored.
import { Mastra } from '@mastra/core/mastra';
import { InMemoryStore, type MastraCompositeStore } from '@mastra/core/storage';
import type { ObservabilityEntrypoint } from '@mastra/core/observability';
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
import { createChoreRunWorkflow, type ChoreRunWorkflow, type FlowState } from '@/lib/mastra/workflows/chore-run';
import { resolveStepInput } from '@/lib/actions/step-input';
import { flag } from '@/lib/addons/flags';
import { onRunVerified } from '@/lib/judge';

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
  /** Wave B self-heal hooks (lib/heal). Optional so tests and fakes stay valid. */
  healer?: {
    heal(input: { runId: string; sessionId: string; skill: SkillDetail; steps: SkillStep[]; failedIndex: number; failure: string }): Promise<{ steps: SkillStep[]; resumeIndex: number } | null>;
    restore(runId: string, skill: SkillDetail): Promise<SkillDetail | null>;
    commit(runId: string): Promise<void>;
  };
}

/** RunEngine plus a test helper that resolves once the background work for a run has settled. */
export interface RunEngineWithIdle extends RunEngine {
  whenIdle(runId: string): Promise<void>;
}

/** Optional per-browser-step tracing hook (the workflow wires it to Mastra child spans). */
export interface StepTracer {
  start(step: SkillStep, kind: 'step' | 'catch-up'): { end(outcome: ActionOutcome): void; fail(err: unknown): void };
}

const WAIT_FOR_TEXT_MS = 8000;

/** Raised to abort background work with a readable message (already the run's error). */
export class RunAbort extends Error {}

function isSessionGone(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: unknown }).name === 'BrowserSessionGoneError';
}

/**
 * Demo pacing: each step takes at least STEP_MIN_MS (default 0) so the checklist moves in step with
 * Kernel's live view, which shows page changes with a short streaming delay. Off in tests.
 */
async function paceStep(startedAt: number) {
  const min = Number(process.env.STEP_MIN_MS ?? 0);
  const wait = min - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
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

/** Mastra trace id for a run: the run UUID without dashes (32 hex chars), so start + every resume share one trace. */
export function traceIdForRun(runId: string): string | undefined {
  const hex = runId.replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{1,32}$/.test(hex) ? hex : undefined;
}

interface ExecCtx {
  run: SkillRun;
  skill: SkillDetail;
  steps: SkillStep[];
  sessionId: string | null;
  lastUrl: string | null;
  recovered: boolean;
}

export interface ApprovalRequest {
  approvalId: string;
  stepSequence: number;
  title: string;
  payload: Approval['payload'];
}

// ═════════════════════════ Run core (called by the Mastra workflow steps) ═════════════════════════

export type RunCore = ReturnType<typeof createRunCore>;

export function createRunCore(deps: RunEngineDeps) {
  const { repo, browser, verify, extract } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();

  /** Runs with background work in flight in this process. Guards against double execution. */
  const active = new Set<string>();
  /** Stop was pressed while background work was in flight: steps check this and halt. */
  const stopRequested = new Set<string>();
  /** Skill per run, loaded once per process (locator updates are applied to it in place). */
  const skills = new Map<string, SkillDetail>();

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
    skills.delete(run.id);
  }

  /** Rebuilds the in-memory execution context from the run row + the workflow's flow state. */
  async function loadCtx(state: FlowState): Promise<ExecCtx> {
    const run = await repo.getRun(state.runId);
    if (!run) throw new Error(`Run ${state.runId} not found`);
    let skill = skills.get(run.id);
    if (!skill) {
      const loaded = await repo.getSkill(run.skillId);
      if (!loaded) throw new Error('The skill for this run no longer exists');
      skill = (await deps.healer?.restore(run.id, loaded)) ?? loaded; // heal hook: keep a run's healed path
      skills.set(run.id, skill);
    }
    const steps = [...skill.steps].sort((a, b) => a.sequence - b.sequence);
    return {
      run,
      skill,
      steps,
      sessionId: run.browserSessionId ?? state.sessionId,
      lastUrl: state.lastUrl,
      recovered: state.recovered,
    };
  }

  function flow(ctx: ExecCtx, status: FlowState['status'], pendingStep: number | null = null): FlowState {
    return { runId: ctx.run.id, sessionId: ctx.sessionId, lastUrl: ctx.lastUrl, recovered: ctx.recovered, status, pendingStep };
  }

  function halted(state: FlowState): FlowState {
    return { ...state, status: 'halted', pendingStep: null };
  }

  function isStopped(runId: string) {
    return stopRequested.has(runId);
  }

  function startIndexOf(ctx: ExecCtx): number {
    const from = Math.max(ctx.run.currentStep, 1);
    const found = ctx.steps.findIndex((s) => s.sequence >= from);
    return found === -1 ? ctx.steps.length : found;
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
  async function withRecovery<T>(ctx: ExecCtx, index: number, fn: () => Promise<T>, tracer?: StepTracer): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!isSessionGone(err) || ctx.recovered) throw err;
      // A Stop closes the browser; never reopen (and pay for) a new one after that.
      if (isStopped(ctx.run.id)) throw new RunAbort('stopped');
      ctx.recovered = true;
      await emit(ctx.run.id, 'log', 'Browser session expired — reopening and catching up', {
        stepSequence: ctx.steps[index]?.sequence ?? ctx.run.currentStep,
      });
      await closeQuietly(ctx.sessionId);
      await openBrowser(ctx);
      await catchUp(ctx, index, tracer);
      if (isStopped(ctx.run.id)) {
        await closeQuietly(ctx.sessionId);
        throw new RunAbort('stopped');
      }
      return await fn();
    }
  }

  /** Re-executes steps [0, index) quietly in the current browser to get back to where the run was. */
  async function catchUp(ctx: ExecCtx, index: number, tracer?: StepTracer) {
    for (let i = 0; i < index; i++) {
      const step = ctx.steps[i];
      if (step.requiresApproval) {
        throw new Error(`Can't safely repeat "${step.intent}" to catch up — it is irreversible`);
      }
      if (isStopped(ctx.run.id)) throw new RunAbort('stopped');
      // Visible progress so the UI doesn't look stalled while catching up.
      await emit(ctx.run.id, 'log', `Catching up: ${step.intent}`, { stepSequence: step.sequence, catchUp: true });
      const span = tracer?.start(step, 'catch-up');
      const outcome = await performStep(ctx, step);
      span?.end(outcome);
      if (outcome.page?.url) ctx.lastUrl = outcome.page.url;
      if (!outcome.ok) {
        throw new Error(`Couldn't catch up at "${step.intent}": ${outcome.error ?? 'the step did not work'}`);
      }
    }
  }

  function resolveUrl(skill: SkillDetail, source: string): string {
    const raw = source.startsWith('url:') ? source.slice(4) : source;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!skill.startUrl) throw new Error(`no start URL to resolve "${raw}" against`);
    return new URL(raw, new URL(skill.startUrl).origin).toString();
  }

  /** Performs the step's action and checks expectedAfter. Rethrows only BrowserSessionGoneError. */
  async function performStep(ctx: ExecCtx, step: SkillStep): Promise<ActionOutcome> {
    const sid = ctx.sessionId!;
    // literal:/pref: inputs (pref: picks the radio/checkbox label, select option or typed text).
    const { target, value, error: inputError } = resolveStepInput(ctx.skill, step);
    if (inputError) return { ok: false, usedLocator: null, page: { url: ctx.lastUrl ?? '', title: '', text: '' }, error: inputError };
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
          outcome = await browser.type(sid, target, value ?? '');
          break;
        case 'select':
          outcome = await browser.select(sid, target, value ?? '');
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

  // ───────────── Workflow step bodies ─────────────

  /** Step "prepare": load the run + skill, mark it running, open the browser (catching up if resuming). */
  async function prepare(runId: string): Promise<FlowState> {
    const blank: FlowState = { runId, sessionId: null, lastUrl: null, recovered: false, status: 'continue', pendingStep: null };
    const existing = await repo.getRun(runId);
    if (!existing) throw new Error(`Run ${runId} not found`);
    if (TERMINAL_STATES.includes(existing.state) || isStopped(runId)) return halted(blank);
    const ctx = await loadCtx(blank);
    // 'resumed' = a run approved before it had a workflow snapshot (legacy run): continue it.
    if (ctx.run.state !== 'resumed') {
      ctx.run = await repo.updateRun(runId, { state: 'running' });
      await emit(runId, 'run.started', `Starting: ${ctx.skill.title}`, {});
    }
    if (!ctx.sessionId) {
      await openBrowser(ctx);
      const startIndex = startIndexOf(ctx);
      if (startIndex > 0) await catchUp(ctx, startIndex);
    }
    return flow(ctx, 'continue');
  }

  /**
   * Step "execute-steps": performs browser steps from `currentStep` until the end, or until an
   * irreversible step that has not been approved yet (→ status 'awaiting_approval').
   */
  async function executeSteps(state: FlowState, tracer?: StepTracer): Promise<FlowState> {
    if (state.status !== 'continue') return state;
    const runId = state.runId;
    if (isStopped(runId)) return halted(state);
    const ctx = await loadCtx(state);
    if (TERMINAL_STATES.includes(ctx.run.state)) return halted(state);
    const { steps } = ctx;

    for (let i = startIndexOf(ctx); i < steps.length; i++) {
      const step = steps[i];
      if (isStopped(runId)) return halted(flow(ctx, 'halted'));
      ctx.run = await repo.updateRun(runId, { currentStep: step.sequence });

      if (step.requiresApproval) {
        const latest = await repo.getLatestApproval(runId);
        const approved = latest && latest.stepSequence === step.sequence && latest.status === 'approved';
        if (!approved) return flow(ctx, 'awaiting_approval', step.sequence); // browser stays open
      }

      const urlBefore = ctx.lastUrl;
      await emit(runId, 'step.started', step.intent, { stepSequence: step.sequence, url: urlBefore, usedLocator: null });
      const stepStartedAt = Date.now();

      const span = tracer?.start(step, 'step');
      let outcome: ActionOutcome;
      try {
        outcome = await withRecovery(ctx, i, () => performStep(ctx, step), tracer);
      } catch (err) {
        span?.fail(err);
        throw err;
      }
      span?.end(outcome);
      if (isStopped(runId)) return halted(flow(ctx, 'halted'));
      if (outcome.page?.url) ctx.lastUrl = outcome.page.url;

      if (!outcome.ok && deps.healer && ctx.sessionId && !step.requiresApproval) {
        // Self-heal hook: re-learn the path on the live page; stops before the irreversible step.
        const healed = await deps.healer.heal({
          runId, sessionId: ctx.sessionId, skill: ctx.skill, steps, failedIndex: i, failure: outcome.error ?? 'the step did not work',
        });
        if (isStopped(runId)) return halted(flow(ctx, 'halted'));
        if (healed) {
          steps.splice(0, steps.length, ...healed.steps);
          ctx.skill.steps = [...healed.steps];
          i = healed.resumeIndex - 1;
          continue;
        }
      }
      if (!outcome.ok) {
        const reason = outcome.error ?? 'the step did not work';
        const message = `Couldn't ${lowerFirst(step.intent)}: ${reason}`;
        await emit(runId, 'step.failed', message, {
          stepSequence: step.sequence,
          url: ctx.lastUrl,
          usedLocator: outcome.usedLocator,
        });
        await failRun(ctx.run, message);
        return flow(ctx, 'halted');
      }

      if (outcome.usedLocator && outcome.usedLocator !== step.locatorHint) {
        await repo.updateStepLocator(step.id, outcome.usedLocator);
        step.locatorHint = outcome.usedLocator;
      }
      await paceStep(stepStartedAt);
      await emit(runId, 'step.succeeded', `${step.intent} — done`, {
        stepSequence: step.sequence,
        url: ctx.lastUrl,
        usedLocator: outcome.usedLocator,
      });
    }

    if (isStopped(runId)) return halted(flow(ctx, 'halted'));
    return flow(ctx, 'steps_done');
  }

  /**
   * Step "approval" (first pass): reads the page, creates the approval row, sets waiting_approval and
   * emits approval.requested. Returns null if a Stop raced in. The workflow then calls suspend().
   */
  async function requestApproval(state: FlowState): Promise<{ state: FlowState; request: ApprovalRequest | null }> {
    const ctx = await loadCtx(state);
    const index = ctx.steps.findIndex((s) => s.sequence === state.pendingStep);
    const step = ctx.steps[index];
    if (!step) throw new Error(`Approval step ${state.pendingStep} not found`);
    const page = await withRecovery(ctx, index, () => browser.readPage(ctx.sessionId!));
    ctx.lastUrl = page.url;
    const payload: Approval['payload'] = { ...extract(page), pageUrl: page.url };
    const title = step.config.approval?.title ?? `${step.intent}?`;
    const description = step.config.approval?.description ?? `The next step is irreversible: ${lowerFirst(step.intent)}.`;
    if (isStopped(ctx.run.id)) return { state: flow(ctx, 'halted'), request: null };
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
    return {
      state: flow(ctx, 'awaiting_approval', step.sequence),
      request: { approvalId: approval.id, stepSequence: step.sequence, title, payload },
    };
  }

  /** Step "verify": state verifying, screenshot proof, verifyPage → succeeded or failed. Closes the browser. */
  async function verifyAndFinish(state: FlowState): Promise<FlowState> {
    if (state.status !== 'steps_done') return state;
    const runId = state.runId;
    if (isStopped(runId)) return halted(state);
    const ctx = await loadCtx(state);
    if (TERMINAL_STATES.includes(ctx.run.state)) return halted(state);
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

    if (isStopped(runId)) return halted(flow(ctx, 'halted'));
    ctx.lastUrl = page.url;

    if (vr.passed) {
      await deps.healer?.commit(runId); // heal hook: verified → write the new skill version
      const summary = successSummary(ctx.skill, merchant);
      const result: RunResult = { success: true, summary, ...base };
      await emit(runId, 'verify.passed', `Verified: ${vr.matched.find((m) => !/^https?:/.test(m)) ?? vr.matched[0] ?? 'the website confirms it'}`, {
        url: page.url,
        evidence: vr.matched,
      });
      if (flag('ADDON_JUDGE')) void onRunVerified(runId); // add-on A3: AI judge (display only)
      await emit(runId, 'run.succeeded', summary, { url: page.url, valuePerYear: ctx.skill.valuePerYear });
      await repo.updateRun(runId, { state: 'succeeded', result, completedAt: iso(), error: null });
      await repo.recordSkillOutcome(ctx.skill.id, true);
      if (ctx.run.triggerId) await repo.setTriggerState(ctx.run.triggerId, 'done');
      await closeQuietly(ctx.sessionId);
      skills.delete(runId);
      return flow(ctx, 'verified');
    }
    const summary = `Couldn't confirm on the website that "${ctx.skill.title}" worked.`;
    const result: RunResult = { success: false, summary, ...base };
    const detail = vr.failedRules.map((r) => `${r.type.replace('_', ' ')} "${r.value}"`).join(', ');
    await emit(runId, 'verify.failed', `Verification failed${detail ? `: ${detail}` : ''}`, {
      url: page.url,
      failedRules: vr.failedRules,
    });
    if (flag('ADDON_JUDGE')) void onRunVerified(runId); // add-on A3: AI judge (display only)
    ctx.run = { ...ctx.run, browserSessionId: ctx.sessionId };
    await failRun(ctx.run, summary, result);
    return flow(ctx, 'halted');
  }

  return {
    repo,
    active,
    stopRequested,
    iso,
    emit,
    closeQuietly,
    handleUnexpected,
    isStopped,
    isAbort: (err: unknown) => err instanceof RunAbort,
    halted,
    prepare,
    executeSteps,
    requestApproval,
    verifyAndFinish,
    forget: (runId: string) => skills.delete(runId),
  };
}

// ═════════════════════════ RunEngine facade over the Mastra workflow ═════════════════════════

export interface MastraRunEngineOptions {
  core: RunCore;
  /** The registered `choreRun` workflow (must belong to a Mastra instance with storage). */
  workflow: () => ChoreRunWorkflow;
  /** Flushes buffered trace spans (observability), best effort. */
  flushTraces?: () => Promise<void>;
}

export function createMastraRunEngine({ core, workflow, flushTraces }: MastraRunEngineOptions): RunEngineWithIdle {
  const { repo, active, stopRequested } = core;
  const tasks = new Map<string, Promise<void>>();

  const tracing = (runId: string, extra: Record<string, unknown> = {}) => {
    const traceId = traceIdForRun(runId);
    return { ...(traceId ? { traceId } : {}), metadata: { runId, ...extra } };
  };

  function track(runId: string, task: Promise<void>) {
    const prev = tasks.get(runId) ?? Promise.resolve();
    const chained = Promise.all([prev, task]).then(() => undefined);
    tasks.set(runId, chained);
  }

  /** Runs workflow work in the background. Caller must already hold the `active` slot for runId. */
  function launch(runId: string, work: () => Promise<{ status: string; error?: unknown }>) {
    const task = (async () => {
      try {
        const result = await work();
        // Errors are normally turned into a failed run inside the step; this is the safety net.
        if (result.status === 'failed') await core.handleUnexpected(runId, result.error ?? new Error('workflow failed'));
      } catch (err) {
        await core.handleUnexpected(runId, err);
      } finally {
        // Safety net: if a stop raced with a browser reopen, close whatever session the run holds now.
        if (stopRequested.has(runId)) {
          const latest = await repo.getRun(runId).catch(() => null);
          await core.closeQuietly(latest?.browserSessionId);
        }
        active.delete(runId);
        stopRequested.delete(runId);
        await flushTraces?.().catch(() => undefined);
      }
    })().catch(() => {
      /* never let a rejection escape */
    });
    track(runId, task);
  }

  return {
    async startRun(input) {
      const run = await repo.createRun({ skillId: input.skillId, userId: input.userId, triggerId: input.triggerId ?? null });
      if (run.triggerId) await repo.setTriggerState(run.triggerId, 'running');
      if (!active.has(run.id)) {
        active.add(run.id);
        launch(run.id, async () => {
          const wfRun = await workflow().createRun({ runId: run.id, resourceId: run.userId });
          return wfRun.start({
            inputData: { runId: run.id },
            tracingOptions: tracing(run.id, { skillId: run.skillId, userId: run.userId }),
          });
        });
      }
      return { runId: run.id };
    },

    async approve(runId) {
      if (active.has(runId)) return; // already executing (double click / concurrent approve)
      active.add(runId);
      let userId: string;
      try {
        const run = await repo.getRun(runId);
        if (!run) throw new Error(`Run ${runId} not found`);
        if (run.state !== 'waiting_approval') throw new Error(`Run is not waiting for approval (state: ${run.state})`);
        const approval = await repo.getLatestApproval(runId);
        if (!approval || approval.status !== 'pending') throw new Error('There is no pending approval for this run');
        await repo.decideApproval(approval.id, 'approved');
        await core.emit(runId, 'approval.granted', `You approved: ${approval.title}`, {
          stepSequence: approval.stepSequence,
          approvalId: approval.id,
        });
        await repo.updateRun(runId, { state: 'resumed' });
        userId = run.userId;
      } catch (err) {
        active.delete(runId);
        throw err;
      }
      launch(runId, async () => {
        const wf = workflow();
        // Works in a fresh process: the suspended snapshot is loaded from storage by runId.
        const snapshot = await wf.getWorkflowRunById(runId);
        const wfRun = await wf.createRun({ runId, resourceId: userId });
        if (snapshot?.status === 'suspended') {
          return wfRun.resume({ resumeData: { approved: true }, tracingOptions: tracing(runId, { resumedBy: 'approve' }) });
        }
        // No suspended snapshot (run predates the workflow): start one; it continues from currentStep.
        return wfRun.start({ inputData: { runId }, tracingOptions: tracing(runId, { resumedBy: 'approve' }) });
      });
    },

    async stop(runId) {
      const run = await repo.getRun(runId);
      if (!run) throw new Error(`Run ${runId} not found`);
      if (TERMINAL_STATES.includes(run.state)) return;
      const inFlight = active.has(runId);
      if (inFlight) stopRequested.add(runId);
      const approval = await repo.getLatestApproval(runId);
      if (approval && approval.status === 'pending') {
        await repo.decideApproval(approval.id, 'denied');
        await core.emit(runId, 'approval.denied', `You declined: ${approval.title}`, {
          stepSequence: approval.stepSequence,
          approvalId: approval.id,
        });
      }
      await core.emit(runId, 'run.stopped', 'Stopped. Nothing else will happen.', { stepSequence: run.currentStep });
      await repo.updateRun(runId, { state: 'stopped', completedAt: core.iso() });
      if (run.triggerId) await repo.setTriggerState(run.triggerId, 'pending');
      core.forget(runId);
      // Close the paid browser in the background so the Stop button answers instantly.
      void core.closeQuietly(run.browserSessionId);
      if (inFlight) return; // the running steps see stopRequested and halt; launch() cleans up.

      // Not executing here: settle the Mastra run so its snapshot doesn't stay suspended forever.
      const settle = (async () => {
        try {
          const wf = workflow();
          const snapshot = await wf.getWorkflowRunById(runId);
          if (!snapshot) return;
          const wfRun = await wf.createRun({ runId, resourceId: run.userId });
          if (snapshot.status === 'suspended') {
            await wfRun.resume({ resumeData: { approved: false }, tracingOptions: tracing(runId, { resumedBy: 'stop' }) });
          } else if (snapshot.status === 'running' || snapshot.status === 'pending' || snapshot.status === 'waiting') {
            await wfRun.cancel();
          }
        } catch {
          /* the run is already stopped in our tables; the snapshot is only bookkeeping */
        } finally {
          await flushTraces?.().catch(() => undefined);
        }
      })();
      track(runId, settle);
    },

    whenIdle(runId) {
      return tasks.get(runId) ?? Promise.resolve();
    },
  };
}

/**
 * Self-contained engine (own Mastra instance) — used by tests and scripts. Pass a shared `storage`
 * to simulate a server restart (a second engine resumes snapshots the first one persisted).
 */
export function createRunEngine(
  deps: RunEngineDeps & { storage?: MastraCompositeStore; observability?: ObservabilityEntrypoint },
): RunEngineWithIdle {
  const core = createRunCore(deps);
  const choreRun = createChoreRunWorkflow(() => core);
  const mastra = new Mastra({
    storage: deps.storage ?? new InMemoryStore(),
    workflows: { choreRun },
    logger: false,
    ...(deps.observability ? { observability: deps.observability } : {}),
  });
  return createMastraRunEngine({
    core,
    workflow: () => mastra.getWorkflow('choreRun'),
    flushTraces: deps.observability ? () => mastra.observability.flush() : undefined,
  });
}

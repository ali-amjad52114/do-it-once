// Shared types for Do It Once. Single source of truth for every module.
// Only the session lead changes this file. See docs/CONTRACTS.md.

export const DEMO_USER_ID = '00000000-0000-0000-0000-000000000001';

// ───────────────────────── Skills ─────────────────────────

export type SkillStatus = 'active' | 'draft' | 'archived';

export type ActionType =
  | 'navigate' // go to a URL (inputSource or config.url)
  | 'click' // click the element described by targetDescription
  | 'type' // type inputSource into the described field
  | 'select' // choose an option in the described control
  | 'extract' // read text from the page into the run context
  | 'wait' // wait for expectedAfter to appear
  | 'screenshot';

/** One reusable step: intent + evidence, not a brittle selector. */
export interface SkillStep {
  id: string;
  skillId: string;
  sequence: number; // 1-based
  intent: string; // "Open billing settings"
  actionType: ActionType;
  targetDescription: string | null; // "Billing link in the account sidebar"
  /** Where typed/selected input comes from: "literal:<text>", "pref:<key>", "url:<path or absolute url>", or null. */
  inputSource: string | null;
  expectedBefore: string | null; // text that should be on the page before acting
  expectedAfter: string | null; // text that should be on the page after acting ("|" separates alternatives)
  locatorHint: string | null; // last Playwright selector that worked, e.g. 'role=link[name="Billing"]'
  requiresApproval: boolean; // irreversible: pause BEFORE executing this step
  config: StepConfig;
}

export interface StepConfig {
  /** Short visible text to match when the hint fails, e.g. "Billing". */
  matchText?: string;
  /** Shown on the approval card when requiresApproval is true. */
  approval?: { title: string; description: string };
  [key: string]: unknown;
}

export type VerificationRule =
  | { type: 'text_contains'; value: string }
  | { type: 'text_absent'; value: string }
  | { type: 'url_matches'; value: string }; // regex source

/** Run succeeds only if every `allOf` rule passes and at least one `anyOf` rule passes (if any given). */
export interface VerificationSpec {
  allOf?: VerificationRule[];
  anyOf?: VerificationRule[];
}

export interface Skill {
  id: string;
  userId: string;
  title: string;
  description: string;
  status: SkillStatus;
  version: number;
  icon: string; // short keyword for the UI, e.g. "subscription", "return", "haircut"
  targetDomains: string[];
  startUrl: string | null;
  verification: VerificationSpec;
  /** Yearly savings or value shown on success, e.g. 228. */
  valuePerYear: number | null;
  runCount: number;
  successCount: number;
  confidence: number; // 0..1
  lastSuccessAt: string | null; // ISO
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends Skill {
  steps: SkillStep[];
  triggers: string[];
  preferences: Record<string, unknown>;
}

// ───────────────────────── Runs ─────────────────────────

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'resumed'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'stopped';

export const TERMINAL_STATES: RunState[] = ['succeeded', 'failed', 'stopped'];

export interface SkillRun {
  id: string;
  skillId: string;
  userId: string;
  triggerId: string | null;
  state: RunState;
  currentStep: number; // sequence of the step being executed / next to execute (0 = not started)
  browserSessionId: string | null;
  liveViewUrl: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  result: RunResult | null;
}

export interface RunResult {
  success: boolean;
  summary: string; // "Lumen+ Premium canceled. Ends Nov 4."
  evidenceText: string[]; // matched evidence snippets
  finalUrl: string;
  screenshotArtifactId: string | null;
  verifiedAt: string;
  valuePerYear: number | null;
}

export type EventType =
  | 'run.started'
  | 'browser.opened'
  | 'step.started'
  | 'step.succeeded'
  | 'step.failed'
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'verify.started'
  | 'verify.passed'
  | 'verify.failed'
  | 'artifact.saved'
  | 'run.succeeded'
  | 'run.failed'
  | 'run.stopped'
  | 'log';

export interface ExecutionEvent {
  id: string;
  runId: string;
  sequence: number; // 1-based, unique per run
  type: EventType;
  message: string; // human readable: "Opened billing settings"
  metadata: Record<string, unknown>; // { stepSequence?, url?, artifactId?, ... }
  createdAt: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  id: string;
  runId: string;
  stepSequence: number;
  status: ApprovalStatus;
  title: string; // "Cancel $19/month membership?"
  description: string;
  payload: { price?: string; renewal?: string; merchant?: string; pageUrl?: string; [k: string]: unknown };
  createdAt: string;
  decidedAt: string | null;
}

export type ArtifactType = 'screenshot' | 'pdf' | 'label' | 'file';

export interface Artifact {
  id: string;
  runId: string;
  type: ArtifactType;
  mimeType: string;
  /** "neon:<id>" (bytes in artifacts.content_base64), "sprite:<path>", or an https URL. */
  location: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ───────────────────────── Triggers ─────────────────────────

export type TriggerState = 'pending' | 'running' | 'done' | 'dismissed';

export interface IncomingTrigger {
  id: string;
  userId: string;
  source: 'email' | 'manual' | 'seed';
  subject: string;
  payload: { merchant?: string; amount?: string; cadence?: string; dueLabel?: string; [k: string]: unknown };
  matchedSkillId: string | null;
  state: TriggerState;
  createdAt: string;
}

// ───────────────────────── Browser adapter (lib/kernel) ─────────────────────────

export interface PageState {
  url: string;
  title: string;
  text: string; // visible text, whitespace-collapsed, max ~8k chars
}

export interface BrowserSession {
  id: string; // Kernel session_id
  liveViewUrl: string | null;
}

export interface ElementTarget {
  description: string; // targetDescription
  matchText?: string | null; // StepConfig.matchText
  locatorHint?: string | null; // try first
}

export interface ActionOutcome {
  ok: boolean;
  usedLocator: string | null; // the selector that worked; persisted as the new locatorHint
  page: PageState;
  error?: string;
}

/** Stateless by session id so a run can reconnect after a server restart. */
export interface BrowserAdapter {
  open(opts?: { startUrl?: string; profileName?: string }): Promise<BrowserSession>;
  goto(sessionId: string, url: string): Promise<ActionOutcome>;
  click(sessionId: string, target: ElementTarget): Promise<ActionOutcome>;
  type(sessionId: string, target: ElementTarget, text: string): Promise<ActionOutcome>;
  select(sessionId: string, target: ElementTarget, option: string): Promise<ActionOutcome>;
  waitForText(sessionId: string, text: string, timeoutMs?: number): Promise<ActionOutcome>;
  readPage(sessionId: string): Promise<PageState>;
  screenshot(sessionId: string): Promise<Buffer>; // PNG
  close(sessionId: string): Promise<void>;
}

// ───────────────────────── Verification (lib/engine/verify.ts) ─────────────────────────

export interface VerificationResult {
  passed: boolean;
  matched: string[]; // evidence snippets that satisfied rules
  failedRules: VerificationRule[];
}

// ───────────────────────── Run engine (lib/engine) ─────────────────────────

export interface RunEngine {
  /** Creates the run row and executes it in the background. Returns immediately. */
  startRun(input: { skillId: string; userId: string; triggerId?: string | null }): Promise<{ runId: string }>;
  /** Approves the pending approval and continues the run in the background. */
  approve(runId: string): Promise<void>;
  /** Denies any pending approval and stops the run. */
  stop(runId: string): Promise<void>;
}

// ───────────────────────── API payloads (app/api) ─────────────────────────

export interface TodayItem {
  triggerId: string;
  title: string; // "Membership renewal"
  merchant: string | null;
  amount: string | null; // "$19/month"
  dueLabel: string | null; // "Renews tomorrow"
  matchedSkill: { id: string; title: string } | null;
  state: TriggerState;
  latestRunId: string | null;
}

export interface SkillSummary extends Skill {
  successRate: number; // 0..1
}

export interface RunView {
  run: SkillRun;
  skill: SkillDetail;
  approval: Approval | null; // pending or most recent
  events: ExecutionEvent[];
}

/** SSE frames sent by GET /api/runs/:id/events */
export type RunStreamFrame =
  | { kind: 'event'; event: ExecutionEvent }
  | { kind: 'state'; state: RunState; currentStep: number; liveViewUrl: string | null }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'done'; run: SkillRun };

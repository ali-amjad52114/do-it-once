// Add-on types (A1 Guide, A2 MCP, A3 Judge, A4 Discovery). Additive only: lib/contracts.ts is untouched.
// Only the lead changes this file.

// ── A3 AI judge
export type JudgeVerdict = 'pass' | 'fail' | 'unsure';

export interface Judgment {
  verdict: JudgeVerdict;
  confidence: number; // 0..1
  reasons: string[];
  quotedEvidence: string[]; // short quotes from the page/screenshot that support the verdict
}

export interface JudgeInput {
  intent: string; // what the chore should have achieved, e.g. "Cancel the Lumen+ membership"
  verification: import('./contracts').VerificationSpec;
  finalUrl: string;
  pageText: string;
  screenshotPng: Buffer | null;
}

/** Display-only combination of the rule check and the judge. runs.state is never changed. */
export type CombinedVerdict = 'succeeded' | 'succeeded_judge_unsure' | 'needs_review' | 'failed' | 'judging';

export interface JudgmentView {
  runId: string;
  judgment: (Judgment & { model: string; latencyMs: number; createdAt: string }) | null;
  combined: CombinedVerdict;
}

// ── A4 Discovery race
export type DiscoveryState = 'running' | 'judging' | 'done' | 'failed' | 'needs_login';

export interface DiscoveryAttemptView {
  id: string;
  lane: number; // 1..3
  strategy: string; // "menus" | "site search" | "help pages"
  state: 'running' | 'stopped_at_irreversible' | 'goal_reached' | 'gave_up' | 'failed' | 'needs_login';
  liveViewUrl: string | null;
  steps: number;
  judgment: Judgment | null;
  recordingId: string | null;
}

export interface DiscoveryView {
  id: string;
  goal: string;
  startUrl: string;
  state: DiscoveryState;
  winnerAttemptId: string | null;
  draftSkillId: string | null;
  attempts: DiscoveryAttemptView[];
  createdAt: string;
  /** Login handoff: set while (or after) the user signs in. The agent never sees the password. */
  login?: DiscoveryLogin | null;
}

export interface DiscoveryLogin {
  state: 'pending' | 'signed_in';
  profile: string; // Kernel profile, one per site host: site-<host>
  url: string; // the page that asked for sign-in
  liveViewUrl: string | null; // INTERACTIVE live view of the login browser (no readOnly)
  sessionId: string | null;
}

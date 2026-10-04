// Winner selection for the discovery race. Pure, so it is unit-tested (winner.test.ts).
import type { DiscoveryAttemptView, Judgment } from '@/lib/contracts.addons';

export interface Candidate {
  id: string;
  state: DiscoveryAttemptView['state'];
  steps: number;
  judgment: Judgment | null;
  actionCount: number;
}

const JUDGE_RANK: Record<string, number> = { pass: 0, unsure: 1, fail: 2 };

/**
 * Eligible: reached the goal or stopped at the irreversible control, with at least one recorded action.
 * Order: judge pass > unsure/missing > fail, then fewest steps, then stopped_at_irreversible first
 * (it carries the approval step a skill needs).
 */
export function pickWinner<T extends Candidate>(attempts: T[]): T | null {
  const ok = attempts.filter((a) => (a.state === 'goal_reached' || a.state === 'stopped_at_irreversible') && a.actionCount > 0);
  ok.sort((a, b) => {
    const ja = JUDGE_RANK[a.judgment?.verdict ?? 'unsure'] ?? 1;
    const jb = JUDGE_RANK[b.judgment?.verdict ?? 'unsure'] ?? 1;
    if (ja !== jb) return ja - jb;
    if (a.steps !== b.steps) return a.steps - b.steps;
    const sa = a.state === 'stopped_at_irreversible' ? 0 : 1;
    const sb = b.state === 'stopped_at_irreversible' ? 0 : 1;
    return sa - sb;
  });
  return ok[0] ?? null;
}

/** Lanes to start: 3 by default, 2 when the Kernel account already has more than 2 live browsers (limit 5). */
export function laneCount(liveBrowsers: number, requested = 3): number {
  return Math.max(1, Math.min(requested, liveBrowsers > 2 ? 2 : 3));
}

import { describe, expect, it } from 'vitest';
import type { Judgment } from '@/lib/contracts.addons';
import { laneCount, pickWinner, type Candidate } from './winner';

const j = (verdict: Judgment['verdict']): Judgment => ({ verdict, confidence: 0.8, reasons: [], quotedEvidence: [] });
const c = (id: string, state: Candidate['state'], steps: number, judgment: Judgment | null = null, actionCount = steps): Candidate => ({
  id,
  state,
  steps,
  judgment,
  actionCount,
});

describe('pickWinner', () => {
  it('ignores attempts that gave up or failed', () => {
    expect(pickWinner([c('a', 'gave_up', 3), c('b', 'failed', 2)])).toBeNull();
  });

  it('prefers a judge pass over fewer steps', () => {
    const w = pickWinner([c('a', 'stopped_at_irreversible', 4, j('unsure')), c('b', 'stopped_at_irreversible', 7, j('pass'))]);
    expect(w?.id).toBe('b');
  });

  it('with an unsure judge (stub), picks the fewest steps', () => {
    const w = pickWinner([
      c('a', 'stopped_at_irreversible', 9, j('unsure')),
      c('b', 'goal_reached', 6, j('unsure')),
      c('c', 'gave_up', 2, j('unsure')),
    ]);
    expect(w?.id).toBe('b');
  });

  it('ranks a judge fail last but keeps it eligible', () => {
    expect(pickWinner([c('a', 'stopped_at_irreversible', 3, j('fail')), c('b', 'stopped_at_irreversible', 8, null)])?.id).toBe('b');
    expect(pickWinner([c('a', 'stopped_at_irreversible', 3, j('fail'))])?.id).toBe('a');
  });

  it('breaks a step tie in favour of stopped_at_irreversible', () => {
    expect(pickWinner([c('a', 'goal_reached', 5), c('b', 'stopped_at_irreversible', 5)])?.id).toBe('b');
  });

  it('skips attempts without recorded actions', () => {
    expect(pickWinner([c('a', 'goal_reached', 0, j('pass'), 0)])).toBeNull();
  });
});

describe('laneCount', () => {
  it('uses 3 lanes unless more than 2 browsers are live', () => {
    expect(laneCount(0)).toBe(3);
    expect(laneCount(2)).toBe(3);
    expect(laneCount(3)).toBe(2);
  });
});

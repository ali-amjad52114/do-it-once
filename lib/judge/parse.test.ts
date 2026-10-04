import { describe, expect, it } from 'vitest';
import { combineVerdict, parseJudgment } from './parse';

describe('combineVerdict', () => {
  it('combines rules and judge', () => {
    expect(combineVerdict('succeeded', { verdict: 'pass' })).toBe('succeeded');
    expect(combineVerdict('succeeded', { verdict: 'unsure' })).toBe('succeeded_judge_unsure');
    expect(combineVerdict('succeeded', { verdict: 'fail' })).toBe('needs_review');
    expect(combineVerdict('failed', { verdict: 'pass' })).toBe('failed');
    expect(combineVerdict('failed', null)).toBe('failed');
    expect(combineVerdict('succeeded', null)).toBe('judging');
    expect(combineVerdict('verifying', null)).toBe('judging');
  });
});

describe('parseJudgment', () => {
  it('parses plain and fenced JSON', () => {
    const a = parseJudgment('{"verdict":"pass","confidence":0.94,"reasons":["Shows canceled"],"quotedEvidence":["Membership canceled"]}');
    expect(a).toEqual({ ok: true, judgment: { verdict: 'pass', confidence: 0.94, reasons: ['Shows canceled'], quotedEvidence: ['Membership canceled'] } });
    const b = parseJudgment('```json\n{"verdict":"fail","confidence":87,"reasons":["Still active"]}\n```');
    expect(b.ok && b.judgment).toMatchObject({ verdict: 'fail', confidence: 0.87, quotedEvidence: [] });
    const c = parseJudgment('Sure! {"verdict":"unsure","confidence":"0.5","reasons":[]} hope that helps');
    expect(c.ok && c.judgment.verdict).toBe('unsure');
  });

  it('rejects invalid answers', () => {
    expect(parseJudgment('no json here').ok).toBe(false);
    expect(parseJudgment('{"verdict":"maybe","confidence":0.5}').ok).toBe(false);
    expect(parseJudgment('{"verdict":"pass","confidence":250}').ok).toBe(false);
  });
});

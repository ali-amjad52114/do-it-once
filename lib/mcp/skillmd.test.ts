import { describe, expect, it } from 'vitest';
import type { SkillDetail } from '@/lib/contracts';
import { tokenEquals } from './auth';
import { kebab, skillToMarkdown } from './skillmd';

const skill = {
  id: 's1',
  userId: 'u',
  title: 'Cancel Lumen+ membership',
  description: 'Cancel the Lumen+ streaming membership',
  status: 'active',
  version: 2,
  icon: 'subscription',
  targetDomains: ['lumen.example'],
  startUrl: 'https://lumen.example/account',
  verification: { allOf: [{ type: 'text_contains', value: 'canceled' }] },
  valuePerYear: 228,
  runCount: 1,
  successCount: 1,
  confidence: 0.9,
  lastSuccessAt: null,
  createdAt: '',
  updatedAt: '',
  triggers: ['stop paying for Lumen+', 'cancel my subscription'],
  preferences: { reason: 'Too expensive' },
  steps: [
    { id: 'a', skillId: 's1', sequence: 2, intent: 'Confirm cancellation', actionType: 'click', targetDescription: null, inputSource: null, expectedBefore: null, expectedAfter: 'canceled', locatorHint: null, requiresApproval: true, config: { approval: { title: 'Cancel $19/month?', description: '' } } },
    { id: 'b', skillId: 's1', sequence: 1, intent: 'Open billing', actionType: 'click', targetDescription: 'Billing link', inputSource: null, expectedBefore: null, expectedAfter: null, locatorHint: null, requiresApproval: false, config: {} },
  ],
} as unknown as SkillDetail;

describe('skillToMarkdown', () => {
  it('kebab-cases names', () => {
    expect(kebab('Cancel Lumen+ membership')).toBe('cancel-lumen-plus-membership');
    expect(kebab('!!!')).toBe('do-it-once-skill');
  });

  it('renders frontmatter, ordered checklist, approval and MCP guidance', () => {
    const md = skillToMarkdown(skill);
    expect(md.startsWith('---\nname: cancel-lumen-plus-membership\ndescription: "')).toBe(true);
    expect(md).toContain('\\"stop paying for Lumen+\\"');
    expect(md.indexOf('1. Open billing')).toBeLessThan(md.indexOf('2. Confirm cancellation'));
    expect(md).toContain('IRREVERSIBLE');
    expect(md).toContain('Always ask the user before the irreversible step');
    expect(md).toContain('`search_skills`');
    expect(md).toContain('`start_run`');
    expect(md).toContain('- [ ] The page shows "canceled"');
  });
});

describe('tokenEquals', () => {
  it('compares safely', () => {
    expect(tokenEquals('abc', 'abc')).toBe(true);
    expect(tokenEquals('abc', 'abd')).toBe(false);
    expect(tokenEquals('', 'abc')).toBe(false);
  });
});

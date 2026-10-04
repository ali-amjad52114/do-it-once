import { describe, expect, it } from 'vitest';
import {
  collapseText,
  keywordsFromDescription,
  roleLocator,
  roleRegexLocator,
  splitAlternatives,
  textContainsAny,
  textLocator,
} from './selectors';

describe('usedLocator strings', () => {
  it('builds role selectors in the seeded-skill format', () => {
    expect(roleLocator('link', 'Billing')).toBe('role=link[name="Billing"]');
    expect(roleLocator('button', 'Confirm cancellation')).toBe('role=button[name="Confirm cancellation"]');
  });

  it('escapes quotes in names', () => {
    expect(roleLocator('button', 'Say "hi"')).toBe('role=button[name="Say \\"hi\\""]');
  });

  it('builds regex role selectors with escaped keywords', () => {
    expect(roleRegexLocator('link', 'Billing')).toBe('role=link[name=/Billing/i]');
    expect(roleRegexLocator('button', 'Lumen+')).toBe('role=button[name=/Lumen\\+/i]');
  });

  it('builds exact and loose text selectors', () => {
    expect(textLocator('More information...', true)).toBe('text="More information..."');
    expect(textLocator('  Learn   more ')).toBe('text=Learn more');
  });
});

describe('keywordsFromDescription', () => {
  it('drops UI noise words', () => {
    expect(keywordsFromDescription('Billing link in the account sidebar')).toEqual(['Billing', 'account']);
  });

  it('puts the leading phrase first', () => {
    expect(keywordsFromDescription('Manage membership button')).toEqual(['Manage membership', 'membership', 'Manage']);
  });

  it('prefers quoted phrases', () => {
    expect(keywordsFromDescription('the "No thanks, continue to cancel" button')[0]).toBe('No thanks, continue to cancel');
  });

  it('handles empty input', () => {
    expect(keywordsFromDescription('')).toEqual([]);
    expect(keywordsFromDescription(null)).toEqual([]);
    expect(keywordsFromDescription('the button')).toEqual([]);
  });

  it('dedupes case-insensitively', () => {
    expect(keywordsFromDescription('Cancel cancel CANCEL link')).toEqual(['Cancel cancel CANCEL', 'Cancel']);
  });
});

describe('page text helpers', () => {
  it('collapses whitespace and caps length', () => {
    expect(collapseText('  a \n\n b\tc ')).toBe('a b c');
    expect(collapseText('x'.repeat(9000))).toHaveLength(8000);
  });

  it('matches "|" alternatives case-insensitively', () => {
    expect(splitAlternatives('Membership canceled| Renews: No |')).toEqual(['Membership canceled', 'Renews: No']);
    expect(textContainsAny('Plan: RENEWS: NO  today', 'Membership canceled|Renews: No')).toBe('Renews: No');
    expect(textContainsAny('Welcome back, Ali', 'Before you go')).toBeNull();
  });
});

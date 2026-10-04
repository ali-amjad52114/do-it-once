import { describe, expect, it } from 'vitest';
import type { PageState, VerificationSpec } from '@/lib/contracts';
import { EMPTY_SPEC_RULE, verifyPage } from './verify';

const BASE = 'https://demo.example.com';

// The seeded "Cancel subscription" skill's verification (docs/CONTRACTS.md).
const SEEDED: VerificationSpec = {
  anyOf: [
    { type: 'text_contains', value: 'Membership canceled' },
    { type: 'text_contains', value: 'Renews: No' },
  ],
  allOf: [{ type: 'url_matches', value: '/account/membership' }],
};

const canceledPage: PageState = {
  url: `${BASE}/account/membership?canceled=1`,
  title: 'Membership · Lumen+',
  text: `Lumen+   Home  Account
    Overview Profile Billing Devices
    Membership   canceled
    Lumen+ Premium · $19/month
    Renews: No
    Access ends on Nov 5, 2026. You can rejoin any time.`,
};

const activePage: PageState = {
  url: `${BASE}/account/membership`,
  title: 'Membership · Lumen+',
  text: 'Lumen+ Account Overview Profile Billing Devices Lumen+ Premium $19/month Next renewal: Nov 5, 2026 Change plan Cancel membership',
};

const retentionAfterAcceptOffer: PageState = {
  url: `${BASE}/account/membership/cancel`,
  title: 'Before you go · Lumen+',
  text:
    'Before you go… Get 50% off for 3 months. Accept offer No thanks, continue to cancel ' +
    'Offer accepted! Your membership stays active at $9.50/month for 3 months. Renews tomorrow (Nov 5, 2026).',
};

describe('verifyPage', () => {
  it('passes on the canceled membership page and returns evidence', () => {
    const r = verifyPage(SEEDED, canceledPage);
    expect(r.passed).toBe(true);
    expect(r.failedRules).toEqual([]);
    expect(r.matched).toContain(canceledPage.url);
    expect(r.matched.some((m) => m.includes('Membership canceled'))).toBe(true);
    expect(r.matched.some((m) => m.includes('Renews: No'))).toBe(true);
  });

  it('is case-insensitive and whitespace-normalized', () => {
    const r = verifyPage(
      { allOf: [{ type: 'text_contains', value: 'MEMBERSHIP\n  CANCELED' }] },
      { ...canceledPage, text: 'membership  canceled' },
    );
    expect(r.passed).toBe(true);
    expect(r.matched).toEqual(['membership canceled']);
  });

  it('keeps evidence snippets short (~60 chars of context)', () => {
    const long = { ...canceledPage, text: `${'lorem ipsum '.repeat(40)}Membership canceled${' dolor sit'.repeat(40)}` };
    const r = verifyPage({ allOf: [{ type: 'text_contains', value: 'Membership canceled' }] }, long);
    expect(r.passed).toBe(true);
    expect(r.matched[0]).toContain('Membership canceled');
    expect(r.matched[0].length).toBeLessThanOrEqual(64);
    expect(r.matched[0].startsWith('…')).toBe(true);
    expect(r.matched[0].endsWith('…')).toBe(true);
  });

  it('fails on a still-active membership page', () => {
    const r = verifyPage(SEEDED, activePage);
    expect(r.passed).toBe(false);
    expect(r.failedRules).toEqual(SEEDED.anyOf);
    expect(r.matched.some((m) => /membership canceled/i.test(m))).toBe(false);
  });

  it('fails when the URL is wrong even if the text matches', () => {
    const r = verifyPage(SEEDED, { ...canceledPage, url: `${BASE}/account/billing` });
    expect(r.passed).toBe(false);
    expect(r.failedRules).toEqual([{ type: 'url_matches', value: '/account/membership' }]);
  });

  it('does not count an "Accept offer" retention page as canceled', () => {
    const r = verifyPage(SEEDED, retentionAfterAcceptOffer);
    expect(r.passed).toBe(false);
    expect(r.failedRules).toEqual(SEEDED.anyOf);
  });

  it('does not count the confirm page (before approval) as canceled', () => {
    const r = verifyPage(SEEDED, {
      url: `${BASE}/account/membership/cancel/confirm`,
      title: 'Confirm cancellation · Lumen+',
      text: "Confirm cancellation Lumen+ Premium $19/month You'll keep access until Nov 5, 2026. Confirm cancellation",
    });
    expect(r.passed).toBe(false);
  });

  it('fails an empty spec — no verification means not verified', () => {
    for (const spec of [{}, { allOf: [], anyOf: [] }] as VerificationSpec[]) {
      const r = verifyPage(spec, canceledPage);
      expect(r.passed).toBe(false);
      expect(r.matched).toEqual([]);
      expect(r.failedRules).toEqual([EMPTY_SPEC_RULE]);
    }
  });

  it('text_absent passes only when the text is missing', () => {
    const spec: VerificationSpec = { allOf: [{ type: 'text_absent', value: 'next RENEWAL' }] };
    expect(verifyPage(spec, canceledPage).passed).toBe(true);
    expect(verifyPage(spec, activePage).passed).toBe(false);
    expect(verifyPage({ allOf: [{ type: 'text_absent', value: '  ' }] }, canceledPage).passed).toBe(false);
  });

  it('requires every allOf rule', () => {
    const spec: VerificationSpec = {
      allOf: [
        { type: 'text_contains', value: 'Membership canceled' },
        { type: 'text_absent', value: 'Cancel membership' },
      ],
    };
    expect(verifyPage(spec, canceledPage).passed).toBe(true);
    const r = verifyPage(spec, { ...canceledPage, text: `${canceledPage.text} Cancel membership` });
    expect(r.passed).toBe(false);
    expect(r.failedRules).toEqual([{ type: 'text_absent', value: 'Cancel membership' }]);
  });

  it('treats url_matches as a regex, falling back to substring when invalid', () => {
    const strict: VerificationSpec = { allOf: [{ type: 'url_matches', value: '/account/membership(\\?|$)' }] };
    expect(verifyPage(strict, canceledPage).passed).toBe(true);
    expect(verifyPage(strict, retentionAfterAcceptOffer).passed).toBe(false);
    const invalid: VerificationSpec = { allOf: [{ type: 'url_matches', value: 'canceled=1(' }] };
    expect(verifyPage(invalid, { ...canceledPage, url: `${BASE}/account/membership?canceled=1(` }).passed).toBe(true);
    expect(verifyPage(invalid, canceledPage).passed).toBe(false);
  });

  it('empty rule values fail closed', () => {
    expect(verifyPage({ allOf: [{ type: 'text_contains', value: '' }] }, canceledPage).passed).toBe(false);
    expect(verifyPage({ allOf: [{ type: 'url_matches', value: '' }] }, canceledPage).passed).toBe(false);
  });
});

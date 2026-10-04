import { describe, expect, it } from 'vitest';
import type { PageState } from '@/lib/contracts';
import { extractApprovalPayload } from './extract';

const BASE = 'https://demo.example.com';

// The Lumen+ confirm page shown at the approval step (docs/CONTRACTS.md).
const confirmPage: PageState = {
  url: `${BASE}/account/membership/cancel/confirm`,
  title: 'Confirm cancellation · Lumen+',
  text:
    'Lumen+ Home Account Confirm cancellation You are about to cancel Lumen+ Premium. ' +
    "$19/month You'll keep access until Nov 5, 2026. After that you won't be charged. " +
    'Confirm cancellation Keep my membership',
};

const page = (text: string, title = ''): PageState => ({ url: '', title, text });

describe('extractApprovalPayload', () => {
  it('extracts price, renewal, merchant and URL from the Lumen+ confirm page', () => {
    expect(extractApprovalPayload(confirmPage)).toEqual({
      price: '$19/month',
      renewal: 'Nov 5, 2026',
      merchant: 'Lumen+',
      pageUrl: confirmPage.url,
    });
  });

  it('normalizes price formats', () => {
    const p = (text: string) => extractApprovalPayload(page(text)).price;
    expect(p('Only $19 / mo')).toBe('$19/month');
    expect(p('$19.00/month')).toBe('$19/month');
    expect(p('$9.5 per month')).toBe('$9.50/month');
    expect(p('$228/yr billed annually')).toBe('$228/year');
    expect(p('$1,200 a year')).toBe('$1,200/year');
    expect(p('Total $19 today')).toBe('$19'); // one-time amounts are shown too (e.g. a $129.00 refund)
  });

  it('picks the first price on the page', () => {
    expect(extractApprovalPayload(page('Now $19/month, was $29/month')).price).toBe('$19/month');
  });

  it('only takes a date that sits near a renewal word', () => {
    const r = (text: string) => extractApprovalPayload(page(text)).renewal;
    expect(r('Invoice Oct 5, 2026 paid. Renews tomorrow (November 5th, 2026)')).toBe('Nov 5, 2026');
    expect(r('Next renewal: Nov 5, 2026')).toBe('Nov 5, 2026');
    expect(r('Access ends on 2026-11-05')).toBe('Nov 5, 2026');
    expect(r('Invoice Oct 5, 2026 paid $19.00')).toBeUndefined();
  });

  it('derives the merchant from different title shapes', () => {
    const m = (title: string, text = '') => extractApprovalPayload(page(text, title)).merchant;
    expect(m('Lumen+ — Account')).toBe('Lumen+');
    expect(m('Manage your membership | Lumen+')).toBe('Lumen+');
    expect(m('Lumen+ Premium')).toBe('Lumen+');
    expect(m('Netflix')).toBe('Netflix');
    expect(m('Billing', 'Welcome to Lumen+ Premium')).toBe('Lumen+');
  });

  it('omits keys that are not found', () => {
    expect(extractApprovalPayload(page('nothing to see here'))).toEqual({});
    expect(extractApprovalPayload({ url: `${BASE}/x`, title: 'Account settings', text: 'Hello' })).toEqual({
      pageUrl: `${BASE}/x`,
    });
  });
});

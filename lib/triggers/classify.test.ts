import { beforeEach, describe, expect, it, vi } from 'vitest';

// The LLM call is mocked. A plain function (not vi.fn) so a rejected call does not fail the test
// through spy result tracking; calls are recorded by hand.
const gw = vi.hoisted(() => ({
  calls: [] as { system: string; user: string; schema: unknown }[],
  impl: (async () => ({})) as (opts: { system: string; user: string; schema: unknown }) => Promise<unknown>,
}));
vi.mock('@/lib/ai/gateway', () => ({
  MODELS: { fast: 'test-fast', smart: 'test-smart', embed: 'test-embed' },
  chatJSON: (opts: { system: string; user: string; schema: unknown }) => {
    gw.calls.push(opts);
    return gw.impl(opts);
  },
}));
import {
  classifyEmail,
  classifyEmailDetailed,
  EmailClassificationSchema,
  extractAmount,
  extractMerchant,
  fallbackClassification,
  prePass,
} from './classify';

const RECEIVED = '2026-10-04T15:00:00.000Z';

const fixtures = {
  lumen: {
    subject: 'Your Lumen+ Premium membership renews tomorrow',
    from: 'Lumen+ Billing <lumen-billing-demo@agentmail.to>',
    receivedAt: RECEIVED,
    text: [
      'Hi Ali,',
      'Your Lumen+ Premium membership renews tomorrow, October 5, 2026.',
      'Plan: Lumen+ Premium',
      'Price: $19/month',
      'Next charge: $19.00 on October 5, 2026 to the Visa on file',
      'Manage your membership here: https://demo.example/account/membership',
    ].join('\n'),
  },
  annualAbsoluteDate: {
    subject: 'Reminder: your Cloudbox plan will renew',
    from: 'billing@cloudbox.example',
    receivedAt: RECEIVED,
    text: 'Your Cloudbox Pro subscription will automatically renew on Oct 20, 2026 for USD 228 per year.',
  },
  newsletter: {
    subject: 'This week in gardening',
    from: 'Green Thumb <news@greenthumb.example>',
    receivedAt: RECEIVED,
    text: 'Ten tips for autumn bulbs. Read more on our blog.',
  },
};

const validLlm = {
  actionable: true,
  kind: 'renewal',
  title: 'Membership renewal',
  merchant: 'Lumen+',
  amount: '$19 per month',
  cadence: 'monthly',
  dueLabel: 'Tomorrow',
  skillQuery: 'cancel this subscription',
  confidence: 0.93,
};

describe('EmailClassificationSchema', () => {
  it('accepts a valid classification', () => {
    expect(EmailClassificationSchema.safeParse(validLlm).success).toBe(true);
  });
  it('accepts nulls for optional facts', () => {
    const r = EmailClassificationSchema.safeParse({ ...validLlm, merchant: null, amount: null, cadence: null, dueLabel: null });
    expect(r.success).toBe(true);
  });
  it('rejects unknown kinds, out-of-range confidence and missing fields', () => {
    expect(EmailClassificationSchema.safeParse({ ...validLlm, kind: 'spam' }).success).toBe(false);
    expect(EmailClassificationSchema.safeParse({ ...validLlm, confidence: 1.5 }).success).toBe(false);
    const { skillQuery: _omit, ...missing } = validLlm;
    expect(EmailClassificationSchema.safeParse(missing).success).toBe(false);
  });
});

describe('regex pre-pass', () => {
  it('extracts amount, cadence, relative due date and merchant from the Lumen+ email', () => {
    expect(prePass(fixtures.lumen)).toEqual({
      amount: '$19/month',
      cadence: 'monthly',
      dueDate: '2026-10-05',
      dueLabel: 'Renews tomorrow',
      merchant: 'Lumen+',
      kind: 'renewal',
    });
  });
  it('handles "USD 228 per year" and an absolute date', () => {
    const p = prePass(fixtures.annualAbsoluteDate);
    expect(p.amount).toBe('$228/year');
    expect(p.cadence).toBe('yearly');
    expect(p.dueDate).toBe('2026-10-20');
    expect(p.dueLabel).toBe('Renews Oct 20');
    expect(p.kind).toBe('renewal');
  });
  it('labels near dates in days and today', () => {
    expect(prePass({ subject: 'Renewal', text: 'Your plan renews on Oct 7 ($5/mo).', receivedAt: RECEIVED }).dueLabel).toBe('Renews in 3 days');
    expect(prePass({ subject: 'Renewal', text: 'Your plan renews today.', receivedAt: RECEIVED }).dueLabel).toBe('Renews today');
  });
  it('amount variants', () => {
    expect(extractAmount('$9.99 a month')).toEqual({ amount: '$9.99/month', cadence: 'monthly' });
    expect(extractAmount('billed $120 annually')).toEqual({ amount: '$120/year', cadence: 'yearly' });
    expect(extractAmount('total $1,250.00')).toEqual({ amount: '$1250', cadence: null });
    expect(extractAmount('no money here')).toEqual({ amount: null, cadence: null });
  });
  it('merchant from subject or sender display name', () => {
    expect(extractMerchant('Your Lumen+ Premium membership renews tomorrow')).toBe('Lumen+');
    expect(extractMerchant('Payment reminder', 'Acme Streaming Billing <b@acme.example>')).toBe('Acme Streaming');
    expect(extractMerchant('Hello', 'x@y.example')).toBeNull();
  });
  it('newsletter has no facts and is not a renewal', () => {
    const p = prePass(fixtures.newsletter);
    expect(p).toMatchObject({ amount: null, dueLabel: null, kind: 'other' });
    expect(fallbackClassification(fixtures.newsletter).actionable).toBe(false);
  });
});

describe('classifyEmail (gateway mocked)', () => {
  beforeEach(() => {
    gw.calls.length = 0;
  });

  it('uses the gateway result, normalizing amount and dueLabel from the pre-pass', async () => {
    gw.impl = async () => validLlm;
    const r = await classifyEmailDetailed(fixtures.lumen);
    expect(r.by).toBe('gateway');
    expect(r.classification).toEqual({ ...validLlm, amount: '$19/month', dueLabel: 'Renews tomorrow' });
    const call = gw.calls[0];
    expect(call.schema).toBe(EmailClassificationSchema);
    expect(call.user).toContain('"amount":"$19/month"');
    expect(call.user).toContain('Subject: Your Lumen+ Premium membership renews tomorrow');
  });

  it('fills nulls from the pre-pass', async () => {
    gw.impl = async () => ({ ...validLlm, merchant: null, cadence: null, dueLabel: null });
    const c = await classifyEmail(fixtures.lumen);
    expect(c.merchant).toBe('Lumen+');
    expect(c.cadence).toBe('monthly');
  });

  it('falls back to the regex classification when the gateway errors', async () => {
    gw.impl = async () => {
      throw new Error('Neon AI Gateway /v1/chat/completions 503');
    };
    const r = await classifyEmailDetailed(fixtures.lumen);
    expect(r.by).toBe('regex');
    expect(r.error).toContain('503');
    expect(r.classification).toEqual({
      actionable: true,
      kind: 'renewal',
      title: 'Membership renewal',
      merchant: 'Lumen+',
      amount: '$19/month',
      cadence: 'monthly',
      dueLabel: 'Renews tomorrow',
      skillQuery: 'cancel this subscription',
      confidence: 0.6,
    });
    expect(EmailClassificationSchema.safeParse(r.classification).success).toBe(true);
  });
});

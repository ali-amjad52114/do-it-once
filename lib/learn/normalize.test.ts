import { describe, expect, it } from 'vitest';
import { verifyPage } from '@/lib/engine/verify';
import type { Recording } from '@/lib/contracts';
import { cleanActions, normalizeRecording, type LlmOutput } from './normalize';
import { sampleCancelRecording } from './sample';

const BASE = 'https://demo.example.com';

// Scripted LLM: deliberately sloppy (no approval, one bogus "[redacted]" preference) to prove code enforces rules.
const scripted = (over: Partial<LlmOutput> = {}) => async (): Promise<LlmOutput> => ({
  title: 'Cancel subscription',
  description: 'Cancel my Lumen+ membership.',
  icon: 'subscription',
  triggers: ['Cancel my membership', 'stop paying for Lumen+', 'cancel my membership'],
  valuePerYear: null,
  startIntent: 'Open my Lumen+ account',
  steps: [
    { index: 1, intent: 'Open billing settings', targetDescription: 'Billing link in the account sidebar' },
    { index: 2, intent: 'Open membership management' },
    { index: 3, intent: 'Start cancellation' },
    { index: 4, intent: 'Decline the retention offer' },
    { index: 5, intent: 'Confirm the cancellation' },
  ],
  preferences: { decline_retention_offers: true, secret: '[redacted]' },
  approval: null,
  confirmationTexts: ['Membership canceled', 'Confirm cancellation'],
  ...over,
});

describe('normalizeRecording post-processing (sample cancel path)', () => {
  it('builds intent steps with locators, expectations and one approval', async () => {
    const d = await normalizeRecording(sampleCancelRecording(BASE), { llm: scripted() });
    expect(d.steps.map((s) => [s.sequence, s.actionType, s.intent])).toEqual([
      [1, 'navigate', 'Open my Lumen+ account'],
      [2, 'click', 'Open billing settings'],
      [3, 'click', 'Open membership management'],
      [4, 'click', 'Start cancellation'],
      [5, 'click', 'Decline the retention offer'],
      [6, 'click', 'Confirm the cancellation'],
    ]);
    expect(d.steps[0].inputSource).toBe('url:/account');
    expect(d.steps[1]).toMatchObject({ locatorHint: 'role=link[name="Billing"]', config: { matchText: 'Billing' } });
    // Title "Billing" equals the clicked text → next clicked target instead.
    expect(d.steps.map((s) => s.expectedAfter).slice(0, 5)).toEqual([
      'Account',
      'Manage membership',
      'Cancel membership',
      'Before you go',
      'Confirm cancellation',
    ]);
    expect(d.steps.filter((s) => s.requiresApproval).map((s) => s.sequence)).toEqual([6]);
    expect(d.steps[5].config.approval?.title).toBe('Confirm cancellation?');
    // Confirmation text visible before acting ("Confirm cancellation") is dropped; derived ones added.
    expect(d.steps[5].expectedAfter).toBe('Membership canceled|canceled|cancelled');
    expect(d.preferences).toEqual({ decline_retention_offers: true });
    expect(d.triggers).toEqual(['cancel my membership', 'stop paying for lumen+', 'cancel subscription']);
    expect(d.targetDomains).toEqual(['demo.example.com']);
  });

  it('verification passes on the canceled page and fails on the confirm page', async () => {
    const d = await normalizeRecording(sampleCancelRecording(BASE), { llm: scripted() });
    const ok = verifyPage(d.verification, { url: `${BASE}/account/membership?canceled=1`, title: '', text: 'Membership canceled Renews: No' });
    expect(ok.passed).toBe(true);
    const stuck = verifyPage(d.verification, { url: `${BASE}/account/membership/cancel/confirm`, title: '', text: 'Membership canceled' });
    expect(stuck.passed).toBe(false);
  });

  it('dedupes double clicks, drops same-page no-op links, turns typed values into prefs, never stores redacted', async () => {
    const rec = sampleCancelRecording(BASE);
    const a = rec.actions;
    const dbl = { ...a[0], at: new Date(Date.parse(a[0].at) + 300).toISOString() };
    const noop = { ...a[1], target: { ...a[1].target!, name: 'Help', text: 'Help', selector: 'role=link[name="Help"]' } };
    const typed = {
      ...a[2],
      action: 'type' as const,
      target: { tag: 'input', role: 'textbox', name: 'Reason', text: null, label: 'Reason', selector: 'internal:label="Reason"i' },
      value: 'Too expensive',
    };
    const pwd = { ...typed, target: { ...typed.target, name: 'Password', label: 'Password' }, value: '[redacted]' };
    const recording: Recording = { ...rec, actions: [a[0], dbl, noop, a[1], typed, pwd, a[2], a[3], a[4]] };
    expect(cleanActions(recording).length).toBe(7);
    const d = await normalizeRecording(recording, { llm: scripted({ steps: [] }) });
    const t = d.steps.find((s) => s.actionType === 'type' && s.inputSource);
    expect(t?.inputSource).toBe('pref:reason');
    expect(d.preferences.reason).toBe('Too expensive');
    const p = d.steps.find((s) => s.config.matchText === 'Password');
    expect(p?.inputSource).toBeNull();
    expect(p?.config.note).toBe('ask the user at run time');
    expect(JSON.stringify(d)).not.toContain('[redacted]');
    expect(d.steps.filter((s) => s.requiresApproval)).toHaveLength(1);
  });
});

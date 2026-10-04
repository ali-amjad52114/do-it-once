import { describe, expect, it } from 'vitest';
import type { SkillStep } from '@/lib/contracts';
import { resolveStepInput, stepControl } from './step-input';
import { dateFromText, findLink, htmlToText } from './index';

const prefs = {
  return_reason: 'No longer needed',
  refund_destination: 'Original payment method (Visa •••• 4242)',
  dropoff: 'UPS Store',
};

const step = (p: Partial<SkillStep>): SkillStep => ({
  id: 's', skillId: 'k', sequence: 1, intent: 'Do it', actionType: 'click', targetDescription: null, inputSource: null,
  expectedBefore: null, expectedAfter: null, locatorHint: null, requiresApproval: false, config: {}, ...p,
});

describe('resolveStepInput', () => {
  it('pref: on a radio click supplies the matchText and a role=radio locator (ignores a stale stored hint)', () => {
    const r = resolveStepInput({ preferences: prefs }, step({
      targetDescription: 'Return method radio', inputSource: 'pref:dropoff', locatorHint: 'role=radio[name="Schedule pickup"]', config: { control: 'radio' },
    }));
    expect(r.value).toBe('UPS Store');
    expect(r.target.matchText).toBe('UPS Store');
    expect(r.target.locatorHint).toBe('role=radio[name="UPS Store"]');
  });

  it('infers radio/checkbox from the description', () => {
    expect(stepControl(step({ targetDescription: 'Refund destination radio' }))).toBe('radio');
    expect(stepControl(step({ targetDescription: 'Item checkbox' }))).toBe('checkbox');
    expect(stepControl(step({ targetDescription: 'Billing link' }))).toBeNull();
  });

  it('checkbox with matchText and no hint gets a role=checkbox locator', () => {
    const r = resolveStepInput({ preferences: {} }, step({ config: { matchText: 'Lumen Aura Wireless Headphones', control: 'checkbox' } }));
    expect(r.target.locatorHint).toBe('role=checkbox[name="Lumen Aura Wireless Headphones"]');
  });

  it('select uses the preference as the option label', () => {
    const r = resolveStepInput({ preferences: prefs }, step({ actionType: 'select', inputSource: 'pref:return_reason', config: { matchText: 'Reason for return' } }));
    expect(r.value).toBe('No longer needed');
    expect(r.target.matchText).toBe('Reason for return');
  });

  it('literal: works for type, select and click', () => {
    expect(resolveStepInput({ preferences: {} }, step({ actionType: 'type', inputSource: 'literal:hello' })).value).toBe('hello');
    expect(resolveStepInput({ preferences: {} }, step({ actionType: 'select', inputSource: 'literal:Store credit' })).value).toBe('Store credit');
    const c = resolveStepInput({ preferences: {} }, step({ inputSource: 'literal:QR code', config: { control: 'radio' } }));
    expect(c.target.locatorHint).toBe('role=radio[name="QR code"]');
  });

  it('a missing preference is a readable error', () => {
    const r = resolveStepInput({ preferences: {} }, step({ inputSource: 'pref:label_format', config: { control: 'radio' } }));
    expect(r.error).toMatch(/no saved preference for "label format"/);
  });

  it('plain clicks keep their stored hint and matchText', () => {
    const r = resolveStepInput({ preferences: prefs }, step({ locatorHint: 'role=link[name="Billing"]', config: { matchText: 'Billing' } }));
    expect(r.target).toMatchObject({ matchText: 'Billing', locatorHint: 'role=link[name="Billing"]' });
  });
});

describe('post-action page helpers', () => {
  const html = `<div><span class="k">Drop off by</span><span><b>Oct 18, 2026</b></span>
    <a class="btn" href="/store/returns/RMA-1/label.svg" download="lumen-return-RMA-1.svg">Download label</a></div>`;
  it('finds the link and the date', () => {
    expect(findLink(html, 'Download label', 'https://x.test/store/returns/RMA-1')).toEqual({
      href: 'https://x.test/store/returns/RMA-1/label.svg',
      download: 'lumen-return-RMA-1.svg',
    });
    const d = dateFromText(htmlToText(html), 'Drop off by ([A-Z][a-z]{2} \\d{1,2}, \\d{4})');
    expect(d?.label).toBe('Oct 18, 2026');
    expect(d?.date.getDate()).toBe(18);
  });
});

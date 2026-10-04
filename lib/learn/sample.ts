// The sample Teach Mode recording: the demo site's (Lumen+) cancel path, as the extension records it.
import type { RecordedAction, Recording } from '@/lib/contracts';

export function sampleCancelRecording(baseUrl: string): Recording {
  const base = baseUrl.replace(/\/+$/, '');
  const t0 = Date.parse('2026-10-04T20:45:20.000Z');
  const click = (i: number, path: string, title: string, role: 'link' | 'button', name: string): RecordedAction => ({
    at: new Date(t0 + i * 4000).toISOString(),
    url: `${base}${path}`,
    pageTitle: `${title} · Lumen+`,
    action: 'click',
    target: { tag: role === 'link' ? 'a' : 'button', role, name, text: name, label: null, selector: `role=${role}[name="${name}"]` },
    value: null,
  });
  return {
    startedAt: new Date(t0).toISOString(),
    endedAt: new Date(t0 + 30000).toISOString(),
    startUrl: `${base}/account`,
    actions: [
      click(1, '/account', 'Account', 'link', 'Billing'),
      click(2, '/account/billing', 'Billing', 'link', 'Manage membership'),
      click(3, '/account/membership', 'Membership', 'link', 'Cancel membership'),
      click(4, '/account/membership/cancel', 'Before you go', 'link', 'No thanks, continue to cancel'),
      click(5, '/account/membership/cancel/confirm', 'Confirm cancellation', 'button', 'Confirm cancellation'),
    ],
  };
}

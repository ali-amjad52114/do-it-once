// Fixed ids and seed content for the demo user (docs/CONTRACTS.md "The seeded skill").
// Used by scripts/seed.ts and repo.resetDemoState. Server-only.
import { DEMO_USER_ID, type ActionType, type StepConfig, type VerificationSpec } from '@/lib/contracts';

export { DEMO_USER_ID };

export const DEMO_USER = { id: DEMO_USER_ID, name: 'Ali Amjad', email: 'demo@doitonce.local' };

export const CANCEL_SKILL_ID = '10000000-0000-4000-8000-000000000001';
export const RETURN_SKILL_ID = '10000000-0000-4000-8000-000000000002';
export const HAIRCUT_SKILL_ID = '10000000-0000-4000-8000-000000000003';
export const REGISTRATION_SKILL_ID = '10000000-0000-4000-8000-000000000004';
export const DEMO_TRIGGER_ID = '30000000-0000-4000-8000-000000000001';

/** Seeded history: last success 12 days before seeding/reset. */
export const SEED_LAST_SUCCESS_INTERVAL = '12 days';

export const DEFAULT_DEMO_SITE_URL = 'https://do-it-once-demo.fly.dev';

export function demoSiteUrl(): string {
  return (process.env.DEMO_SITE_URL || DEFAULT_DEMO_SITE_URL).replace(/\/+$/, '');
}

export interface SeedStep {
  id: string;
  sequence: number;
  intent: string;
  actionType: ActionType;
  targetDescription: string | null;
  inputSource: string | null;
  expectedBefore: string | null;
  expectedAfter: string | null;
  locatorHint: string | null;
  requiresApproval: boolean;
  config: StepConfig;
}

export interface SeedSkill {
  id: string;
  title: string;
  description: string;
  icon: string;
  startUrl: string | null;
  targetDomains: string[];
  verification: VerificationSpec;
  valuePerYear: number | null;
  runCount: number;
  successCount: number;
  steps: SeedStep[];
  triggers: string[];
  preferences: Record<string, unknown>;
}

const stepId = (n: number) => `20000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;

export function cancelSkill(siteUrl = demoSiteUrl()): SeedSkill {
  return {
    id: CANCEL_SKILL_ID,
    title: 'Cancel subscription',
    description: 'Cancel a recurring membership, decline retention offers, and confirm it is canceled.',
    icon: 'subscription',
    startUrl: `${siteUrl}/account`,
    targetDomains: [new URL(siteUrl).host],
    verification: {
      anyOf: [
        { type: 'text_contains', value: 'Membership canceled' },
        { type: 'text_contains', value: 'Renews: No' },
      ],
      allOf: [{ type: 'url_matches', value: '/account/membership(\\?|$)' }],
    },
    valuePerYear: 228,
    runCount: 3,
    successCount: 3,
    triggers: [
      'cancel subscription',
      'get rid of this subscription',
      'stop paying for this',
      'cancel my membership',
      'unsubscribe from this service',
    ],
    preferences: { confirm_before_cancel: true, decline_retention_offers: true },
    steps: [
      {
        id: stepId(1), sequence: 1, intent: 'Open my Lumen+ account', actionType: 'navigate',
        targetDescription: null, inputSource: 'url:/account', expectedBefore: null,
        expectedAfter: 'Welcome back', locatorHint: null, requiresApproval: false, config: {},
      },
      {
        id: stepId(2), sequence: 2, intent: 'Open billing settings', actionType: 'click',
        targetDescription: 'Billing link in the account sidebar', inputSource: null, expectedBefore: null,
        expectedAfter: 'Manage membership', locatorHint: 'role=link[name="Billing"]', requiresApproval: false,
        config: { matchText: 'Billing' },
      },
      {
        id: stepId(3), sequence: 3, intent: 'Open membership management', actionType: 'click',
        targetDescription: 'Manage membership button', inputSource: null, expectedBefore: null,
        expectedAfter: 'Cancel membership', locatorHint: 'role=link[name="Manage membership"]', requiresApproval: false,
        config: { matchText: 'Manage membership' },
      },
      {
        id: stepId(4), sequence: 4, intent: 'Start cancellation', actionType: 'click',
        targetDescription: 'Cancel membership link', inputSource: null, expectedBefore: null,
        expectedAfter: 'Before you go', locatorHint: 'role=link[name="Cancel membership"]', requiresApproval: false,
        config: { matchText: 'Cancel membership' },
      },
      {
        id: stepId(5), sequence: 5, intent: 'Decline the retention offer', actionType: 'click',
        targetDescription: 'No thanks, continue to cancel button', inputSource: null, expectedBefore: null,
        expectedAfter: 'Confirm cancellation', locatorHint: 'role=link[name="No thanks, continue to cancel"]',
        requiresApproval: false, config: { matchText: 'No thanks, continue to cancel' },
      },
      {
        id: stepId(6), sequence: 6, intent: 'Confirm the cancellation', actionType: 'click',
        targetDescription: 'Confirm cancellation button', inputSource: null, expectedBefore: null,
        expectedAfter: 'Membership canceled', locatorHint: 'role=button[name="Confirm cancellation"]',
        requiresApproval: true,
        config: {
          matchText: 'Confirm cancellation',
          approval: {
            title: 'Cancel $19/month membership?',
            description: 'Agent reached the final cancellation screen. This is irreversible.',
          },
        },
      },
    ],
  };
}

const displaySkill = (id: string, title: string, icon: string, description: string, runCount: number, successCount: number): SeedSkill => ({
  id, title, description, icon, startUrl: null, targetDomains: [], verification: {}, valuePerYear: null,
  runCount, successCount, steps: [], triggers: [], preferences: {},
});

export function allSeedSkills(siteUrl = demoSiteUrl()): SeedSkill[] {
  return [
    cancelSkill(siteUrl),
    displaySkill(RETURN_SKILL_ID, 'Return online order', 'return', 'Start a return, pick the refund method and save the label.', 7, 6),
    displaySkill(HAIRCUT_SKILL_ID, 'Book haircut', 'haircut', 'Book my usual haircut at my usual time.', 9, 9),
    displaySkill(REGISTRATION_SKILL_ID, 'Renew registration', 'registration', 'Renew my vehicle registration online.', 1, 1),
  ];
}

export const DEMO_TRIGGER = {
  id: DEMO_TRIGGER_ID,
  userId: DEMO_USER_ID,
  source: 'seed' as const,
  subject: 'Your Lumen+ membership renews tomorrow',
  payload: { title: 'Membership renewal', merchant: 'Lumen+', amount: '$19/month', cadence: 'monthly', dueLabel: 'Renews tomorrow' },
  matchedSkillId: CANCEL_SKILL_ID,
};

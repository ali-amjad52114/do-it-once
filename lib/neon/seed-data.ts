// Fixed ids and seed content for the demo user (docs/CONTRACTS.md "The seeded skill").
// Used by scripts/seed.ts and repo.resetDemoState. Server-only.
import { DEMO_USER_ID, type ActionType, type PostAction, type StepConfig, type VerificationSpec } from '@/lib/contracts';

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
  status: 'active' | 'draft';
  runCount: number;
  successCount: number;
  steps: SeedStep[];
  triggers: string[];
  preferences: Record<string, unknown>;
  postActions?: PostAction[];
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
    // Real history only: counts start at 0 and grow with actual runs.
    status: 'active',
    runCount: 0,
    successCount: 0,
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

const returnStepId = (n: number) => `20000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;

type StepSpec = Omit<SeedStep, 'id' | 'sequence' | 'expectedBefore' | 'locatorHint' | 'requiresApproval' | 'inputSource' | 'targetDescription' | 'expectedAfter'> &
  Partial<Pick<SeedStep, 'locatorHint' | 'requiresApproval' | 'inputSource' | 'targetDescription' | 'expectedAfter'>>;

/** "Return online order" on the demo site's Lumen Store (demo-site/README.md). Choices come from preferences. */
export function returnSkill(siteUrl = demoSiteUrl()): SeedSkill {
  const specs: StepSpec[] = [
    { intent: 'Open my Lumen Store orders', actionType: 'navigate', inputSource: 'url:/store/orders', expectedAfter: 'Your orders', config: {} },
    {
      intent: 'Open the headphones order', actionType: 'click', targetDescription: 'Lumen Aura Wireless Headphones link in your orders',
      expectedAfter: 'Return or replace items', locatorHint: 'role=link[name="Lumen Aura Wireless Headphones"]',
      config: { matchText: 'Lumen Aura Wireless Headphones' },
    },
    {
      intent: 'Start the return', actionType: 'click', targetDescription: 'Return or replace items link',
      expectedAfter: 'Which item are you returning?', locatorHint: 'role=link[name="Return or replace items"]',
      config: { matchText: 'Return or replace items' },
    },
    {
      intent: 'Select the headphones', actionType: 'click', targetDescription: 'Lumen Aura Wireless Headphones checkbox',
      locatorHint: 'role=checkbox[name="Lumen Aura Wireless Headphones"]',
      config: { matchText: 'Lumen Aura Wireless Headphones', control: 'checkbox' },
    },
    {
      intent: 'Choose the reason for return', actionType: 'select', targetDescription: 'Reason for return dropdown',
      inputSource: 'pref:return_reason', locatorHint: 'role=combobox[name="Reason for return"]',
      config: { matchText: 'Reason for return' },
    },
    {
      intent: 'Continue to refund options', actionType: 'click', targetDescription: 'Continue button',
      expectedAfter: 'Refund destination', locatorHint: 'role=button[name="Continue"]', config: { matchText: 'Continue' },
    },
    {
      intent: 'Choose where the refund goes', actionType: 'click', targetDescription: 'Refund destination radio',
      inputSource: 'pref:refund_destination', config: { control: 'radio' },
    },
    {
      intent: 'Choose how to send it back', actionType: 'click', targetDescription: 'Return method radio',
      inputSource: 'pref:dropoff', config: { control: 'radio' },
    },
    {
      intent: 'Choose the label format', actionType: 'click', targetDescription: 'Label format radio',
      inputSource: 'pref:label_format', config: { control: 'radio' },
    },
    {
      intent: 'Continue to review', actionType: 'click', targetDescription: 'Continue to review button',
      expectedAfter: 'Review your return', locatorHint: 'role=button[name="Continue to review"]',
      config: { matchText: 'Continue to review' },
    },
    {
      intent: 'Submit the return', actionType: 'click', targetDescription: 'Submit return button',
      expectedAfter: 'Return started', locatorHint: 'role=button[name="Submit return"]', requiresApproval: true,
      config: {
        matchText: 'Submit return',
        approval: {
          title: 'Return Lumen Aura headphones ($129.00)?',
          description: 'Agent reached the review page with your saved choices. Submitting starts the return and can’t be edited.',
        },
      },
    },
  ];
  return {
    id: RETURN_SKILL_ID,
    title: 'Return online order',
    description: 'Start a return, pick the refund method and save the label.',
    icon: 'return',
    startUrl: `${siteUrl}/store/orders`,
    targetDomains: [new URL(siteUrl).host],
    verification: {
      anyOf: [{ type: 'text_contains', value: 'Return started' }],
      allOf: [
        { type: 'url_matches', value: '/store/returns/RMA-[A-Za-z0-9-]+(\\?|$)' },
        { type: 'text_contains', value: '$129.00' },
      ],
    },
    // One-time refund, not a yearly value (no contract field for it: the UI reads "$129.00" from the evidence).
    valuePerYear: null,
    status: 'active',
    runCount: 0,
    successCount: 0,
    triggers: ['return these headphones', 'return my headphones', 'send this item back', 'start a return', 'get a refund for my purchase'],
    preferences: {
      return_reason: 'No longer needed',
      refund_destination: 'Original payment method (Visa •••• 4242)',
      dropoff: 'UPS Store',
      label_format: 'QR code',
    },
    postActions: [
      { type: 'save_download', linkText: 'Download label', folder: 'return-labels' },
      {
        type: 'calendar_event',
        title: 'Drop off Lumen Aura headphones at UPS Store',
        dateFromPage: 'Drop off by ([A-Z][a-z]{2} \\d{1,2}, \\d{4})',
        durationMinutes: 30,
        location: 'The UPS Store',
      },
    ],
    steps: specs.map((s, i) => ({
      id: returnStepId(i + 1),
      sequence: i + 1,
      expectedBefore: null,
      targetDescription: null,
      inputSource: null,
      expectedAfter: null,
      locatorHint: null,
      requiresApproval: false,
      ...s,
    })),
  };
}

// Not learned yet (no steps): shown as drafts until taught in later phases.
const draftSkill = (id: string, title: string, icon: string, description: string): SeedSkill => ({
  id, title, description, icon, startUrl: null, targetDomains: [], verification: {}, valuePerYear: null,
  status: 'draft', runCount: 0, successCount: 0, steps: [], triggers: [], preferences: {},
});

export function allSeedSkills(siteUrl = demoSiteUrl()): SeedSkill[] {
  return [
    cancelSkill(siteUrl),
    returnSkill(siteUrl),
    draftSkill(HAIRCUT_SKILL_ID, 'Book haircut', 'haircut', 'Book my usual haircut at my usual time.'),
    draftSkill(REGISTRATION_SKILL_ID, 'Renew registration', 'registration', 'Renew my vehicle registration online.'),
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

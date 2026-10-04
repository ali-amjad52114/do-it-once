// Safety guard for self-heal: the healer must NEVER click the irreversible step (requiresApproval).
// Enforced in code: name match against the approval step + risky-word check confirmed by an LLM.
import type { InteractiveElement, SkillStep } from '@/lib/contracts';

export const RISKY_WORDS =
  /\b(confirm|end|ending|cancel|cancellation|submit|delete|remove|pay|payment|purchase|buy|order|terminate|unsubscribe|close|finish|complete|agree)\b/i;

export interface GuardQuestion {
  name: string;
  role: string;
  approvalIntent: string;
  pageText: string;
}

/** LLM check: would clicking this perform the irreversible action itself (not just navigate towards it)? */
export type IrreversibleCheck = (q: GuardQuestion) => Promise<boolean>;

export interface GuardVerdict {
  blocked: boolean;
  reason: string;
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export async function guardClick(
  el: Pick<InteractiveElement, 'name' | 'role'>,
  approvalStep: SkillStep | null,
  pageText: string,
  llmCheck?: IrreversibleCheck,
): Promise<GuardVerdict> {
  if (!approvalStep) return { blocked: false, reason: 'no irreversible step in this skill' };
  const name = norm(el.name);
  const old = norm(approvalStep.config.matchText ?? null);
  if (old && (name === old || name.includes(old) || old.includes(name))) {
    return { blocked: true, reason: `"${el.name}" matches the irreversible step "${approvalStep.config.matchText}"` };
  }
  if (!RISKY_WORDS.test(el.name)) return { blocked: false, reason: 'no risky words' };
  // Links are navigations (GET); buttons usually submit forms. Without an LLM answer: block buttons, allow links.
  const failSafe = el.role !== 'link';
  if (!llmCheck) return { blocked: failSafe, reason: failSafe ? 'risky button (no LLM check)' : 'risky words on a link' };
  try {
    const irreversible = await llmCheck({ name: el.name, role: el.role, approvalIntent: approvalStep.intent, pageText });
    return irreversible
      ? { blocked: true, reason: `"${el.name}" would ${approvalStep.intent.toLowerCase()} (irreversible)` }
      : { blocked: false, reason: 'LLM: navigates only' };
  } catch {
    return { blocked: failSafe, reason: failSafe ? 'risky button (LLM check failed)' : 'risky words on a link' };
  }
}

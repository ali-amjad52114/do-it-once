// Input resolution for a skill step (agent R). Pure — used by performStep in lib/engine/engine.ts.
//
// inputSource forms:  "literal:<text>"  |  "pref:<key>" (from the skill's preferences)  |  "url:<path>" (navigate only)
// - click:  a literal:/pref: value becomes the element's matchText ("UPS Store"). When the target is a
//           radio or checkbox (config.control, or the description says so) it is clicked by its label
//           through `role=radio[name="…"]` / `role=checkbox[name="…"]`, then the adapter's text fallbacks.
// - select: the value is the option label ("No longer needed").
// - type:   the value is the text to type.
import type { ElementTarget, SkillDetail, SkillStep } from '@/lib/contracts';

export type StepControl = 'radio' | 'checkbox';

export interface ResolvedStepInput {
  target: ElementTarget;
  /** Resolved literal:/pref: value (typed text, option label, or the label clicked). null when the step has none. */
  value: string | null;
  /** Readable reason the step can't run (e.g. a missing preference). */
  error?: string;
}

/** Playwright role selector, same format as lib/kernel/selectors roleLocator. */
export function roleSelector(role: string, name: string): string {
  return `role=${role}[name=${JSON.stringify(name)}]`;
}

/** 'radio' | 'checkbox' when the step targets one (config.control wins over the description). */
export function stepControl(step: Pick<SkillStep, 'config' | 'targetDescription'>): StepControl | null {
  const c = step.config?.control;
  if (c === 'radio' || c === 'checkbox') return c;
  const d = (step.targetDescription ?? '').toLowerCase();
  if (/\bradio\b/.test(d)) return 'radio';
  if (/\bcheck ?box\b/.test(d)) return 'checkbox';
  return null;
}

/** Resolves "literal:" / "pref:" (and passes other strings through). `missing` names an absent preference. */
export function resolveSource(
  preferences: Record<string, unknown> | undefined,
  source: string | null,
): { value: string | null; missing?: string } {
  if (!source) return { value: null };
  if (source.startsWith('literal:')) return { value: source.slice('literal:'.length) };
  if (source.startsWith('pref:')) {
    const key = source.slice('pref:'.length);
    const v = preferences?.[key];
    if (v == null || v === '') return { value: null, missing: key };
    return { value: typeof v === 'string' ? v : String(v) };
  }
  return { value: source };
}

const humanKey = (k: string) => k.replace(/[_-]+/g, ' ').trim();

export function resolveStepInput(skill: Pick<SkillDetail, 'preferences'>, step: SkillStep): ResolvedStepInput {
  const base: ElementTarget = {
    description: step.targetDescription ?? step.config.matchText ?? step.intent,
    matchText: step.config.matchText ?? null,
    locatorHint: step.locatorHint,
  };
  // navigate resolves its own url: source; wait/extract/screenshot take no input.
  if (step.actionType !== 'click' && step.actionType !== 'select' && step.actionType !== 'type') {
    return { target: base, value: null };
  }
  const { value, missing } = resolveSource(skill.preferences, step.inputSource);
  if (missing) {
    return { target: base, value: null, error: `there is no saved preference for "${humanKey(missing)}"` };
  }
  if (step.actionType !== 'click') return { target: base, value: value ?? '' };

  const control = stepControl(step);
  if (value != null) {
    // The preference decides WHICH element: the stored hint was for whatever value worked last time.
    return {
      target: {
        description: control ? `${value} ${control}` : value,
        matchText: value,
        locatorHint: control ? roleSelector(control, value) : null,
      },
      value,
    };
  }
  if (control && !base.locatorHint && base.matchText) {
    return { target: { ...base, locatorHint: roleSelector(control, base.matchText) }, value: null };
  }
  return { target: base, value: null };
}

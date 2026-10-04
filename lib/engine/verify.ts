// CONTRACT STUB — owned by agent B6 (Evidence). B6 replaces the body; the signature is fixed.
import type { PageState, VerificationResult, VerificationSpec } from '@/lib/contracts';

/** Pure function: checks the final page against the skill's verification spec. Never trusts an LLM "done". */
export function verifyPage(spec: VerificationSpec, page: PageState): VerificationResult {
  throw new Error('lib/engine/verify not implemented yet');
}

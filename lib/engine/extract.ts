// CONTRACT STUB — owned by agent B6 (Evidence). B6 replaces the body; the signature is fixed.
import type { Approval, PageState } from '@/lib/contracts';

/** Pulls price ("$19/month"), renewal date and merchant from the page shown at the approval step. */
export function extractApprovalPayload(page: PageState): Approval['payload'] {
  throw new Error('lib/engine/extract not implemented yet');
}

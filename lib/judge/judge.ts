// CONTRACT STUB — owned by agent A3 (Judge). A3 replaces the body; the signature is fixed.
// A4 (Discovery) imports judgeRun from here.
import type { JudgeInput, Judgment } from '@/lib/contracts.addons';

export async function judgeRun(_input: JudgeInput): Promise<Judgment> {
  return { verdict: 'unsure', confidence: 0, reasons: ['judge not implemented yet'], quotedEvidence: [] };
}

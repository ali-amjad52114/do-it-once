// CONTRACT STUB — owned by agent S4 (Email triggers). S4 replaces the body (uses lib/ai/gateway).
import type { EmailClassification } from '@/lib/contracts';

export async function classifyEmail(_input: { subject: string; text: string; from?: string | null }): Promise<EmailClassification> {
  throw new Error('lib/triggers/classify not implemented yet');
}

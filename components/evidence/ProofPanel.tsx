'use client';
// CONTRACT STUB — owned by agent B6 (Evidence). B6 replaces the body; props are fixed.
import type { RunResult } from '@/lib/contracts';

export function ProofPanel({ result }: { result: RunResult }) {
  return <pre>{JSON.stringify(result, null, 2)}</pre>;
}

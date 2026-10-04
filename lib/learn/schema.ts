// Zod mirrors of the Teach Mode contracts (lib/contracts.ts: Recording, RecordedAction, RecordedTarget).
// Shared by the API (validates what the extension posts) and lib/learn. No server-only imports.
import { z } from 'zod';
import type { Recording } from '@/lib/contracts';

const str = (max: number) => z.string().max(max);

export const RecordedTargetSchema = z.object({
  tag: str(40),
  role: str(60).nullable(),
  name: str(400).nullable(),
  text: str(400).nullable(),
  label: str(400).nullable(),
  selector: str(1000).nullable(),
});

export const RecordedActionSchema = z.object({
  at: str(64),
  url: str(4000),
  pageTitle: str(400),
  action: z.enum(['navigate', 'click', 'type', 'select', 'submit']),
  target: RecordedTargetSchema.nullable(),
  value: str(4000).nullable(),
});

export const RecordingSchema = z.object({
  startedAt: str(64),
  endedAt: str(64),
  startUrl: z.string().url().max(4000),
  actions: z.array(RecordedActionSchema).min(1, 'the recording has no actions').max(500),
});

// Compile-time check that the zod schema stays in sync with the contract type.
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _recordingInSync: _Same<z.infer<typeof RecordingSchema>, Recording> = true;
void _recordingInSync;

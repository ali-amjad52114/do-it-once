// RFC 5545 iCalendar builder for the .ics fallback (no dependencies).
import { randomUUID } from 'node:crypto';
import type { CalendarEventInput } from '@/lib/contracts';

/** Date → "YYYYMMDDTHHMMSSZ" (UTC form, RFC 5545 §3.3.5 FORM #2). */
export function formatIcsUtc(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date for iCalendar');
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escape a TEXT value (RFC 5545 §3.3.11): backslash, semicolon, comma, newline. */
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a content line to at most 75 octets per physical line (RFC 5545 §3.1).
 * Continuation lines start with a single space. Never splits a UTF-8 code point.
 */
export function foldIcsLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75; // first line 75 octets; continuation lines 74 + leading space
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit) {
      out.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export interface IcsOptions {
  uid?: string;
  now?: Date;
}

export function buildIcs(input: CalendarEventInput, opts: IcsOptions = {}): string {
  const start = new Date(input.start);
  const end = new Date(input.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error('Invalid start/end ISO date');
  if (end.getTime() <= start.getTime()) throw new Error('Event end must be after start');
  const uid = opts.uid ?? `${randomUUID()}@doitonce`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Do It Once//Executor fallback//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatIcsUtc(opts.now ?? new Date())}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
    `SUMMARY:${escapeIcsText(input.title)}`,
  ];
  if (input.location) lines.push(`LOCATION:${escapeIcsText(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escapeIcsText(input.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldIcsLine, formatIcsUtc } from './ics';

const unfold = (s: string) => s.replace(/\r\n /g, '');

describe('ics', () => {
  it('formats UTC times', () => {
    expect(formatIcsUtc(new Date('2026-10-05T10:00:00-07:00'))).toBe('20261005T170000Z');
    expect(formatIcsUtc(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102T030405Z');
  });

  it('escapes TEXT values', () => {
    expect(escapeIcsText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });

  it('folds at 75 octets without splitting UTF-8 characters', () => {
    const line = 'DESCRIPTION:' + 'é·'.repeat(60);
    const folded = foldIcsLine(line);
    for (const physical of folded.split('\r\n')) expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(unfold(folded)).toBe(line);
    expect(foldIcsLine('SHORT:x')).toBe('SHORT:x');
  });

  it('builds a valid VEVENT', () => {
    const ics = buildIcs(
      {
        title: 'Do It Once demo · Return drop-off at UPS Store',
        start: '2026-10-05T17:00:00.000Z',
        end: '2026-10-05T17:30:00.000Z',
        location: '123 Main St, Suite 4; Springfield',
        description: 'Bring the box\nand the QR code',
      },
      { uid: 'abc@doitonce', now: new Date('2026-10-04T12:00:00Z') },
    );
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/\n/); // only CRLF line endings
    const lines = unfold(ics).split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('UID:abc@doitonce');
    expect(lines).toContain('DTSTAMP:20261004T120000Z');
    expect(lines).toContain('DTSTART:20261005T170000Z');
    expect(lines).toContain('DTEND:20261005T173000Z');
    expect(lines).toContain('SUMMARY:Do It Once demo · Return drop-off at UPS Store');
    expect(lines).toContain('LOCATION:123 Main St\\, Suite 4\\; Springfield');
    expect(lines).toContain('DESCRIPTION:Bring the box\\nand the QR code');
    for (const physical of ics.split('\r\n')) expect(Buffer.byteLength(physical, 'utf8')).toBeLessThanOrEqual(75);
  });

  it('generates a UID and rejects bad ranges', () => {
    const ics = buildIcs({ title: 'x', start: '2026-10-05T10:00:00Z', end: '2026-10-05T11:00:00Z' });
    expect(ics).toMatch(/UID:[0-9a-f-]{36}@doitonce/);
    expect(ics).not.toMatch(/LOCATION|DESCRIPTION/);
    expect(() => buildIcs({ title: 'x', start: '2026-10-05T11:00:00Z', end: '2026-10-05T10:00:00Z' })).toThrow();
    expect(() => buildIcs({ title: 'x', start: 'nope', end: '2026-10-05T10:00:00Z' })).toThrow();
  });
});

// Live smoke test for the Fly.io Sprite workspace (lib/fly). Costs fractions of a cent of Sprite time.
//   npx tsx scripts/smoke-sprite.ts
// Skips (exit 0) when SPRITES_TOKEN / SPRITE_TOKEN is not set.
import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { extractPdfText, getWorkspace, hasSpritesToken, listWorkspace, saveArtifact } from '@/lib/fly';

if (!hasSpritesToken()) {
  console.log('SKIPPED: SPRITES_TOKEN (or SPRITE_TOKEN) is not set. Create a token at https://sprites.dev/account and add SPRITES_TOKEN=... to .env.');
  process.exit(0);
}

// 1x1 red PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

/** Minimal one-page PDF with a Helvetica text line and a correct xref table. */
function makePdf(text: string): Buffer {
  const esc = text.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 18 Tf 72 720 Td (${esc}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const timings: Array<[string, number]> = [];
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - t);
    timings.push([label, ms]);
    console.log(`  ${label}: ${ms} ms`);
  }
}

async function main() {
  const ws = getWorkspace();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const phrase = `Do It Once smoke ${stamp}`;

  console.log(`Sprite "${ws.spriteName}", root ${ws.root}`);
  const info = await timed('ensure (get/create + wake + mkdir)', () => ws.ensure());
  console.log(`  status before: ${info.statusBefore}  created: ${info.created}  url: ${info.url}`);

  await timed('exec #1 (first exec)', () => ws.exec('true'));
  await timed('exec #2 (warm)', () => ws.exec('true'));
  const probe = await ws.exec('uname -sr; id -un; (mkdir -p /workspace 2>/dev/null && test -w /workspace && echo "/workspace writable") || echo "/workspace NOT writable"; sudo -n true 2>/dev/null && echo "passwordless sudo: yes" || echo "passwordless sudo: no"');
  console.log(probe.stdout.trim().split('\n').map((l) => `  ${l}`).join('\n'));

  const pdfBytes = makePdf(phrase);
  const png = await timed('saveArtifact PNG', () => saveArtifact('artifacts', `smoke-${stamp}.png`, PNG));
  const pdf = await timed('saveArtifact PDF', () => saveArtifact('artifacts', `smoke-${stamp}.pdf`, pdfBytes));
  console.log(`  ${png.location}\n  ${pdf.location}`);

  const listing = await timed('list artifacts/', () => ws.list(`${ws.root}/artifacts`));
  for (const p of [png.path, pdf.path]) {
    const hit = listing.find((f) => f.path === p);
    if (!hit) throw new Error(`list() did not include ${p}`);
    console.log(`  listed ${p} (${hit.size} B)`);
  }

  const backPng = await timed('readFile PNG', () => ws.readFile(png.path));
  const backPdf = await timed('readFile PDF', () => ws.readFile(pdf.path));
  if (!backPng.equals(PNG)) throw new Error('PNG bytes differ after round trip');
  if (!backPdf.equals(pdfBytes)) throw new Error('PDF bytes differ after round trip');
  console.log(`  round trip OK (${PNG.length} B png, ${pdfBytes.length} B pdf)`);

  const text = await timed('extractPdfText (incl. install if needed)', () => extractPdfText(pdf.path));
  if (text.text === null) console.log(`  extractPdfText: null (${text.reason})`);
  else {
    console.log(`  extractPdfText (installed now: ${text.installed}): ${JSON.stringify(text.text.trim())}`);
    if (!text.text.includes('Do It Once smoke')) throw new Error('extracted text missing phrase');
  }
  await timed('extractPdfText (second call)', () => extractPdfText(pdf.path));

  const tree = await timed('listWorkspace', () => listWorkspace());
  console.log(`  tree: ${tree.folders.map((f) => `${f.kind}(${f.fileCount})`).join(' ')}`);

  console.log('\nTimings (ms):');
  for (const [l, ms] of timings) console.log(`  ${String(ms).padStart(6)}  ${l}`);
  console.log('\nPASS');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FAIL', err);
    process.exit(1);
  },
);

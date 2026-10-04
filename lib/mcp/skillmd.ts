// A2: renders a personal skill as a Claude Skill (SKILL.md). Pure, no I/O.
import type { SkillDetail, VerificationRule } from '@/lib/contracts';

/** "Cancel Lumen+ membership" → "cancel-lumen-plus-membership" (Claude Skill names: lowercase, digits, hyphens, ≤ 64). */
export function kebab(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return out || 'do-it-once-skill';
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const yamlStr = (s: string) => JSON.stringify(oneLine(s)); // JSON strings are valid YAML double-quoted scalars

function ruleText(r: VerificationRule): string {
  if (r.type === 'text_contains') return `The page shows "${r.value}"`;
  if (r.type === 'text_absent') return `The page no longer shows "${r.value}"`;
  return `The page URL matches \`${r.value}\``;
}

export function skillToMarkdown(skill: SkillDetail): string {
  const name = kebab(skill.title);
  const triggers = skill.triggers.slice(0, 8);
  const description =
    `${oneLine(skill.description || skill.title)}.`.replace(/\.\.$/, '.') +
    (triggers.length ? ` Use when the user says things like: ${triggers.map((t) => `"${t}"`).join(', ')}.` : '');

  const steps = [...skill.steps].sort((a, b) => a.sequence - b.sequence);
  const irreversible = steps.filter((s) => s.requiresApproval);
  const lines: string[] = [];
  lines.push('---', `name: ${name}`, `description: ${yamlStr(description)}`, '---', '');
  lines.push(`# ${skill.title}`, '');
  if (skill.description) lines.push(oneLine(skill.description), '');
  lines.push(
    '## Preferred: use the Do It Once MCP server',
    '',
    'If the `do-it-once` MCP server is connected, do NOT do this by hand. Call `search_skills` with the',
    "user's request, then `start_run` with the matching skill id, and poll `get_run`. The run pauses before",
    'the irreversible step; the user approves it in the Do It Once dashboard (there is no approve tool).',
    '',
  );
  if (skill.startUrl || skill.targetDomains.length) {
    lines.push('## Where', '');
    if (skill.startUrl) lines.push(`- Start at: ${skill.startUrl}`);
    if (skill.targetDomains.length) lines.push(`- Sites: ${skill.targetDomains.join(', ')}`);
    lines.push('');
  }
  const prefs = Object.entries(skill.preferences);
  if (prefs.length) {
    lines.push('## Preferences', '');
    for (const [k, v] of prefs) lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    lines.push('');
  }
  lines.push('## Steps', '');
  for (const s of steps) {
    const extra = [s.targetDescription && `target: ${oneLine(s.targetDescription)}`, s.expectedAfter && `expect: ${oneLine(s.expectedAfter)}`]
      .filter(Boolean)
      .join('; ');
    const flag = s.requiresApproval ? ' **(IRREVERSIBLE: ask the user first)**' : '';
    lines.push(`- [ ] ${s.sequence}. ${oneLine(s.intent)}${flag}${extra ? ` (${extra})` : ''}`);
  }
  lines.push('');
  lines.push('## Safety', '');
  lines.push('- Always ask the user before the irreversible step, and stop if they say no.');
  for (const s of irreversible) {
    const t = s.config.approval?.title;
    lines.push(`- Step ${s.sequence} (${oneLine(s.intent)}) is irreversible${t ? `: confirm "${oneLine(t)}"` : ''}.`);
  }
  lines.push('');
  const rules = [...(skill.verification.allOf ?? [])];
  const anyOf = skill.verification.anyOf ?? [];
  lines.push('## Verification checklist', '');
  for (const r of rules) lines.push(`- [ ] ${ruleText(r)}`);
  if (anyOf.length) lines.push(`- [ ] At least one of: ${anyOf.map(ruleText).join('; ')}`);
  if (!rules.length && !anyOf.length) lines.push('- [ ] The final page confirms the chore is done');
  lines.push('- [ ] Tell the user what changed and save the confirmation text', '');
  return lines.join('\n');
}

// Idempotent demo seed (fixed UUIDs + upserts). Usage:
//   npm run db:seed            upsert user, skills, steps, triggers, preferences, Today trigger
//   npm run db:seed -- --reset  Today trigger back to pending (keeps real run history)
//   npm run db:seed -- --wipe   delete all demo runs and zero every skill's counters
// Re-running updates start_url / target_domains from DEMO_SITE_URL (fallback https://do-it-once-demo.fly.dev).
import 'dotenv/config';
import { getSql } from '../lib/neon/db';
import { resetDemoState, wipeDemoHistory } from '../lib/neon/repo';
import { DEMO_TRIGGER, DEMO_USER, allSeedSkills, demoSiteUrl } from '../lib/neon/seed-data';

async function main() {
  const reset = process.argv.includes('--reset');
  const wipe = process.argv.includes('--wipe');
  const sql = getSql();
  const siteUrl = demoSiteUrl();
  const skills = allSeedSkills(siteUrl);

  const queries = [
    sql`
      INSERT INTO users (id, name, email) VALUES (${DEMO_USER.id}, ${DEMO_USER.name}, ${DEMO_USER.email})
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, updated_at = now()`,
  ];

  for (const s of skills) {
    const confidence = s.runCount ? s.successCount / s.runCount : 0;
    // Definition fields are refreshed on every seed; history counters only on first insert (or --reset).
    queries.push(sql`
      INSERT INTO personal_skills (id, user_id, title, description, status, version, icon, target_domains, start_url,
        verification, value_per_year, run_count, success_count, confidence, last_success_at, post_actions)
      VALUES (${s.id}, ${DEMO_USER.id}, ${s.title}, ${s.description}, ${s.status}, 1, ${s.icon}, ${s.targetDomains}::text[],
        ${s.startUrl}, ${JSON.stringify(s.verification)}::jsonb, ${s.valuePerYear}, ${s.runCount}, ${s.successCount},
        ${confidence}, NULL, ${JSON.stringify(s.postActions ?? [])}::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id, title = EXCLUDED.title, description = EXCLUDED.description, status = EXCLUDED.status,
        icon = EXCLUDED.icon, target_domains = EXCLUDED.target_domains, start_url = EXCLUDED.start_url,
        verification = EXCLUDED.verification, value_per_year = EXCLUDED.value_per_year,
        post_actions = EXCLUDED.post_actions, updated_at = now()`);

    const stepIds = s.steps.map((st) => st.id);
    // Drop steps that are no longer part of the seed (frees their sequence numbers first).
    queries.push(sql`DELETE FROM skill_steps WHERE skill_id = ${s.id} AND NOT (id = ANY(${stepIds}::uuid[]))`);
    for (const st of s.steps) {
      queries.push(sql`
        INSERT INTO skill_steps (id, skill_id, sequence, intent, action_type, target_description, input_source,
          expected_before, expected_after, locator_hint, requires_approval, config)
        VALUES (${st.id}, ${s.id}, ${st.sequence}, ${st.intent}, ${st.actionType}, ${st.targetDescription}, ${st.inputSource},
          ${st.expectedBefore}, ${st.expectedAfter}, ${st.locatorHint}, ${st.requiresApproval}, ${JSON.stringify(st.config)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          skill_id = EXCLUDED.skill_id, sequence = EXCLUDED.sequence, intent = EXCLUDED.intent,
          action_type = EXCLUDED.action_type, target_description = EXCLUDED.target_description,
          input_source = EXCLUDED.input_source, expected_before = EXCLUDED.expected_before,
          expected_after = EXCLUDED.expected_after, locator_hint = EXCLUDED.locator_hint,
          requires_approval = EXCLUDED.requires_approval, config = EXCLUDED.config, updated_at = now()`);
    }

    queries.push(sql`DELETE FROM skill_triggers WHERE skill_id = ${s.id} AND NOT (phrase = ANY(${s.triggers}::text[]))`);
    s.triggers.forEach((phrase, i) => {
      // created_at staggered so getSkill returns phrases in seed order.
      queries.push(sql`
        INSERT INTO skill_triggers (skill_id, user_id, phrase, created_at)
        VALUES (${s.id}, ${DEMO_USER.id}, ${phrase}, '2026-01-01T00:00:00Z'::timestamptz + ${i} * interval '1 second')
        ON CONFLICT (skill_id, phrase) DO NOTHING`);
    });

    const prefKeys = Object.keys(s.preferences);
    queries.push(sql`DELETE FROM skill_preferences WHERE skill_id = ${s.id} AND NOT (key = ANY(${prefKeys}::text[]))`);
    for (const [key, value] of Object.entries(s.preferences)) {
      queries.push(sql`
        INSERT INTO skill_preferences (skill_id, key, value) VALUES (${s.id}, ${key}, ${JSON.stringify(value)}::jsonb)
        ON CONFLICT (skill_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    }
  }

  const t = DEMO_TRIGGER;
  queries.push(sql`
    INSERT INTO incoming_triggers (id, user_id, source, subject, payload, matched_skill_id, state)
    VALUES (${t.id}, ${t.userId}, ${t.source}, ${t.subject}, ${JSON.stringify(t.payload)}::jsonb, ${t.matchedSkillId}, 'pending')
    ON CONFLICT (id) DO UPDATE SET
      user_id = EXCLUDED.user_id, source = EXCLUDED.source, subject = EXCLUDED.subject, payload = EXCLUDED.payload,
      matched_skill_id = EXCLUDED.matched_skill_id, updated_at = now()`);

  await sql.transaction(queries);
  console.log(`seeded user ${DEMO_USER.id}, ${skills.length} skills, trigger ${t.id} (site ${siteUrl})`);

  if (wipe) {
    await wipeDemoHistory();
    console.log('wipe: demo runs deleted, all counters zeroed, trigger pending');
  } else if (reset) {
    await resetDemoState();
    console.log('reset: trigger pending, run history kept');
  }

  const [summary] = await sql`
    SELECT
      (SELECT count(*) FROM personal_skills WHERE user_id = ${DEMO_USER.id})::int AS skills,
      (SELECT count(*) FROM skill_steps WHERE skill_id = ${skills[0].id})::int AS cancel_steps,
      (SELECT count(*) FROM skill_triggers WHERE skill_id = ${skills[0].id})::int AS cancel_triggers,
      (SELECT count(*) FROM skill_preferences WHERE skill_id = ${skills[0].id})::int AS cancel_prefs,
      (SELECT count(*) FROM skill_runs WHERE user_id = ${DEMO_USER.id})::int AS demo_runs,
      (SELECT run_count || '/' || success_count FROM personal_skills WHERE id = ${skills[0].id}) AS cancel_counts,
      (SELECT state FROM incoming_triggers WHERE id = ${t.id}) AS trigger_state`;
  console.log(summary);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

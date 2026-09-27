import assert from "node:assert/strict";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";

import { loadMigrations } from "./migrations.ts";

/** 0023 운영 상태에 레거시 기록이 있는 경우를 재현해 0024 백필을 검증한다. */
export async function verifyReviewRecordUpgrade(): Promise<void> {
  const upgrade = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  try {
    const root = new URL("../..", import.meta.url).pathname;
    const migrations = loadMigrations(root);
    for (const migration of migrations.filter((m) => m.version <= "0023")) {
      await upgrade.exec(`BEGIN;${migration.sql}COMMIT;`);
    }

    const leadId = "00000000-0000-4000-8000-000000000024";
    const frameId = "00000000-0000-4000-8000-000000000025";
    await upgrade.exec(`
      INSERT INTO event_lead (id, source, source_key, title, observed_at, raw, state)
      VALUES (
        '${leadId}', 'vod_title', 'review-upgrade', 'review upgrade', now(),
        '{"candidates":[{"id":"candidate-1","at":[10,20],"conclusion":"unresolved","match_id":"not-created-yet","observed":"scoreboard","why":"winner hidden","open_questions":["find another POV"]}]}'::jsonb,
        'confirmed'
      );
      INSERT INTO match (match_id, queue_id, game_creation, winning_team, source, origin, result_evidence)
      VALUES ('review-upgrade:match', 0, now(), 100, 'manual', 'vod_scan', 'blue victory');
      INSERT INTO match_evidence_frame (id, lead_id, frame_path, at_sec, kind, note, read_at)
      VALUES ('${frameId}', '${leadId}', 'out/upgrade.jpg', 10, 'result', 'result screen', now());
    `);

    const migration = migrations.find((m) => m.version === "0024");
    assert.ok(migration, "0024 migration must exist");
    await upgrade.exec(`BEGIN;${migration.sql}COMMIT;`);

    const records = (await upgrade.query<{
      type: string; body: string; candidate_id: string | null; frame_id: string | null; match_id: string | null;
    }>(`SELECT type, body, candidate_id, frame_id, match_id FROM review_record ORDER BY type, body`)).rows;
    assert.equal(records.length, 5);
    assert.deepEqual(records.map((r) => [r.type, r.body]), [
      ["assessment", "winner hidden"],
      ["final_evidence", "blue victory"],
      ["observation", "result screen"],
      ["observation", "scoreboard"],
      ["question", "find another POV"],
    ]);
    assert.equal(records.find((r) => r.candidate_id)?.match_id, null,
      "a candidate may point at a match that has not been created yet");
    assert.equal(records.find((r) => r.frame_id)?.frame_id, frameId);

    const legacy = (await upgrade.query<{ note: string; result_evidence: string }>(`
      SELECT f.note, m.result_evidence
        FROM match_evidence_frame f CROSS JOIN match m
       WHERE f.id='${frameId}' AND m.match_id='review-upgrade:match'
    `)).rows[0];
    assert.deepEqual(legacy, { note: "result screen", result_evidence: "blue victory" },
      "expand migration must preserve compatibility columns");
    console.log("Review record migration: 0023 upgrade, backfill, dangling candidate match and legacy preservation passed");
  } finally {
    await upgrade.close();
  }
}

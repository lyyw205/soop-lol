/**
 * 분류·수집 뼈대 초안(db/migrations/0089_classification_skeleton.sql)을 메모리 DB 에서 끝까지 돌려 본다 — 계획 §8 1단계.
 *
 *   1) 마이그레이션 전부 적용 → **옛 구조**로 실제 경우들을 넣는다(엑셀 CK·VOD 직접 연결·토너먼트 코드·지울/남길 공개 큐·
 *      FC 친선·사람의 제외·숨긴 계정·계정 없이 사람만 확인된 자리·보너스·검수 완료).
 *   2) 초안 적용.
 *   3) 대조 — 건수가 아니라 ID·값 집합으로(§8): 남은 경기 = 전 − 삭제 목록, 참가자 기본 칸·보너스·숨김·검수 완료·잠금이 같다,
 *      옛 kind → 새 format 매핑, 제외 표, 상대전적 대칭.
 *   4) 새 불변식이 잘못된 행을 실제로 거부하는가, 공개 뷰가 규칙대로 내고 빼는가, 트리거가 지운 칸을 읽지 않는가.
 *
 * 운영 DB 는 건드리지 않는다(빈 메모리 DB 만 만든다).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FORMATS_BY_GAME } from "../packages/core/lib/metrics/format.ts";
import { mirror, pairSetOutcome, tally, type Outcome } from "../packages/core/lib/metrics/tally.ts";
import { disposablePglite } from "./lib/disposable-pglite.ts";
import { applyAll } from "./lib/migrations.ts";

const ROOT = join(import.meta.dirname, "..");
const DRAFT = readFileSync(join(ROOT, "db/migrations/0089_classification_skeleton.sql"), "utf8");
const DUO1 = "jAu-Fy-yQ96GJFQtR4mbyYIiumZdM8v3dmyaPu4dQuAslWnjeiGfKLJmu2-yQe79gBdWbKDpZmTivA";
const DUO2 = "hmeMsJn7_kn3-w6SLpjVBC59hkbzfdiTi6hOWv2aSpbIgYBJCnf8hUigsdf7seukt7x0eV610pO9fw";

const pg = await disposablePglite();
const db = pg.database;
const q = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows;
const one = async <T = Record<string, unknown>>(sql: string) => (await q<T>(sql))[0];
let passed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message.split("\n").join("\n    ")}`); process.exitCode = 1; }
};
/** 저장이 거부되는지 — 트랜잭션 안에서 시도하고 언제나 되돌린다(통과해 버려도 행이 남지 않는다). */
const rejects = async (sql: string, why: RegExp | string) => {
  let error: Error | null = null;
  await db.exec("BEGIN");
  try { await db.exec(sql); } catch (e) { error = e as Error; } finally { await db.exec("ROLLBACK"); }
  if (!error) throw new Error(`거부되어야 했다: ${sql.slice(0, 120)}`);
  if (why instanceof RegExp ? !why.test(error.message) : !error.message.includes(why)) throw new Error(`다른 이유로 실패: ${error.message}`);
};

try {
  await applyAll((s) => db.exec(s), ROOT, { before: "0089" });

  // ── 1. 옛 구조의 실제 경우들 ───────────────────────────────────────────────
  await db.exec(`
    INSERT INTO streamer (id, slug, display_name) VALUES
      ('00000000-0000-0000-0000-00000000000a', 'sa', '에이'),
      ('00000000-0000-0000-0000-00000000000b', 'sb', '비'),
      ('00000000-0000-0000-0000-00000000000c', 'sc', '씨');
    INSERT INTO streamer (id, slug, display_name, visibility) VALUES ('00000000-0000-0000-0000-0000000000ff', 'shid', '숨김', 'hidden');
    INSERT INTO riot_account (puuid) VALUES ('pA'), ('pB'), ('pBalt'), ('pC'), ('${DUO1}'), ('${DUO2}');
    INSERT INTO streamer_account (streamer_id, puuid, visibility) VALUES
      ('00000000-0000-0000-0000-00000000000a', 'pA', 'public'),
      ('00000000-0000-0000-0000-00000000000b', 'pB', 'public'),
      ('00000000-0000-0000-0000-00000000000b', 'pBalt', 'hidden'),
      ('00000000-0000-0000-0000-00000000000c', 'pC', 'public'),
      ('00000000-0000-0000-0000-00000000000c', '${DUO1}', 'public'),
      ('00000000-0000-0000-0000-00000000000a', '${DUO2}', 'public');

    INSERT INTO event (id, slug, name, kind, game_code) VALUES
      ('10000000-0000-0000-0000-000000000001', 'ck-1', '에이팀 vs 비팀 CK', 'ck', 'lol'),
      ('10000000-0000-0000-0000-000000000002', 'land-1', '랜드', 'land', 'lol'),
      ('10000000-0000-0000-0000-000000000003', 'meljang-1', '멸망전', 'tournament', 'lol'),
      ('10000000-0000-0000-0000-000000000004', 'other-1', '서도일 방송 5대5 내전', 'other', 'lol'),
      ('10000000-0000-0000-0000-000000000005', 'other-empty', '경기 없는 행사', 'other', 'lol'),
      ('20000000-0000-0000-0000-000000000001', 'fc-tour', 'FC 대회', 'tournament', 'fconline'),
      ('20000000-0000-0000-0000-000000000002', 'fc-scrim', 'FC 스크림', 'scrim', 'fconline'),
      ('20000000-0000-0000-0000-000000000003', 'fc-show', 'FC 이벤트전', 'showmatch', 'fconline');

    INSERT INTO match_series (id, game_code, event_id) VALUES
      ('ck-1:s1', 'lol', '10000000-0000-0000-0000-000000000001'),
      ('ck-1:s2', 'lol', '10000000-0000-0000-0000-000000000001'),
      ('ck-1:aram', 'lol', '10000000-0000-0000-0000-000000000001'),
      ('land-1:land', 'lol', '10000000-0000-0000-0000-000000000002'),
      ('meljang-1:g1', 'lol', '10000000-0000-0000-0000-000000000003'),
      ('excel-ck-2026-09-01 1', 'lol', NULL);

    -- 롤 판
    INSERT INTO match (match_id, game_code, source, origin, game_creation, queue_id, game_mode, event_id, series_id, series_game_no, set_role, set_label, visibility) VALUES
      ('ck1', 'lol', 'manual', 'vod_scan', '2026-09-03 20:00+09', 0, 'CLASSIC', NULL, 'ck-1:s1', 1, 'main', NULL, 'public'),
      ('ck2', 'lol', 'manual', 'vod_scan', '2026-09-03 20:40+09', 0, 'CLASSIC', NULL, 'ck-1:s1', 2, 'main', NULL, 'public'),
      ('ck3', 'lol', 'manual', 'vod_scan', '2026-09-03 21:20+09', 0, 'CLASSIC', NULL, 'ck-1:s1', 3, 'main', NULL, 'public'),
      ('ckb', 'lol', 'manual', 'vod_scan', '2026-09-03 22:00+09', 0, 'CLASSIC', NULL, 'ck-1:s1', 4, 'bonus', '범인찾기', 'public'),
      ('ckh', 'lol', 'manual', 'vod_scan', '2026-09-04 20:00+09', 0, 'CLASSIC', NULL, 'ck-1:s2', 1, 'main', NULL, 'public'),
      ('cka', 'lol', 'manual', 'vod_scan', '2026-09-04 22:00+09', 0, 'ARAM', NULL, 'ck-1:aram', 1, 'main', NULL, 'public'),
      ('ld1', 'lol', 'manual', 'vod_scan', '2026-09-05 20:00+09', 0, 'CLASSIC', NULL, 'land-1:land', 1, 'main', NULL, 'public'),
      ('ld2', 'lol', 'manual', 'vod_scan', '2026-09-05 20:40+09', 0, 'CLASSIC', NULL, 'land-1:land', 2, 'main', NULL, 'public'),
      ('ld3', 'lol', 'manual', 'vod_scan', '2026-09-05 21:20+09', 0, 'CLASSIC', NULL, 'land-1:land', 3, 'main', NULL, 'public'),
      ('dir', 'lol', 'manual', 'vod_scan', '2026-09-06 20:00+09', 0, 'CLASSIC', '10000000-0000-0000-0000-000000000004', NULL, NULL, 'main', NULL, 'public'),
      ('wk1', 'lol', 'manual', 'wiki_seed', '2020-05-01 18:00+09', 0, NULL, NULL, 'meljang-1:g1', 1, 'main', NULL, 'public'),
      ('xs1', 'lol', 'manual', 'admin', '2026-09-01 00:00+09', 0, NULL, NULL, 'excel-ck-2026-09-01 1', 1, 'main', NULL, 'public'),
      ('xs2', 'lol', 'manual', 'admin', '2026-09-01 00:00+09', 0, NULL, NULL, 'excel-ck-2026-09-01 1', 2, 'main', NULL, 'public'),
      ('xl1', 'lol', 'manual', 'admin', '2026-09-02 00:00+09', 0, NULL, NULL, NULL, NULL, 'main', NULL, 'public'),
      ('xl2', 'lol', 'manual', 'admin', '2026-09-02 00:00+09', 0, NULL, NULL, NULL, NULL, 'main', NULL, 'hidden');
    INSERT INTO match (match_id, game_code, source, game_creation, queue_id, game_mode, platform_id, riot_game_id, tournament_code) VALUES
      ('KR_c1', 'lol', 'tournament_code', '2026-09-07 21:00+09', 3130, 'CLASSIC', 'KR', 1, 'KR0-code'),
      ('KR_c2', 'lol', 'tournament_code', '2026-09-07 23:30+09', 3130, 'CLASSIC', 'KR', 2, NULL),
      ('KR_keep', 'lol', 'public_queue', '2026-09-10 01:00+09', 420, 'CLASSIC', 'KR', 3, NULL),
      ('KR_old', 'lol', 'public_queue', '2026-08-01 01:00+09', 420, 'CLASSIC', 'KR', 4, NULL),
      ('KR_other', 'lol', 'public_queue', '2026-09-10 01:00+09', 420, 'CLASSIC', 'KR', 5, NULL),
      ('KR_arena', 'lol', 'public_queue', '2026-09-11 01:00+09', 1700, 'CHERRY', 'KR', 6, NULL);

    -- 참가자 (상세 칸은 공개 큐 판에만 — 실제처럼)
    INSERT INTO match_participant (match_id, participant_id, puuid, streamer_id, observed_name, team_id, team_position, champion_id, kills, deaths, assists, outcome) VALUES
      ('ck1', 1, 'pA', NULL, NULL, 100, 'MIDDLE', 1, 5, 1, 3, 'win'),  ('ck1', 2, 'pB', NULL, NULL, 200, 'MIDDLE', 2, 1, 5, 0, 'loss'),
      ('ck2', 1, 'pA', NULL, NULL, 100, 'MIDDLE', 1, 0, 3, 1, 'loss'), ('ck2', 2, 'pB', NULL, NULL, 200, 'MIDDLE', 2, 3, 0, 2, 'win'),
      ('ck3', 1, 'pA', NULL, NULL, 100, 'MIDDLE', 3, 7, 2, 4, 'win'),  ('ck3', 2, 'pB', NULL, NULL, 200, 'MIDDLE', 4, 2, 7, 1, 'loss'),
      ('ckb', 1, 'pA', NULL, NULL, 100, 'MIDDLE', 3, 1, 1, 1, 'loss'), ('ckb', 2, 'pB', NULL, NULL, 200, 'MIDDLE', 4, 1, 1, 1, 'win'),
      -- 숨긴 계정 자리: 계정 규칙이 이긴다(streamer_id 가 있어도 빠진다)
      ('ckh', 1, 'pA', NULL, NULL, 100, 'TOP', 5, 1, 1, 1, 'win'),     ('ckh', 2, 'pBalt', '00000000-0000-0000-0000-00000000000b', NULL, 200, 'TOP', 6, 1, 1, 1, 'loss'),
      ('cka', 1, 'pA', NULL, NULL, 100, NULL, 7, 9, 9, 9, 'win'),      ('cka', 2, 'pB', NULL, NULL, 200, NULL, 8, 9, 9, 9, 'loss'),
      ('ld1', 1, 'pA', NULL, NULL, 100, 'TOP', 1, 1, 1, 1, 'win'),     ('ld1', 2, 'pB', NULL, NULL, 200, 'TOP', 2, 1, 1, 1, 'loss'),
      ('ld2', 1, 'pA', NULL, NULL, 200, 'TOP', 1, 1, 1, 1, 'win'),     ('ld2', 2, 'pB', NULL, NULL, 100, 'TOP', 2, 1, 1, 1, 'loss'),
      ('ld3', 1, 'pA', NULL, NULL, 100, 'TOP', 1, 1, 1, 1, 'loss'),    ('ld3', 2, 'pB', NULL, NULL, 200, 'TOP', 2, 1, 1, 1, 'win'),
      -- 계정 없이 사람만 확인된 자리(0021) + 미등록 이름 자리
      ('dir', 1, NULL, '00000000-0000-0000-0000-00000000000a', NULL, 100, 'MIDDLE', 1, 2, 2, 2, 'win'),
      ('dir', 2, 'pC', NULL, NULL, 200, 'MIDDLE', 2, 2, 2, 2, 'loss'),
      ('dir', 3, NULL, NULL, '시청자1', 200, 'TOP', 3, 0, 0, 0, 'loss'),
      ('wk1', 1, NULL, '00000000-0000-0000-0000-00000000000a', NULL, 100, NULL, NULL, NULL, NULL, NULL, 'win'),
      ('wk1', 2, NULL, '00000000-0000-0000-0000-00000000000c', NULL, 200, NULL, NULL, NULL, NULL, NULL, 'loss'),
      ('xs1', 1, NULL, '00000000-0000-0000-0000-00000000000a', NULL, 100, 'MIDDLE', 1, 1, 1, 1, 'win'),
      ('xs1', 2, NULL, '00000000-0000-0000-0000-00000000000b', NULL, 200, 'MIDDLE', 2, 1, 1, 1, 'loss'),
      ('xs2', 1, NULL, '00000000-0000-0000-0000-00000000000a', NULL, 100, 'MIDDLE', 1, 1, 1, 1, 'unknown'),
      ('xs2', 2, NULL, '00000000-0000-0000-0000-00000000000b', NULL, 200, 'MIDDLE', 2, 1, 1, 1, 'unknown'),
      ('xl1', 1, NULL, '00000000-0000-0000-0000-00000000000b', NULL, 100, 'TOP', 1, 1, 1, 1, 'win'),
      ('xl1', 2, NULL, '00000000-0000-0000-0000-00000000000c', NULL, 200, 'TOP', 2, 1, 1, 1, 'loss'),
      ('xl2', 1, NULL, '00000000-0000-0000-0000-00000000000b', NULL, 100, 'TOP', 1, 1, 1, 1, 'win'),
      ('KR_c1', 1, 'pA', NULL, NULL, 100, 'MIDDLE', 1, 1, 1, 1, 'win'), ('KR_c1', 2, 'stranger1', NULL, NULL, 200, 'MIDDLE', 2, 1, 1, 1, 'loss'),
      ('KR_c2', 1, 'pB', NULL, NULL, 100, 'MIDDLE', 1, 1, 1, 1, 'win'), ('KR_c2', 2, 'stranger2', NULL, NULL, 200, 'MIDDLE', 2, 1, 1, 1, 'loss');
    INSERT INTO match_participant (match_id, participant_id, puuid, team_id, team_position, champion_id, kills, deaths, assists, outcome, cs, gold_earned, damage_to_champions, vision_score, items, summoner1_id, perks, challenges) VALUES
      ('KR_keep', 1, '${DUO1}', 100, 'TOP', 1, 4, 2, 6, 'win', 180, 11000, 21000, 20, ARRAY[1,2], 4, '{"styles":[{"selections":[{"perk":8010}]},{"style":8400}]}', '{"kda":5}'),
      ('KR_keep', 2, 'stranger3', 200, 'TOP', 2, 2, 4, 1, 'loss', 150, 9000, 15000, 10, ARRAY[3], 4, '{}', '{}'),
      ('KR_old', 1, '${DUO1}', 100, 'TOP', 1, 1, 1, 1, 'win', 1, 1, 1, 1, NULL, NULL, NULL, NULL),
      ('KR_other', 1, 'pA', 100, 'TOP', 1, 1, 1, 1, 'win', 1, 1, 1, 1, NULL, NULL, NULL, NULL),
      ('KR_arena', 1, '${DUO1}', 100, NULL, 1, 1, 1, 1, 'win', 1, 1, 1, 1, NULL, NULL, NULL, NULL);

    -- FC
    INSERT INTO fco_account (ouid, nickname) VALUES ('oA', '에이FC'), ('oB', '비FC'), ('oC', '씨FC'), ('oX', '일반인');
    INSERT INTO streamer_fco_account (ouid, streamer_id) VALUES
      ('oA', '00000000-0000-0000-0000-00000000000a'), ('oB', '00000000-0000-0000-0000-00000000000b'), ('oC', '00000000-0000-0000-0000-00000000000c');
    INSERT INTO match (match_id, game_code, source, game_creation, mode_key, event_id) VALUES
      ('f_p1', 'fconline', 'provider_api', '2026-09-08 20:00+09', '40', NULL),
      ('f_p2', 'fconline', 'provider_api', '2026-09-08 20:30+09', '40', NULL),
      ('f_solo', 'fconline', 'provider_api', '2026-09-08 21:00+09', '50', NULL),
      ('f_tour', 'fconline', 'provider_api', '2026-09-09 20:00+09', '40', '20000000-0000-0000-0000-000000000001'),
      ('f_excl', 'fconline', 'provider_api', '2026-09-09 19:00+09', '40', NULL),
      ('f_scrim', 'fconline', 'provider_api', '2026-09-09 18:00+09', '40', '20000000-0000-0000-0000-000000000002'),
      ('f_show', 'fconline', 'provider_api', '2026-09-09 17:00+09', '40', '20000000-0000-0000-0000-000000000003');
    INSERT INTO fco_match_participant (match_id, ouid, nickname, streamer_id, side_no, outcome, goals) VALUES
      ('f_p1', 'oA', '에이FC', '00000000-0000-0000-0000-00000000000a', 1, 'win', 2),  ('f_p1', 'oB', '비FC', '00000000-0000-0000-0000-00000000000b', 2, 'loss', 1),
      ('f_p2', 'oA', '에이FC', '00000000-0000-0000-0000-00000000000a', 1, 'loss', 0), ('f_p2', 'oB', '비FC', '00000000-0000-0000-0000-00000000000b', 2, 'loss', 0),
      ('f_solo', 'oA', '에이FC', '00000000-0000-0000-0000-00000000000a', 1, 'win', 3), ('f_solo', 'oX', '일반인', NULL, 2, 'loss', 0),
      ('f_tour', 'oA', '에이FC', '00000000-0000-0000-0000-00000000000a', 1, 'draw', 1), ('f_tour', 'oB', '비FC', '00000000-0000-0000-0000-00000000000b', 2, 'draw', 1),
      ('f_excl', 'oA', '에이FC', '00000000-0000-0000-0000-00000000000a', 1, 'win', 1), ('f_excl', 'oC', '씨FC', '00000000-0000-0000-0000-00000000000c', 2, 'loss', 0),
      ('f_scrim', 'oB', '비FC', '00000000-0000-0000-0000-00000000000b', 1, 'win', 1), ('f_scrim', 'oC', '씨FC', '00000000-0000-0000-0000-00000000000c', 2, 'loss', 0),
      ('f_show', 'oB', '비FC', '00000000-0000-0000-0000-00000000000b', 1, 'win', 1), ('f_show', 'oC', '씨FC', '00000000-0000-0000-0000-00000000000c', 2, 'loss', 0);
    INSERT INTO fco_event_match_decision (event_id, match_id, decision, created_by, note) VALUES
      ('20000000-0000-0000-0000-000000000001', 'f_excl', 'include', 'auto', '같은 날'),
      ('20000000-0000-0000-0000-000000000001', 'f_excl', 'exclude', 'admin', '개막 전 연습');  -- 같은 시각 — 사람이 이긴다
    INSERT INTO fco_match_context (match_id, judgment, note, created_by) VALUES
      ('f_p1', 'casual', '행사 단서 없음', 'auto'), ('f_p2', 'unresolved', '그 시각 VOD 없음', 'auto');

    -- 검수 상태와 사람 손 기록
    UPDATE match SET review_completed_at = '2026-10-01 00:00+09' WHERE match_id IN ('ck1', 'dir', 'xs1', 'KR_c1', 'wk1');
    UPDATE match SET reviewed_at = '2026-10-01 00:00+09' WHERE match_id IN ('ck2', 'dir');
    INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor) VALUES
      ('ck2', 'participant', '1', 'kills', '1', '0', 'admin'),
      (NULL, 'series', 'ck-1:s1', 'best_of', NULL, '3', 'admin');
  `);

  // ── 이관 전 상태(대조 기준) ─────────────────────────────────────────────────
  const DELETED = ["KR_old", "KR_other", "KR_arena"];
  const baseCols = "match_id, participant_id, puuid, streamer_id, observed_name, team_id, side_no, team_position, individual_position, champion_id, champion_name, champ_level, kills, deaths, assists, outcome";
  const before = {
    ids: (await q<{ match_id: string }>(`SELECT match_id FROM match ORDER BY 1`)).map((r) => r.match_id),
    parts: JSON.stringify(await q(`SELECT ${baseCols} FROM match_participant WHERE match_id <> ALL (ARRAY['${DELETED.join("','")}']) ORDER BY 1, 2`)),
    state: JSON.stringify(await q(`SELECT match_id, set_role, set_label, visibility, review_completed_at, review_version, reviewed_at, context_review_completed_at, context_review_version FROM match WHERE match_id <> ALL (ARRAY['${DELETED.join("','")}']) ORDER BY 1`)),
    seriesOf: new Map((await q<{ match_id: string; series_id: string | null; series_game_no: number | null }>(`SELECT match_id, series_id, series_game_no FROM match WHERE series_id IS NOT NULL`)).map((r) => [r.match_id, `${r.series_id}#${r.series_game_no}`])),
    changes: JSON.stringify(await q(`SELECT id, match_id, entity, entity_key, field, before, after, actor FROM review_change ORDER BY id`)),
  };

  // ── 2. 초안 적용 ───────────────────────────────────────────────────────────
  await db.exec(`BEGIN;\n${DRAFT}\nCOMMIT;`);
  console.log("초안 적용 완료 — 대조:");

  // ── 3. 옮겨 담기 대조 ───────────────────────────────────────────────────────
  await check("남은 경기 ID = 전 − 삭제 목록(공개 큐: 지명 범위 밖·시작 전·다른 큐)", async () => {
    const ids = (await q<{ match_id: string }>(`SELECT match_id FROM match ORDER BY 1`)).map((r) => r.match_id);
    assert.deepEqual(ids, before.ids.filter((i) => !DELETED.includes(i)));
  });
  await check("참가자 기본 칸 값이 그대로", async () => {
    assert.equal(JSON.stringify(await q(`SELECT ${baseCols} FROM match_participant ORDER BY 1, 2`)), before.parts);
  });
  await check("보너스·숨김·검수 완료·버전·잠금(reviewed_at)·FC 맥락 확인이 그대로", async () => {
    assert.equal(JSON.stringify(await q(`SELECT match_id, set_role, set_label, visibility, review_completed_at, review_version, reviewed_at, context_review_completed_at, context_review_version FROM match ORDER BY 1`)), before.state);
  });
  await check("기존 시리즈 키·세트 번호는 바뀌지 않는다(사람 손 기록의 주소)", async () => {
    for (const [id, key] of before.seriesOf) {
      const r = await one<{ k: string }>(`SELECT series_id || '#' || series_game_no AS k FROM match WHERE match_id = '${id}'`);
      assert.equal(r?.k, key, id);
    }
  });
  await check("옛 review_change 는 한 줄도 바뀌지 않는다", async () => {
    assert.equal(JSON.stringify(await q(`SELECT id, match_id, entity, entity_key, field, before, after, actor FROM review_change WHERE entity <> 'classification' ORDER BY id`)), before.changes);
  });
  await check("옛 kind → 새 format 매핑(경기 없는 옛 행사는 지움)", async () => {
    const rows = Object.fromEntries((await q<{ slug: string; format: string }>(`SELECT slug, format FROM event`)).map((r) => [r.slug, r.format]));
    assert.equal(rows["ck-1"], "ck"); assert.equal(rows["land-1"], "land"); assert.equal(rows["meljang-1"], "tournament");
    assert.equal(rows["other-1"], "unclassified"); assert.equal(rows["fc-tour"], "tournament");
    assert.equal(rows["fc-scrim"], "unclassified", "FC 에는 스크림이 없다 — 사용자 지정 대기");
    assert.equal(rows["fc-show"], "concept");
    assert.equal(rows["other-empty"], undefined);
  });
  await check("VOD 행사 직접 연결 → 같은 행사의 한 판짜리 시리즈", async () => {
    const r = await one<{ series_id: string; series_game_no: number; slug: string }>(`SELECT m.series_id, m.series_game_no, e.slug FROM match m JOIN match_series ms ON ms.id = m.series_id JOIN event e ON e.id = ms.event_id WHERE m.match_id = 'dir'`);
    assert.deepEqual(r, { series_id: "set:dir", series_game_no: 1, slug: "other-1" });
  });
  await check("엑셀 CK → 날짜별 CK 행사(시리즈 있던 것은 시리즈째, 없던 것은 한 판 시리즈, 숨김은 숨김)", async () => {
    const r = await q<{ match_id: string; series_id: string; slug: string; format: string }>(`SELECT m.match_id, m.series_id, e.slug, e.format FROM match m JOIN match_series ms ON ms.id = m.series_id JOIN event e ON e.id = ms.event_id WHERE m.match_id IN ('xs1','xs2','xl1','xl2') ORDER BY 1`);
    assert.deepEqual(r.map((x) => [x.match_id, x.series_id, x.slug, x.format]), [
      ["xl1", "set:xl1", "ck-import-2026-09-02", "ck"], ["xl2", "set:xl2", "ck-import-2026-09-02", "ck"],
      ["xs1", "excel-ck-2026-09-01 1", "ck-import-2026-09-01", "ck"], ["xs2", "excel-ck-2026-09-01 1", "ck-import-2026-09-01", "ck"]]);
  });
  await check("토너먼트 코드 → 날짜별 자동 미분류 묶음(분류 경로가 아니다)", async () => {
    const r = await q<{ slug: string; format: string; auto_bucket: boolean }>(`SELECT DISTINCT e.slug, e.format, e.auto_bucket FROM match m JOIN match_series ms ON ms.id = m.series_id JOIN event e ON e.id = ms.event_id WHERE m.match_id IN ('KR_c1','KR_c2')`);
    assert.deepEqual(r, [{ slug: "lol-code-auto-2026-09-07", format: "unclassified", auto_bucket: true }]);
  });
  await check("FC 스트리머끼리 → (두 사람, 날짜) 묶음 / 한쪽만 스트리머 → 개인 기록 / 행사 직접 → 한 판 시리즈", async () => {
    const r = Object.fromEntries((await q<{ match_id: string; scope: string; slug: string | null }>(`SELECT m.match_id, m.scope, e.slug FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id LEFT JOIN event e ON e.id = ms.event_id WHERE m.game_code = 'fconline'`)).map((x) => [x.match_id, `${x.scope}:${x.slug}`]));
    const bucket = "versus:fc-auto-2026-09-08-00000000-0000-0000-0000-00000000000a-00000000-0000-0000-0000-00000000000b";
    assert.equal(r.f_p1, bucket); assert.equal(r.f_p2, bucket);
    assert.equal(r.f_solo, "personal:null");
    assert.equal(r.f_tour, "versus:fc-tour");
    assert.match(r.f_excl!, /^versus:fc-auto-2026-09-09-/, "사람이 뺀 판은 묶음으로");
  });
  await check("사람의 제외는 현재 제약으로 남는다 / 판단 메모는 이력으로", async () => {
    assert.deepEqual(await q(`SELECT e.slug, x.match_id, x.decided_by, x.note FROM event_exclusion x JOIN event e ON e.id = x.event_id`),
      [{ slug: "fc-tour", match_id: "f_excl", decided_by: "admin", note: "개막 전 연습" }]);
    const notes = await q<{ after: { judgment: string } }>(`SELECT after FROM review_change WHERE field = 'fco_match_context' ORDER BY match_id`);
    assert.deepEqual(notes.map((n) => n.after.judgment), ["casual", "unresolved"]);
  });
  await check("공개 큐: 지명 범위만 개인 기록으로, 상세는 지명 계정만", async () => {
    assert.deepEqual(await q(`SELECT match_id, scope FROM match WHERE collected_via = 'api' AND game_code = 'lol' AND scope = 'personal'`), [{ match_id: "KR_keep", scope: "personal" }]);
    assert.deepEqual(await q(`SELECT match_id, participant_id, cs FROM lol_participant_detail`), [{ match_id: "KR_keep", participant_id: 1, cs: 180 }]);
  });
  await check("옛 분류 체계가 남아 있지 않다", async () => {
    const cols = await q<{ c: string }>(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'
      AND ((table_name = 'match' AND column_name IN ('event_id','source','origin','has_timeline')) OR (table_name = 'event' AND column_name = 'kind')
        OR (table_name = 'match_participant' AND column_name IN ('cs','perks','challenges','lane')) OR (table_name = 'schedule_entry' AND column_name = 'planned_kind'))`);
    assert.deepEqual(cols, []);
    assert.deepEqual(await q(`SELECT proname FROM pg_proc WHERE proname = 'lol_match_category'`), []);
    assert.deepEqual(await q(`SELECT relname FROM pg_class WHERE relname IN ('streamer_encounter','champion_stat','ingest_cursor','fco_match_context','fco_event_match_decision') AND relkind = 'r'`), []);
  });

  await check("DB 함수 본문이 지운 칸·표를 참조하지 않는다(plpgsql 은 실행 전까지 오류가 안 난다)", async () => {
    // 지운 표·함수 이름, 경기(m)의 지운 칸, match·event 트리거(NEW/OLD)의 지운 칸, 행사(e·ev)의 kind.
    // 다른 표의 자기 event_id(event_slot_match·event_slot_decision·match_series)는 남는 칸이라 걸지 않는다.
    const OLD = /\b(lol_match_category|streamer_encounter|champion_stat|ingest_cursor|fco_match_context|fco_event_match_decision|planned_kind)\b|\bm\.(source|origin|event_id)\b|\b(NEW|OLD)\.(source|origin|kind)\b|\b(e|ev)\.kind\b/g;
    const fns = await q<{ name: string; src: string }>(`SELECT n.nspname || '.' || p.proname AS name, p.prosrc AS src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'core_public')`);
    const hits = fns.flatMap((f) => [...f.src.matchAll(OLD)].map((m) => `${f.name}: ${m[0]}`));
    assert.deepEqual(hits, []);
  });

  // ── 4. 새 불변식 — 잘못된 행을 실제로 거부하는가 ─────────────────────────────
  await check("scope NULL·허용 밖 값 거부", async () => {
    await rejects(`INSERT INTO match (match_id, game_code, collected_via, game_creation) VALUES ('bad1', 'lol', 'vod', now())`, /scope|null/i);
    await rejects(`INSERT INTO match (match_id, game_code, collected_via, scope, game_creation) VALUES ('bad2', 'lol', 'vod', 'other', now())`, "match_scope_check");
  });
  await check("내전 판은 시리즈 필수 / 개인 기록은 시리즈 금지", async () => {
    await rejects(`INSERT INTO match (match_id, game_code, collected_via, scope, game_creation) VALUES ('bad3', 'lol', 'vod', 'versus', now())`, "match_scope_series");
    await rejects(`INSERT INTO match (match_id, game_code, collected_via, scope, game_creation, series_id, series_game_no) VALUES ('bad4', 'lol', 'api', 'personal', now(), 'ck-1:s1', 9)`, "match_scope_series");
  });
  await check("게임별 허용 진행 방식 / 자동 묶음은 미분류만", async () => {
    await rejects(`INSERT INTO event (slug, name, format, game_code) VALUES ('b1', 'x', 'friendly', 'lol')`, "event_format_by_game");
    await rejects(`INSERT INTO event (slug, name, format, game_code) VALUES ('b2', 'x', 'scrim', 'fconline')`, "event_format_by_game");
    await rejects(`INSERT INTO event (slug, name, format, game_code) VALUES ('b3', 'x', NULL, 'lol')`, /format|null/i);
    await rejects(`INSERT INTO event (slug, name, format, game_code, auto_bucket) VALUES ('b4', 'x', 'ck', 'lol', true)`, "event_auto_bucket_unclassified");
  });
  await check("시리즈는 행사 필수 · 다른 게임 행사 금지", async () => {
    await rejects(`INSERT INTO match_series (id, game_code) VALUES ('bs1', 'lol')`, /event_id|null/i);
    await rejects(`INSERT INTO match_series (id, game_code, event_id) VALUES ('bs2', 'lol', '20000000-0000-0000-0000-000000000001')`, "match_series_event_fk");
  });
  await check("TS 진행 방식 목록 = DB CHECK", async () => {
    const def = (await one<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'event_format_by_game'`))!.d;
    for (const [game, list] of Object.entries(FORMATS_BY_GAME)) {
      const part = new RegExp(`game_code = '${game}'::text\\)[^\\[]*ARRAY\\[([^\\]]*)\\]`).exec(def)?.[1] ?? "";
      const inDb = [...part.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
      assert.deepEqual(inDb, [...list].sort(), game);
    }
  });
  await check("맵은 Riot 사실에서 생긴다 — 롤 칼바람·아레나, FC 는 NULL", async () => {
    const r = Object.fromEntries((await q<{ match_id: string; map: string | null }>(`SELECT match_id, map FROM match WHERE match_id IN ('cka','ck1','f_p1','KR_keep')`)).map((x) => [x.match_id, x.map]));
    assert.deepEqual(r, { ck1: "rift", cka: "aram", f_p1: null, KR_keep: "rift" });
  });

  // ── 5. 공개 뷰 ────────────────────────────────────────────────────────────
  const vs = await q<{ match_id: string; streamer_id: string; outcome: Outcome; series_id: string; format: string; map: string | null; game_code: string }>(`SELECT * FROM core_public.versus_set`);
  const S = { a: "00000000-0000-0000-0000-00000000000a", b: "00000000-0000-0000-0000-00000000000b", c: "00000000-0000-0000-0000-00000000000c" };
  await check("versus_set: FC 판이 빠지지 않는다(맵 NULL 함정)", () => {
    assert.ok(vs.some((r) => r.match_id === "f_p1"), "FC 판이 없다");
  });
  await check("versus_set: 보너스·개인 기록·숨김 판 제외, 칼바람은 맵 aram 으로", () => {
    const ids = new Set(vs.map((r) => r.match_id));
    for (const no of ["ckb", "KR_keep", "f_solo", "xl2"]) assert.ok(!ids.has(no), no);
    assert.equal(vs.find((r) => r.match_id === "cka")?.map, "aram");
  });
  await check("versus_set: 계정 없이 사람만 확인된 자리는 나오고, 숨긴 계정 자리는 streamer_id 가 있어도 빠진다", () => {
    assert.ok(vs.some((r) => r.match_id === "dir" && r.streamer_id === S.a));
    assert.ok(!vs.some((r) => r.match_id === "ckh" && r.streamer_id === S.b));
    assert.ok(vs.some((r) => r.match_id === "ckh" && r.streamer_id === S.a));
  });
  await check("세트·시리즈: CK 2:1 → 세트 2승 1패·시리즈 1승 / 랜드 2승 1패 → 시리즈 1승 / 엑셀 1승 1미상 → 시리즈 미상", () => {
    const of = (series: string) => tally(vs.filter((r) => r.streamer_id === S.a && r.series_id === series));
    assert.deepEqual(of("ck-1:s1"), { sets: { win: 2, draw: 0, loss: 1, unknown: 0 }, series: { win: 1, draw: 0, loss: 0, unknown: 0 } });
    assert.deepEqual(of("land-1:land").series, { win: 1, draw: 0, loss: 0, unknown: 0 });
    assert.deepEqual(of("excel-ck-2026-09-01 1").series, { win: 0, draw: 0, loss: 0, unknown: 1 });
  });
  await check("한 맵 탭 안에서 전체 = 진행 방식 칩 합", () => {
    const a = vs.filter((r) => r.streamer_id === S.a && r.game_code === "lol" && r.map === "rift");
    const all = tally(a);
    const sum = { win: 0, draw: 0, loss: 0, unknown: 0 };
    for (const f of FORMATS_BY_GAME.lol) {
      const t = tally(a.filter((r) => r.format === f));
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += t.series[k];
    }
    assert.deepEqual(sum, all.series);
  });
  await check("상대전적은 언제나 대칭 — 양쪽 몰수(FC 양쪽 패)는 무", async () => {
    const pairs = await q<{ a_streamer_id: string; b_streamer_id: string; relation: string; a_outcome: Outcome; b_outcome: Outcome; series_id: string; match_id: string }>(`SELECT * FROM core_public.versus_pair_set WHERE relation = 'opponent'`);
    const side = (x: string, y: string) => tally(pairs.filter((p) => p.a_streamer_id === x && p.b_streamer_id === y)
      .map((p) => ({ series_id: p.series_id, outcome: pairSetOutcome(p.a_outcome, p.b_outcome) })));
    for (const [x, y] of [[S.a, S.b], [S.a, S.c], [S.b, S.c]] as const) {
      const ab = side(x, y), ba = side(y, x);
      assert.deepEqual(ab.sets, mirror(ba.sets)); assert.deepEqual(ab.series, mirror(ba.series));
    }
    const p2 = pairs.find((p) => p.match_id === "f_p2" && p.a_streamer_id === S.a)!;
    assert.equal(pairSetOutcome(p2.a_outcome, p2.b_outcome), "draw");
  });
  await check("개인 기록 뷰: 지명 판, 상세는 지명 계정만, 일반인 자리는 이름 없이", async () => {
    const r = await q<{ slot: number; streamer_id: string | null; cs: number | null; keystone_id: number | null }>(`SELECT slot, streamer_id, cs, keystone_id FROM core_public.personal_game WHERE match_id = 'KR_keep' ORDER BY slot`);
    assert.deepEqual(r, [{ slot: 1, streamer_id: S.c, cs: 180, keystone_id: 8010 }, { slot: 2, streamer_id: null, cs: null, keystone_id: null }]);
  });
  await check("경기 상세 뷰: 공개 스트리머·미등록 이름 자리만, Riot 일반인·숨긴 계정 자리는 빠진다", async () => {
    const dir = await q<{ participant_id: number; streamer_id: string | null; observed_name: string | null }>(`SELECT participant_id, streamer_id, observed_name FROM core_public.match_detail WHERE match_id = 'dir' ORDER BY 1`);
    assert.deepEqual(dir, [{ participant_id: 1, streamer_id: S.a, observed_name: null }, { participant_id: 2, streamer_id: S.c, observed_name: null }, { participant_id: 3, streamer_id: null, observed_name: "시청자1" }]);
    assert.deepEqual(await q(`SELECT participant_id FROM core_public.match_detail WHERE match_id = 'KR_c1' ORDER BY 1`), [{ participant_id: 1 }]);
    assert.deepEqual(await q(`SELECT participant_id FROM core_public.match_detail WHERE match_id = 'ckh' ORDER BY 1`), [{ participant_id: 1 }]);
  });
  await check("행사 유효 날짜는 시리즈 경유 공개 본게임으로", async () => {
    const r = await one<{ effective_starts_at: Date }>(`SELECT effective_starts_at FROM core_public.event_dates WHERE slug = 'other-1'`);
    assert.equal(new Date(r!.effective_starts_at).toISOString(), "2026-09-06T11:00:00.000Z");
  });

  // ── 6. 트리거가 지운 칸을 읽지 않고, 규칙대로 반응한다 ────────────────────────
  await check("대진표 칸: 그 대회 시리즈의 판만 잇는다(시리즈 경유 한 길)", async () => {
    await db.exec(`INSERT INTO event_stage (id, event_id, stage_no, name, evidence) VALUES ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 1, '본선', '공지');
      INSERT INTO event_slot (id, event_id, stage_id, slot_no, evidence) VALUES ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 1, '공지');`);
    await db.exec(`INSERT INTO event_slot_match (slot_id, event_id, match_id) VALUES ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'f_tour')`);
    await rejects(`INSERT INTO event_slot_match (slot_id, event_id, match_id) VALUES ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'f_p1')`, "같은 게임의 경기가 아니다");
  });
  await check("롤 경기 값 변경 → 검수 완료 해제 / 보너스 지정 변경도 값 변경", async () => {
    await db.exec(`UPDATE match SET game_duration = 1800 WHERE match_id = 'ck1'`);
    assert.equal((await one<{ r: unknown }>(`SELECT review_completed_at AS r FROM match WHERE match_id = 'ck1'`))!.r, null);
    await db.exec(`UPDATE match SET review_completed_at = now() WHERE match_id = 'wk1'`);
    await db.exec(`UPDATE match SET set_label = NULL WHERE match_id = 'wk1'`);  // 값이 그대로면 안 풀린다
    assert.notEqual((await one<{ r: unknown }>(`SELECT review_completed_at AS r FROM match WHERE match_id = 'wk1'`))!.r, null);
  });
  await check("참가자 값 변경 → 검수 해제(기본 칸 트리거)", async () => {
    await db.exec(`UPDATE match_participant SET kills = 9 WHERE match_id = 'dir' AND participant_id = 1`);
    assert.equal((await one<{ r: unknown }>(`SELECT review_completed_at AS r FROM match WHERE match_id = 'dir'`))!.r, null);
  });
  await check("FC 행사 진행 방식 변경 → 그 행사 판의 맥락 확인 해제(시리즈 경유)", async () => {
    await db.exec(`UPDATE match SET context_review_completed_at = now() WHERE match_id = 'f_tour'`);
    await db.exec(`UPDATE event SET format = 'concept' WHERE slug = 'fc-tour'`);
    assert.equal((await one<{ r: unknown }>(`SELECT context_review_completed_at AS r FROM match WHERE match_id = 'f_tour'`))!.r, null);
  });
  await check("시리즈의 행사 이동 → 그 시리즈 판 검수 해제", async () => {
    await db.exec(`UPDATE match SET review_completed_at = now() WHERE match_id = 'xs1'`);
    await db.exec(`UPDATE match_series SET event_id = '10000000-0000-0000-0000-000000000001' WHERE id = 'excel-ck-2026-09-01 1'`);
    assert.equal((await one<{ r: unknown }>(`SELECT review_completed_at AS r FROM match WHERE match_id = 'xs1'`))!.r, null);
  });
} finally {
  await pg.stop();
}
console.log(`\n${passed}개 통과${process.exitCode ? " — 실패 있음" : ""}`);

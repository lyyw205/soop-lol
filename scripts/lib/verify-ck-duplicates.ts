import assert from "node:assert/strict";
import { db } from "../../packages/core/lib/db/client.ts";
import { upsertMatchFromScan, upsertMatchFromScanInTx, type CkMatchInput } from "../../packages/core/lib/db/ck.ts";
import { listDuplicateSuspects, markDistinctMatches, mergeDuplicateMatch } from "../../packages/core/lib/db/ck-duplicates.ts";
import { createStreamer, linkAccount } from "../../packages/core/lib/db/streamers.ts";
import { lolEvent } from "./verify-ck-fixtures.ts";

/** 실제 저장 질의로 오탐·임계값·시각 경계·계정 신원·예외 이력을 검증한다. 폐기용 DB에서만 호출한다. */
export async function verifyCkDuplicatesDb() {
  const sql = db();
  let day = 0;
  const event = await lolEvent("verify-duplicates");
  const input = (id: string, at: Date): CkMatchInput => ({
    match_id: `duplicate-regression:${id}`, event_id: event, played_at: at, played_at_precision: "datetime",
    duration: 1500, winning_team: 100, participants: Array.from({ length: 10 }, (_, i) => ({
      participant_id: i + 1, observed_name: `중복${i}`, team_id: i < 5 ? 100 : 200,
      champion_id: i + 1, kills: i, deaths: i + 1, assists: i + 2,
    })),
  });
  async function pair(label: string, change: (next: CkMatchInput, base: CkMatchInput) => void, rejects: boolean) {
    // 각 사례를 날짜로 분리해 앞 사례가 다음 사례의 차단 후보가 되지 않게 한다.
    const at = new Date(Date.UTC(2030, 0, ++day, 12));
    const base = input(`${label}:a`, at), next = input(`${label}:b`, at);
    change(next, base);
    await upsertMatchFromScan(base);
    if (rejects) {
      await assert.rejects(upsertMatchFromScan(next), new RegExp(base.match_id));
      assert.equal((await sql`SELECT 1 FROM match WHERE match_id=${next.match_id}`).length, 0);
    } else assert.equal(await upsertMatchFromScan(next), true, label);
  }
  // ★ 2026-10-09 정책 변경: 이름이 전부 달라도 열 명의 (승패·챔피언·KDA)가 통째로 같으면 같은 판 후보다.
  //   실제로 같은 판이 오독·미연결 이름 때문에 2~4명만 대응돼 그대로 저장됐다. 다른 판이면 distinct_from 으로 남긴다.
  await pair("different-names-same-values", (n) => { n.participants.forEach(p => { p.observed_name = `다른사람${p.participant_id}`; }); }, true);
  await pair("different-names-seven", (n) => { n.participants.forEach((p, i) => { p.observed_name = `다른사람${i}`; if (i >= 7) p.champion_id = i + 101; }); }, false);
  await pair("different-names-eight", (n) => { n.participants.forEach((p, i) => { p.observed_name = `다른사람${i}`; if (i >= 8) p.champion_id = i + 101; }); }, true);
  await pair("different-names-partial-kda", (n) => { n.participants.forEach((p, i) => { p.observed_name = `다른사람${i}`; if (i >= 7) p.assists = null; }); }, false);
  await pair("repeated-kda", (n) => { n.participants.forEach((p, i) => {
    const source = i < 5 ? 0 : 5;
    p.kills = source; p.deaths = source + 1; p.assists = source + 2; p.champion_id = i + 101;
  }); }, false);
  await pair("different-duration", (n) => { n.duration = 1800; }, false);
  await pair("duration-edge", (n) => { n.duration = 1502; }, true);
  await pair("duration-outside", (n) => { n.duration = 1503; }, false);
  await pair("flip", (n) => { n.winning_team = 200; n.participants.forEach(p => { p.team_id = p.team_id === 100 ? 200 : 100; }); }, true);
  await pair("six-kda", (n) => { n.participants.forEach((p, i) => { p.champion_id = i + 101; if (i >= 6) p.kills = 100; }); }, true);
  await pair("five-only", (n) => { n.participants.forEach((p, i) => { if (i >= 5) { p.champion_id = i + 101; p.kills = 100; } }); }, false);
  await pair("unknown-duration-eight", (n) => { n.duration = null; n.participants.length = 8; }, true);
  await pair("unknown-duration-seven", (n) => { n.duration = null; n.participants.length = 7; }, false);
  await pair("unknown-stored-duration", (_, b) => { b.duration = null; }, true);
  await pair("missing-assists", (n) => { n.participants.forEach((p, i) => { p.assists = null; p.champion_id = i + 101; }); }, false);
  await pair("time-edge", (n) => { n.played_at = new Date(n.played_at.getTime() + 1200_000); }, true);
  await pair("time-outside", (n) => { n.played_at = new Date(n.played_at.getTime() + 1200_001); }, false);
  await pair("date-precision", (n) => { n.played_at_precision = "date"; n.played_at = new Date(n.played_at.getTime() - 12 * 3600_000); }, true);
  await pair("kst-midnight", (n, b) => {
    b.played_at.setUTCHours(14, 55); n.played_at = new Date(b.played_at.getTime() + 10 * 60_000);
  }, true);
  await pair("kst-different-date", (n, b) => {
    b.played_at.setUTCHours(14, 55); b.played_at_precision = "date";
    n.played_at = new Date(b.played_at.getTime() + 10 * 60_000);
  }, false);
  await pair("different-outcome", (n) => { n.winning_team = 200; }, false);
  // 이름이 모호해 사람 대응은 0이어도, 값이 통째로 같으면 이름 무관 일치로 후보가 된다(위 정책 변경).
  await pair("ambiguous-identity", (n, b) => {
    for (const g of [n, b]) g.participants.forEach(p => { p.observed_name = "동명이인"; });
  }, true);
  await pair("ambiguous-identity-different-values", (n, b) => {
    for (const g of [n, b]) g.participants.forEach(p => { p.observed_name = "동명이인"; });
    n.participants.forEach((p, i) => { p.champion_id = i + 101; });
  }, false);

  const at = new Date("2030-03-01T12:00:00Z"), original = input("audit:a", at), distinct = input("audit:b", at);
  await upsertMatchFromScan(original);
  distinct.distinct_from = [original.match_id];
  await upsertMatchFromScan(distinct);
  const [audit] = await sql`SELECT after FROM review_change WHERE match_id=${distinct.match_id} AND field='distinct_from'`;
  assert.deepEqual(audit.after, [original.match_id]);
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  const suspectKeys = async () => new Set((await listDuplicateSuspects()).map(d => pairKey(d.a, d.b)));
  // 사람이 다른 판이라고 확인한 쌍은 의심 목록에 다시 돌아오지 않는다.
  assert.equal((await suspectKeys()).has(pairKey(original.match_id, distinct.match_id)), false, "distinct_from 쌍은 의심 목록에서 빠진다");
  await sql`UPDATE match SET visibility='hidden' WHERE match_id IN (${original.match_id},${distinct.match_id})`;
  assert.equal(await upsertMatchFromScan(input("hidden-candidate", at)), true);

  // 한쪽은 계정만, 다른 쪽은 사람 ID만 알아도 현행 계정 주인으로 같은 사람에 대응한다.
  const accountBase = input("account:a", new Date("2030-04-01T12:00:00Z"));
  const accountNext = input("account:b", accountBase.played_at);
  for (let i = 0; i < 6; i++) {
    const s = await createStreamer({ slug: `duplicate-regression-${i}`, display_name: `중복 신원 ${i}` });
    const puuid = `duplicate-regression-account-${i}`;
    await sql`INSERT INTO riot_account (puuid, game_name, tag_line) VALUES (${puuid}, ${`duplicate${i}`}, 'KR1')`;
    await linkAccount({ streamer_id: s.id, puuid, label: "main", is_main: true,
      evidence: { source: "manual", note: "중복 저장 회귀 검증" }, confidence: "verified" });
    accountBase.participants[i].puuid = puuid; accountBase.participants[i].observed_name = null;
    accountNext.participants[i].streamer_id = s.id; accountNext.participants[i].observed_name = "다른 표기";
  }
  accountNext.participants.length = 6;
  await upsertMatchFromScan(accountBase);
  await assert.rejects(upsertMatchFromScan(accountNext), /duplicate-regression:account:a/);
  const togetherAt = new Date("2030-05-01T12:00:00Z");
  await assert.rejects(sql.begin(tx => Promise.all([
    upsertMatchFromScanInTx(tx, input("same-tx:a", togetherAt)),
    upsertMatchFromScanInTx(tx, input("same-tx:b", togetherAt)),
  ])), /duplicate-regression:same-tx:a/);
  assert.equal((await sql`SELECT 1 FROM match WHERE match_id LIKE 'duplicate-regression:same-tx:%'`).length, 0);
  // ── 저장 뒤에야 드러나는 같은 판(2026-10-09, 확정 중복 14쌍 중 11쌍) ──
  // 먼저 저장된 쪽이 이름만 있는 뼈대면 저장 검사는 비교할 값이 없어 통과한다. 값이 채워지면 의심 목록에 떠야 한다.
  const skeleton = (g: CkMatchInput): CkMatchInput => ({ ...g, duration: null, participants: g.participants.map(p => ({
    ...p, observed_name: `뼈대${p.participant_id}`, champion_id: 0, kills: null, deaths: null, assists: null })) });
  const fill = async (g: CkMatchInput) => { for (const p of g.participants) await sql`
    UPDATE match_participant SET champion_id=${p.champion_id ?? 0}, kills=${p.kills ?? null}, deaths=${p.deaths ?? null}, assists=${p.assists ?? null}
     WHERE match_id=${g.match_id} AND participant_id=${p.participant_id}`; };
  const late = input("late-fill:a", new Date("2030-06-01T12:00:00Z"));
  const lateBase = skeleton(input("late-fill:z", late.played_at));
  await upsertMatchFromScan(lateBase);
  assert.equal(await upsertMatchFromScan(late), true, "뼈대만 있을 때는 저장 검사가 막지 못한다(재현)");
  assert.equal((await suspectKeys()).has(pairKey(late.match_id, lateBase.match_id)), false);
  await fill(input("late-fill:z", late.played_at));
  assert.equal((await suspectKeys()).has(pairKey(late.match_id, lateBase.match_id)), true, "값이 채워지면 의심 목록에 뜬다");

  // 자정 양쪽 + 경기 ID 순서가 시각 순서와 반대(23:55 의 'z', 00:05 의 'a') — 날짜별·ID 순 짝짓기면 빠졌다.
  const night = input("night:a", new Date("2030-06-10T15:05:00Z"));
  const nightBase = skeleton(input("night:z", new Date("2030-06-10T14:55:00Z")));
  await upsertMatchFromScan(nightBase);
  assert.equal(await upsertMatchFromScan(night), true);
  await fill(input("night:z", nightBase.played_at));
  assert.equal((await suspectKeys()).has(pairKey(night.match_id, nightBase.match_id)), true, "자정 양쪽·ID 역순도 짝을 찾는다");

  // 숨긴 경기(정리된 쪽)는 의심 목록에 올리지 않는다.
  await sql`UPDATE match SET visibility='hidden' WHERE match_id=${lateBase.match_id}`;
  assert.equal((await suspectKeys()).has(pairKey(late.match_id, lateBase.match_id)), false, "숨긴 경기는 의심 목록에서 빠진다");
  console.log("  ok   중복 저장 회귀: 사람별 1:1·이름 무관 일치(7/8 경계·불완전 KDA)·시간/날짜 경계·계정 주인·숨김·예외 이력");
  console.log("  ok   중복 의심 조회: 뼈대 뒤 보강·자정 양쪽 ID 역순·distinct_from 제외·숨김 제외");
}

/**
 * 확정된 같은 판 정리(mergeDuplicateMatch) — 미리보기는 아무것도 안 바꾸고, 중간 실패는 통째로 취소되고,
 * 적용은 근거·시점·최종 근거·VOD 후보 연결을 옮긴 뒤 숨기고, 다시 돌리면 할 일이 없다.
 */
export async function verifyCkDuplicateMergeDb() {
  const sql = db();
  const event = await lolEvent("verify-duplicates");
  const game = (id: string, at: Date, name = "합침"): CkMatchInput => ({
    match_id: `duplicate-merge:${id}`, event_id: event, played_at: at, played_at_precision: "datetime",
    duration: null, winning_team: 100, participants: Array.from({ length: 10 }, (_, i) => ({
      participant_id: i + 1, observed_name: `${name}${i}`, team_id: i < 5 ? 100 : 200,
      champion_id: i + 1, kills: i, deaths: i + 1, assists: i + 2,
    })),
  });
  // 저장 검사를 지나게 숨길 쪽을 뼈대로 만든 뒤 값을 채운다 — 실제 중복 11쌍이 생긴 방식 그대로.
  async function savedPair(label: string, at: Date) {
    const keep = game(`${label}:keep`, at), drop = game(`${label}:drop`, at, "오독");
    await upsertMatchFromScan(keep);
    await upsertMatchFromScan({ ...drop, participants: drop.participants.map(p => ({ ...p, champion_id: 0, kills: null, deaths: null, assists: null })) });
    for (const p of drop.participants) await sql`
      UPDATE match_participant SET champion_id=${p.champion_id ?? 0}, kills=${p.kills ?? null}, deaths=${p.deaths ?? null}, assists=${p.assists ?? null}
       WHERE match_id=${drop.match_id} AND participant_id=${p.participant_id}`;
    return { keep: keep.match_id, drop: drop.match_id };
  }
  const { keep, drop } = await savedPair("main", new Date("2030-07-01T12:00:00Z"));
  const L1 = "00000000-0000-4000-8000-0000000d0001", L2 = "00000000-0000-4000-8000-0000000d0002";
  await sql`INSERT INTO event_lead (id, source, source_key, title, observed_at, raw, state) VALUES
    (${L1}, 'vod_title', 'merge-L1', '합침 L1', now(), '{}'::jsonb, 'confirmed'),
    (${L2}, 'vod_title', 'merge-L2', '합침 L2', now(),
     ${sql.json({ candidates: [{ id: "c1", conclusion: "match", match_id: drop }, { id: "c2", conclusion: "unresolved" }] })}, 'confirmed')`;
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source) VALUES
    (${keep}, ${L1}, 'created', 'own'), (${drop}, ${L1}, 'created', 'own'), (${drop}, ${L2}, 'created', 'own')`;
  await sql`INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind) VALUES
    (${L1}, ${keep}, 'keep.jpg', 10, 'result'), (${L1}, ${drop}, 'drop-1.jpg', 11, 'result'), (${L2}, ${drop}, 'drop-2.jpg', 12, 'result')`;
  await sql`INSERT INTO review_record (match_id, type, body, created_by) VALUES (${drop}, 'final_evidence', '숨길 쪽 결과창', 'admin')`;
  const input = { keep, drop, evidence: "두 결과창 대조: 열 명 챔피언·KDA·승패 동일" };
  const state = async () => ({
    frames: (await sql`SELECT frame_path, match_id FROM match_evidence_frame WHERE lead_id IN (${L1}, ${L2}) ORDER BY frame_path`).map(r => `${r.frame_path}>${r.match_id}`),
    povs: (await sql`SELECT match_id, lead_id, role FROM match_pov WHERE lead_id IN (${L1}, ${L2}) ORDER BY match_id, lead_id`).map(r => `${r.match_id}|${r.lead_id}|${r.role}`),
    finals: (await sql`SELECT match_id FROM review_record WHERE type='final_evidence' AND match_id IN (${keep}, ${drop})`).map(r => r.match_id),
    candidate: (await sql`SELECT raw->'candidates' AS c FROM event_lead WHERE id=${L2}`)[0].c,
    visibility: (await sql`SELECT visibility FROM match WHERE match_id=${drop}`)[0].visibility,
    history: (await sql`SELECT count(*)::int AS n FROM review_change WHERE match_id IN (${keep}, ${drop})`)[0].n,
  });
  const before = await state();

  // 1. 미리보기는 계획만 돌려주고 아무것도 바꾸지 않는다.
  const preview = await mergeDuplicateMatch(input, { apply: false });
  assert.equal(preview.frames_moved, 2);
  assert.deepEqual(preview.povs_moved, [L2]);
  assert.deepEqual(preview.povs_kept_on_drop, [L1], "같은 방송의 시점 기록이 양쪽에 있으면 옮기지 않는다");
  assert.equal(preview.final_evidence_moved, true);
  assert.equal(preview.candidates_relinked, 1);
  assert.equal(preview.hidden, true);
  assert.deepEqual(preview.value_differences, []);
  assert.deepEqual(await state(), before, "미리보기는 DB 를 바꾸지 않는다");

  // 2. 숨기는 단계에서 실패하면 앞서 옮긴 것까지 통째로 취소된다.
  await sql.unsafe(`CREATE FUNCTION merge_fail_hide() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.match_id = '${drop}' AND NEW.visibility = 'hidden' THEN RAISE EXCEPTION 'merge-test-boom'; END IF; RETURN NEW; END $$`);
  await sql.unsafe(`CREATE TRIGGER merge_fail_hide BEFORE UPDATE ON match FOR EACH ROW EXECUTE FUNCTION merge_fail_hide()`);
  await assert.rejects(mergeDuplicateMatch(input, { apply: true }), /merge-test-boom/);
  await sql.unsafe(`DROP TRIGGER merge_fail_hide ON match; DROP FUNCTION merge_fail_hide()`);
  assert.deepEqual(await state(), before, "중간에 실패하면 아무것도 안 바뀐다");

  // 3. 적용.
  const applied = await mergeDuplicateMatch(input, { apply: true });
  assert.equal(applied.already, false);
  const after = await state();
  assert.deepEqual(after.frames, [`drop-1.jpg>${keep}`, `drop-2.jpg>${keep}`, `keep.jpg>${keep}`]);
  assert.deepEqual(after.povs, [`${drop}|${L1}|created`, `${keep}|${L1}|created`, `${keep}|${L2}|added`].sort());
  assert.deepEqual(after.finals, [keep]);
  assert.equal(after.candidate[0].match_id, keep, "VOD 후보가 남길 경기를 가리킨다");
  assert.equal(after.candidate[1].match_id, undefined, "다른 후보는 그대로");
  assert.equal(after.visibility, "hidden");
  const merged = await sql`SELECT match_id, field, after FROM review_change WHERE field IN ('merged_into', 'merged_from') AND match_id IN (${keep}, ${drop}) ORDER BY field`;
  assert.deepEqual(merged.map(r => `${r.match_id}:${r.field}`), [`${keep}:merged_from`, `${drop}:merged_into`]);
  assert.equal(merged[1].after.evidence, input.evidence);
  assert.equal((await listDuplicateSuspects()).some(d => [d.a, d.b].includes(drop)), false, "정리된 쌍은 의심 목록에서 빠진다");

  // 4. 다시 돌리면 할 일이 없고 이력도 늘지 않는다.
  const historyAfter = after.history;
  const again = await mergeDuplicateMatch(input, { apply: true });
  assert.equal(again.already, true);
  assert.equal((await state()).history, historyAfter);

  // 5. 거부 — 근거 없음·같은 경기·숨긴 경기를 남기려 함·값이 다른 판·사람이 다른 판이라 확인한 쌍.
  await assert.rejects(mergeDuplicateMatch({ ...input, evidence: " " }, { apply: true }), /근거/);
  await assert.rejects(mergeDuplicateMatch({ keep, drop: keep, evidence: "x" }, { apply: true }), /같다/);
  await assert.rejects(mergeDuplicateMatch({ keep: drop, drop: keep, evidence: "x" }, { apply: true }), /공개 경기여야/);
  const other = game("other:drop", new Date("2030-07-01T12:05:00Z"), "남");
  other.participants.forEach((p, i) => { p.champion_id = i + 101; p.kills = i + 20; });
  await upsertMatchFromScan(other);
  await assert.rejects(mergeDuplicateMatch({ keep, drop: other.match_id, evidence: "x" }, { apply: true }), /같은 판 후보가 아니다/);
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id=${other.match_id}`)[0].visibility, "public");
  // 이미 저장된 두 경기를 다른 판으로 기록 — 미리보기는 안 쓰고, 기록하면 목록에서 빠지고 합치기가 거부되고, 다시 하면 할 일이 없다.
  const confirmed = await savedPair("distinct", new Date("2030-07-02T12:00:00Z"));
  const listed = async () => (await listDuplicateSuspects()).some(d => [d.a, d.b].includes(confirmed.drop));
  assert.equal(await listed(), true);
  assert.deepEqual(await markDistinctMatches(confirmed.keep, confirmed.drop, { apply: false }), { already: false });
  assert.equal(await listed(), true, "미리보기는 기록하지 않는다");
  assert.deepEqual(await markDistinctMatches(confirmed.keep, confirmed.drop, { apply: true }), { already: false });
  assert.equal(await listed(), false, "다른 판으로 기록하면 의심 목록에서 빠진다");
  assert.deepEqual(await markDistinctMatches(confirmed.drop, confirmed.keep, { apply: true }), { already: true });
  await assert.rejects(mergeDuplicateMatch({ ...confirmed, evidence: "x" }, { apply: true }), /distinct_from/);
  // 6. 이미 숨긴 경기(손으로 숨기고 근거만 남은 경우)도 근거를 옮긴다. 챔피언을 못 읽은 기록은 승패·KDA 일치로 받는다.
  const late = await savedPair("hidden-no-champion", new Date("2030-07-03T12:00:00Z"));
  await sql`UPDATE match SET visibility='hidden' WHERE match_id=${late.drop}`;
  const orphanOf = async (id: string) => (await listDuplicateSuspects()).find(d => d.hidden === id);
  assert.equal(await orphanOf(late.drop), undefined, "근거가 없는 숨긴 경기는 목록에 없다");
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source) VALUES (${late.drop}, ${L2}, 'created', 'own')`;
  assert.ok(await orphanOf(late.drop), "숨기기만 하고 근거가 남은 경기는 공개 쪽과 짝지어 뜬다");
  await sql`UPDATE match_participant SET champion_id=0 WHERE match_id=${late.drop}`;
  const moved = await mergeDuplicateMatch({ ...late, evidence: "x" }, { apply: true });
  assert.equal(moved.hidden, false, "이미 숨긴 경기는 다시 숨기지 않는다");
  assert.deepEqual(moved.povs_moved, [L2]);
  assert.equal(moved.already, false);
  await sql`UPDATE match_participant SET champion_id=1 WHERE match_id=${late.drop}`;
  assert.equal(await orphanOf(late.drop), undefined, "합친 뒤엔 근거가 옮겨져 목록에서 빠진다");
  console.log("  ok   같은 판 정리: 미리보기 무변경·중간 실패 전부 취소·근거/시점/최종 근거/VOD 후보 이전·같은 방송 시점 보존·재실행 무변경·거부 5종·숨긴 경기 근거 이전·숨기기만 한 경기 목록 표시·다른 판 기록");
}

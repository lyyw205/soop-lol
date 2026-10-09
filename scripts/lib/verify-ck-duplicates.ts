import assert from "node:assert/strict";
import { db } from "../../packages/core/lib/db/client.ts";
import { upsertMatchFromScan, upsertMatchFromScanInTx, type CkMatchInput } from "../../packages/core/lib/db/ck.ts";
import { listDuplicateSuspects } from "../../packages/core/lib/db/ck-duplicates.ts";
import { createStreamer, linkAccount } from "../../packages/core/lib/db/streamers.ts";

/** 실제 저장 질의로 오탐·임계값·시각 경계·계정 신원·예외 이력을 검증한다. 폐기용 DB에서만 호출한다. */
export async function verifyCkDuplicatesDb() {
  const sql = db();
  let day = 0;
  const input = (id: string, at: Date): CkMatchInput => ({
    match_id: `duplicate-regression:${id}`, played_at: at, played_at_precision: "datetime",
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
    UPDATE match_participant SET champion_id=${p.champion_id}, kills=${p.kills}, deaths=${p.deaths}, assists=${p.assists}
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

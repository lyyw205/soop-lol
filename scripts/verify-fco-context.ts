/**
 * FC 경기 맥락 계약의 회귀 검증 (FCO-MATCH-CONTEXT-SKILL-PLAN 구현 순서 3).
 *
 * 검사하는 계약: 재수집 후 사람 교정 보존 · 복수 POV 근거 보존과 현재 최종 판단의 유일성 ·
 * API 소유 필드 보호 · 수집 실패/0건/지원 밖의 구분 · 멱등 재전송 · 충돌 거부.
 * ⚠ 근거의 의미나 CK/대회 여부는 여기서 판정하지 않는다 — 그건 조사자의 몫이다.
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { applyAll } from "./lib/migrations.ts";
import { freePort } from "./lib/disposable-postgres.ts";

const database = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: database, port, host: "127.0.0.1" });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const { linkFcoAccount, saveFcoMatch } = await import("../packages/core/lib/games/fconline/ingest.ts");
const { applyFcoMatchContext, approveFcoContext, approveFcoEvent, holdFcoContext, holdFcoEvent,
  listFcoEventOptions, getFcoReviewWorkspace, listUnlinkedInEventWindows, decideFcoEventMatch, updateFcoEvent,
  listFcoContextQueue, getFcoContextDetail, addFcoCrossClue, listFcoCrossClues } =
  await import("../packages/core/lib/games/fconline/context.ts");
const { syncFcoMatches } = await import("../packages/core/lib/games/fconline/sync.ts");
const { fcoSeriesStanding, fcoSeriesResultFor, groupFcoSeries } = await import("../packages/core/lib/games/fconline/series.ts");

function detailOf(matchId: string, matchDate: string, players: [string, string]) {
  return {
    matchId, matchDate, matchType: 40,
    matchInfo: [
      { ouid: players[0], nickname: players[0], matchDetail: { matchResult: "승" as const },
        shoot: { goalTotal: 2 }, player: [] },
      { ouid: players[1], nickname: players[1], matchDetail: { matchResult: "패" as const },
        shoot: { goalTotal: 1 }, player: [] },
    ],
  };
}

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('a-fc', '알파'), ('b-fc', '베타')`;
  await linkFcoAccount({ streamerSlug: "a-fc", ouid: "ouid-a", nickname: "알파감독", level: 1 });
  await linkFcoAccount({ streamerSlug: "b-fc", ouid: "ouid-b", nickname: "베타감독", level: 1 });
  await saveFcoMatch(detailOf("fm1", "2026-09-20 09:51:35", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("fm2", "2026-09-20 10:03:58", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("fm3", "2026-09-21 10:00:00", ["ouid-a", "ouid-b"]));

  console.log("\n▸ 파생 규칙 — event 연결 > 최신 판단 > 미조사");
  let queue = await listFcoContextQueue({});
  check("수집 직후엔 전부 미조사다", queue.length === 3 && queue.every((r) => r.status === "uninvestigated"));

  console.log("\n▸ 반영 — 멱등·이력·유일성");
  const first = await applyFcoMatchContext({
    provider_match_id: "fm1", conclusion: "unresolved", note: "VOD 못 찾음 — 두 채널 다 그날 VOD 없음",
    evidences: [{ evidence_key: "vod:100@1479", kind: "vod_frame", vod_title_no: 100, channel_id: "cha",
      at_sec: 1479, observed: "88:23 인게임 3:4" }],
  });
  check("판단·근거가 저장된다", first.actions.length === 2, JSON.stringify(first.actions));
  const again = await applyFcoMatchContext({
    provider_match_id: "fm1", conclusion: "unresolved", note: "VOD 못 찾음 — 두 채널 다 그날 VOD 없음",
    evidences: [{ evidence_key: "vod:100@1479", kind: "vod_frame", vod_title_no: 100, channel_id: "cha",
      at_sec: 1479, observed: "88:23 인게임 3:4" }],
  });
  check("★★ 같은 반영 재전송은 전부 ⏭ 이고 중복을 만들지 않는다",
    again.actions.length === 0 && again.skipped.length === 2, JSON.stringify(again.skipped));
  await applyFcoMatchContext({
    provider_match_id: "fm1", conclusion: "unresolved", note: "다른 POV 확인 필요",
    evidences: [{ evidence_key: "vod:200@360", kind: "vod_frame", vod_title_no: 200, channel_id: "chb",
      at_sec: 360, observed: "상대 시점 결과 화면" }],
  });
  const fm1 = await getFcoContextDetail("fm1");
  check("★★ 같은 경기의 복수 POV 근거가 모두 남는다", fm1!.evidences.length === 2);
  check("★★ 판단은 이력으로 쌓이고 현재 판단은 최신 하나다",
    fm1!.history.length === 2 && fm1!.history[0].note === "다른 POV 확인 필요" && fm1!.status === "unresolved");

  console.log("\n▸ 근거 역할 (0036) — 결과 화면");
  const roleFill = await applyFcoMatchContext({
    provider_match_id: "fm1",
    evidences: [{ evidence_key: "vod:200@360", kind: "vod_frame", vod_title_no: 200, channel_id: "chb",
      at_sec: 360, observed: "상대 시점 결과 화면", role: "result" }],
  });
  const roleOf = async (key: string) => (await getFcoContextDetail("fm1"))!.evidences.find((e) => e.evidence_key === key)!.role;
  check("★ 같은 내용의 재전송은 빈 역할만 채운다 (0036 이전 근거에 역할 달기)",
    roleFill.actions.length === 1 && (await roleOf("vod:200@360")) === "result", JSON.stringify(roleFill.actions));
  const roleAgain = await applyFcoMatchContext({
    provider_match_id: "fm1",
    evidences: [{ evidence_key: "vod:200@360", kind: "vod_frame", vod_title_no: 200, channel_id: "chb",
      at_sec: 360, observed: "상대 시점 결과 화면", role: "end" }],
  });
  check("★★ 이미 달린 역할은 auto 재전송이 못 바꾼다",
    roleAgain.actions.length === 0 && (await roleOf("vod:200@360")) === "result");
  await assert.rejects(
    applyFcoMatchContext({ provider_match_id: "fm1", evidences: [{ evidence_key: "vod:200@361", kind: "vod_frame",
      vod_title_no: 200, at_sec: 361, observed: "x", role: "scoreboard" as never }] }),
  );
  check("정의 밖의 역할은 DB 가 거부한다", true);

  console.log("\n▸ 검수 보호 — auto 는 admin 을 못 덮는다");
  await applyFcoMatchContext({ provider_match_id: "fm1", conclusion: "casual",
    note: "본인 방송에서 '오늘은 그냥 몸풀기' 발언 확인" }, { createdBy: "admin" });
  const blocked = await applyFcoMatchContext({ provider_match_id: "fm1", conclusion: "unresolved",
    note: "자동 재조사 결과" }, { createdBy: "auto" });
  check("★★ admin 판단 위에 auto 판단이 못 올라간다 (⏭)",
    blocked.actions.length === 0 && blocked.skipped.length === 1, JSON.stringify(blocked.skipped));
  const evBlocked = await applyFcoMatchContext({ provider_match_id: "fm1",
    evidences: [{ evidence_key: "vod:100@1479", kind: "vod_frame", vod_title_no: 100, channel_id: "cha",
      at_sec: 1479, observed: "내용이 달라진 자동 재전송" }] });
  check("★★ 내용이 달라진 근거의 auto 재전송은 기존 근거를 안 덮는다",
    evBlocked.skipped.length === 1 && (await getFcoContextDetail("fm1"))!.evidences
      .find((e) => e.evidence_key === "vod:100@1479")!.observed === "88:23 인게임 3:4");
  const evAdmin = await applyFcoMatchContext({ provider_match_id: "fm1",
    evidences: [{ evidence_key: "vod:100@1479", kind: "vod_frame", vod_title_no: 100, channel_id: "cha",
      at_sec: 1479, observed: "admin 교정 — 실은 89:53" }] }, { createdBy: "admin" });
  check("admin 은 근거를 교정할 수 있다", evAdmin.actions.length === 1);

  console.log("\n▸ 행사 결론 — 충돌은 확인 대상이지 덮어쓰기 대상이 아니다");
  await applyFcoMatchContext({ provider_match_id: "fm2", conclusion: "event",
    event: { slug: "fc-sisik-cup", name: "고세구 피온시식컵", kind: "ck", source_url: "https://example.com/cup" } });
  const fm2 = await getFcoContextDetail("fm2");
  check("행사 생성·연결이 된다 (kind=ck 로도)", fm2!.status === "event" && fm2!.event!.kind === "ck");
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "event",
      event: { slug: "fc-sisik-cup", name: "다른 이름", kind: "ck", source_url: "https://example.com/x" } }),
    /덮어쓰지 않는다/);
  check("★★ 같은 slug 다른 이름은 거부한다 — 조용한 이름 덮어쓰기 금지", true);
  await sql`INSERT INTO event (slug, name, kind, game_code) VALUES ('lol-cup', '롤대회', 'tournament', 'lol')`;
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "event",
      event: { slug: "lol-cup", name: "롤대회", kind: "ck", source_url: "https://example.com/x" } }),
    /행사가 쓰고 있다/);
  check("LoL 이 쓰는 slug 는 거부한다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm2", conclusion: "casual", note: "친선인 듯" }),
    /event 연결이 이미 결론/);
  check("★★ event 연결 위에 '단순 친선' 판단은 모순으로 거부한다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "casual", note: "" }),
    /note/);
  check("빈 note 도장은 못 찍는다", true);

  console.log("\n▸ 시리즈 — 세트의 행사는 match_series.event_id 가 정본");
  await sql`INSERT INTO match_series (id, game_code) VALUES ('fs1', 'fconline')`;
  await sql`UPDATE match SET series_id = 'fs1', series_game_no = 1 WHERE match_id = 'fco:fm3'`;
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "event",
      event: { slug: "fc-other", name: "다른컵", kind: "tournament", source_url: "https://example.com/y" } }),
    /시리즈/);
  check("시리즈에 속한 세트의 직접 event 연결은 거부한다", true);
  await sql`UPDATE match SET series_id = NULL, series_game_no = NULL WHERE match_id = 'fco:fm3'`;

  console.log("\n▸ 시리즈 — 세트를 한 판으로 묶는다 (승패는 저장하지 않고 파생)");
  await saveFcoMatch(detailOf("fs-a", "2026-09-25 10:00:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch({ ...detailOf("fs-b", "2026-09-25 10:12:00", ["ouid-a", "ouid-b"]),
    matchInfo: [
      { ouid: "ouid-a", nickname: "ouid-a", matchDetail: { matchResult: "\ud328" as const }, shoot: { goalTotal: 0 }, player: [] },
      { ouid: "ouid-b", nickname: "ouid-b", matchDetail: { matchResult: "\uc2b9" as const }, shoot: { goalTotal: 2 }, player: [] },
    ] });
  await saveFcoMatch({ ...detailOf("fs-c", "2026-09-25 10:25:00", ["ouid-a", "ouid-b"]),
    matchInfo: [
      { ouid: "ouid-a", nickname: "ouid-a", matchDetail: { matchResult: "\ubb34" as const }, shoot: { goalTotal: 1 }, player: [] },
      { ouid: "ouid-b", nickname: "ouid-b", matchDetail: { matchResult: "\ubb34" as const }, shoot: { goalTotal: 1 }, player: [] },
    ] });
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a",
      series: { id: "s-test", game_no: 1, best_of: 3 } }),
    /best_of 에는 근거가 필수/);
  check("\u2605\u2605 best_of 는 근거 없이 못 넣는다 — 연속 경기 수로 추측 금지", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a", series: { id: "s-test", game_no: 1, best_of: 2, best_of_evidence: "x" } }),
    /홀수/);
  check("짝수 best_of 는 거부한다", true);
  const s1 = await applyFcoMatchContext({ provider_match_id: "fs-a",
    series: { id: "s-test", game_no: 1, best_of: 3, best_of_evidence: "\ubc29\uc1a1 \uacf5\uc9c0 '3\ud310 2\uc120\uc2b9'" } });
  check("시리즈 생성·연결이 된다", s1.actions.length === 2, JSON.stringify(s1.actions));
  const s1again = await applyFcoMatchContext({ provider_match_id: "fs-a", series: { id: "s-test", game_no: 1 } });
  check("같은 세트 재전송은 멱등이다", s1again.actions.length === 0 && s1again.skipped.length === 1);
  await applyFcoMatchContext({ provider_match_id: "fs-b", series: { id: "s-test", game_no: 2 } });
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-c", series: { id: "s-test", game_no: 2 } }),
    /2세트는 이미/);
  check("\u2605\u2605 같은 세트 번호를 두 경기가 쓸 수 없다", true);
  await applyFcoMatchContext({ provider_match_id: "fs-c", series: { id: "s-test", game_no: 3 } });
  await saveFcoMatch(detailOf("fs-other", "2026-09-25 11:00:00", ["ouid-a", "ouid-c"]));
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-other", series: { id: "s-test", game_no: 4 } }),
    /다른 대진/);
  check("\u2605\u2605 상대가 바뀐 경기는 같은 시리즈에 못 들어간다 (대회는 event 로)", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a",
      series: { id: "s-test", game_no: 1, best_of: 5, best_of_evidence: "\ub2e4\ub978 \uc8fc\uc7a5" } }),
    /이미 Bo3/);
  check("best_of 충돌은 덮어쓰지 않고 거부한다", true);

  const seriesGames = await sql<{ series_id: string | null; series_game_no: number | null; event_id: string | null }[]>`
    SELECT series_id, series_game_no, event_id FROM match WHERE match_id IN ('fco:fs-a','fco:fs-b','fco:fs-c') ORDER BY series_game_no
  `;
  check("세 세트가 같은 시리즈에 1·2·3세트로 붙었다",
    seriesGames.length === 3 && seriesGames.every((g) => g.series_id === "s-test")
      && seriesGames.map((g) => g.series_game_no).join(",") === "1,2,3");

  const standing = fcoSeriesStanding([
    { series_id: "s-test", series_game_no: 1, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "\uc54c\ud30c", outcome: "win", side_no: 1 },
      { ouid: "ouid-b", nickname: "\ubca0\ud0c0", outcome: "loss", side_no: 2 }] },
    { series_id: "s-test", series_game_no: 2, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "\uc54c\ud30c", outcome: "loss", side_no: 1 },
      { ouid: "ouid-b", nickname: "\ubca0\ud0c0", outcome: "win", side_no: 2 }] },
    { series_id: "s-test", series_game_no: 3, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "\uc54c\ud30c", outcome: "draw", side_no: 1 },
      { ouid: "ouid-b", nickname: "\ubca0\ud0c0", outcome: "draw", side_no: 2 }] },
  ]);
  check("\u2605\u2605 세트 무승부가 있으면 LoL 의 '세트 과반' 이 아니라 양쪽 세트승을 비교한다 — 1승1패1무는 무승부",
    standing.leader_key === null && standing.draws === 1 && standing.sets === 3
      && fcoSeriesResultFor(standing, "ouid-a") === "draw", JSON.stringify(standing));
  const clinched = fcoSeriesStanding([
    { series_id: "x", series_game_no: 1, best_of: 3, participants: [
      { ouid: "a", nickname: "a", outcome: "win", side_no: 1 }, { ouid: "b", nickname: "b", outcome: "loss", side_no: 2 }] },
    { series_id: "x", series_game_no: 2, best_of: 3, participants: [
      { ouid: "a", nickname: "a", outcome: "win", side_no: 1 }, { ouid: "b", nickname: "b", outcome: "loss", side_no: 2 }] },
  ]);
  check("Bo3 에서 2승이면 확정(clinched)이고 시리즈 승자가 나온다",
    clinched.clinched === true && clinched.complete === true && clinched.leader_key === "a"
      && fcoSeriesResultFor(clinched, "b") === "loss");
  const unknownFormat = fcoSeriesStanding([
    { series_id: "y", series_game_no: 1, best_of: null, participants: [
      { ouid: "a", nickname: "a", outcome: "win", side_no: 1 }, { ouid: "b", nickname: "b", outcome: "loss", side_no: 2 }] },
  ]);
  check("\u2605 best_of 를 모르면 '확정' 을 말하지 않는다 (모른다 ≠ 아니다)",
    unknownFormat.clinched === null && unknownFormat.complete === null && unknownFormat.leader_key === "a");
  const blocks = groupFcoSeries([
    { series_id: null, series_game_no: null, participants: [] },
    { series_id: "s-test", series_game_no: 1, participants: [] },
    { series_id: "s-test", series_game_no: 2, participants: [] },
  ]);
  check("단판과 시리즈가 섞인 목록을 블록으로 접는다",
    blocks.length === 2 && blocks[0].kind === "single" && blocks[1].kind === "series"
      && (blocks[1] as { sets: unknown[] }).sets.length === 2);

  console.log("\n▸ 재수집 보존 — 공급자 재수집이 사람의 판단·근거·연결을 못 덮는다");
  await saveFcoMatch(detailOf("fm1", "2026-09-20 09:51:35", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("fm2", "2026-09-20 10:03:58", ["ouid-a", "ouid-b"]));
  const fm1After = await getFcoContextDetail("fm1");
  const fm2After = await getFcoContextDetail("fm2");
  check("★★ 재수집 후 판단 이력·근거·행사 연결이 그대로다",
    fm1After!.history.length === 3 && fm1After!.evidences.length === 2 && fm2After!.status === "event");
  const scores = await sql<{ score: number | null }[]>`
    SELECT coalesce(score_display, goals) AS score FROM fco_match_participant WHERE match_id = 'fco:fm1' ORDER BY side_no
  `;
  check("★★ 맥락 반영은 API 소유 필드(점수·승패)를 건드리지 않았다",
    scores[0].score === 2 && scores[1].score === 1, JSON.stringify(scores));

  console.log("\n▸ dry-run — 아무것도 저장되지 않는다");
  const dry = await applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "unresolved",
    note: "dry-run 시험", evidences: [{ evidence_key: "dry:1", kind: "url", url: "https://example.com", observed: "시험" }] },
    { dryRun: true });
  const fm3 = await getFcoContextDetail("fm3");
  check("dry-run 은 했을 일만 보여 주고 저장하지 않는다",
    dry.actions.every((a) => a.startsWith("(dry-run)")) && fm3!.history.length === 0 && fm3!.evidences.length === 0);

  console.log("\n▸ 교차 단서 — LoL 조사가 연 FC 화면");
  const fresh = await addFcoCrossClue({ vod_title_no: 207602969, channel_id: "lshooooo", at_sec: 2400,
    observed: "FC 인게임 화면, 스코어보드에 호날두", observed_at: "2026-09-19T12:00:00Z" });
  const dup = await addFcoCrossClue({ vod_title_no: 207602969, channel_id: "lshooooo", at_sec: 2400,
    observed: "같은 화면 재발견", observed_at: "2026-09-19T12:00:00Z" });
  // event_lead.kind 는 0035 에서 사라진다 — 교차 단서는 분류를 갖지 않는다.
  const clues = await sql<{ source: string }[]>`
    SELECT source FROM event_lead WHERE source = 'fc_screen'
  `;
  check("교차 단서는 fc_screen 으로 한 번만 쌓인다",
    fresh === true && dup === false && clues.length === 1);
  const clueRows = await listFcoCrossClues();
  check("교차 단서가 FC 조사 입구(listFcoCrossClues)로 다시 나온다 — 좌표·관찰 그대로",
    clueRows.length === 1 && clueRows[0].vod_title_no === 207602969
      && clueRows[0].at_sec === 2400 && clueRows[0].observed.includes("호날두"));

  console.log("\n▸ 승인 — 조사가 제안하고 사람은 도장만 찍는다");
  await assert.rejects(() => approveFcoContext("fm3"), /미조사/);
  check("★★ 미조사 경기는 승인할 수 없다 — 도장이 조사를 대신하지 못한다", true);
  await applyFcoMatchContext({
    provider_match_id: "fm3", conclusion: "unresolved", note: "결과창 근처만 확인 — 행사 언급 못 찾음",
    evidences: [{ evidence_key: "vod:300@500", kind: "vod_frame", vod_title_no: 300, channel_id: "cha",
      at_sec: 500, frame_path: "out/ck/300/g0000500.jpg", observed: "FC 인게임 45:00" }],
  });
  const fm3Before = await getFcoContextDetail("fm3");
  check("근거의 frame_path 가 그대로 돌아온다 — 검수 화면이 띄울 파일",
    fm3Before!.evidences[0]?.frame_path === "out/ck/300/g0000500.jpg" && fm3Before!.confirmed === false);
  const approved = await approveFcoContext("fm3");
  const fm3After = await getFcoContextDetail("fm3");
  check("★★ 승인은 auto 판단을 admin 으로 도장 찍고 reviewed_at 을 남긴다",
    approved.actions.length === 2 && fm3After!.confirmed === true
      && fm3After!.history[0].created_by === "admin" && fm3After!.history[0].note === fm3Before!.history[0].note,
    JSON.stringify(approved.actions));
  const approvedAgain = await approveFcoContext("fm3");
  check("승인 재실행은 전부 ⏭ 이고 admin 행을 늘리지 않는다",
    approvedAgain.actions.length === 0 && (await getFcoContextDetail("fm3"))!.history.length === fm3After!.history.length);
  const autoAfterApprove = await applyFcoMatchContext({
    provider_match_id: "fm3", conclusion: "casual", note: "자동 재조사가 뒤집으려 함" });
  check("★★ 승인된 판단을 자동 반영이 못 덮는다", autoAfterApprove.skipped.length === 1);
  const approvedEvent = await approveFcoContext("fm2");
  check("행사 결론 경기의 승인은 확인 도장만 남긴다",
    approvedEvent.actions.length === 1 && (await getFcoContextDetail("fm2"))!.confirmed === true);
  const queueConfirm = await listFcoContextQueue({});
  check("큐가 확인됨(confirmed)과 판단 주체(judgment_by)를 보여 준다",
    queueConfirm.find((r) => r.provider_match_id === "fm3")?.confirmed === true
      && queueConfirm.find((r) => r.provider_match_id === "fm1")?.judgment_by === "admin");

  console.log("\n▸ 보류 — 승인은 되돌릴 수 있다 (판단 이력은 건드리지 않는다)");
  const beforeHold = await getFcoContextDetail("fm3");
  const held = await holdFcoContext("fm3");
  const afterHold = await getFcoContextDetail("fm3");
  check("★★ 보류는 확인 도장만 뗀다 — 판단 이력은 그대로",
    held.actions.length === 1 && afterHold!.confirmed === false
      && afterHold!.history.length === beforeHold!.history.length
      && afterHold!.history[0].created_by === "admin", JSON.stringify(held));
  check("보류 재실행은 ⏭ 다", (await holdFcoContext("fm3")).skipped.length === 1);
  await approveFcoContext("fm3");
  check("보류한 것을 다시 승인할 수 있다", (await getFcoContextDetail("fm3"))!.confirmed === true);
  console.log("\n▸ 수집 구분 — 실패 ≠ 0건 ≠ 지원 밖");
  const fake = {
    async matchIds(_ouid: string, type: number) {
      if (type === 40) return ["fm1", "fm-new"];      // 1 known + 1 new
      if (type === 50) return [];                     // 정말 0건
      if (type === 60) throw new Error("HTTP 500");   // 조회 실패
      return ["fm-multi"];
    },
    async matchDetail(id: string) {
      if (id === "fm-new") return detailOf("fm-new", "2026-09-22 10:00:00", ["ouid-a", "ouid-b"]);
      if (id === "fm-multi") return { ...detailOf("fm-multi", "2026-09-22 11:00:00", ["ouid-a", "ouid-b"]),
        matchInfo: [...detailOf("fm-multi", "2026-09-22 11:00:00", ["ouid-a", "ouid-b"]).matchInfo,
          { ouid: "ouid-c", nickname: "셋째", matchDetail: { matchResult: "무" as const }, shoot: {}, player: [] }] };
      return null;
    },
  };
  const sync = await syncFcoMatches(fake, "ouid-a", { types: [40, 50, 60, 204] });
  check("★★ 타입별로 실패('error')와 0건(0)이 구분된다",
    sync.listed["40"] === 2 && sync.listed["50"] === 0 && sync.listed["60"] === "error" && sync.errors.length === 1,
    JSON.stringify(sync.listed));
  check("★★ 아는 경기(known)·새 저장(saved)·지원 밖(unsupported)이 구분된다",
    sync.known === 1 && sync.saved === 1 && sync.unsupported === 1, JSON.stringify(sync));

  check("목록 조회가 하나라도 실패하면 커서를 안 옮긴다 — 다음 수집이 다시 끝까지 본다",
    sync.cursorAdvanced === false && sync.coverage["60"] === "error");

  console.log("\n▸ 목록 넘기기 — 「몇 건」이 아니라 「어디까지」 (넥슨은 30일 지난 경기를 지운다)");
  await linkFcoAccount({ streamerSlug: "a-fc", ouid: "ouid-p", nickname: "페이지감독", level: 1 });
  // 최신순 250경기 — matchId 앞 8자리 = 시작 유닉스 초. 10분 간격으로 과거로 간다.
  const T0 = 0x6a900000;
  const idAt = (i: number) => `${(T0 - i * 600).toString(16)}${"0".repeat(16)}`;
  let listCalls = 0;
  let total = 250;
  const paged = {
    async matchIds(_o: string, _t: number, offset: number, limit: number) {
      listCalls++;
      return Array.from({ length: total }, (_, i) => idAt(i)).slice(offset, offset + limit);
    },
    async matchDetail() { return null; },
  };
  // 상대 스트리머 목록으로 이미 들어온 경기 — 여기서 멈추면 새 계정 수집이 첫 페이지에서 끊긴다.
  await saveFcoMatch(detailOf(idAt(3), "2026-09-01 00:00:00", ["ouid-p", "ouid-b"]));
  const pgFirst = await syncFcoMatches(paged, "ouid-p", { types: [40] });
  check("★★ 새 계정은 목록 끝까지 넘긴다 — 100건에서 멈추지 않는다",
    pgFirst.listed["40"] === 250 && pgFirst.coverage["40"] === "end" && listCalls === 3, JSON.stringify(pgFirst));
  check("★★ 상대 목록으로 이미 저장된 경기에서 멈추지 않는다 — 상세만 건너뛴다",
    pgFirst.known === 1 && pgFirst.missing === 249);
  check("빈틈없이 읽었으면 커서를 옮긴다", pgFirst.cursorAdvanced === true);

  // 다음 날: 새 경기 5판이 위에 쌓였다.
  const idNew = (i: number) => `${(T0 + (i + 1) * 600).toString(16)}${"0".repeat(16)}`;
  listCalls = 0;
  const nextDay = {
    async matchIds(_o: string, _t: number, offset: number, limit: number) {
      listCalls++;
      const all = [...Array.from({ length: 5 }, (_, i) => idNew(4 - i)), ...Array.from({ length: total }, (_, i) => idAt(i))];
      return all.slice(offset, offset + limit);
    },
    async matchDetail() { return null; },
  };
  const pgSecond = await syncFcoMatches(nextDay, "ouid-p", { types: [40] });
  check("★★ 매일 수집은 지난번 읽은 지점(+여유 2시간)에서 멈춘다 — 30일을 매번 다시 넘기지 않는다",
    pgSecond.coverage["40"] === "caught_up" && listCalls === 1 && Number(pgSecond.listed["40"]) < 30, JSON.stringify(pgSecond));
  const refetch = await syncFcoMatches(nextDay, "ouid-p", { types: [40], refetchKnown: true });
  check("--refetch 는 커서를 무시하고 끝까지 간다", refetch.coverage["40"] === "end" && refetch.listed["40"] === 255);

  queue = await listFcoContextQueue({});
  check("새로 수집된 경기는 미조사로 큐에 선다",
    queue.find((r) => r.provider_match_id === "fm-new")?.status === "uninvestigated");

  console.log("\n▸ 근거의 최소 요건 — 빈 도장은 저장이 거부한다 (draft 초안이 이걸 딛고 선다)");
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3",
      evidences: [{ evidence_key: "draft:1", kind: "vod_frame", vod_title_no: 1, at_sec: 0, observed: "" }] }),
    /observed/);
  check("\u2605\u2605 observed 가 비면 거부한다 — draft 가 채워 둔 빈칸은 지우거나 채워야 반영된다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm3",
      evidences: [{ evidence_key: "draft:2", kind: "vod_frame", vod_title_no: 1, observed: "봤다" }] }),
    /at_sec/);
  check("vod_frame 은 좌표(vod·초) 없이는 근거가 아니다", true);

  console.log("\n▸ 검수 작업대 — 행사는 행사 하나가 한 단위다");
  const workspace = await getFcoReviewWorkspace();
  const eventUnit = workspace.find((u) => u.kind === "event" && u.event?.slug === "fc-sisik-cup");
  check("행사 단위가 소속 경기·근거를 묶어서 나온다",
    eventUnit?.matches.some((m) => m.provider_match_id === "fm2") === true && eventUnit?.status === "event");
  check("행사에 안 붙은 경기는 경기 단위이고 판단·근거·프레임이 실려 온다",
    workspace.some((u) => u.kind === "match" && u.id === "match:fm3"
      && u.judgment?.created_by === "admin"
      && u.evidences.some((e) => e.frame_path === "out/ck/300/g0000500.jpg")));
  check("확인 전 단위는 pending, 미조사는 pending 이 아니다",
    workspace.find((u) => u.id === "match:fm1")?.pending === true
      && workspace.find((u) => u.id === "match:fm-new")?.pending === false);

  console.log("\n▸ 행사 단위 승인 — 소속 경기 전부에 확인 도장");
  await applyFcoMatchContext({ provider_match_id: "fm-new", conclusion: "event",
    event: { slug: "fc-cup-2", name: "검증컵 2", kind: "tournament", source_url: "https://example.com/cup2" } });
  const [cup2] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'fc-cup-2'`;
  const eventApproved = await approveFcoEvent(cup2.id);
  check("행사 승인이 소속 경기에 도장을 찍는다",
    eventApproved.stamped === 1 && (await getFcoContextDetail("fm-new"))!.confirmed === true);
  const eventApprovedAgain = await approveFcoEvent(cup2.id);
  check("행사 승인 재실행은 이미 찍힌 것을 다시 찍지 않는다",
    eventApprovedAgain.stamped === 0 && eventApprovedAgain.already === 1);
  check("승인 뒤 행사 단위는 confirmed 다",
    (await getFcoReviewWorkspace()).find((u) => u.id === `event:${cup2.id}`)?.confirmed === true);

  const heldEvent = await holdFcoEvent(cup2.id);
  check("행사 단위도 보류로 되돌린다",
    heldEvent.cleared === 1 && (await getFcoContextDetail("fm-new"))!.confirmed === false);
  await approveFcoEvent(cup2.id);

  console.log("\n▸ 계정을 늦게 연결해도 행사 기간 안의 미연결 경기를 알린다");
  await sql`UPDATE event SET starts_at = '2026-09-22T09:00:00Z', ends_at = '2026-09-22T12:00:00Z' WHERE slug = 'fc-cup-2'`;
  await saveFcoMatch(detailOf("late-1", "2026-09-22 10:30:00", ["ouid-a", "ouid-b"]));
  const loose = await listUnlinkedInEventWindows("a-fc");
  check("\u2605\u2605 행사 기간 안인데 행사에 안 붙은 경기를 찾는다",
    loose.some((m) => m.provider_match_id === "late-1" && m.event_slug === "fc-cup-2"), JSON.stringify(loose.map((m) => m.provider_match_id)));
  check("이미 행사에 붙은 경기는 안 나온다", !loose.some((m) => m.provider_match_id === "fm-new"));

  console.log("\n▸ 행사 변경 — 화면에서 사람이 바꿀 때만 (relink)");
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm2", conclusion: "event",
      event: { slug: "fc-cup-2", name: "검증컵 2", kind: "tournament", source_url: "https://example.com/cup2" } }),
    /이미 다른 행사에 연결/);
  check("★★ 기본은 거부다 — 자동 경로가 행사를 갈아타지 못한다", true);
  const relinked = await applyFcoMatchContext(
    { provider_match_id: "fm2", conclusion: "event",
      event: { slug: "fc-cup-2", name: "검증컵 2", kind: "tournament", source_url: "https://example.com/cup2" } },
    { createdBy: "admin", relink: true });
  check("admin 이 relink 로 명시하면 바꾼다",
    relinked.actions.some((a) => a.includes("행사 연결"))
      && (await getFcoContextDetail("fm2"))!.event?.slug === "fc-cup-2");
  const options = await listFcoEventOptions();
  check("행사 선택지가 경기 수와 함께 온다",
    options.length >= 2 && options.every((o) => typeof o.games === "number"), JSON.stringify(options.map((o) => `${o.slug}:${o.games}`)));



  console.log("\n▸ 대회 후보의 포함/제외 결정 (0034) — 조사 제안이 기본, 사람은 바꿀 것만");
  await saveFcoMatch(detailOf("d1", "2026-09-26 10:00:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("d2", "2026-09-26 10:15:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("d3", "2026-09-26 10:30:00", ["ouid-a", "ouid-b"]));
  const decCup = { slug: "dec-cup", name: "결정컵", kind: "tournament" as const, source_url: "https://example.com/dec" };
  for (const pid of ["d1", "d2", "d3"]) await applyFcoMatchContext({ provider_match_id: pid, conclusion: "event", event: decCup });
  const [dec] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'dec-cup'`;
  const autoRows = await sql<{ n: number }[]>`SELECT count(*)::int n FROM fco_event_match_decision WHERE event_id = ${dec.id}::uuid AND created_by = 'auto' AND decision = 'include'`;
  check("조사가 행사에 붙이면 「포함(조사)」 결정이 같이 남는다", autoRows[0].n === 3, String(autoRows[0].n));
  await assert.rejects(() => decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "exclude" }, { createdBy: "admin" }), /이유/);
  check("\u2605\u2605 이유 없는 제외는 거부한다 — 왜 뺐는지가 남아야 되돌릴 수 있다", true);
  await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "exclude", note: "개막 전 연습" }, { createdBy: "admin" });
  const d1 = (await getFcoContextDetail("d1"))!;
  check("\u2605\u2605 제외하면 공개 연결(event_id)이 풀리고 확인 도장이 찍힌다", d1.event === null && d1.confirmed === true);
  const relinkTry = await applyFcoMatchContext({ provider_match_id: "d1", conclusion: "event", event: decCup });
  check("\u2605\u2605 사람이 뺀 경기는 자동 조사가 다시 붙이지 못한다 (⏭)",
    relinkTry.skipped.some((x) => x.includes("제외한 경기")) && (await getFcoContextDetail("d1"))!.event === null, JSON.stringify(relinkTry));
  const decUnit = (await getFcoReviewWorkspace({ eventId: dec.id }))[0];
  const d1Row = decUnit.matches.find((m) => m.provider_match_id === "d1");
  check("\u2605\u2605 제외한 경기도 대회 후보로 남는다 — 사라지지 않아 되돌릴 수 있다",
    d1Row?.decision === "exclude" && d1Row.decision_by === "admin" && decUnit.matches.at(-1)?.provider_match_id === "d1");
  check("제외한 경기가 따로 단독 단위로 튀어나오지 않는다",
    !(await getFcoReviewWorkspace()).some((u) => u.kind === "match" && u.matches[0].provider_match_id === "d1"));
  await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d2", decision: "include", bracketNo: 1, bracketLabel: "1경기" });
  const blocked2 = await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "include" });
  check("사람 결정 위에 자동 결정은 못 올라간다", blocked2.skipped.length === 1 && blocked2.actions.length === 0);
  await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "include", note: "다시 보니 대회 경기" }, { createdBy: "admin" });
  check("사람은 제외를 되돌릴 수 있다", (await getFcoContextDetail("d1"))!.event?.slug === "dec-cup");
  const unit2 = (await getFcoReviewWorkspace({ eventId: dec.id }))[0];
  check("큐는 브래킷 번호가 있는 포함 경기부터 선다", unit2.matches[0].provider_match_id === "d2" && unit2.matches[0].bracket_label === "1경기");
  const bulk = await approveFcoEvent(dec.id);
  const decLatest = await sql<{ created_by: string }[]>`
    SELECT DISTINCT ON (match_id) created_by FROM fco_event_match_decision WHERE event_id = ${dec.id}::uuid ORDER BY match_id, created_at DESC`;
  check("\u2605\u2605 일괄 승인은 조사 제안을 사람 결정으로 굳힌다 — 이후 자동 조사가 못 뒤집는다",
    bulk.promoted >= 2 && decLatest.every((r) => r.created_by === "admin"), JSON.stringify(bulk));
  const drift = await sql<{ n: number }[]>`
    SELECT count(*)::int n FROM (
      SELECT DISTINCT ON (x.event_id, x.match_id) x.event_id, x.match_id, x.decision
        FROM fco_event_match_decision x ORDER BY x.event_id, x.match_id, x.created_at DESC) d
      JOIN match m ON m.match_id = d.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
     WHERE (d.decision = 'include') <> (COALESCE(ms.event_id, m.event_id) IS NOT DISTINCT FROM d.event_id)`;
  check("\u2605\u2605 결정 표와 공개 연결(event_id)이 어긋난 경기가 없다", drift[0].n === 0, String(drift[0].n));
  await updateFcoEvent(dec.id, { name: "결정컵 2026", organizer: "주최자" });
  check("행사 정보를 [대회] 탭에서 고칠 수 있다",
    (await listFcoEventOptions()).some((o) => o.id === dec.id && o.name === "결정컵 2026" && o.organizer === "주최자"));

  if (failures) { console.error(`\n${failures}개 실패.`); process.exitCode = 1; }
  else console.log("\nFC 맥락 계약 검증 전부 통과.");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

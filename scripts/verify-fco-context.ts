/**
 * FC 경기 맥락 계약의 회귀 검증 — 새 분류 뼈대(docs/CLASSIFICATION-REDESIGN-PLAN.md §3·§10, 0089).
 *
 * 검사하는 계약: 판단 = "어느 진행 방식의 행사 소속인가" · 수집이 두 사람 판을 (두 사람, 날짜) 자동 묶음에 두고 재수집이 시리즈를 안 옮김 ·
 * 묶음 키가 순서와 무관 · 자동은 친선을 못 낸다 · 사람의 제외는 자동이 못 넘는다(단독·시리즈·다른 세트·포함 결정) ·
 * 판단 메모는 이력(review_change) · API 소유 필드 보호 · 수집 실패/0건/지원 밖 구분 · 멱등 재전송 · 충돌 거부.
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
const { fcFriendlyEventSlug } = await import("../packages/core/lib/games/fconline/classify.ts");
const { fcPairBucketSlug } = await import("../packages/core/lib/db/classification.ts");
const { syncFcoMatches } = await import("../packages/core/lib/games/fconline/sync.ts");
const { fcoSeriesStanding, groupFcoSeries } = await import("../packages/core/lib/games/fconline/series.ts");

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
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('a-fc', '알파'), ('b-fc', '베타'), ('c-fc', '감마')`;
  await linkFcoAccount({ streamerSlug: "a-fc", ouid: "ouid-a", nickname: "알파감독", level: 1 });
  await linkFcoAccount({ streamerSlug: "b-fc", ouid: "ouid-b", nickname: "베타감독", level: 1 });
  const [A, B, C] = (await sql<{ id: string }[]>`SELECT id FROM streamer WHERE slug IN ('a-fc','b-fc','c-fc') ORDER BY slug`).map((r) => r.id);
  await saveFcoMatch(detailOf("fm1", "2026-09-20 09:51:35", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("fm2", "2026-09-20 10:03:58", ["ouid-b", "ouid-a"]));
  await saveFcoMatch(detailOf("fm3", "2026-09-21 10:00:00", ["ouid-a", "ouid-b"]));
  const placeOf = async (pid: string) => (await sql<{ scope: string; series_id: string | null; series_game_no: number | null; slug: string | null; format: string | null; auto_bucket: boolean | null }[]>`
    SELECT m.scope, m.series_id, m.series_game_no, e.slug, e.format, e.auto_bucket
      FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id LEFT JOIN event e ON e.id = ms.event_id
     WHERE m.match_id = ${pid.startsWith("fc") && pid.includes(":") ? pid : `fco:${pid}`}`)[0];

  console.log("\n▸ 수집 — 두 사람 판은 (두 사람, KST 날짜) 자동 미분류 묶음, 한쪽만 스트리머면 개인 기록");
  const p1 = await placeOf("fm1"), p2 = await placeOf("fm2"), p3 = await placeOf("fm3");
  check("★★ 두 사람 판은 내전 세트(versus)로 묶음 행사의 한 판짜리 시리즈에 들어간다",
    p1.scope === "versus" && p1.series_id === "set:fco:fm1" && p1.auto_bucket === true && p1.format === "unclassified", JSON.stringify(p1));
  check("★★ 묶음 키는 사람 순서와 무관하다 — 같은 날 B vs A 판도 같은 묶음",
    p2.slug === p1.slug && p1.slug === fcPairBucketSlug(new Date("2026-09-20T09:51:35Z"), B, A), `${p1.slug} / ${p2.slug}`);
  check("날짜가 다르면 다른 묶음", p3.slug !== p1.slug && p3.auto_bucket === true);
  await saveFcoMatch(detailOf("solo", "2026-09-20 11:00:00", ["ouid-a", "ouid-stranger"]));
  check("★★ 한쪽만 스트리머인 판은 개인 기록이다 — 시리즈 밖", (await placeOf("solo")).scope === "personal" && (await placeOf("solo")).series_id === null);
  await saveFcoMatch(detailOf("late-link", "2026-09-20 11:30:00", ["ouid-a", "ouid-c"]));
  check("준비: 아직 연결 전 계정과의 판은 개인 기록", (await placeOf("late-link")).scope === "personal");
  await linkFcoAccount({ streamerSlug: "c-fc", ouid: "ouid-c", nickname: "감마감독", level: 1 });
  const lateLinked = await placeOf("late-link");
  check("★★ 계정을 나중에 연결하면 그 판이 같은 규칙으로 묶음에 들어간다(수집 순서와 무관)",
    lateLinked.scope === "versus" && lateLinked.slug === fcPairBucketSlug(new Date("2026-09-20T11:30:00Z"), A, C), JSON.stringify(lateLinked));
  const bucketCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int n FROM event WHERE auto_bucket AND game_code = 'fconline'`)[0].n;
  const beforeResave = await bucketCount();
  await saveFcoMatch(detailOf("fm1", "2026-09-20 09:51:35", ["ouid-a", "ouid-b"]));
  check("재수집은 묶음을 새로 만들지 않고 자리도 그대로다", (await bucketCount()) === beforeResave && (await placeOf("fm1")).slug === p1.slug);

  console.log("\n▸ 상태 — 실제 행사 > 판단 메모 > 미조사 (자동 묶음은 행사가 아니다)");
  let queue = await listFcoContextQueue({});
  check("수집 직후엔 두 사람 판이 전부 미조사다(묶음에 있어도)",
    queue.length === 4 && queue.every((r) => r.status === "uninvestigated" && r.event_name === null), JSON.stringify(queue.map((r) => [r.provider_match_id, r.status])));

  console.log("\n▸ 반영 — 멱등·이력·유일성");
  const first = await applyFcoMatchContext({
    provider_match_id: "fm1", conclusion: "unresolved", note: "VOD 못 찾음 — 두 채널 다 그날 VOD 없음",
    evidences: [{ evidence_key: "vod:100@1479", kind: "vod_frame", vod_title_no: 100, channel_id: "cha",
      at_sec: 1479, observed: "88:23 인게임 3:4" }],
  });
  check("판단 메모·근거가 저장된다", first.actions.length === 2, JSON.stringify(first.actions));
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
  check("★★ 판단 메모는 이력(review_change)으로 쌓이고 현재 판단은 최신 하나다",
    fm1!.history.length === 2 && fm1!.history[0].note === "다른 POV 확인 필요" && fm1!.status === "unresolved");
  check("판단 메모는 분류가 아니다 — 판은 여전히 자동 묶음에 있다", (await placeOf("fm1")).auto_bucket === true);
  const noteRows = await sql<{ n: number }[]>`SELECT count(*)::int n FROM review_change WHERE match_id = 'fco:fm1' AND entity = 'classification' AND field = 'fco_match_context'`;
  check("메모는 entity 'classification' 이력이다", noteRows[0].n === 2);

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
  await applyFcoMatchContext({ provider_match_id: "fm1", conclusion: "unresolved",
    note: "본인 방송 대화로는 행사인지 판단 불가 — 공지 확인 필요" }, { createdBy: "admin" });
  const blocked = await applyFcoMatchContext({ provider_match_id: "fm1", conclusion: "unresolved",
    note: "자동 재조사 결과" }, { createdBy: "auto" });
  check("★★ admin 메모 위에 auto 메모가 못 올라간다 (⏭)",
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

  console.log("\n▸ 친선 — 사람만 정한다(사용자 결정 5-A·7), 옛 casual 은 없다");
  await assert.rejects(() => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "friendly",
    evidences: [{ evidence_key: "fr:1", kind: "url", url: "https://example.com/f", observed: "몸풀기 친선이라 함" }] }), /사람이 확인/);
  check("★★ 자동 조사의 친선 결론은 거부한다 — 근거도 저장되지 않는다(통째로 받지 않음)",
    (await getFcoContextDetail("fm3"))!.evidences.length === 0 && (await placeOf("fm3")).auto_bucket === true);
  await assert.rejects(() => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "casual" as never, note: "x" }), /casual 은 없어졌다/);
  check("★ 옛 casual 결론은 거부한다 — 친선으로 몰래 바꾸지 않는다", true);
  await assert.rejects(() => applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "event",
    event: { slug: "fr-x", name: "친선 행사", format: "friendly" as never, source_url: "https://example.com/x" } }), /event.format/);
  check("★★ event 결론으로 친선을 우회할 수 없다(format friendly 거부)", true);
  await assert.rejects(() => applyFcoMatchContext({ provider_match_id: "solo", conclusion: "friendly" }, { createdBy: "admin" }), /두 사람/);
  check("친선은 두 사람 판에만", true);
  const friendly = await applyFcoMatchContext({ provider_match_id: "fm3", conclusion: "friendly" }, { createdBy: "admin" });
  const fr = await placeOf("fm3");
  check("★★ 사람이 친선을 확정하면 (두 사람, 날짜) 친선 행사로 옮긴다",
    fr.format === "friendly" && fr.auto_bucket === false && fr.slug === fcFriendlyEventSlug(new Date("2026-09-21T10:00:00Z"), A, B)
      && (await getFcoContextDetail("fm3"))!.status === "event", JSON.stringify([fr, friendly.actions]));
  const p3bucket = p3.slug!;
  // ⚠ moveSeriesInTx 는 비게 된 자동 묶음 행사를 지우지 않는다(dropEmptySeriesInTx 는 시리즈가 지워질 때만) — 판이 없는 빈 그릇만 남는다.
  check("옮긴 뒤 옛 묶음에는 판이 남지 않는다", (await sql`SELECT 1 FROM match_series ms JOIN event e ON e.id = ms.event_id WHERE e.slug = ${p3bucket}`).length === 0);

  console.log("\n▸ 행사 결론 — 충돌은 확인 대상이지 덮어쓰기 대상이 아니다");
  await applyFcoMatchContext({ provider_match_id: "fm2", conclusion: "event",
    event: { slug: "fc-sisik-cup", name: "고세구 피온시식컵", format: "ck", source_url: "https://example.com/cup" } });
  const fm2 = await getFcoContextDetail("fm2");
  check("행사 생성·연결이 된다 (format=ck)", fm2!.status === "event" && fm2!.event!.format === "ck", JSON.stringify(fm2!.event));
  check("행사로 옮기면 한 판짜리 시리즈째 간다 — 시리즈 키는 그대로", (await placeOf("fm2")).series_id === "set:fco:fm2" && (await placeOf("fm2")).slug === "fc-sisik-cup");
  await saveFcoMatch(detailOf("fm4", "2026-09-21 12:00:00", ["ouid-a", "ouid-b"]));
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "event",
      event: { slug: "fc-sisik-cup", name: "다른 이름", format: "ck", source_url: "https://example.com/x" } }),
    /덮어쓰지 않는다/);
  check("★★ 같은 slug 다른 이름은 거부한다 — 조용한 이름 덮어쓰기 금지", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "event",
      event: { slug: "fc-sisik-cup", name: "고세구 피온시식컵", format: "tournament", source_url: "https://example.com/x" } }),
    /이미 ck/);
  check("★★ 같은 slug 다른 진행 방식은 거부한다 — 연결하는 쪽은 행사를 고치지 않는다", true);
  await sql`INSERT INTO event (slug, name, format, game_code) VALUES ('lol-cup', '롤대회', 'tournament', 'lol')`;
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "event",
      event: { slug: "lol-cup", name: "롤대회", format: "ck", source_url: "https://example.com/x" } }),
    /행사가 쓰고 있다/);
  check("LoL 이 쓰는 slug 는 거부한다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "event",
      event: { slug: "no-url", name: "근거 없음", format: "ck", source_url: "" } }), /source_url/);
  check("근거 URL 없는 행사 결론은 거부한다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "unresolved", note: "" }), /note/);
  check("빈 note 메모는 못 남긴다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "event",
      event: { slug: p1.slug!, name: "묶음 이름", format: "ck", source_url: "https://example.com/x" } }), /자동 미분류 묶음/);
  check("★ 자동 묶음 slug 를 실제 행사로 쓸 수 없다", true);

  console.log("\n▸ 시리즈 — 결론 없이 묶으면 그 판이 있는 묶음 안에서, 승패는 저장하지 않고 파생");
  await saveFcoMatch(detailOf("fs-a", "2026-09-25 10:00:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch({ ...detailOf("fs-b", "2026-09-25 10:12:00", ["ouid-a", "ouid-b"]),
    matchInfo: [
      { ouid: "ouid-a", nickname: "ouid-a", matchDetail: { matchResult: "패" as const }, shoot: { goalTotal: 0 }, player: [] },
      { ouid: "ouid-b", nickname: "ouid-b", matchDetail: { matchResult: "승" as const }, shoot: { goalTotal: 2 }, player: [] },
    ] });
  await saveFcoMatch({ ...detailOf("fs-c", "2026-09-25 10:25:00", ["ouid-a", "ouid-b"]),
    matchInfo: [
      { ouid: "ouid-a", nickname: "ouid-a", matchDetail: { matchResult: "무" as const }, shoot: { goalTotal: 1 }, player: [] },
      { ouid: "ouid-b", nickname: "ouid-b", matchDetail: { matchResult: "무" as const }, shoot: { goalTotal: 1 }, player: [] },
    ] });
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a",
      series: { id: "s-test", game_no: 1, best_of: 3 } }),
    /best_of 에는 근거가 필수/);
  check("★★ best_of 는 근거 없이 못 넣는다 — 연속 경기 수로 추측 금지", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a", series: { id: "s-test", game_no: 1, best_of: 2, best_of_evidence: "x" } }),
    /홀수/);
  check("짝수 best_of 는 거부한다", true);
  const fsBucket = (await placeOf("fs-a")).slug;
  const s1 = await applyFcoMatchContext({ provider_match_id: "fs-a",
    series: { id: "s-test", game_no: 1, best_of: 3, best_of_evidence: "방송 공지 '3판 2선승'" } });
  check("시리즈 생성·연결이 된다", s1.actions.length === 2, JSON.stringify(s1.actions));
  check("★ 결론 없는 시리즈는 그 판의 묶음 안에 선다 — 분류는 여전히 분류 전", (await placeOf("fs-a")).slug === fsBucket && (await placeOf("fs-a")).series_id === "s-test");
  const s1again = await applyFcoMatchContext({ provider_match_id: "fs-a", series: { id: "s-test", game_no: 1 } });
  check("같은 세트 재전송은 멱등이다", s1again.actions.length === 0 && s1again.skipped.length === 1, JSON.stringify(s1again));
  await applyFcoMatchContext({ provider_match_id: "fs-b", series: { id: "s-test", game_no: 2 } });
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-c", series: { id: "s-test", game_no: 2 } }),
    /2세트는 이미/);
  check("★★ 같은 세트 번호를 두 경기가 쓸 수 없다", true);
  await applyFcoMatchContext({ provider_match_id: "fs-c", series: { id: "s-test", game_no: 3 } });
  await saveFcoMatch(detailOf("fs-other", "2026-09-25 11:00:00", ["ouid-a", "ouid-c"]));
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-other", series: { id: "s-test", game_no: 4 } }),
    /다른 대진/);
  check("★★ 상대가 바뀐 경기는 같은 시리즈에 못 들어간다 (대회는 event 로)", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a",
      series: { id: "s-test", game_no: 1, best_of: 5, best_of_evidence: "다른 주장" } }),
    /이미 Bo3/);
  check("best_of 충돌은 덮어쓰지 않고 거부한다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fs-a", conclusion: "event",
      event: { slug: "fc-other", name: "다른컵", format: "tournament", source_url: "https://example.com/y" } }),
    /시리즈/);
  check("여러 판 시리즈의 세트 하나만 행사로 옮기는 것은 거부한다 — series 블록과 함께", true);
  const seriesGames = await sql<{ series_id: string | null; series_game_no: number | null }[]>`
    SELECT series_id, series_game_no FROM match WHERE match_id IN ('fco:fs-a','fco:fs-b','fco:fs-c') ORDER BY series_game_no`;
  check("세 세트가 같은 시리즈에 1·2·3세트로 붙었다",
    seriesGames.length === 3 && seriesGames.every((g) => g.series_id === "s-test")
      && seriesGames.map((g) => g.series_game_no).join(",") === "1,2,3");
  check("옛 한 판짜리 시리즈는 남지 않는다", (await sql`SELECT 1 FROM match_series WHERE id IN ('set:fco:fs-a','set:fco:fs-b','set:fco:fs-c')`).length === 0);
  const toEvent = await applyFcoMatchContext({ provider_match_id: "fs-a", conclusion: "event", series: { id: "s-test", game_no: 1 },
    event: { slug: "fc-series-cup", name: "시리즈컵", format: "tournament", source_url: "https://example.com/s" } });
  check("★ 묶음에 있던 시리즈는 행사 결론과 함께 시리즈째 옮긴다(세 세트 모두)",
    (await placeOf("fs-b")).slug === "fc-series-cup" && (await placeOf("fs-c")).slug === "fc-series-cup", JSON.stringify(toEvent.actions));

  const standing = fcoSeriesStanding([
    { series_id: "s-test", series_game_no: 1, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "알파", outcome: "win", side_no: 1 },
      { ouid: "ouid-b", nickname: "베타", outcome: "loss", side_no: 2 }] },
    { series_id: "s-test", series_game_no: 2, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "알파", outcome: "loss", side_no: 1 },
      { ouid: "ouid-b", nickname: "베타", outcome: "win", side_no: 2 }] },
    { series_id: "s-test", series_game_no: 3, best_of: 3, participants: [
      { ouid: "ouid-a", nickname: "알파", outcome: "draw", side_no: 1 },
      { ouid: "ouid-b", nickname: "베타", outcome: "draw", side_no: 2 }] },
  ]);
  check("★ 표시용 스코어 — 세트 무승부는 어느 쪽 세트승도 아니다(1승1패1무는 동률)",
    standing.leader_key === null && standing.draws === 1 && standing.sets === 3, JSON.stringify(standing));
  const unknownFormat = fcoSeriesStanding([
    { series_id: "y", series_game_no: 1, best_of: null, participants: [
      { ouid: "a", nickname: "a", outcome: "win", side_no: 1 }, { ouid: "b", nickname: "b", outcome: "loss", side_no: 2 }] },
  ]);
  check("★ best_of 를 모르면 '확정' 을 말하지 않는다 (모른다 ≠ 아니다)",
    unknownFormat.clinched === null && unknownFormat.complete === null && unknownFormat.leader_key === "a");
  const blocks = groupFcoSeries([
    { id: "x1", series_id: "set:x1", series_game_no: 1, participants: [] },
    { id: "x2", series_id: "s-test", series_game_no: 1, participants: [] },
    { id: "x3", series_id: "s-test", series_game_no: 2, participants: [] },
  ]);
  check("한 판짜리 시리즈는 단판, 진짜 시리즈는 블록으로 접는다",
    blocks.length === 2 && blocks[0].kind === "single" && blocks[1].kind === "series"
      && (blocks[1] as { sets: unknown[] }).sets.length === 2);

  console.log("\n▸ 재수집 보존 — 공급자 재수집이 사람의 판단·근거·연결·시리즈를 못 덮는다");
  await saveFcoMatch(detailOf("fm1", "2026-09-20 09:51:35", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("fm2", "2026-09-20 10:03:58", ["ouid-b", "ouid-a"]));
  await saveFcoMatch(detailOf("fs-a", "2026-09-25 10:00:00", ["ouid-a", "ouid-b"]));
  const fm1After = await getFcoContextDetail("fm1");
  const fm2After = await getFcoContextDetail("fm2");
  check("★★ 재수집 후 판단 이력·근거·행사 연결이 그대로다",
    fm1After!.history.length === 3 && fm1After!.evidences.length === 2 && fm2After!.status === "event");
  check("★★ 재수집은 이미 시리즈에 있는 판을 옮기지 않는다", (await placeOf("fs-a")).series_id === "s-test" && (await placeOf("fs-a")).slug === "fc-series-cup");
  const scores = await sql<{ score: number | null }[]>`
    SELECT coalesce(score_display, goals) AS score FROM fco_match_participant WHERE match_id = 'fco:fm1' ORDER BY side_no`;
  check("★★ 맥락 반영은 API 소유 필드(점수·승패)를 건드리지 않았다",
    scores[0].score === 2 && scores[1].score === 1, JSON.stringify(scores));

  console.log("\n▸ dry-run — 아무것도 저장되지 않는다");
  const dry = await applyFcoMatchContext({ provider_match_id: "fm4", conclusion: "unresolved",
    note: "dry-run 시험", evidences: [{ evidence_key: "dry:1", kind: "url", url: "https://example.com", observed: "시험" }] },
    { dryRun: true });
  const fm4 = await getFcoContextDetail("fm4");
  check("dry-run 은 했을 일만 보여 주고 저장하지 않는다",
    dry.actions.every((a) => a.startsWith("(dry-run)")) && fm4!.history.length === 0 && fm4!.evidences.length === 0);

  console.log("\n▸ 교차 단서 — LoL 조사가 연 FC 화면");
  const fresh = await addFcoCrossClue({ vod_title_no: 207602969, channel_id: "lshooooo", at_sec: 2400,
    observed: "FC 인게임 화면, 스코어보드에 호날두", observed_at: "2026-09-19T12:00:00Z" });
  const dup = await addFcoCrossClue({ vod_title_no: 207602969, channel_id: "lshooooo", at_sec: 2400,
    observed: "같은 화면 재발견", observed_at: "2026-09-19T12:00:00Z" });
  const clues = await sql<{ source: string }[]>`SELECT source FROM event_lead WHERE source = 'fc_screen'`;
  check("교차 단서는 fc_screen 으로 한 번만 쌓인다", fresh === true && dup === false && clues.length === 1);
  const clueRows = await listFcoCrossClues();
  check("교차 단서가 FC 조사 입구(listFcoCrossClues)로 다시 나온다 — 좌표·관찰 그대로",
    clueRows.length === 1 && clueRows[0].vod_title_no === 207602969
      && clueRows[0].at_sec === 2400 && clueRows[0].observed.includes("호날두"));

  console.log("\n▸ 승인 — 조사가 제안하고 사람은 도장만 찍는다");
  await assert.rejects(() => approveFcoContext("fm4"), /미조사/);
  check("★★ 미조사 경기는 승인할 수 없다 — 도장이 조사를 대신하지 못한다", true);
  await applyFcoMatchContext({
    provider_match_id: "fm4", conclusion: "unresolved", note: "결과창 근처만 확인 — 행사 언급 못 찾음",
    evidences: [{ evidence_key: "vod:300@500", kind: "vod_frame", vod_title_no: 300, channel_id: "cha",
      at_sec: 500, frame_path: "out/ck/300/g0000500.jpg", observed: "FC 인게임 45:00" }],
  });
  const fm4Before = await getFcoContextDetail("fm4");
  check("근거의 frame_path 가 그대로 돌아온다 — 검수 화면이 띄울 파일",
    fm4Before!.evidences[0]?.frame_path === "out/ck/300/g0000500.jpg" && fm4Before!.confirmed === false);
  const approved = await approveFcoContext("fm4");
  const fm4After = await getFcoContextDetail("fm4");
  check("★★ 승인은 auto 메모를 admin 으로 다시 남기고 확인 도장을 찍는다",
    approved.actions.length === 2 && fm4After!.confirmed === true
      && fm4After!.history[0].created_by === "admin" && fm4After!.history[0].note === fm4Before!.history[0].note,
    JSON.stringify(approved.actions));
  const approvedAgain = await approveFcoContext("fm4");
  check("승인 재실행은 전부 ⏭ 이고 admin 행을 늘리지 않는다",
    approvedAgain.actions.length === 0 && (await getFcoContextDetail("fm4"))!.history.length === fm4After!.history.length);
  const autoAfterApprove = await applyFcoMatchContext({
    provider_match_id: "fm4", conclusion: "unresolved", note: "자동 재조사가 뒤집으려 함" });
  check("★★ 승인된 판단을 자동 반영이 못 덮는다", autoAfterApprove.skipped.length === 1);
  const approvedEvent = await approveFcoContext("fm2");
  check("행사 결론 경기의 승인은 확인 도장만 남긴다",
    approvedEvent.actions.length === 1 && (await getFcoContextDetail("fm2"))!.confirmed === true);
  const queueConfirm = await listFcoContextQueue({});
  check("큐가 확인됨(confirmed)과 판단 주체(judgment_by)를 보여 준다",
    queueConfirm.find((r) => r.provider_match_id === "fm4")?.confirmed === true
      && queueConfirm.find((r) => r.provider_match_id === "fm1")?.judgment_by === "admin"
      && queueConfirm.find((r) => r.provider_match_id === "fm2")?.event_format === "ck");

  console.log("\n▸ 보류 — 승인은 되돌릴 수 있다 (판단 이력은 건드리지 않는다)");
  const beforeHold = await getFcoContextDetail("fm4");
  const held = await holdFcoContext("fm4");
  const afterHold = await getFcoContextDetail("fm4");
  check("★★ 보류는 확인 도장만 뗀다 — 판단 이력은 그대로",
    held.actions.length === 1 && afterHold!.confirmed === false
      && afterHold!.history.length === beforeHold!.history.length
      && afterHold!.history[0].created_by === "admin", JSON.stringify(held));
  check("보류 재실행은 ⏭ 다", (await holdFcoContext("fm4")).skipped.length === 1);
  await approveFcoContext("fm4");
  check("보류한 것을 다시 승인할 수 있다", (await getFcoContextDetail("fm4"))!.confirmed === true);

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
  const T0 = 0x6a900000;
  const idAt = (i: number) => `${(T0 - i * 600).toString(16)}${"0".repeat(16)}`;
  let listCalls = 0;
  const total = 250;
  const paged = {
    async matchIds(_o: string, _t: number, offset: number, limit: number) {
      listCalls++;
      return Array.from({ length: total }, (_, i) => idAt(i)).slice(offset, offset + limit);
    },
    async matchDetail() { return null; },
  };
  await saveFcoMatch(detailOf(idAt(3), "2026-09-01 00:00:00", ["ouid-p", "ouid-b"]));
  const pgFirst = await syncFcoMatches(paged, "ouid-p", { types: [40] });
  check("★★ 새 계정은 목록 끝까지 넘긴다 — 100건에서 멈추지 않는다",
    pgFirst.listed["40"] === 250 && pgFirst.coverage["40"] === "end" && listCalls === 3, JSON.stringify(pgFirst));
  check("★★ 상대 목록으로 이미 저장된 경기에서 멈추지 않는다 — 상세만 건너뛴다",
    pgFirst.known === 1 && pgFirst.missing === 249);
  check("빈틈없이 읽었으면 커서를 옮긴다", pgFirst.cursorAdvanced === true);
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

  console.log("\n▸ 모드를 추가해도 과거 경기를 건너뛰지 않는다 (커서는 읽은 모드의 것이다, 0051)");
  const typesOf = async () => (await sql<{ t: number[] | null }[]>`SELECT list_synced_types AS t FROM fco_account WHERE ouid = 'ouid-p'`)[0].t;
  check("기록된 모드가 커서와 함께 저장된다", JSON.stringify(await typesOf()) === JSON.stringify([40]), JSON.stringify(await typesOf()));
  const old50 = Array.from({ length: 30 }, (_, i) => `${(T0 - (2000 + i) * 600).toString(16)}${"0".repeat(16)}`);
  const withMode50 = {
    async matchIds(_o: string, type: number, offset: number, limit: number) {
      const all = type === 50 ? old50 : [...Array.from({ length: 5 }, (_, i) => idNew(4 - i)), ...Array.from({ length: total }, (_, i) => idAt(i))];
      return all.slice(offset, offset + limit);
    },
    async matchDetail() { return null; },
  };
  const added = await syncFcoMatches(withMode50, "ouid-p", { types: [40, 50] });
  check("★★ 새 모드(50)는 커서에서 멈추지 않고 끝까지 읽는다 — 과거 30일 경기를 받는다",
    added.coverage["50"] === "end" && added.listed["50"] === 30 && added.coverage["40"] === "caught_up", JSON.stringify(added.coverage) + JSON.stringify(added.listed));
  check("읽은 모드가 기록에 더해진다", JSON.stringify(await typesOf()) === JSON.stringify([40, 50]), JSON.stringify(await typesOf()));
  const twoModes = await syncFcoMatches(withMode50, "ouid-p", { types: [40, 50] });
  check("다음 수집부터는 두 모드 모두 커서에서 멈춘다", twoModes.coverage["50"] === "caught_up" && twoModes.coverage["40"] === "caught_up", JSON.stringify(twoModes.coverage));
  const cursorOf = async () => (await sql<{ c: Date | null }[]>`SELECT list_synced_until AS c FROM fco_account WHERE ouid = 'ouid-p'`)[0].c?.getTime();
  const c0 = await cursorOf();
  const newer50 = { async matchIds(_o: string, type: number) { return type === 50 ? [`${(T0 + 99999).toString(16)}${"0".repeat(16)}`] : []; }, async matchDetail() { return null; } };
  const subset = await syncFcoMatches(newer50, "ouid-p", { types: [50] });
  check("★★ 일부 모드만 읽은 실행은 커서를 옮기지 않는다", subset.cursorAdvanced === false && (await cursorOf()) === c0, `${c0} → ${await cursorOf()}`);

  queue = await listFcoContextQueue({});
  check("새로 수집된 경기는 미조사로 큐에 선다",
    queue.find((r) => r.provider_match_id === "fm-new")?.status === "uninvestigated");

  console.log("\n▸ 근거의 최소 요건 — 빈 도장은 저장이 거부한다 (draft 초안이 이걸 딛고 선다)");
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4",
      evidences: [{ evidence_key: "draft:1", kind: "vod_frame", vod_title_no: 1, at_sec: 0, observed: "" }] }),
    /observed/);
  check("★★ observed 가 비면 거부한다 — draft 가 채워 둔 빈칸은 지우거나 채워야 반영된다", true);
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm4",
      evidences: [{ evidence_key: "draft:2", kind: "vod_frame", vod_title_no: 1, observed: "봤다" }] }),
    /at_sec/);
  check("vod_frame 은 좌표(vod·초) 없이는 근거가 아니다", true);

  console.log("\n▸ 검수 작업대 — 실제 행사는 행사 하나가 한 단위, 묶음의 판은 경기 하나가 한 단위");
  const workspace = await getFcoReviewWorkspace();
  const eventUnit = workspace.find((u) => u.kind === "event" && u.event?.slug === "fc-sisik-cup");
  check("행사 단위가 소속 경기·근거를 묶어서 나온다(진행 방식 포함)",
    eventUnit?.matches.some((m) => m.provider_match_id === "fm2") === true && eventUnit?.status === "event" && eventUnit.event?.format === "ck");
  check("자동 묶음은 행사 단위로 나오지 않는다", !workspace.some((u) => u.kind === "event" && u.event?.slug?.startsWith("fc-auto-")));
  check("행사에 안 붙은 경기는 경기 단위이고 판단·근거·프레임이 실려 온다",
    workspace.some((u) => u.kind === "match" && u.id === "match:fm4"
      && u.judgment?.created_by === "admin"
      && u.evidences.some((e) => e.frame_path === "out/ck/300/g0000500.jpg")));
  check("확인 전 단위는 pending, 미조사는 pending 이 아니다",
    workspace.find((u) => u.id === "match:fm1")?.pending === true
      && workspace.find((u) => u.id === "match:fm-new")?.pending === false);

  console.log("\n▸ 행사 단위 승인 — 소속 경기 전부에 확인 도장");
  await applyFcoMatchContext({ provider_match_id: "fm-new", conclusion: "event",
    event: { slug: "fc-cup-2", name: "검증컵 2", format: "tournament", source_url: "https://example.com/cup2" } });
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
  check("★★ 행사 기간 안인데 행사에 안 붙은 경기를 찾는다(묶음에 있어도)",
    loose.some((m) => m.provider_match_id === "late-1" && m.event_slug === "fc-cup-2"), JSON.stringify(loose.map((m) => m.provider_match_id)));
  check("이미 행사에 붙은 경기는 안 나온다", !loose.some((m) => m.provider_match_id === "fm-new"));

  console.log("\n▸ 행사 변경 — 화면에서 사람이 바꿀 때만 (relink)");
  await assert.rejects(
    () => applyFcoMatchContext({ provider_match_id: "fm2", conclusion: "event",
      event: { slug: "fc-cup-2", name: "검증컵 2", format: "tournament", source_url: "https://example.com/cup2" } }),
    /이미 다른 행사에 연결/);
  check("★★ 기본은 거부다 — 자동 경로가 행사를 갈아타지 못한다", true);
  const relinked = await applyFcoMatchContext(
    { provider_match_id: "fm2", conclusion: "event",
      event: { slug: "fc-cup-2", name: "검증컵 2", format: "tournament", source_url: "https://example.com/cup2" } },
    { createdBy: "admin", relink: true });
  check("admin 이 relink 로 명시하면 바꾼다",
    relinked.actions.some((a) => a.includes("행사 연결"))
      && (await getFcoContextDetail("fm2"))!.event?.slug === "fc-cup-2");
  const options = await listFcoEventOptions();
  check("행사 선택지가 경기 수·진행 방식과 함께 오고 자동 묶음은 없다",
    options.length >= 2 && options.every((o) => typeof o.games === "number" && !o.slug?.startsWith("fc-auto-")), JSON.stringify(options.map((o) => `${o.slug}:${o.format}:${o.games}`)));
  const bucketId = (await sql<{ id: string }[]>`SELECT id FROM event WHERE auto_bucket AND game_code = 'fconline' LIMIT 1`)[0].id;
  await assert.rejects(() => updateFcoEvent(bucketId, { format: "ck" }), /자동 미분류 묶음/);
  check("★★ 사람은 자동 묶음을 relabel 하지 않는다 — 판을 실제 행사로 옮긴다", true);
  await assert.rejects(() => updateFcoEvent(cup2.id, { format: "land" }), /쓸 수 없다/);
  check("FC 허용 밖 진행 방식(land)은 거부한다", true);

  console.log("\n▸ 대회 후보의 포함/제외 — 소속이 포함, 제외는 현재 제약(event_exclusion)");
  await saveFcoMatch(detailOf("d1", "2026-09-26 10:00:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("d2", "2026-09-26 10:15:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("d3", "2026-09-26 10:30:00", ["ouid-a", "ouid-b"]));
  const dayBucket = (await placeOf("d1")).slug;
  const decCup = { slug: "dec-cup", name: "결정컵", format: "tournament" as const, source_url: "https://example.com/dec" };
  for (const pid of ["d1", "d2", "d3"]) await applyFcoMatchContext({ provider_match_id: pid, conclusion: "event", event: decCup });
  const [dec] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'dec-cup'`;
  const ws0 = (await getFcoReviewWorkspace({ eventId: dec.id }))[0];
  check("조사가 행사에 붙이면 「포함(조사 — 사람 확정 전)」이다", ws0.matches.filter((m) => m.decision === "include" && m.decision_by === "auto").length === 3);
  await assert.rejects(() => decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "exclude" }, { createdBy: "admin" }), /이유/);
  check("★★ 이유 없는 제외는 거부한다 — 왜 뺐는지가 남아야 되돌릴 수 있다", true);
  await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "exclude", note: "개막 전 연습" }, { createdBy: "admin" });
  const d1 = (await getFcoContextDetail("d1"))!;
  check("★★ 제외하면 행사에서 빠져 그날 두 사람 묶음(분류 전)으로 돌아가고 확인 도장이 찍힌다",
    d1.event === null && d1.confirmed === true && (await placeOf("d1")).slug === dayBucket, JSON.stringify(await placeOf("d1")));
  const relinkTry = await applyFcoMatchContext({ provider_match_id: "d1", conclusion: "event", event: decCup });
  check("★★ 사람이 뺀 경기는 자동 조사가 다시 붙이지 못한다 (⏭)",
    relinkTry.skipped.some((x) => x.includes("제외한 경기")) && (await getFcoContextDetail("d1"))!.event === null, JSON.stringify(relinkTry));
  const decUnit = (await getFcoReviewWorkspace({ eventId: dec.id }))[0];
  const d1Row = decUnit.matches.find((m) => m.provider_match_id === "d1");
  check("★★ 제외한 경기도 대회 후보로 남는다 — 사라지지 않아 되돌릴 수 있다",
    d1Row?.decision === "exclude" && d1Row.decision_by === "admin" && d1Row.decision_note === "개막 전 연습" && decUnit.matches.at(-1)?.provider_match_id === "d1");
  check("제외한 경기가 따로 단독 단위로 튀어나오지 않는다",
    !(await getFcoReviewWorkspace()).some((u) => u.kind === "match" && u.matches[0].provider_match_id === "d1"));
  const blocked2 = await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "include" });
  check("사람의 제외 위에 자동 포함은 못 올라간다", blocked2.skipped.length === 1 && blocked2.actions.length === 0);
  const autoExclude = await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d3", decision: "exclude", note: "자동 판단 — 시간 밖" });
  check("자동 제외는 된다(사람이 확정 전인 판)", autoExclude.actions.length === 1 && (await getFcoContextDetail("d3"))!.event === null);
  await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "include", note: "다시 보니 대회 경기" }, { createdBy: "admin" });
  check("사람은 제외를 되돌릴 수 있다 — 제외 행도 지운다",
    (await getFcoContextDetail("d1"))!.event?.slug === "dec-cup"
      && (await sql`SELECT 1 FROM event_exclusion WHERE event_id = ${dec.id}::uuid AND match_id = 'fco:d1'`).length === 0);
  const confirmedOut = await decideFcoEventMatch({ eventId: dec.id, providerMatchId: "d1", decision: "exclude", note: "자동이 빼려 함" });
  check("★ 사람이 확정한 판은 자동 제외가 빼지 않는다", confirmedOut.skipped.length === 1 && (await getFcoContextDetail("d1"))!.event?.slug === "dec-cup");
  const bulk = await approveFcoEvent(dec.id);
  const exRows = await sql<{ decided_by: string }[]>`SELECT decided_by FROM event_exclusion WHERE event_id = ${dec.id}::uuid`;
  check("★★ 일괄 승인은 조사의 제외 제안을 사람 제외로 굳힌다 — 이후 자동 조사가 못 뒤집는다",
    bulk.promoted === 1 && exRows.length === 1 && exRows.every((r) => r.decided_by === "admin"), JSON.stringify(bulk));
  const drift = await sql<{ n: number }[]>`
    SELECT count(*)::int n FROM event_exclusion x
      JOIN match m ON m.match_id = x.match_id JOIN match_series ms ON ms.id = m.series_id
     WHERE ms.event_id = x.event_id`;
  check("★★ 제외된 행사에 여전히 소속된 경기가 없다", drift[0].n === 0, String(drift[0].n));
  await updateFcoEvent(dec.id, { name: "결정컵 2026", organizer: "주최자" });
  check("행사 정보를 [대회] 탭에서 고칠 수 있다",
    (await listFcoEventOptions()).some((o) => o.id === dec.id && o.name === "결정컵 2026" && o.organizer === "주최자"));

  console.log("\n▸ 시리즈 대진 비교는 사람으로 한다 — 화면 경기(ouid 없음)와 API 경기의 같은 사람은 같은 대진 (0054)");
  {
    const { saveFcoScreenMatch } = await import("../packages/core/lib/games/fconline/screen.ts");
    await saveFcoMatch(detailOf("sr-api", "2026-06-01 10:30:00", ["ouid-a", "ouid-b"]));
    // 같은 두 사람의 화면 경기(30일 이전) — 닉네임이 등록 계정과 하나씩만 일치해 사람이 붙고, 같은 날 같은 묶음에 든다
    const scr = await saveFcoScreenMatch({ vodTitleNo: 990001, atSec: 100, endedAt: "2026-06-01T10:10:00Z",
      sides: [{ nickname: "알파감독", score: 2 }, { nickname: "베타감독", score: 1 }] });
    const scrId = (scr as { match_id: string }).match_id;
    check("화면 경기도 같은 규칙으로 두 사람 묶음에 든다", (await placeOf(scrId)).slug === (await placeOf("sr-api")).slug);
    await applyFcoMatchContext({ provider_match_id: scrId, series: { id: "sr-1", game_no: 1 } });
    const joined = await applyFcoMatchContext({ provider_match_id: "sr-api", series: { id: "sr-1", game_no: 2 } });
    check("★★ 화면 경기와 API 경기의 같은 두 사람은 같은 대진으로 본다(예전엔 ouid 비교라 '다른 대진'으로 거부)",
      joined.actions.some((a) => a.includes("시리즈 연결")), JSON.stringify(joined));
    const other = await saveFcoScreenMatch({ vodTitleNo: 990002, atSec: 100, endedAt: "2026-06-01T11:10:00Z",
      sides: [{ nickname: "알파감독", score: 2 }, { nickname: "모르는사람", score: 0 }] });
    const otherId = (other as { match_id: string }).match_id;
    check("한쪽만 스트리머인 화면 경기는 개인 기록", (await placeOf(otherId)).scope === "personal");
    await assert.rejects(() => applyFcoMatchContext({ provider_match_id: otherId, series: { id: "sr-2", game_no: 1 } }), /개인 기록 판/);
    check("개인 기록 판은 결론 없이 시리즈로 묶지 못한다(행사가 없다)", true);
    const srCup = { slug: "sr-cup", name: "화면컵", format: "tournament" as const, source_url: "https://example.com/sr" };
    await applyFcoMatchContext({ provider_match_id: otherId, conclusion: "event", event: srCup, series: { id: "sr-2", game_no: 1 } });
    check("★ 개인 기록 판도 행사 결론으로 내전 세트가 된다(대회의 미등록 상대전)", (await placeOf(otherId)).scope === "versus" && (await placeOf(otherId)).slug === "sr-cup");
    await saveFcoMatch(detailOf("sr-api-2", "2026-06-01 11:30:00", ["ouid-a", "ouid-b"]));
    await assert.rejects(() => applyFcoMatchContext({ provider_match_id: "sr-api-2", conclusion: "event", event: srCup, series: { id: "sr-2", game_no: 2 } }), /다른 대진/);
    check("상대가 다른 화면 경기와는 여전히 같은 대진이 아니다", true);
  }

  console.log("\n▸ 사람이 제외한 경기는 어느 경로로도 되살아나지 않는다 (직접 연결·시리즈·다른 세트·포함 결정)");
  await saveFcoMatch(detailOf("ex-1", "2026-09-28 10:00:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("ex-2", "2026-09-28 10:20:00", ["ouid-a", "ouid-b"]));
  await saveFcoMatch(detailOf("ex-3", "2026-09-28 10:40:00", ["ouid-a", "ouid-b"]));
  const exEvent = { slug: "ex-cup", name: "제외컵", format: "tournament" as const, source_url: "https://example.com/ex" };
  await applyFcoMatchContext({ provider_match_id: "ex-1", conclusion: "event", event: exEvent });
  const exEventId = (await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'ex-cup'`)[0].id;
  await decideFcoEventMatch({ eventId: exEventId, providerMatchId: "ex-1", decision: "exclude", note: "대회 밖 경기" }, { createdBy: "admin" });
  check("준비: admin 이 제외하면 행사에서 빠진다", (await placeOf("ex-1")).slug !== "ex-cup");
  const viaEvent = await applyFcoMatchContext({ provider_match_id: "ex-1", conclusion: "event", event: exEvent });
  check("★★ 단독 연결 경로는 건너뛴다", viaEvent.skipped.some((x) => x.includes("제외")) && (await placeOf("ex-1")).slug !== "ex-cup");
  const viaSeries = await applyFcoMatchContext({ provider_match_id: "ex-1", conclusion: "event", event: exEvent,
    series: { id: "ex-s1", game_no: 1 }, evidences: [{ evidence_key: "ex:1", kind: "url", url: "https://example.com/e", observed: "대진표에 이 경기가 없다" }] });
  check("★★ 시리즈 경로도 건너뛴다 — 시리즈가 생기지도, 행사가 붙지도 않는다",
    viaSeries.skipped.some((x) => x.includes("시리즈") && x.includes("제외")) && (await placeOf("ex-1")).series_id === "set:fco:ex-1"
      && (await sql`SELECT 1 FROM match_series WHERE id = 'ex-s1'`).length === 0, JSON.stringify(viaSeries.skipped));
  check("근거는 보존된다", (await sql`SELECT 1 FROM fco_context_evidence WHERE match_id = 'fco:ex-1' AND evidence_key = 'ex:1'`).length === 1);
  // 다른 세트를 고치다가 제외된 세트가 되살아나는 경로 — 묶음 안에서 시리즈로 묶은 뒤 다른 세트가 시리즈째 행사로 가려 한다
  await applyFcoMatchContext({ provider_match_id: "ex-1", series: { id: "ex-s2", game_no: 1 } });
  const sibling = await applyFcoMatchContext({ provider_match_id: "ex-2", conclusion: "event", event: exEvent, series: { id: "ex-s2", game_no: 2 } });
  check("★★ 다른 세트(자동)가 시리즈째 행사로 옮겨 제외된 세트를 되살리지 못한다",
    sibling.skipped.some((x) => x.includes("같은 시리즈의")) && (await placeOf("ex-1")).slug !== "ex-cup", JSON.stringify(sibling.skipped));
  check("그 세트도 시리즈에 편입되지 않는다(전부 건너뜀)", (await placeOf("ex-2")).series_id === "set:fco:ex-2");
  await applyFcoMatchContext({ provider_match_id: "ex-3", series: { id: "ex-s2", game_no: 3 } });
  await assert.rejects(() => decideFcoEventMatch({ eventId: exEventId, providerMatchId: "ex-3", decision: "include" }), /사람이 이 행사에서 뺀 판/);
  check("★★ 포함 결정도 같은 시리즈의 제외된 세트가 있으면 시리즈째 행사로 못 옮긴다", (await placeOf("ex-3")).slug !== "ex-cup");
  await applyFcoMatchContext({ provider_match_id: "ex-1", conclusion: "event", event: exEvent, series: { id: "ex-s2", game_no: 1 } }, { createdBy: "admin" });
  check("admin 이 명시적으로 다시 포함하면 시리즈째 연결되고 제외가 풀린다",
    (await placeOf("ex-3")).slug === "ex-cup" && (await sql`SELECT 1 FROM event_exclusion WHERE event_id = ${exEventId}::uuid`).length === 0);

  if (failures) { console.error(`\n${failures}개 실패.`); process.exitCode = 1; }
  else console.log("\nFC 맥락 계약 검증 전부 통과.");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

/**
 * FC 화면 경기 검수 작업대의 저장 계약 검증 — 값 고치기·같은 경기 잇기/풀기·완료. 외부 DB 를 쓰지 않는다(PGlite).
 * (docs/FCO-SCREEN-MATCH-DESIGN.md §4 단계 3·7단계, packages/core/lib/games/fconline/screen-review.ts)
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
const R = await import("../packages/core/lib/db/fconline.ts");
const S = await import("../packages/core/lib/games/fconline/screen.ts");
const V = await import("../packages/core/lib/games/fconline/screen-review.ts");
const C = await import("../packages/core/lib/games/fconline/context.ts");
const B = await import("../packages/core/lib/games/fconline/match-units.ts");
const SS = await import("../packages/core/lib/games/fconline/sessions.ts");
/** 그 경기가 들어 있는 대전(경기 하나는 대전 하나에만) */
const sessionsOf = async (id: string) => (await SS.listFcoSessions()).filter((x) => x.match_ids.includes(id));
const unitOf = async (id: string) => (await B.buildMatchUnits([id]))[0];

const dayAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const apiDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const player = (ouid: string, nickname: string, result: "승" | "패" | "무", goal: number) => ({
  ouid, nickname, matchDetail: { matchResult: result, possession: 50 },
  shoot: { goalTotal: goal, shootTotal: 5, effectiveShootTotal: 2 }, pass: { passTry: 50, passSuccess: 40 }, defence: { tackleSuccess: 3 }, player: [],
});
const rejects = async (name: string, fn: () => Promise<unknown>, expected: string) => {
  await assert.rejects(fn, (e: Error) => e.message.includes(expected), `${name} — "${expected}" 로 거부돼야 한다`);
};

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('alpha-fc','알파'),('beta-fc','베타')`;
  await linkFcoAccount({ streamerSlug: "alpha-fc", ouid: "alpha-ouid", nickname: "알파감독", level: 100 });
  await linkFcoAccount({ streamerSlug: "beta-fc", ouid: "beta-ouid", nickname: "베타감독", level: 100 });

  const side = (nickname: string, score: number | null, streamerSlug?: string) =>
    streamerSlug ? { nickname, score, streamerSlug, basis: "vod_owner" as const } : { nickname, score };
  const save = (sec: number, at: Date, a: ReturnType<typeof side>, b: ReturnType<typeof side>) => S.saveFcoScreenMatch({
    vodTitleNo: 900100, atSec: sec, endedAt: at.toISOString(), channelId: "ch", sides: [a, b],
    evidence: [{ observed: `결과 화면 ${a.score}:${b.score}`, frame_path: `out/ck/900100/g${sec}.jpg` }],
  });
  const ver = async (id: string) => (await sql<{ v: number; c: Date | null; r: Date | null }[]>`SELECT review_version v, review_completed_at c, reviewed_at r FROM match WHERE match_id = ${id}`)[0];

  // 준비: 단독 경기 둘, API 경기 하나와 한 글자 오독 화면 경기(검수 대기)
  const t1 = dayAgo(60), t3 = dayAgo(70);
  await save(10, t1, side("알파감독", 2, "alpha-fc"), side("일반감독", 1));
  await save(500, new Date(t1.getTime() + 3_600_000), side("알파감독", 3, "alpha-fc"), side("낯선감독", 3));
  await saveFcoMatch({ matchId: "api-link", matchDate: apiDate(t3), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "승", 2), player("beta-ouid", "베타감독", "패", 1)] });
  const r3 = await save(900, new Date(t3.getTime() + 5_000), side("알파감둑", 2), side("베타감독", 1));
  assert.equal(r3.status, "needs_review");
  const S1 = "fcs:900100@10", S2 = "fcs:900100@500", S3 = "fcs:900100@900", API = "fco:api-link";

  // 1) 목록(대전)·작업대 읽기 — 경기 하나는 대전 하나에만
  for (const id of [S1, S2, S3]) assert.equal((await sessionsOf(id)).length, 1, `${id} 는 대전 하나에만`);
  assert.equal((await sessionsOf(S1))[0].kind, "solo", "알파(방송 주인) vs 일반 유저 → 알파의 일반 유저전");
  assert.ok((await sessionsOf(S1))[0].vods.includes("900100"), "대전이 본 방송을 안다(방송 거르기)");
  const ws = { matches: await B.buildMatchUnits([S1, S2, S3]), streamers: await B.listPickableStreamers() };
  assert.equal(ws.matches.length, 3);
  assert.ok(ws.matches.every((m) => m.sides.length === 2 && m.editable && m.views.find((v) => v.key === "vod:900100")?.frames.length === 1), "경기마다 두 칸과 그 방송 시점의 근거 사진");
  const w3 = ws.matches.find((m) => m.match_id === S3)!;
  assert.equal(w3.candidates[0]?.match_id, API, "오독 경기의 후보에 API 경기가 나온다");
  assert.equal(w3.candidates[0].verdict, "maybe");
  assert.equal(await SS.getFcoSession("abc"), null, "형식이 아닌 대전 id 는 없는 것");
  assert.ok(ws.streamers.some((s) => s.slug === "alpha-fc"), "사람 선택 목록에 FC 계정이 있는 스트리머");

  // 2) 완료 — 변경 번호가 안 맞으면 거부, 완료는 숨김을 바꾸지 않는다
  const v1 = await ver(S1);
  await rejects("오래된 화면", () => B.setFcoMatchCompleted(S1, true, v1.v + 5), "바뀌었습니다");
  await B.setFcoMatchCompleted(S1, true, v1.v);
  const done1 = await ver(S1);
  assert.ok(done1.c && done1.r, "완료하면 완료 시각과 보호 도장이 찍힌다");
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id = ${S1}`)[0].visibility, "hidden", "완료해도 공개되지 않는다");
  await rejects("없는 경기", () => B.setFcoMatchCompleted("fco:none", true, 0), "경기를 찾지 못했습니다");

  // 3) 값 고치기 — 완료가 풀리고 변경 번호가 오르고, 로그가 남고, 다음 자동 조사가 덮지 못한다
  await V.updateScreenSides(S1, done1.v, [{ nickname: "알파감독", score: 2, person: "auto" }, { nickname: "일반감독2", score: 2, person: "auto" }], "first_win");
  const after = await ver(S1);
  assert.equal(after.c, null, "값이 바뀌면 완료가 풀린다");
  assert.equal(after.v, done1.v + 1);
  const row = (await sql<{ nickname: string; outcome: string; score_display: number }[]>`SELECT nickname, outcome, score_display FROM fco_match_participant WHERE match_id = ${S1} ORDER BY side_no`);
  assert.deepEqual(row.map((r) => r.outcome), ["win", "loss"], "직접 정한 결과가 점수보다 우선(승부차기)");
  assert.equal(row[1].nickname, "일반감독2");
  const logs = await sql<{ field: string }[]>`SELECT field FROM review_change WHERE match_id = ${S1}`;
  assert.ok(logs.some((l) => l.field === "nickname") && logs.some((l) => l.field === "review_completed"), "닉네임 변경과 완료 해제가 기록된다");
  const again = await save(10, t1, side("알파감독", 9, "alpha-fc"), side("일반감독", 9));
  assert.equal(again.status, "protected", "사람이 고친 경기는 자동 조사가 덮지 않는다");
  await rejects("오래된 화면", () => V.updateScreenSides(S1, done1.v, [{ nickname: "가", score: 1, person: "auto" }, { nickname: "나", score: 0, person: "auto" }], "auto"), "바뀌었습니다");
  await rejects("빈 닉네임", () => V.updateScreenSides(S1, after.v, [{ nickname: " ", score: 1, person: "auto" }, { nickname: "나", score: 0, person: "auto" }], "auto"), "닉네임이 비었습니다");
  await rejects("범위 밖 점수", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 120, person: "auto" }, { nickname: "나", score: 0, person: "auto" }], "auto"), "점수는");
  await rejects("같은 사람 두 칸", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 1, person: { slug: "alpha-fc" } }, { nickname: "나", score: 0, person: { slug: "alpha-fc" } }], "auto"), "같은 사람");
  await rejects("없는 스트리머", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 1, person: { slug: "nobody" } }, { nickname: "나", score: 0, person: "auto" }], "auto"), "없는 스트리머");
  await V.updateScreenSides(S1, after.v, [{ nickname: "알파감독", score: 2, person: { slug: "alpha-fc" } }, { nickname: "일반감독", score: 1, person: "auto" }], "auto");
  const manual = (await sql<{ identity_basis: string | null; outcome: string }[]>`SELECT identity_basis, outcome FROM fco_match_participant WHERE match_id = ${S1} AND side_no = 1`)[0];
  assert.deepEqual([manual.identity_basis, manual.outcome], ["manual", "win"], "사람이 정한 칸은 근거 manual, 결과는 점수로");
  // 승패만 뒤집어도 기록이 남는다(이전 값·이후 값)
  const vo = await ver(S1);
  await V.updateScreenSides(S1, vo.v, [{ nickname: "알파감독", score: 2, person: "keep" }, { nickname: "일반감독", score: 1, person: "keep" }], "second_win");
  const outcomeLogs = await sql<{ before: unknown; after: unknown }[]>`SELECT before, "after" FROM review_change WHERE match_id = ${S1} AND field = 'outcome' AND entity_key = ${S1 + "#1"} ORDER BY changed_at DESC LIMIT 1`;
  assert.deepEqual([outcomeLogs[0]?.before, outcomeLogs[0]?.after], ["win", "loss"], "승패 변경이 이전·이후 값과 함께 기록된다");

  // 3-2) ★ 사람 지정은 "그대로"가 기본 — 방송 주인(vod_owner) 근거가 저장만으로 사라지면 안 된다(실데이터 56칸이 그 상태였다)
  const S4 = "fcs:900100@1500";
  await save(1500, new Date(t1.getTime() + 7_200_000), side("본캐아님", 1, "alpha-fc"), side("상대", 0));
  const v4 = await ver(S4);
  await V.updateScreenSides(S4, v4.v, [{ nickname: "본캐아님", score: 2, person: "keep" }, { nickname: "상대", score: 0, person: "keep" }], "auto");
  const kept = (await sql<{ streamer_id: string | null; identity_basis: string | null; score_display: number }[]>`SELECT streamer_id, identity_basis, score_display FROM fco_match_participant WHERE match_id = ${S4} AND side_no = 1`)[0];
  assert.deepEqual([kept.identity_basis, kept.score_display], ["vod_owner", 2], "점수만 고치면 방송 주인 근거가 그대로");
  assert.ok(kept.streamer_id, "사람이 그대로 붙어 있다");
  const v4b = await ver(S4);
  await V.updateScreenSides(S4, v4b.v, [{ nickname: "본캐아님", score: 2, person: "auto" }, { nickname: "상대", score: 0, person: "keep" }], "auto");
  const redo = (await sql<{ streamer_id: string | null }[]>`SELECT streamer_id FROM fco_match_participant WHERE match_id = ${S4} AND side_no = 1`)[0];
  assert.equal(redo.streamer_id, null, "닉네임으로 다시 판정을 고르면 등록 닉네임이 아니라 사람이 떨어진다(의도한 선택일 때만)");
  const v4c = await ver(S4);
  await V.updateScreenSides(S4, v4c.v, [{ nickname: "본캐아님", score: 2, person: { slug: "alpha-fc" } }, { nickname: "상대", score: 0, person: "none" }], "auto");
  const manual2 = (await sql<{ identity_basis: string | null }[]>`SELECT identity_basis FROM fco_match_participant WHERE match_id = ${S4} AND side_no = 1`)[0];
  assert.equal(manual2.identity_basis, "manual", "직접 지정은 근거 manual");

  // 4) 같은 경기로 잇기 — 숨김·근거 복사·값 잠금, 풀면 복사한 근거만 거둔다
  const v3 = await ver(S3);
  await rejects("자기 자신", () => V.linkScreenByAdmin(S3, v3.v, S3), "자기 자신");
  await rejects("없는 대상", () => V.linkScreenByAdmin(S3, v3.v, "fco:none"), "찾지 못했습니다");
  await V.linkScreenByAdmin(S3, v3.v, API);
  const link = (await sql<{ api_match_id: string; decided_by: string }[]>`SELECT api_match_id, decided_by FROM fco_screen_link WHERE screen_match_id = ${S3}`)[0];
  assert.deepEqual([link.api_match_id, link.decided_by], [API, "admin"]);
  assert.equal((await sql`SELECT count(*)::int n FROM fco_context_evidence WHERE match_id = ${API} AND frame_path IS NOT NULL`)[0].n, 1, "근거 프레임이 API 경기로 복사된다");
  const v3b = await ver(S3);
  await rejects("연결된 경기 값 고치기", () => V.updateScreenSides(S3, v3b.v, [{ nickname: "가", score: 1, person: "auto" }, { nickname: "나", score: 0, person: "auto" }], "auto"), "연결된 화면 경기");
  await rejects("이미 연결됨", () => V.linkScreenByAdmin(S3, v3b.v, API), "이미 연결");
  const v2 = await ver(S2);
  await rejects("이미 연결된 화면 경기를 대상으로", () => V.linkScreenByAdmin(S2, v2.v, S3), "이미 다른 경기에 연결");
  // 이으면 S3 은 따로 된 경기가 아니라 API 경기의 시점이다(경기 하나 = 키 하나)
  assert.equal((await sessionsOf(S3)).length, 0, "이어진 화면 기록은 따로 된 경기로 안 나온다");
  assert.equal((await sessionsOf(API)).length, 1, "정본(넥슨 기록)은 대전 하나에");
  const apiUnit = (await unitOf(API))!;
  assert.deepEqual([apiUnit.source, apiUnit.provider_match_id, apiUnit.editable], ["provider_api", "api-link", false], "정본은 넥슨 기록(잠김)");
  assert.deepEqual(apiUnit.views.map((v) => v.key), ["api", "vod:900100"], "시점: 넥슨 기록 + 그 방송");
  const s3view = apiUnit.views.find((v) => v.key === "vod:900100")!;
  assert.deepEqual([s3view.screen?.match_id, s3view.screen?.linked?.decided_by], [S3, "admin"]);
  assert.deepEqual(apiUnit.sides.map((x) => x.score), [2, 1], "경기 값은 넥슨 기록");
  // 이어진 경기의 맥락은 대상에 저장된다 — 화면에서 대상 id 로 고친다
  await C.applyFcoMatchContext({ provider_match_id: API, conclusion: "unresolved", note: "이어진 대상의 맥락" }, { createdBy: "admin" });
  const afterCtx = (await unitOf(API))!;
  assert.equal(afterCtx.context.status, "unresolved", "맥락은 정본 경기 하나에 저장된다");
  assert.equal((await sql`SELECT count(*)::int n FROM fco_match_context WHERE match_id = ${S3}`)[0].n, 0, "화면 기록 자체엔 따로 안 쌓인다");

  await V.unlinkScreenByAdmin(S3, v3b.v);
  assert.equal((await sql`SELECT count(*)::int n FROM fco_screen_link WHERE screen_match_id = ${S3}`)[0].n, 0, "연결이 풀린다");
  assert.equal((await sql`SELECT count(*)::int n FROM fco_context_evidence WHERE match_id = ${API} AND frame_path IS NOT NULL`)[0].n, 0, "복사한 근거만 거둔다");
  const v3c = await ver(S3);
  await rejects("연결 안 된 경기 풀기", () => V.unlinkScreenByAdmin(S3, v3c.v), "연결돼 있지 않은");

  // 4-2) 맥락 — 기존 FC 맥락 검수와 같은 함수·같은 도장. 화면 경기는 내부 match_id 로 부른다.
  const ctxOf = async (id: string) => (await unitOf(id))!;
  assert.equal((await ctxOf(S2)).context.status, "uninvestigated", "처음엔 미조사");
  await rejects("근거 없는 친선", () => C.applyFcoMatchContext({ provider_match_id: S2, conclusion: "casual", note: " " }, { createdBy: "admin" }), "note");
  await C.applyFcoMatchContext({ provider_match_id: S2, conclusion: "casual", note: "본인 방송에서 몸풀기라고 말함" }, { createdBy: "admin" });
  const casual = await ctxOf(S2);
  assert.deepEqual([casual.context.status, casual.context.judgment?.created_by], ["casual", "admin"], "화면 경기에도 같은 판단 저장");
  await C.applyFcoMatchContext({ provider_match_id: S2, conclusion: "event", event: { slug: "scr-cup", name: "화면컵", kind: "tournament", source_url: "https://example.com/scr" } }, { createdBy: "admin", relink: true });
  // 행사에 붙으면 대전에서 빠지고 대회 단위에서 본다
  assert.equal((await sessionsOf(S2)).length, 0, "대회에 붙은 경기는 대전에서 빠진다(대회 단위)");
  const [withEvent] = await sql<{ slug: string; c: Date | null }[]>`SELECT e.slug, m.review_completed_at c FROM match m JOIN event e ON e.id = m.event_id WHERE m.match_id = ${S2}`;
  assert.equal(withEvent?.slug, "scr-cup", "행사 연결이 맥락이 된다(기존 규칙)");
  assert.equal(withEvent.c, null, "값(행사)이 바뀌면 완료는 풀린다");
  assert.equal(await C.listFcoEventOptions().then((o) => o.some((e) => e.slug === "scr-cup")), true, "행사 목록에도 나온다");

  // 4-3) 도장 한 가지 — 승인·보류·완료가 같은 두 칸을 만진다. 화면 경기와 API 경기가 똑같다.
  const stamps = async (id: string) => (await sql<{ r: Date | null; c: Date | null }[]>`SELECT reviewed_at r, review_completed_at c FROM match WHERE match_id = ${id}`)[0];
  const a1 = await C.approveFcoContext(S2);
  assert.ok(a1.actions.some((x) => x.includes("확인 도장")));
  const st = await stamps(S2);
  assert.ok(st.r && st.c, "승인은 보호와 완료를 같이 찍는다");
  const a2 = await C.approveFcoContext(S2);
  assert.ok(a2.skipped.some((x) => x.includes("이미")), "다시 승인해도 그대로(멱등)");
  await C.holdFcoContext(S2);
  const held = await stamps(S2);
  assert.deepEqual([held.r, held.c], [null, null], "보류는 두 칸 모두 뗀다");
  // API 경기도 같은 도장 — 맥락 검수 큐의 「확인됨」은 완료(review_completed_at) 기준이다
  await C.applyFcoMatchContext({ provider_match_id: "api-link", conclusion: "casual", note: "API 경기 맥락" }, { createdBy: "admin" });
  assert.equal((await C.getFcoContextDetail("api-link"))!.confirmed, false, "승인 전에는 확인됨이 아니다");
  await C.approveFcoContext("api-link");
  assert.equal((await C.getFcoContextDetail("api-link"))!.confirmed, true, "승인하면 확인됨");
  const api = await stamps(API);
  assert.ok(api.r && api.c, "API 경기 승인도 같은 두 칸");
  await sql`UPDATE match SET review_completed_at = NULL WHERE match_id = ${API}`;
  assert.equal((await C.getFcoContextDetail("api-link"))!.confirmed, false, "보호(reviewed_at)만 있으면 확인됨이 아니다 — 두 뜻을 섞지 않는다");
  // 화면 경기 완료 버튼도 같은 함수 — 같은 두 칸
  const vNow = await ver(S2);
  await B.setFcoMatchCompleted(S2, true, vNow.v);
  const viaScreen = await stamps(S2);
  assert.ok(viaScreen.r && viaScreen.c, "화면 경기 완료도 같은 두 칸");

  // 4-4) ★ 사람이 푼 연결은 자동 합침(reconcile)이 다시 잇지 않는다
  //   S3 은 위에서 사람이 풀었다. API 경기와 닉네임까지 맞게 고쳐 두면 원래 자동 합침 대상이다.
  const v3d = await ver(S3);
  await V.updateScreenSides(S3, v3d.v, [{ nickname: "알파감독", score: 2, person: "auto" }, { nickname: "베타감독", score: 1, person: "auto" }], "auto");
  const rec = await S.reconcileFcoScreenMatches();
  assert.ok(!rec.linked.some((x) => x.screen === S3), "사람이 푼 연결을 자동으로 되살리지 않는다");
  assert.equal((await sql`SELECT count(*)::int n FROM fco_screen_link WHERE screen_match_id = ${S3}`)[0].n, 0);

  // 6) ★ 경기 하나 = 키 하나 — 정본 경기·시점·집 방송 (broadcast.ts)
  //   api-x 를 VOD 900150 은 근거 사진으로, VOD 900200 은 화면 기록(닉네임 한 글자 오독)으로 봤다. 집은 처음 본 방송(900150).
  const tx6 = dayAgo(80);
  await saveFcoMatch({ matchId: "api-x", matchDate: apiDate(tx6), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "승", 3), player("beta-ouid", "베타감독", "패", 0)] });
  await C.applyFcoMatchContext({ provider_match_id: "api-x", conclusion: "casual", note: "조사: 몸풀기", evidences: [
    { evidence_key: "vod:900150@100", kind: "vod_frame", vod_title_no: 900150, at_sec: 100, frame_path: "out/ck/900150/g0000100.jpg", observed: "대기실", role: "pre" }] });
  const X = "fcs:900200@50";
  const rx = await S.saveFcoScreenMatch({ vodTitleNo: 900200, atSec: 50, endedAt: new Date(tx6.getTime() + 4_000).toISOString(), channelId: "ch2",
    sides: [{ nickname: "알파감둑", score: 3 }, { nickname: "베타감독", score: 0 }], evidence: [{ observed: "결과 3:0", frame_path: "out/ck/900200/g0000050.jpg" }] });
  assert.equal(rx.status, "needs_review");
  await V.linkScreenByAdmin(X, (await ver(X)).v, "fco:api-x");

  const sx = await sessionsOf("fco:api-x");
  assert.equal(sx.length, 1, "두 방송에서 본 경기도 대전 하나에만(방송마다 다시 보지 않는다)");
  assert.equal(sx[0].kind, "pair", "알파 vs 베타 — 두 사람의 대전");
  assert.deepEqual(sx[0].vods, ["900150", "900200"], "그 대전을 본 방송 둘(방송 거르기에 둘 다 걸린다)");
  assert.equal((await sessionsOf(X)).length, 0, "이어진 화면 기록은 따로 줄이 되지 않는다");
  assert.equal((await sessionsOf(S2)).length, 0, "S2 는 위에서 행사(scr-cup)에 붙었다 — 대회 단위");
  const mx = (await unitOf("fco:api-x"))!;
  assert.deepEqual(mx.views.map((v) => v.key), ["api", "vod:900150", "vod:900200"], "시점: 넥슨 기록 + VOD 둘");
  assert.equal(mx.editable, false, "넥슨 기록이 정본이면 경기 값은 잠긴다");
  const v200 = mx.views.find((v) => v.key === "vod:900200")!;
  assert.equal(v200.screen?.match_id, X);
  assert.ok(v200.mismatches.some((x) => x.field.includes("닉네임") && x.view === "알파감둑"), "시점이 읽은 값과 경기 값이 다른 곳(닉네임 오독)");
  assert.equal(mx.views.find((v) => v.key === "vod:900150")!.frames.length, 1, "근거 사진만 있는 시점");
  assert.equal(mx.context.judgment?.created_by, "auto");

  // 완료: 넥슨 기록 정본도 같은 도장. 자동 판단은 사람 판단으로 굳는다(기존 승인과 같다)
  await B.setFcoMatchCompleted("fco:api-x", true, mx.review_version);
  const after6 = (await unitOf("fco:api-x"))!;
  assert.ok(after6.review_completed_at, "완료");
  assert.equal(after6.context.judgment?.created_by, "admin", "완료하면 자동 판단이 사람 판단으로 굳는다");

  // 저장하고 완료 — 한 트랜잭션: 고친 값에 완료가 붙는다
  const v1now = await ver(S1);
  await B.saveAndCompleteScreenMatch(S1, v1now.v, [{ nickname: "알파감독", score: 4, person: "keep" }, { nickname: "일반감독", score: 1, person: "keep" }], "auto");
  const done1b = await ver(S1);
  const score1 = (await sql<{ s: number }[]>`SELECT score_display s FROM fco_match_participant WHERE match_id = ${S1} AND side_no = 1`)[0].s;
  assert.ok(done1b.c && score1 === 4, "고친 값(4)으로 저장되고 완료가 찍힌다");
  await rejects("오래된 화면에서 저장하고 완료", () => B.saveAndCompleteScreenMatch(S1, v1now.v, [{ nickname: "알파감독", score: 5, person: "keep" }, { nickname: "일반감독", score: 1, person: "keep" }], "auto"), "바뀌었습니다");
  assert.equal((await sql<{ s: number }[]>`SELECT score_display s FROM fco_match_participant WHERE match_id = ${S1} AND side_no = 1`)[0].s, 4, "실패하면 값도 안 바뀐다(같은 트랜잭션)");

  // 7) 대회에 붙은 화면 기록 정본도 대회 작업대가 읽고, 포함/제외를 정할 수 있다(넥슨 번호가 없어도)
  const [scr] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'scr-cup'`;
  assert.deepEqual(await B.eventScreenMatchIds(scr.id), [S2], "대회에 붙은 화면 기록 정본");
  await C.decideFcoEventMatch({ eventId: scr.id, providerMatchId: S2, decision: "exclude", note: "개막 전 연습" }, { createdBy: "admin" });
  assert.equal((await sql`SELECT event_id FROM match WHERE match_id = ${S2}`)[0].event_id, null, "내부 번호로도 대회에서 뺄 수 있다");
  assert.equal((await B.buildMatchUnits([S2]))[0]?.match_id, S2, "공용 빌더는 어느 단위의 경기든 같은 모양으로 만든다");

  // 8) 같은 경기를 두 방송에서 읽음 — 한쪽은 사람이 붙고(방송 주인) 다른 쪽은 닉네임만. 자동 대조가 작은 방송 쪽으로 묶는다.
  const t8 = dayAgo(90);
  const P = "fcs:900300@30", Q = "fcs:900400@40";
  await S.saveFcoScreenMatch({ vodTitleNo: 900300, atSec: 30, endedAt: t8.toISOString(), channelId: "c3",
    sides: [{ nickname: "불꽃열정", score: 1, streamerSlug: "beta-fc", basis: "vod_owner" }, { nickname: "H000", score: 3 }], evidence: [{ observed: "1:3", frame_path: "out/ck/900300/g0000030.jpg" }] });
  const rq = await S.saveFcoScreenMatch({ vodTitleNo: 900400, atSec: 40, endedAt: new Date(t8.getTime() + 7_000).toISOString(), channelId: "c4",
    sides: [{ nickname: "H000", score: 3 }, { nickname: "불꽃열정", score: 1 }], evidence: [{ observed: "3:1", frame_path: "out/ck/900400/g0000040.jpg" }] });
  assert.equal(rq.status, "linked", "저장할 때 이미 같은 경기로 묶인다(규칙 수정 전에는 needs_review)");
  assert.equal((rq as { link_to: string }).link_to, P, "먼저 방송한 쪽이 정본");
  assert.equal((await sessionsOf(P)).length, 1, "목록에는 한 번만");
  assert.equal((await sessionsOf(Q)).length, 0, "이어진 쪽은 따로 안 나온다");
  const viewsP = (await unitOf(P))!.views.map((v) => v.key);
  assert.deepEqual(viewsP, ["vod:900300", "vod:900400"], "두 방송이 같은 경기의 시점");

  // 9) 대전 묶음 — 같은 두 사람이 40분 안에 연달아 하면 한 대전, 더 벌어지면 다음 대전
  const t9 = dayAgo(100);
  for (const [id, mins] of [["pair-a", 0], ["pair-b", 20], ["pair-c", 140]] as const) {
    await saveFcoMatch({ matchId: id, matchDate: apiDate(new Date(t9.getTime() + mins * 60_000)), matchType: 40,
      matchInfo: [player("alpha-ouid", "알파감독", "승", 1), player("beta-ouid", "베타감독", "패", 0)] });
  }
  const sa = await sessionsOf("fco:pair-a"), sc = await sessionsOf("fco:pair-c");
  assert.deepEqual(sa[0]?.match_ids, ["fco:pair-a", "fco:pair-b"], "20분 간격은 한 대전");
  assert.deepEqual(sc[0]?.match_ids, ["fco:pair-c"], "2시간 뒤는 다음 대전");
  assert.equal(sa[0].investigated, false, "조사 기록이 없으면 「조사 필요」");
  assert.equal((await SS.getFcoSession(sa[0].id))?.id, sa[0].id, "대전 id 로 다시 연다");

  // 5) 검수해도 공개 조회는 그대로 — 화면 경기가 공개 쪽에 새지 않는다
  const dump = JSON.stringify([await R.listFcoPeople(), await R.listFcoTopPairs(50), await R.listFcoLeaderboard(), await R.listFcoEvents()]);
  assert.ok(!dump.includes("fcs:") && !dump.includes("일반감독") && !dump.includes("낯선감독"), "공개 조회에 화면 경기가 샜다");
  console.log("FC 화면 경기 검수(값 고치기·잇기·풀기·완료·보호·로그·공개 불변) 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

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

  // 1) 목록·작업대 읽기
  const vods = await V.listScreenReviewVods();
  assert.equal(vods.length, 1);
  assert.deepEqual([vods[0].vod, vods[0].total, vods[0].completed, vods[0].linked], ["900100", 3, 0, 0]);
  const ws = (await V.getScreenReviewWorkspace("900100"))!;
  assert.equal(ws.matches.length, 3);
  assert.ok(ws.matches.every((m) => m.sides.length === 2 && m.frames.length === 1), "경기마다 두 칸과 근거 프레임");
  const w3 = ws.matches.find((m) => m.match_id === S3)!;
  assert.equal(w3.candidates[0]?.match_id, API, "오독 경기의 후보에 API 경기가 나온다");
  assert.equal(w3.candidates[0].verdict, "maybe");
  assert.equal(await V.getScreenReviewWorkspace("abc"), null, "숫자가 아닌 VOD 는 없는 것");
  assert.ok(ws.streamers.some((s) => s.slug === "alpha-fc"), "사람 선택 목록에 FC 계정이 있는 스트리머");

  // 2) 완료 — 변경 번호가 안 맞으면 거부, 완료는 숨김을 바꾸지 않는다
  const v1 = await ver(S1);
  await rejects("오래된 화면", () => V.setScreenReviewCompleted(S1, true, v1.v + 5), "바뀌었습니다");
  await V.setScreenReviewCompleted(S1, true, v1.v);
  const done1 = await ver(S1);
  assert.ok(done1.c && done1.r, "완료하면 완료 시각과 보호 도장이 찍힌다");
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id = ${S1}`)[0].visibility, "hidden", "완료해도 공개되지 않는다");
  await rejects("화면 경기가 아닌 것", () => V.setScreenReviewCompleted(API, true, 0), "화면 경기를 찾지 못했습니다");

  // 3) 값 고치기 — 완료가 풀리고 변경 번호가 오르고, 로그가 남고, 다음 자동 조사가 덮지 못한다
  await V.updateScreenSides(S1, done1.v, [{ nickname: "알파감독", score: 2, streamerSlug: null }, { nickname: "일반감독2", score: 2, streamerSlug: null }], "first_win");
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
  await rejects("오래된 화면", () => V.updateScreenSides(S1, done1.v, [{ nickname: "가", score: 1, streamerSlug: null }, { nickname: "나", score: 0, streamerSlug: null }], "auto"), "바뀌었습니다");
  await rejects("빈 닉네임", () => V.updateScreenSides(S1, after.v, [{ nickname: " ", score: 1, streamerSlug: null }, { nickname: "나", score: 0, streamerSlug: null }], "auto"), "닉네임이 비었습니다");
  await rejects("범위 밖 점수", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 120, streamerSlug: null }, { nickname: "나", score: 0, streamerSlug: null }], "auto"), "점수는");
  await rejects("같은 사람 두 칸", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 1, streamerSlug: "alpha-fc" }, { nickname: "나", score: 0, streamerSlug: "alpha-fc" }], "auto"), "같은 사람");
  await rejects("없는 스트리머", () => V.updateScreenSides(S1, after.v, [{ nickname: "가", score: 1, streamerSlug: "nobody" }, { nickname: "나", score: 0, streamerSlug: null }], "auto"), "없는 스트리머");
  await V.updateScreenSides(S1, after.v, [{ nickname: "알파감독", score: 2, streamerSlug: "alpha-fc" }, { nickname: "일반감독", score: 1, streamerSlug: null }], "auto");
  const manual = (await sql<{ identity_basis: string | null; outcome: string }[]>`SELECT identity_basis, outcome FROM fco_match_participant WHERE match_id = ${S1} AND side_no = 1`)[0];
  assert.deepEqual([manual.identity_basis, manual.outcome], ["manual", "win"], "사람이 정한 칸은 근거 manual, 결과는 점수로");

  // 4) 같은 경기로 잇기 — 숨김·근거 복사·값 잠금, 풀면 복사한 근거만 거둔다
  const v3 = await ver(S3);
  await rejects("자기 자신", () => V.linkScreenByAdmin(S3, v3.v, S3), "자기 자신");
  await rejects("없는 대상", () => V.linkScreenByAdmin(S3, v3.v, "fco:none"), "찾지 못했습니다");
  await V.linkScreenByAdmin(S3, v3.v, API);
  const link = (await sql<{ api_match_id: string; decided_by: string }[]>`SELECT api_match_id, decided_by FROM fco_screen_link WHERE screen_match_id = ${S3}`)[0];
  assert.deepEqual([link.api_match_id, link.decided_by], [API, "admin"]);
  assert.equal((await sql`SELECT count(*)::int n FROM fco_context_evidence WHERE match_id = ${API} AND frame_path IS NOT NULL`)[0].n, 1, "근거 프레임이 API 경기로 복사된다");
  const v3b = await ver(S3);
  await rejects("연결된 경기 값 고치기", () => V.updateScreenSides(S3, v3b.v, [{ nickname: "가", score: 1, streamerSlug: null }, { nickname: "나", score: 0, streamerSlug: null }], "auto"), "연결된 화면 경기");
  await rejects("이미 연결됨", () => V.linkScreenByAdmin(S3, v3b.v, API), "이미 연결");
  const v2 = await ver(S2);
  await rejects("이미 연결된 화면 경기를 대상으로", () => V.linkScreenByAdmin(S2, v2.v, S3), "이미 다른 경기에 연결");
  assert.equal(((await V.getScreenReviewWorkspace("900100"))!.matches.find((m) => m.match_id === S3)!).link?.decided_by, "admin");

  await V.unlinkScreenByAdmin(S3, v3b.v);
  assert.equal((await sql`SELECT count(*)::int n FROM fco_screen_link WHERE screen_match_id = ${S3}`)[0].n, 0, "연결이 풀린다");
  assert.equal((await sql`SELECT count(*)::int n FROM fco_context_evidence WHERE match_id = ${API} AND frame_path IS NOT NULL`)[0].n, 0, "복사한 근거만 거둔다");
  const v3c = await ver(S3);
  await rejects("연결 안 된 경기 풀기", () => V.unlinkScreenByAdmin(S3, v3c.v), "연결돼 있지 않은");

  // 5) 검수해도 공개 조회는 그대로 — 화면 경기가 공개 쪽에 새지 않는다
  const dump = JSON.stringify([await R.listFcoPeople(), await R.listFcoTopPairs(50), await R.listFcoLeaderboard(), await R.listFcoEvents()]);
  assert.ok(!dump.includes("fcs:") && !dump.includes("일반감독") && !dump.includes("낯선감독"), "공개 조회에 화면 경기가 샜다");
  console.log("FC 화면 경기 검수(값 고치기·잇기·풀기·완료·보호·로그·공개 불변) 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

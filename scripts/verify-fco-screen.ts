/** FC 화면 경기(API 없이 VOD 화면으로만 아는 경기)의 저장·합침 검증. 외부 DB를 사용하지 않는다. (docs/FCO-SCREEN-MATCH-DESIGN.md) */
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

/** 공개 조회 전부의 직렬화 — 화면 경기를 넣어도 이게 안 바뀌어야 한다(설계 §10 단계 1). */
async function publicDump(ids: string[]): Promise<string> {
  const out: unknown[] = [await R.listFcoPeople(), await R.listFcoTopPairs(50), await R.getFeaturedFcoPair(), await R.listFcoEvents()];
  for (const e of await R.listFcoEvents()) out.push(await R.listFcoEventGames(e.id));
  for (const id of ids) {
    out.push(await R.listFcoGamesForPerson(id, 500), await R.listFcoStreamerGamesForPerson(id, 500), await R.listFcoModesForPerson(id));
    for (const o of ids) if (o !== id) out.push(await R.listFcoVersus(id, o));
  }
  return JSON.stringify(out);
}

const dayAgo = (d: number, minutes = 0) => new Date(Date.now() - d * 86_400_000 + minutes * 60_000);
const apiDate = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const player = (ouid: string, nickname: string, result: "승" | "패" | "무", goal: number) => ({
  ouid, nickname, matchDetail: { matchResult: result, possession: 50 },
  shoot: { goalTotal: goal, shootTotal: 5, effectiveShootTotal: 2 }, pass: { passTry: 50, passSuccess: 40 }, defence: { tackleSuccess: 3 }, player: [],
});

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('alpha-fc','알파'),('beta-fc','베타'),('gamma-fc','감마')`;
  await linkFcoAccount({ streamerSlug: "alpha-fc", ouid: "alpha-ouid", nickname: "알파감독", level: 100 });
  await linkFcoAccount({ streamerSlug: "beta-fc", ouid: "beta-ouid", nickname: "베타감독", level: 100 });
  const ids = (await sql<{ id: string }[]>`SELECT id FROM streamer WHERE slug IN ('alpha-fc','beta-fc') ORDER BY slug`).map((r) => r.id);
  // 기존 API 경기 몇 개 — 공개 조회가 이걸 보여 주고 있어야 비교가 의미 있다.
  const recent = dayAgo(5);
  await saveFcoMatch({ matchId: "api-recent", matchDate: apiDate(recent), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "승", 2), player("beta-ouid", "베타감독", "패", 1)] });
  await saveFcoMatch({ matchId: "api-recent-2", matchDate: apiDate(dayAgo(3)), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "패", 0), player("beta-ouid", "베타감독", "승", 1)] });
  const before = await publicDump(ids);
  assert.ok(before.includes("알파감독"), "기준 덤프에 API 경기가 있어야 한다");

  const old = dayAgo(60);
  const input = (vod: number, sec: number, at: Date, a: Partial<import("../packages/core/lib/games/fconline/screen.ts").FcoScreenSideInput>, b: Partial<import("../packages/core/lib/games/fconline/screen.ts").FcoScreenSideInput>) => ({
    vodTitleNo: vod, atSec: sec, endedAt: at.toISOString(), channelId: "ch",
    sides: [{ nickname: "알파감독", score: 2, ...a }, { nickname: "일반감독", score: 1, ...b }] as [never, never],
    evidence: [{ observed: "결과 화면 2:1", frame_path: `out/ck/${vod}/g${sec}.jpg` }],
  });

  // 1) 저장 — 오래된 경기: 알파(방송 주인) vs 미등록 상대
  const r1 = await S.saveFcoScreenMatch(input(900001, 3600, old, { streamerSlug: "alpha-fc", basis: "vod_owner" }, {}));
  assert.equal(r1.status, "created");
  const id1 = (r1 as { match_id: string }).match_id;
  assert.equal(id1, "fcs:900001@3600");
  const m1 = (await sql`SELECT source, origin, visibility, game_code, mode_key, source_url FROM match WHERE match_id = ${id1}`)[0];
  assert.deepEqual({ ...m1 }, { source: "manual", origin: "vod_scan", visibility: "hidden", game_code: "fconline", mode_key: null, source_url: "https://vod.sooplive.com/player/900001" });
  assert.equal((await sql`SELECT 1 FROM fco_match_detail WHERE match_id = ${id1}`).length, 0, "화면 경기에 가짜 원본(detail)을 만들지 않는다");
  const p1 = await sql`SELECT side_no, ouid, nickname, streamer_id IS NOT NULL AS has_streamer, identity_basis, outcome, goals, score_display FROM fco_match_participant WHERE match_id = ${id1} ORDER BY side_no`;
  assert.deepEqual(p1.map((r) => ({ ...r })), [
    { side_no: 1, ouid: null, nickname: "알파감독", has_streamer: true, identity_basis: "vod_owner", outcome: "win", goals: null, score_display: 2 },
    { side_no: 2, ouid: null, nickname: "일반감독", has_streamer: false, identity_basis: null, outcome: "loss", goals: null, score_display: 1 },
  ]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = ${id1} AND role = 'result'`)[0].n, 1);

  // 핵심 불변식: 화면 경기가 있어도 기존 공개 조회 결과는 한 글자도 안 바뀐다
  assert.equal(await publicDump(ids), before, "화면 경기가 공개 조회에 새거나 기존 결과를 바꿨다");

  // 2) 멱등 — 같은 화면을 다시 읽어도 한 번만 남는다
  assert.equal((await S.saveFcoScreenMatch(input(900001, 3600, old, { streamerSlug: "alpha-fc", basis: "vod_owner" }, {}))).status, "updated");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_match_participant WHERE match_id = ${id1}`)[0].n, 2);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = ${id1}`)[0].n, 1);

  // 3) 못 읽은 값은 NULL, 같은 점수는 승부차기 가능성 → unknown, 직접 본 결과가 우선
  const t3 = dayAgo(61);
  const r3 = await S.saveFcoScreenMatch(input(900002, 100, t3, { score: null, nickname: "무명A" }, { score: null, nickname: "무명B" }));
  assert.equal(r3.status, "created");
  const o3 = await sql`SELECT outcome, score_display FROM fco_match_participant WHERE match_id = 'fcs:900002@100' ORDER BY side_no`;
  assert.deepEqual(o3.map((r) => ({ ...r })), [{ outcome: "unknown", score_display: null }, { outcome: "unknown", score_display: null }]);
  assert.deepEqual(S.screenOutcomes([{ nickname: "a", score: 1 }, { nickname: "b", score: 1 }]), ["unknown", "unknown"]);
  assert.deepEqual(S.screenOutcomes([{ nickname: "a", score: 1, outcome: "win" }, { nickname: "b", score: 1 }]), ["win", "loss"]);
  assert.throws(() => S.screenOutcomes([{ nickname: "a", score: 1, outcome: "win" }, { nickname: "b", score: 1, outcome: "win" }]));

  // 4) 닉네임이 등록 계정 하나와만 일치하면 붙인다(nickname_match) · 동명이면 안 붙인다
  const t4 = dayAgo(62);
  await S.saveFcoScreenMatch(input(900003, 200, t4, { nickname: "베타감독" }, { nickname: "일반감독" }));
  const p4 = (await sql`SELECT streamer_id IS NOT NULL AS has, identity_basis FROM fco_match_participant WHERE match_id = 'fcs:900003@200' AND side_no = 1`)[0];
  assert.deepEqual({ ...p4 }, { has: true, identity_basis: "nickname_match" });
  await sql`INSERT INTO fco_account (ouid, nickname) VALUES ('dup-ouid', '베타 감독')`;
  await sql`INSERT INTO streamer_fco_account (ouid, streamer_id) SELECT 'dup-ouid', id FROM streamer WHERE slug = 'gamma-fc'`;
  await S.saveFcoScreenMatch(input(900003, 200, t4, { nickname: "베타감독" }, { nickname: "일반감독" }));
  const p4b = (await sql`SELECT streamer_id IS NOT NULL AS has, identity_basis FROM fco_match_participant WHERE match_id = 'fcs:900003@200' AND side_no = 1`)[0];
  assert.deepEqual({ ...p4b }, { has: false, identity_basis: null }, "닉네임이 두 계정에 걸리면 사람을 붙이지 않는다");
  await sql`DELETE FROM streamer_fco_account WHERE ouid = 'dup-ouid'`;

  // 5) 근거 없는 사람 지정은 거부 — API 와 DB 제약 둘 다
  await assert.rejects(() => S.saveFcoScreenMatch(input(900004, 1, old, { streamerSlug: "alpha-fc" }, {})), /basis/);
  await assert.rejects(() => sql`INSERT INTO fco_match_participant (match_id, side_no, nickname, streamer_id, outcome) SELECT ${id1}, 3, 'x', id, 'unknown' FROM streamer WHERE slug = 'alpha-fc'`);
  await assert.rejects(() => sql`INSERT INTO fco_match_participant (match_id, side_no, nickname, ouid, identity_basis, outcome) VALUES (${id1}, 4, 'x', 'o', 'manual', 'unknown')`);

  // 6) 검수된 경기는 덮어쓰지 않는다
  await sql`UPDATE match SET reviewed_at = now() WHERE match_id = ${id1}`;
  assert.equal((await S.saveFcoScreenMatch(input(900001, 3600, old, { nickname: "다른이름", score: 9 }, {}))).status, "protected");
  assert.equal((await sql`SELECT nickname FROM fco_match_participant WHERE match_id = ${id1} AND side_no = 1`)[0].nickname, "알파감독");

  // 7) R1 — 같은 경기의 API 기록이 이미 있으면 **연결**한다. 관측은 먼저 저장되고, 근거는 API 경기로 복사된다(버리지 않는다)
  const r7 = await S.saveFcoScreenMatch(input(900005, 300, new Date(recent.getTime() + 60_000), { streamerSlug: "alpha-fc", basis: "vod_owner" }, { nickname: "베타감독" }));
  assert.equal(r7.status, "linked");
  assert.equal((r7 as { link_to: string }).link_to, "fco:api-recent");
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id = 'fcs:900005@300'`)[0].visibility, "hidden", "관측은 숨긴 채 남는다");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = 'fco:api-recent'`)[0].n, 1, "새 영상의 근거가 API 경기에 붙었다");
  assert.equal((await S.saveFcoScreenMatch(input(900005, 300, new Date(recent.getTime() + 60_000), { streamerSlug: "alpha-fc", basis: "vod_owner" }, { nickname: "베타감독" }))).status, "linked", "다시 불러도 같다");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_screen_link WHERE screen_match_id = 'fcs:900005@300'`)[0].n, 1);

  // 8) 최근 30일 + 등록 계정이 있는데 API 경기가 아직 없다 → **저장은 하고** expect_api 로 알린다. API 가 끝내 안 와도 관측은 남는다.
  const r8 = await S.saveFcoScreenMatch(input(900006, 400, dayAgo(2), { streamerSlug: "alpha-fc", basis: "vod_owner" }, {}));
  assert.equal(r8.status, "created");
  assert.equal((r8 as { expect_api: boolean }).expect_api, true);
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id = 'fcs:900006@400'`)[0].visibility, "hidden");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = 'fcs:900006@400'`)[0].n, 1);
  // 최근이어도 등록 계정이 없으면 API 가 못 준다 → expect_api false (결정 2)
  const r8b = await S.saveFcoScreenMatch(input(900007, 500, dayAgo(2), { nickname: "남1" }, { nickname: "남2" }));
  assert.deepEqual({ s: r8b.status, e: (r8b as { expect_api: boolean }).expect_api }, { s: "created", e: false });

  // 9) 다른 VOD 가 같은 경기를 또 찍었다 → 기존 기록에 연결하고 근거를 더한다
  const r9 = await S.saveFcoScreenMatch(input(900008, 77, new Date(old.getTime() + 90_000), { streamerSlug: "alpha-fc", basis: "vod_owner" }, {}));
  assert.equal(r9.status, "linked");
  assert.equal((r9 as { link_to: string }).link_to, id1);
  assert.equal((r9 as { link_to_source: string }).link_to_source, "manual");
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = ${id1}`)[0].n, 2, "두 VOD 의 근거가 정본 경기에 모인다");

  // 10) 참가자 구분 키
  // 스트리머 → 계정 → 화면 이름 순(0054). 같은 사람이 API 경기(ouid+스트리머)와 화면 경기(스트리머만)에서 같은 키를 받는다.
  const key = await sql`SELECT fco_participant_key('o', NULL, 'n') AS a, fco_participant_key(NULL, ${ids[0]}::uuid, 'n') AS b,
                               fco_participant_key(NULL, NULL, 'n') AS c, fco_participant_key('o', ${ids[0]}::uuid, 'n') AS d`;
  assert.equal(key[0].a, "o"); assert.equal(key[0].b, `streamer:${ids[0]}`); assert.equal(key[0].c, "name:n");
  assert.equal(key[0].d, key[0].b, "API 경기의 같은 사람(ouid+스트리머)과 화면 경기(스트리머만)가 같은 키");

  // 11) R2 — 화면으로 먼저 안 경기가 나중에 API 로 들어오면 합친다
  const t11 = dayAgo(70);
  const r11 = await S.saveFcoScreenMatch(input(900009, 900, t11, { streamerSlug: "alpha-fc", basis: "vod_owner" }, { nickname: "베타감독" }));
  assert.equal(r11.status, "created");
  assert.deepEqual(await S.reconcileFcoScreenMatches(), { linked: [], suspects: 0 }, "API 경기가 아직 없으면 합칠 게 없다");
  await saveFcoMatch({ matchId: "api-late", matchDate: apiDate(new Date(t11.getTime() + 45_000)), matchType: 40,
    matchInfo: [player("alpha-ouid", "알파감독", "승", 2), player("beta-ouid", "베타감독", "패", 1)] });
  const rec = await S.reconcileFcoScreenMatches();
  assert.deepEqual(rec.linked, [{ screen: "fcs:900009@900", api: "fco:api-late" }]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_context_evidence WHERE match_id = 'fco:api-late'`)[0].n, 1, "근거가 API 경기로 옮겨졌다");
  assert.equal((await sql`SELECT visibility FROM match WHERE match_id = 'fcs:900009@900'`)[0].visibility, "hidden");
  assert.deepEqual(await S.reconcileFcoScreenMatches(), { linked: [], suspects: 0 }, "다시 불러도 같다(멱등)");

  // 12) R3 — 스코어를 못 읽었으면 합치지 않고 의심으로 남긴다
  const t12 = dayAgo(71);
  await S.saveFcoScreenMatch(input(900010, 10, t12, { streamerSlug: "alpha-fc", basis: "vod_owner", score: null }, { nickname: "베타감독", score: null }));
  await saveFcoMatch({ matchId: "api-maybe", matchDate: apiDate(t12), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "승", 3), player("beta-ouid", "베타감독", "패", 0)] });
  const rec12 = await S.reconcileFcoScreenMatches();
  assert.deepEqual(rec12.linked, []); assert.equal(rec12.suspects >= 1, true);
  assert.deepEqual((await S.findFcoScreenSuspects()).filter((x) => x.screen_match_id === "fcs:900010@10").map((x) => x.other_match_id), ["fco:api-maybe"]);
  // 후보가 둘이면 스코어가 맞아도 자동으로 안 합친다
  const t13 = dayAgo(72);
  await S.saveFcoScreenMatch(input(900011, 11, t13, { streamerSlug: "alpha-fc", basis: "vod_owner" }, { nickname: "베타감독", score: 1 }));
  for (const [i, off] of [[1, 10_000], [2, 70_000]] as const) {
    await saveFcoMatch({ matchId: `api-two-${i}`, matchDate: apiDate(new Date(t13.getTime() + off)), matchType: 40,
      matchInfo: [player("alpha-ouid", "알파감독", "승", 2), player("beta-ouid", "베타감독", "패", 1)] });
  }
  assert.deepEqual((await S.reconcileFcoScreenMatches()).linked, [], "후보가 둘이면 합치지 않는다");
  const amb = (await S.findFcoScreenSuspects()).filter((x) => x.screen_match_id === "fcs:900011@11");
  assert.deepEqual(amb.map((x) => x.verdict), ["ambiguous", "ambiguous"], "후보가 둘이면 둘 다 의심 목록에 올라온다");
  // 후보가 이미 둘인 상태에서 새로 저장해도 먼저 찾은 것을 고르지 않고, 관측은 저장하고 검수 대기로 둔다
  const r13 = await S.saveFcoScreenMatch(input(900012, 12, new Date(t13.getTime() + 20_000), { streamerSlug: "alpha-fc", basis: "vod_owner" }, { nickname: "베타감독", score: 1 }));
  assert.equal(r13.status, "needs_review");
  assert.deepEqual((r13 as { candidates: string[] }).candidates.filter((c) => c.startsWith("fco:api-two")).sort(), ["fco:api-two-1", "fco:api-two-2"]);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_screen_link WHERE screen_match_id = 'fcs:900012@12'`)[0].n, 0);

  // 12-2) 닉네임 한 글자 오독(5단계 검증의 실제 사례) — API 경기와 시각·스코어가 맞아도 자동 연결하지 않고 검수 대기로 올린다
  const t14 = dayAgo(75);
  await saveFcoMatch({ matchId: "api-typo", matchDate: apiDate(t14), matchType: 40, matchInfo: [player("alpha-ouid", "알파감독", "승", 2), player("beta-ouid", "베타감독", "패", 1)] });
  const r14 = await S.saveFcoScreenMatch(input(900013, 14, new Date(t14.getTime() + 5_000), { nickname: "알파감둑", score: 2 }, { nickname: "베타감독", score: 1 }));
  assert.equal(r14.status, "needs_review", "한 글자 오독은 같은 경기 의심으로 검수 대기");
  assert.ok((r14 as { candidates: string[] }).candidates.includes("fco:api-typo"));
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_screen_link WHERE screen_match_id = 'fcs:900013@14'`)[0].n, 0, "자동 연결은 하지 않는다");

  // 13) 시각 창 계산
  const win = S.fcoApiWindowStart(new Date("2026-10-01T03:00:00Z")); // KST 10-01 12:00 → 9-01 00:00 KST = 08-31 15:00Z
  assert.equal(win.toISOString(), "2026-08-31T15:00:00.000Z");

  // 끝: 화면 경기가 이만큼 쌓여도 공개 조회는 처음 그대로다(API 경기는 위에서 늘었으므로 화면 경기 id 가 안 섞였는지만 본다)
  const final = await publicDump(ids);
  assert.ok(!final.includes("fcs:") && !final.includes("일반감독") && !final.includes("남1"), "공개 조회에 화면 경기가 샜다");
  console.log("FC 화면 경기 저장·합침(R1~R3)·공개 조회 불변 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

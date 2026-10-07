/**
 * FC 구단(공식 구단가치·스쿼드 6칸·카드 시세) 수집과 계산을 실제 Postgres(PGlite)에서 끝까지 돌린다.
 * 가짜는 HTTP 경계 하나뿐이고(fetchImpl), 응답 본문은 실제 홈페이지 응답 표본(fixtures/)이다.
 * docs/FCO-CLUB-VALUE-PLAN.md
 */
import { readFileSync } from "node:fs";
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
const { linkFcoAccount } = await import("../packages/core/lib/games/fconline/ingest.ts");
const { FcoSiteClient } = await import("../packages/core/lib/games/fconline/club/site-client.ts");
const { RateLimiter } = await import("../packages/core/lib/riot/rate-limiter.ts");
const { syncValueRanking } = await import("../packages/core/lib/games/fconline/club/sync-value-ranking.ts");
const { syncRating } = await import("../packages/core/lib/games/fconline/club/sync-rating.ts");
const { syncTeamColors } = await import("../packages/core/lib/games/fconline/club/sync-team-colors.ts");
const { syncClub, heldCards, syncCardPrices } = await import("../packages/core/lib/games/fconline/club/sync.ts");

const FIXTURES = join(import.meta.dirname, "../packages/core/lib/games/fconline/club/fixtures");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

/** 가짜 홈페이지. 감독명 → 회원번호. 표본의 저창FC·1977710213 을 그 계정 값으로 바꿔 돌려준다. */
const site = {
  accounts: new Map<string, { sn: number; displayName?: string }>(),
  failSquadFor: null as number | null,
  requests: [] as string[],
};
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const fetchImpl: typeof fetch = async (input) => {
  const url = new URL(String(input));
  site.requests.push(url.pathname);
  const withAccount = (text: string, name: string, sn: number) =>
    text.replaceAll("저창FC", name).replaceAll("1977710213", String(sn));
  if (url.pathname === "/profile/common/PopProfile") {
    const name = url.searchParams.get("strCharacterName")!;
    // 넥슨 구단주 검색처럼 대소문자를 무시한다.
    const hit = [...site.accounts].find(([n]) => n.toLowerCase() === name.toLowerCase());
    if (!hit) return html(fixture("profile-missing.html"));
    return html(withAccount(fixture("profile-found.html"), hit[1].displayName ?? hit[0], hit[1].sn));
  }
  const tip = /^\/Profile\/Common\/ToolTip\/(\d+)$/.exec(url.pathname);
  if (tip) {
    const hit = [...site.accounts].find(([, a]) => a.sn === Number(tip[1]));
    return hit ? html(withAccount(fixture("tooltip.html"), hit[1].displayName ?? hit[0], hit[1].sn)) : html("", 500);
  }
  if (url.pathname === "/datacenter/SquadGetUserInfo") {
    if (Number(url.searchParams.get("n8NexonSN")) === site.failSquadFor && url.searchParams.get("n1Type") === "3") return html("");
    // 대표팀 B 만 2군 표본, 나머지는 1군 표본
    const second = url.searchParams.get("strTeamType") === "1" && url.searchParams.get("n1Type") === "2";
    return html(JSON.stringify({ ...JSON.parse(fixture(second ? "squad-2nd.json" : "squad.json")), ...JSON.parse(fixture("squad-team-colors.json")) }));
  }
  if (url.pathname.startsWith("/Profile/Stat/TeamInfo/")) {
    assert.equal(url.searchParams.get("n1Type"), "50");
    return html(fixture("season-grades.html"));
  }
  if (url.pathname === "/datacenter/dailyrank") return html(fixture("value-ranking.html").replaceAll("1809854163", "111").replaceAll("호날두", "알파감독"));
  if (url.pathname === "/datacenter/rank_inner") {
    const name = url.searchParams.get("strCharacterName")!;
    const hit = site.accounts.get(name);
    return html(hit ? fixture("rank-france.html").replaceAll("호날두", name).replaceAll("1809854163", String(hit.sn)) : fixture("rank-empty.html"));
  }
  if (url.pathname === "/datacenter/PlayerPriceGraph") return html(fixture("price-graph.html"));
  return html("not found", 404);
};
const client = new FcoSiteClient({ fetchImpl, limiter: new RateLimiter({ initialAppLimits: "1000:1" }) });
const names = { nicknames: new Map<string, string>(), async userBasic(ouid: string) {
  const nickname = this.nicknames.get(ouid);
  return nickname ? { ouid, nickname, level: 1 } : null;
} };

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('alpha-fc', '알파'), ('beta-fc', '베타'), ('gamma-fc', '감마')`;
  await linkFcoAccount({ streamerSlug: "alpha-fc", ouid: "alpha-ouid", nickname: "알파감독", level: 1 });
  await linkFcoAccount({ streamerSlug: "beta-fc", ouid: "beta-ouid", nickname: "베타옛이름", level: 1 });
  await linkFcoAccount({ streamerSlug: "gamma-fc", ouid: "gamma-ouid", nickname: "Gamma", level: 1 });
  site.accounts.set("알파감독", { sn: 111 });
  site.accounts.set("베타감독", { sn: 222 });
  site.accounts.set("gamma", { sn: 333 });   // 넥슨 쪽 실제 이름은 소문자
  names.nicknames.set("alpha-ouid", "알파감독");
  names.nicknames.set("beta-ouid", "베타감독"); // 감독명이 바뀌었다
  names.nicknames.set("gamma-ouid", "Gamma");

  // ── ①② 정상: 구단가치 + 6칸이 한 번에 ──────────────────────────────
  site.requests.length = 0;
  const alpha = await syncClub(client, names, "alpha-ouid");
  assert.equal(site.requests.length, 8, "검색 1 + 툴팁 1 + 스쿼드 6");
  await syncValueRanking(client);
  const { listFcoClubBoard: rankBoard } = await import("../packages/core/lib/db/fconline-club.ts");
  await syncRating(client, "alpha-ouid");
  const rankingRows = await rankBoard();
  assert.equal(rankingRows.find(r => r.slug === "alpha-fc")!.account.rating?.score, 2527.91);
  assert.equal(rankingRows.find(r => r.slug === "alpha-fc")!.account.rating?.currentGrade?.name, "챌린저 3부");
  assert.equal(rankingRows.find(r => r.slug === "alpha-fc")!.account.rating?.previousBestGrade?.name, "슈퍼 챔피언스");
  assert.deepEqual(rankingRows.find(r => r.slug === "alpha-fc")!.account.officialRank, { day: "2026-10-01", rank: 3 });
  assert.equal(rankingRows.find(r => r.slug === "beta-fc")!.account.officialRank?.rank, null);
  await sql`UPDATE fco_account SET nickname = '알파새이름' WHERE ouid = 'alpha-ouid'`;
  assert.equal((await rankBoard()).find(r => r.slug === "alpha-fc")!.account.officialRank?.rank, null, 'renamed owners cannot inherit a stale name match');
  assert.equal((await rankBoard()).find(r => r.slug === "alpha-fc")!.account.rating, null);
  await sql`UPDATE fco_account SET nickname = '알파감독' WHERE ouid = 'alpha-ouid'`;

  await syncTeamColors(client, "alpha-ouid");
  const [chemistry] = await sql`SELECT colors, source_at FROM fco_team_colors WHERE ouid = 'alpha-ouid'`;
  assert.equal(chemistry.colors[0].name, "프랑스");
  assert.equal((await sql`SELECT source FROM fco_team_colors WHERE ouid = 'alpha-ouid'`)[0].source, 'profile-squad');
  site.accounts.set("알파감독", { sn: 999 });
  await assert.rejects(() => syncTeamColors(client, "alpha-ouid"));
  await assert.rejects(() => syncRating(client, "alpha-ouid"));
  assert.equal((await rankBoard()).find(r => r.slug === "alpha-fc")!.account.rating?.score, 2527.91);
  assert.equal((await sql`SELECT nexon_sn::text AS sn FROM fco_team_colors WHERE ouid = 'alpha-ouid'`)[0].sn, '111');
  site.accounts.set("알파감독", { sn: 111 });

  assert.equal(alpha.outcome, "ok", JSON.stringify(alpha));
  const [snap] = await sql`SELECT status, nickname, nexon_sn::int AS sn, club_value::text AS v FROM fco_club_snapshot WHERE ouid = 'alpha-ouid'`;
  assert.deepEqual({ ...snap }, { status: "ok", nickname: "알파감독", sn: 111, v: "212235711090" });
  const squads = await sql`SELECT team_type, slot, total_price::text FROM fco_squad_snapshot ORDER BY team_type DESC, slot`;
  assert.equal(squads.length, 6);
  const [{ n, starters }] = await sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE is_starter)::int AS starters FROM fco_squad_player`;
  assert.equal(n, 6 * 18);
  assert.equal(starters, 6 * 11);
  const [{ sum }] = await sql`SELECT sum(price)::text AS sum FROM fco_squad_player WHERE is_starter AND team_type = 1 AND slot = 1`;
  assert.equal(sum, squads[0].total_price, "우리가 더한 선발 합 = 넥슨이 준 선발 합");

  // ── 감독명이 바뀐 계정: API 의 새 이름으로 찾고 fco_account 를 갱신한다 ──
  assert.equal((await syncClub(client, names, "beta-ouid")).outcome, "ok");
  const [beta] = await sql`SELECT nickname FROM fco_account WHERE ouid = 'beta-ouid'`;
  assert.equal(beta.nickname, "베타감독");

  // ── 대소문자만 다른 감독명은 받지 않는다(구단주 검색이 대소문자를 무시한다) ──
  const gamma = await syncClub(client, names, "gamma-ouid");
  assert.equal(gamma.outcome, "error");
  assert.match((gamma as { reason: string }).reason, /다른 감독명/);

  // ── 없는 감독명은 missing 행, 실패는 행 없음 ───────────────────────
  names.nicknames.set("gamma-ouid", "없는감독");
  assert.equal((await syncClub(client, names, "gamma-ouid")).outcome, "missing");
  const before = (await sql`SELECT count(*)::int AS n FROM fco_club_snapshot`)[0].n;
  site.failSquadFor = 111;
  const partial = await syncClub(client, names, "alpha-ouid");
  assert.equal(partial.outcome, "error");
  assert.match((partial as { reason: string }).reason, /빈 응답/);
  assert.equal((await sql`SELECT count(*)::int AS n FROM fco_club_snapshot`)[0].n, before, "칸 하나라도 못 받으면 아무것도 안 쓴다");
  site.failSquadFor = null;

  // ── 회원번호가 바뀌면(감독명이 남에게 넘어감) 저장하지 않는다 ───────
  site.accounts.set("알파감독", { sn: 999 });
  const moved = await syncClub(client, names, "alpha-ouid");
  assert.equal(moved.outcome, "error");
  assert.match((moved as { reason: string }).reason, /회원번호/);
  site.accounts.set("알파감독", { sn: 111 });

  // ── ③ 시세: 공개 계정의 최신 보유 카드만, 카드당 한 번 ───────────────
  await sql`UPDATE streamer_fco_account SET visibility = 'hidden' WHERE ouid = 'beta-ouid'`;
  const cards = await heldCards();
  const [{ distinct }] = await sql`
    SELECT count(DISTINCT (p.spid, p.grade))::int AS distinct FROM fco_squad_player p
      JOIN fco_club_snapshot s ON s.id = p.snapshot_id WHERE s.ouid = 'alpha-ouid' AND p.grade IS NOT NULL`;
  assert.equal(cards.length, distinct, "숨긴 계정의 카드는 시세를 받지 않는다(같은 카드라 수는 같다)");
  const now = new Date("2026-10-02T03:00:00Z");
  const first = await syncCardPrices(client, cards.slice(0, 3), now);
  assert.deepEqual({ fetched: first.fetched, inserted: first.inserted, revised: first.revised, errors: first.errors.length },
    { fetched: 3, inserted: 3 * 99, revised: 0, errors: 0 });
  const [{ last }] = await sql`SELECT max(day)::text AS last FROM fco_card_price_daily`;
  assert.equal(last, "2026-10-01");
  const again = await syncCardPrices(client, cards.slice(0, 3), now);
  assert.equal(again.fresh, 3, "오늘 이미 받은 카드는 다시 부르지 않는다");
  await sql`UPDATE fco_card_price_daily SET price = 1, fetched_at = now() - interval '2 days'`;
  const revised = await syncCardPrices(client, cards.slice(0, 1), now);
  assert.equal(revised.revised, 99, "넥슨 값으로 덮고, 바뀐 행 수를 남긴다");

  // ── 공개 조회: 계산은 원본에서, 숨긴 계정·신원은 나가지 않는다 ─────────
  const { listFcoClubBoard, getFcoClub } = await import("../packages/core/lib/db/fconline-club.ts");
  // 알파의 첫 스냅샷을 어제로 옮기고, 오늘 한 번 더 받는다 → 이틀치 보유
  // ★ 시각은 표본(fixtures/)의 날짜에 고정한다 — 시세 표본이 2026-10-01 까지라, DB now() 를 쓰면 날짜가 지날수록
  //   "보유 기준일의 시세" 가 표본 밖으로 나가 깨졌다(10-08 실측). 위 시세 검사와 같은 now 를 쓴다.
  await sql`UPDATE fco_club_snapshot SET captured_at = ${new Date("2026-10-01T03:00:00Z")} WHERE ouid = 'alpha-ouid'`;
  assert.equal((await syncClub(client, names, "alpha-ouid")).outcome, "ok");
  await sql`UPDATE fco_club_snapshot SET captured_at = ${now} WHERE ouid = 'alpha-ouid' AND captured_at > ${now}`;
  await syncCardPrices(client, await heldCards(), now);

  const board = await listFcoClubBoard();
  assert.deepEqual(board.map((r) => r.slug).sort(), ["alpha-fc", "gamma-fc"], "숨긴 계정만 가진 베타는 순위표에 없다");
  const alphaRow = board.find((r) => r.slug === "alpha-fc")!;
  assert.equal(alphaRow.account.club_value, 212235711090);
  assert.equal(alphaRow.account.history.length, 2, "공식 구단가치는 날마다 하나");
  const gammaRow = board.find((r) => r.slug === "gamma-fc")!;
  assert.deepEqual([gammaRow.account.status, gammaRow.account.club_value], ["missing", null], "못 찾은 계정은 0원이 아니라 missing");

  const club = (await getFcoClub("alpha-fc"))!;
  const [{ keys }] = await sql`
    SELECT count(DISTINCT (p.spid, coalesce(p.grade, -1)))::int AS keys FROM fco_squad_player p
     WHERE p.snapshot_id = (SELECT max(id) FROM fco_club_snapshot WHERE ouid = 'alpha-ouid' AND status = 'ok')`;
  assert.equal(club.holdings.length, keys, "스쿼드 등록 선수 = 6칸 합집합(카드+강화)");
  assert.equal(club.squads.length, 6);
  assert.equal(club.squads[0].label, "대표A");
  assert.equal(club.actual.length, 2);
  assert.ok(club.actual.every((p) => p.priced > 0 && p.value > 0), "보유 기준일(조회 전날)의 시세로 평가해 점이 비지 않는다");
  assert.equal(club.changes.length, 1);
  assert.equal(club.changes[0].added + club.changes[0].removed, 0, "같은 스쿼드라 교체가 없다");
  assert.ok(club.backcast.length > 0, "현재 스쿼드 소급 추정이 시세 이력만큼 나온다");
  assert.ok(club.backcast.every((p) => p.day <= "2026-10-01"));
  const seriesKeys = Object.keys(club.cardSeries);
  assert.ok(seriesKeys.length > 0, "선수 시세를 차트에 더할 수 있다");
  assert.ok(seriesKeys.every((k) => club.holdings.some((c) => `${c.spid}:${c.grade}` === k)), "지금 등록된 카드의 시세만 준다");
  assert.ok(Object.values(club.cardSeries).every((s) => s.every((p, i) => i === 0 || s[i - 1].day < p.day)), "날짜 오름차순");
  assert.equal(await getFcoClub("beta-fc"), null, "숨긴 계정만 가진 사람은 구단 화면이 없다");
  const dump = JSON.stringify([board, club]);
  for (const secret of ["alpha-ouid", "beta-ouid", "gamma-ouid", "베타감독", "\"111\"", "6b07d5bd64eeb9a0ffed86a1"]) {
    assert.ok(!dump.includes(secret), `공개 반환값에 ${secret} 가 남았다`);
  }

  console.log("FC 구단 수집(①구단가치 ②스쿼드 6칸 ③시세)·신원 대조·부분 실패 차단·공개 조회 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

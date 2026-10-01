/**
 * FC 공개 조회 결과의 스냅샷 — 마이그레이션·조회 쿼리를 고치기 전후에 **결과가 한 글자도 안 바뀌었는지** 비교한다.
 * (docs/FCO-SCREEN-MATCH-DESIGN.md §3.5)
 *
 *   node scripts/fco-public-snapshot.ts fixture <출력.json>   # 가짜 DB(PGlite)에 고정 자료를 넣고 덤프 — 외부 DB 안 씀
 *   node --env-file=apps/web/.env.local scripts/fco-public-snapshot.ts real <출력.json>   # 실제 DB 를 **읽기만** 한다
 *   node scripts/fco-public-snapshot.ts diff <앞.json> <뒤.json>   # 다르면 종료 코드 1 + 어디가 다른지
 *
 * fixture 는 UUID 를 등장 순서대로 U1·U2… 로 바꿔 매번 같은 파일이 나오게 한다. real 은 UUID 를 그대로 둔다(DB 가 안정적).
 * 이 스크립트는 아무것도 쓰지 않는다(real 은 SELECT 만 부르는 공개 조회 함수만 쓴다).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, a, b] = process.argv.slice(2);
if (!["fixture", "real", "diff"].includes(mode) || !a) {
  console.error("사용법은 파일 머리말을 본다: scripts/fco-public-snapshot.ts");
  process.exit(1);
}

if (mode === "diff") {
  if (!b) { console.error("diff <앞.json> <뒤.json>"); process.exit(1); }
  const x = JSON.parse(readFileSync(a, "utf8")) as Record<string, unknown>;
  const y = JSON.parse(readFileSync(b, "utf8")) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  const bad = keys.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
  console.log(`항목 ${keys.length}개 비교 — 다른 항목 ${bad.length}개`);
  for (const k of bad.slice(0, 20)) console.log(`  ✗ ${k}`);
  process.exit(bad.length ? 1 : 0);
}

let cleanup: () => Promise<void> = async () => {};
if (mode === "fixture") {
  const { PGlite } = await import("@electric-sql/pglite");
  const { pg_trgm } = await import("@electric-sql/pglite/contrib/pg_trgm");
  const { pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const { applyAll } = await import("./lib/migrations.ts");
  const { freePort } = await import("./lib/disposable-postgres.ts");
  const database = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
  const port = await freePort();
  const server = new PGLiteSocketServer({ db: database, port, host: "127.0.0.1" });
  await server.start();
  process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  cleanup = async () => { await server.stop(); await database.close(); };
}

const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const R = await import("../packages/core/lib/db/fconline.ts");

if (mode === "fixture") {
  const { linkFcoAccount, saveFcoMatch, linkFcoMatchToEvent } = await import("../packages/core/lib/games/fconline/ingest.ts");
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('alpha-fc','알파'),('beta-fc','베타'),('gamma-fc','감마'),('delta-fc','델타')`;
  for (const [s, o, n] of [["alpha-fc", "alpha-ouid", "알파감독"], ["beta-fc", "beta-ouid", "베타감독"], ["gamma-fc", "gamma-ouid", "감마감독"], ["delta-fc", "delta-ouid", "델타감독"]]) {
    await linkFcoAccount({ streamerSlug: s, ouid: o, nickname: n, level: 100 });
  }
  const player = (ouid: string, nickname: string, result: "승" | "패" | "무", goal: number, display?: number) => ({
    ouid, nickname, matchDetail: { matchResult: result, possession: 50 },
    shoot: { goalTotal: goal, ...(display === undefined ? {} : { goalTotalDisplay: display }), shootTotal: 7, effectiveShootTotal: 3 },
    pass: { passTry: 90, passSuccess: 70 }, defence: { tackleSuccess: 5 }, player: [],
  });
  const game = (id: string, date: string, type: number, p1: ReturnType<typeof player>, p2: ReturnType<typeof player>) =>
    ({ matchId: id, matchDate: date, matchType: type, matchInfo: [p1, p2] });
  const A = (r: "승" | "패" | "무", g: number, d?: number) => player("alpha-ouid", "알파감독", r, g, d);
  const B = (r: "승" | "패" | "무", g: number, d?: number) => player("beta-ouid", "베타감독", r, g, d);
  const G = (r: "승" | "패" | "무", g: number) => player("gamma-ouid", "감마감독", r, g);
  const D = (r: "승" | "패" | "무", g: number) => player("delta-ouid", "델타감독", r, g);
  const U = (r: "승" | "패" | "무", g: number) => player("ordinary-ouid", "일반감독", r, g);
  const games = [
    game("snap-1", "2026-09-20 12:00:00", 60, A("승", 2, 3), B("패", 1)),
    game("snap-2", "2026-09-20 13:00:00", 60, A("패", 0), B("승", 2)),
    game("snap-3", "2026-09-21 12:00:00", 40, A("무", 1), G("무", 1)),
    game("snap-4", "2026-09-21 15:00:00", 50, A("승", 3), U("패", 0)),
    game("snap-5", "2026-09-22 12:00:00", 40, B("승", 4), D("패", 2)),
    game("snap-6", "2026-09-22 14:00:00", 40, G("승", 1), D("패", 0)),
    game("snap-7", "2026-09-23 12:00:00", 40, A("패", 1), D("승", 2)),
  ];
  for (const g of games) await saveFcoMatch(g);
  for (const id of ["snap-1", "snap-2"]) await linkFcoMatchToEvent({ providerMatchId: id, eventSlug: "snap-cup", eventName: "스냅컵", sourceUrl: "https://example.com/snap" });
  await linkFcoMatchToEvent({ providerMatchId: "snap-5", eventSlug: "snap-cup-2", eventName: "스냅컵 2", sourceUrl: "https://example.com/snap2" });
  // 숨긴 사람·숨긴 계정 — 가림이 그대로인지도 본다
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'gamma-fc'`;
  await sql`UPDATE streamer_fco_account SET visibility = 'hidden' WHERE ouid = 'delta-ouid'`;
}

const out: Record<string, unknown> = {};
const people = await R.listFcoPeople();
out["people"] = people;
out["topPairs"] = await R.listFcoTopPairs(50);
out["featured"] = await R.getFeaturedFcoPair();
out["leaderboard"] = await R.listFcoLeaderboard();
const events = await R.listFcoEvents();
out["events"] = events;
const providerIds = new Set<string>();
const take = (games: { provider_id: string | null }[]) => { for (const g of games) if (g.provider_id) providerIds.add(g.provider_id); return games; };
for (const e of events) {
  out[`event:${e.slug}`] = await R.getFcoEvent(e.slug);
  out[`event-games:${e.slug}`] = take(await R.listFcoEventGames(e.id));
}
for (const p of people) {
  out[`person:${p.slug}`] = await R.getFcoPerson(p.slug);
  out[`modes:${p.slug}`] = await R.listFcoModesForPerson(p.id);
  out[`games:${p.slug}`] = take(await R.listFcoGamesForPerson(p.id, 500));
  out[`streamer-games:${p.slug}`] = take(await R.listFcoStreamerGamesForPerson(p.id, 500));
  for (const mode of await R.listFcoModesForPerson(p.id)) {
    out[`games:${p.slug}:mode${mode}`] = await R.listFcoGamesForPerson(p.id, 500, { mode });
    out[`streamer-games:${p.slug}:mode${mode}`] = await R.listFcoStreamerGamesForPerson(p.id, 500, { mode });
  }
  for (const q of people) if (q.id !== p.id) out[`versus:${p.slug}:${q.slug}`] = take(await R.listFcoVersus(p.id, q.id));
}
for (const id of [...providerIds].sort()) out[`game:${id}`] = await R.getFcoGame(id);

let text = JSON.stringify(out, null, 1);
if (mode === "fixture") {
  const seen = new Map<string, string>();
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => {
    if (!seen.has(u)) seen.set(u, `U${seen.size + 1}`);
    return seen.get(u)!;
  });
  // 키 이름 안의 UUID 도 같은 규칙으로 바뀐다 — 사람 id 는 키가 아니라 값이라 괜찮다.
}
writeFileSync(a, `${text}\n`);
console.log(`저장 ${a} — 항목 ${Object.keys(out).length}개 (${mode})`);
await closeDb();
await cleanup();

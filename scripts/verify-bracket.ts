/**
 * 대진(칸·화살표·결정)을 실제 Postgres(PGlite)에서 끝까지 돌린다. docs/TOURNAMENT-FORMAT-PLAN.md
 *
 *   npm run verify:bracket
 *
 * 뿌챔스의 실제 경기 20판을 FC 수집 경로(saveFcoMatch)로 넣고, 시드 파일(seed/brackets/2026-mini-ppuchamps.json)을
 * 그대로 반영해 계산 순위가 나오는지, 스키마가 잘못된 연결을 정말 거부하는지 확인한다.
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
import type { BracketSpec } from "../packages/core/lib/tournament/spec.ts";

const ROOT = join(import.meta.dirname, "..");
const database = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: database, port, host: "127.0.0.1" });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const { linkFcoAccount, saveFcoMatch, linkFcoMatchToEvent } = await import("../packages/core/lib/games/fconline/ingest.ts");
const { applyBracketSpec, getEventBracket } = await import("../packages/core/lib/db/event-bracket.ts");
const { resolveBracket, displayRank, rankText } = await import("../packages/core/lib/tournament/bracket.ts");
const { listPublicTournamentEvents } = await import("../packages/core/lib/db/public-tournaments.ts");
const { listStreamerEvents, summarizePlacements } = await import("../packages/core/lib/db/public.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
async function expectReject(name: string, fn: () => Promise<unknown>, expected: string) {
  try {
    await fn();
    check(name, false, "거부되어야 하는데 통과했다");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(expected), message.includes(expected) ? "" : message);
  }
}

const SPEC = JSON.parse(readFileSync(join(ROOT, "seed/brackets/2026-mini-ppuchamps.json"), "utf8")) as BracketSpec;
/** 실제 경기(넥슨 API 기록): 경기 id → [승자, 패자, 승자 점수, 패자 점수] */
const GAMES: Record<string, [string, string, number, number]> = {
  "6a8d4fe066b9776fe4e71070": ["imyujin", "doochiwa-ppukku", 3, 2], "6a8d53c28c7e4462645fc1c2": ["smebim", "clid1", 2, 1],
  "6a8d574d17f5a560e6a5a6f5": ["kimmingyo", "seodoil", 2, 2], "6a8d5cd2e3c14f0cfe6d936a": ["dohyun", "leesangho", 4, 2],
  "6a8d60a20e63f4b38dacb741": ["smebim", "imyujin", 2, 1], "6a8d63d377042869cc5c6b56": ["dohyun", "kimmingyo", 2, 1],
  "6a8d675f14c88e1864cd70bf": ["doochiwa-ppukku", "clid1", 2, 1], "6a8d6ae0cd571e3d4ac70490": ["leesangho", "seodoil", 2, 1],
  "6a8d6e6b65a9205e405ea643": ["smebim", "dohyun", 2, 0], "6a8d75607caf4e2b24437b13": ["imyujin", "kimmingyo", 3, 1],
  "6a8d78b6f9eabe4e7810c8d9": ["doochiwa-ppukku", "leesangho", 2, 1], "6a8d7c04e379e7e63b5a5697": ["leesangho", "clid1", 5, 3],
  "6a8d83497095898040774f83": ["kimmingyo", "doochiwa-ppukku", 3, 1], "6a8d8680a8db38b21d96e4af": ["leesangho", "doochiwa-ppukku", 4, 1],
  "6a8d8a0676472064f023136a": ["imyujin", "smebim", 4, 1], "6a8d8d2a3127b1bfcb7d9751": ["dohyun", "kimmingyo", 3, 2],
  "6a8d91a8c7f13dff46e7c00d": ["leesangho", "kimmingyo", 1, 0], "6a8d9596cf80344b0ed41458": ["dohyun", "smebim", 3, 3],
  "6a8d9a0b73e031dce3609ee8": ["smebim", "leesangho", 1, 0], "6a8da1b6b50f4b19579a2d5a": ["dohyun", "smebim", 3, 2],
};
const EXPECTED = {
  "임유진": "1위", "도현": "2위", "스맵": "3위", "이상호": "4위", "김민교": "5위", "두치와뿌꾸": "6위", "클리드": "7위", "서도일": "8위",
};
const side = (slug: string, result: "승" | "패", score: number) => ({
  ouid: `${slug}-ouid`, nickname: `${slug}감독`, matchDetail: { matchResult: result, possession: 50 },
  shoot: { goalTotal: score, goalTotalDisplay: score, shootTotal: 5, effectiveShootTotal: 3 },
  pass: { passTry: 10, passSuccess: 8 }, defence: { tackleSuccess: 1 }, player: [],
});
const rankMap = (bracket: Awaited<ReturnType<typeof getEventBracket>>) => {
  const names = new Map(bracket!.entrants.map((e) => [e.id, e.name]));
  return Object.fromEntries(resolveBracket(bracket!.input).placements.map((p) => {
    const r = displayRank(p);
    return [names.get(p.entrant), r ? rankText(r.min, r.max) : "—"];
  }));
};

try {
  await applyAll((sql) => database.exec(sql), ROOT);
  const sql = db();
  const people = SPEC.entrants.map((e) => e.streamers[0]);
  for (const e of SPEC.entrants) {
    await sql`INSERT INTO streamer (slug, display_name) VALUES (${e.streamers[0]}, ${e.name})`;
    await linkFcoAccount({ streamerSlug: e.streamers[0], ouid: `${e.streamers[0]}-ouid`, nickname: `${e.streamers[0]}감독`, level: 1 });
  }
  let minute = 0;
  for (const [id, [w, l, ws, ls]] of Object.entries(GAMES)) {
    minute += 15;
    const at = new Date(Date.UTC(2026, 7, 25, 8, minute));
    await saveFcoMatch({ matchId: id, matchDate: at.toISOString().slice(0, 19).replace("T", " "), matchType: 40,
      matchInfo: [side(w, "승", ws), side(l, "패", ls)] } as Parameters<typeof saveFcoMatch>[0]);
    await linkFcoMatchToEvent({ providerMatchId: id, eventSlug: "2026-mini-ppuchamps", eventName: "N커넥트 미니 뿌챔스 싸워",
      sourceUrl: "https://pick.sooplive.com/daily/view/182785" });
  }
  // 다른 대회 경기 하나(연결 거부 검사용)
  await saveFcoMatch({ matchId: "other-event-game", matchDate: "2026-08-26 10:00:00", matchType: 40,
    matchInfo: [side("imyujin", "승", 1), side("dohyun", "패", 0)] } as Parameters<typeof saveFcoMatch>[0]);
  await linkFcoMatchToEvent({ providerMatchId: "other-event-game", eventSlug: "other-cup", eventName: "다른 대회", sourceUrl: "https://example.com/x" });
  const [{ id: eventId }] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = '2026-mini-ppuchamps'`;
  const [{ id: otherEventId }] = await sql<{ id: string }[]>`SELECT id FROM event WHERE slug = 'other-cup'`;
  check(`준비: 경기 ${Object.keys(GAMES).length}판, 참가자 ${people.length}명`, true);

  console.log("\n▶ 미리보기는 아무것도 쓰지 않는다");
  const preview = await applyBracketSpec(SPEC, { dryRun: true });
  const previewRanks = Object.fromEntries(preview.result.placements.map((p) => {
    const r = displayRank(p);
    return [preview.names[p.entrant], r ? rankText(r.min, r.max) : "—"];
  }));
  check("미리보기에서 계산 순위가 나온다", JSON.stringify(previewRanks) === JSON.stringify(EXPECTED), JSON.stringify(previewRanks));
  const [{ n: afterPreview }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_slot`;
  check("미리보기 뒤 칸이 0개다(트랜잭션을 되돌렸다)", afterPreview === 0, `${afterPreview}개`);
  const [{ n: teamsAfterPreview }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_team`;
  check("미리보기 뒤 참가 단위도 0개다", teamsAfterPreview === 0, `${teamsAfterPreview}개`);

  console.log("\n▶ 반영 → 읽기 → 계산");
  const applied = await applyBracketSpec(SPEC);
  check("반영 보고: 칸 24 · 화살표 48 · 경기 연결 20 · 결정 1", applied.slots === 24 && applied.routes === 48 && applied.links === 20 && applied.decisionsAdded === 1,
    JSON.stringify({ slots: applied.slots, routes: applied.routes, links: applied.links, decisions: applied.decisionsAdded }));
  const bracket = await getEventBracket(eventId);
  check("대진을 읽는다(단계 1 · 참가 8)", bracket?.stages.length === 1 && bracket.entrants.length === 8);
  check("★ DB 에서 읽은 대진으로 계산한 순위 = 공식 1~4위 + 규칙 5~8위", JSON.stringify(rankMap(bracket)) === JSON.stringify(EXPECTED), JSON.stringify(rankMap(bracket)));
  const result = resolveBracket(bracket!.input);
  check("문제(issue)가 없다", result.issues.length === 0, result.issues.map((i) => i.message).join(" / "));
  const byName = new Map(bracket!.entrants.map((e) => [e.name, e.id]));
  const cert = (name: string) => result.placements.find((p) => p.entrant === byName.get(name))?.certainty;
  check("기록 없는 10경기로 정해진 서도일 8위는 「추론」", cert("서도일") === "inferred", cert("서도일"));
  check("13경기에 실제로 나온 클리드 7위는 「확인」", cert("클리드") === "confirmed", cert("클리드"));
  check("FC 경기는 참가자 스트리머 → 참가 단위로 바뀐다(모든 경기 참가자가 참가 단위로 매핑)",
    bracket!.input.games.every((g) => g.entrants.every((e) => e.entrant != null)));
  check("FC 경기 상세 주소용 넥슨 id 가 함께 온다", Object.keys(bracket!.providerIds).length === 20);

  console.log("\n▶ 다시 돌려도 안전하다");
  const slotIdsBefore = (await sql<{ id: string }[]>`SELECT id FROM event_slot ORDER BY slot_no`).map((r) => r.id).join();
  const again = await applyBracketSpec(SPEC);
  const slotIdsAfter = (await sql<{ id: string }[]>`SELECT id FROM event_slot ORDER BY slot_no`).map((r) => r.id).join();
  check("같은 파일 재반영: 결정이 더 쌓이지 않는다", again.decisionsAdded === 0, `${again.decisionsAdded}`);
  check("칸 id 가 유지된다(결정 이력이 칸에 붙어 있다)", slotIdsBefore === slotIdsAfter);
  const [{ n: teamCount }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_team WHERE event_id = ${eventId}`;
  check("참가 단위가 늘지 않는다", teamCount === 8, `${teamCount}`);

  console.log("\n▶ 사람의 결정 · 시드 결정 철회");
  const [final] = await sql<{ id: string }[]>`SELECT id FROM event_slot WHERE event_id = ${eventId} AND slot_no = 24`;
  await sql`INSERT INTO event_slot_decision (slot_id, event_id, status, winners, basis, evidence, created_by)
            VALUES (${final.id}, ${eventId}, 'result', ARRAY[${byName.get("임유진")!}]::uuid[], 'observed', '방송 3세트 결과 화면 확인', 'admin')`;
  const withAdmin = await applyBracketSpec(SPEC);
  check("사람(admin)의 최신 결정은 시드가 덮지 않는다", withAdmin.decisionsKeptByAdmin.includes(24) && withAdmin.decisionsAdded === 0,
    JSON.stringify(withAdmin.decisionsKeptByAdmin));
  await sql`DELETE FROM event_slot_decision WHERE created_by = 'admin'`;
  const withoutDecision = await applyBracketSpec({ ...SPEC, decisions: [] });
  const latest = await sql<{ status: string }[]>`SELECT status FROM core_public.event_slot_decision WHERE slot_id = ${final.id}`;
  check("파일에서 빠진 시드 결정은 철회(auto) 행으로 남는다 — 지우지 않는다", withoutDecision.decisionsAdded === 1 && latest[0]?.status === "auto", latest[0]?.status);
  const afterRetract = rankMap(await getEventBracket(eventId));
  check("결승 결과가 없으면 1·2위는 공식 순위만 남고 계산하지 않는다", afterRetract["임유진"] === "1위" && afterRetract["김민교"] === "5위", JSON.stringify(afterRetract));
  await applyBracketSpec(SPEC);

  console.log("\n▶ 스키마가 잘못된 연결을 거부한다");
  const [slot1] = await sql<{ id: string }[]>`SELECT id FROM event_slot WHERE event_id = ${eventId} AND slot_no = 1`;
  const [otherTeam] = await sql<{ id: string }[]>`INSERT INTO event_team (event_id, name) VALUES (${otherEventId}, '남의 팀') RETURNING id`;
  await expectReject("다른 대회 경기를 칸에 이을 수 없다(트리거)",
    () => sql`INSERT INTO event_slot_match (match_id, slot_id, event_id) VALUES ('fco:other-event-game', ${slot1.id}, ${eventId})`, "같은 게임의 경기가 아니다");
  await expectReject("경기 하나를 두 칸에 이을 수 없다",
    () => sql`INSERT INTO event_slot_match (match_id, slot_id, event_id) VALUES ('fco:6a8d53c28c7e4462645fc1c2', ${slot1.id}, ${eventId})`, "duplicate key");
  await expectReject("다른 대회 참가 단위를 시드로 둘 수 없다(복합 외래키)",
    () => sql`UPDATE event_slot SET seed_a = ${otherTeam.id} WHERE id = ${slot1.id}`, "foreign key");
  await expectReject("결정의 승자는 같은 대회 참가 단위여야 한다(트리거)",
    () => sql`INSERT INTO event_slot_decision (slot_id, event_id, status, winners, basis, evidence)
              VALUES (${slot1.id}, ${eventId}, 'result', ARRAY[${otherTeam.id}]::uuid[], 'official', 'x')`, "참가 단위가 아닌");
  await expectReject("부전승 결정에는 승자가 있어야 한다",
    () => sql`INSERT INTO event_slot_decision (slot_id, event_id, status, basis, evidence) VALUES (${slot1.id}, ${eventId}, 'walkover', 'official', 'x')`, "check constraint");
  await expectReject("같은 자리를 두 화살표가 채울 수 없다",
    () => sql`INSERT INTO event_route (event_id, from_slot, outcome, to_kind, to_slot, to_side)
              SELECT ${eventId}, ${final.id}, 'winner', 'slot', to_slot, to_side FROM event_route
               WHERE event_id = ${eventId} AND to_side IS NOT NULL LIMIT 1`, "duplicate key");
  await expectReject("순위 화살표에는 도착 칸이 없어야 한다",
    () => sql`UPDATE event_route SET to_slot = ${slot1.id} WHERE event_id = ${eventId} AND to_kind = 'placement' AND placement_min = 8`, "check constraint");
  await expectReject("최종 순위에는 근거가 있어야 한다",
    () => sql`UPDATE event_team SET final_rank_evidence = NULL WHERE id = ${byName.get("임유진")!}`, "check constraint");

  console.log("\n▶ 구조 오류가 있으면 아무것도 쓰지 않는다");
  const broken: BracketSpec = structuredClone(SPEC);
  broken.stages[0].slots[20].loser = "rank:3"; // 4위 결정전 패자를 3위로 — 3위에 두 명
  const routesBefore = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_route WHERE event_id = ${eventId} AND to_kind = 'placement' AND placement_min = 4`)[0].n;
  await expectReject("구조 오류 시드는 거부된다", () => applyBracketSpec(broken), "대진 구조 오류");
  const routesAfter = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM event_route WHERE event_id = ${eventId} AND to_kind = 'placement' AND placement_min = 4`)[0].n;
  check("거부된 반영은 기존 대진을 건드리지 않는다", routesBefore === 1 && routesAfter === 1);

  console.log("\n▶ FC 대회 참가 단위가 롤 화면에 섞이지 않는다 (0062)");
  check("롤 대회 목록에 FC 대회가 없다", !(await listPublicTournamentEvents()).some((e) => e.slug === "2026-mini-ppuchamps"));
  const [imyujin] = await sql<{ id: string }[]>`SELECT id FROM streamer WHERE slug = 'imyujin'`;
  check("롤 프로필 대회 이력에 FC 대회가 없다", (await listStreamerEvents(imyujin.id)).length === 0);
  check("롤 수상 요약에 FC 대회가 세어지지 않는다", (await summarizePlacements(imyujin.id)).total === 0);

  console.log("\n▶ 공개 범위");
  await sql`UPDATE match SET visibility = 'hidden' WHERE match_id = 'fco:6a8d7c04e379e7e63b5a5697'`;
  const hidden = await getEventBracket(eventId);
  check("숨긴 경기는 공개 대진에서 빠진다(13경기 연결 19개)", hidden!.input.games.length === 19, `${hidden!.input.games.length}`);
  const hiddenResult = resolveBracket(hidden!.input);
  const s13 = hiddenResult.slots.find((s) => s.slot.no === 13)!;
  check("빠진 경기의 칸은 다음 칸 출전으로 추론된다(이상호가 16경기에 나왔다)", s13.source === "inferred" && s13.winners[0] === byName.get("이상호"), s13.source ?? "");
  // 13경기 기록이 없으니 10경기를 추론할 근거(13경기 출전)도 사라진다 — 7·8위는 모른다고 해야 한다
  const hiddenRanks = rankMap(hidden);
  check("근거가 사라진 7·8위는 계산하지 않는다(지어내지 않는다)", hiddenRanks["클리드"] === undefined && hiddenRanks["서도일"] === undefined && hiddenRanks["이상호"] === "4위",
    JSON.stringify(hiddenRanks));
  await sql`UPDATE match SET visibility = 'public' WHERE match_id = 'fco:6a8d7c04e379e7e63b5a5697'`;
} catch (error) {
  console.error(error);
  failures++;
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}

console.log(failures ? `\n✗ ${failures}개 실패` : "\n✓ 대진 검증 통과");
process.exit(failures ? 1 : 0);

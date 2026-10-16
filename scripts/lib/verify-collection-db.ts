/**
 * 지명 수집(0090) — docs/COLLECTION-DESIGNATION-PLAN.md 의 불변식을 실제 함수로 돌려 본다.
 *
 *   · 지명된 사람의 **연결 계정 전부**가 범위다 — 나중에 붙인 계정도 저절로 들어오고, 백필이 그 칸의 진척을 만든다
 *   · 저장 관문은 범위가 덮는 판만 받고, 상세는 범위 계정의 행만
 *   · 지명 둘이 같은 판을 덮으면 하나를 지워도 판은 남는다 / 아무도 안 덮으면 지운다(미리보기 수 = 실제 수)
 *   · 계정 연결을 떼면 그 계정만으로 모은 판이 정리된다
 *   · 내전 세트(versus)는 정리 대상이 아니다
 *   · 이력이 남고, 공개 경로는 공개 스트리머만
 *   · 끝에 "범위 밖 개인 기록 0"
 */
import type postgres from "postgres";

import { db } from "../../packages/core/lib/db/client.ts";
import * as col from "../../packages/core/lib/db/collection.ts";
import { placeSingleSetInTx } from "../../packages/core/lib/db/classification.ts";
import { saveMatch } from "../../packages/core/lib/db/ingest.ts";
import * as streamers from "../../packages/core/lib/db/streamers.ts";
import type { MatchDto } from "../../packages/core/lib/riot/types.ts";
import { lolEvent } from "./verify-ck-fixtures.ts";

type Check = (name: string, ok: boolean, detail?: string) => void;
type Seat = { puuid: string; teamId: 100 | 200; championId: number };
type Game = (matchId: string, gameId: number, at: Date, seats: Seat[], opts?: { queueId?: number }) => MatchDto;

class Rollback extends Error {}
/** 쓰기를 끝까지 해 보고 되돌린다 — CLI 의 미리보기와 같은 길. */
async function preview<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try { await db().begin(async (tx) => { out = await fn(tx); throw new Rollback(); }); } catch (e) { if (!(e instanceof Rollback)) throw e; }
  return out!;
}
const apply = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => db().begin(fn) as Promise<T>;

export async function verifyCollectionDb(check: Check, game: Game): Promise<void> {
  console.log("\n▸ 지명 수집 — 사람 단위 범위·정리·이력 (0090)");
  const sql = db();
  const P = (c: string) => c.repeat(78);
  const [pa1, pa2, pb1, stranger] = [P("1"), P("2"), P("3"), P("4")];
  const a = await streamers.createStreamer({ slug: "col-a", display_name: "지명가" });
  const b = await streamers.createStreamer({ slug: "col-b", display_name: "지명나" });
  for (const p of [pa1, pa2, pb1]) await streamers.upsertRiotAccount({ puuid: p, game_name: `col-${p[0]}`, tag_line: "KR1" });
  const link = (s: string, p: string) => streamers.linkAccount({ streamer_id: s, puuid: p, confidence: "verified", evidence: { source: "manual", note: "지명 시험" } });
  await link(a.id, pa1);
  await link(b.id, pb1);

  const day = (d: string) => new Date(`${d}T00:00:00+09:00`);
  const at = (d: string, h = 12) => new Date(day(d).getTime() + h * 3_600_000);
  const solo = (id: number, d: string, seats: Seat[]) => saveMatch(game(`COL_${id}`, 70_000 + id, at(d), seats, { queueId: 420 }));
  const seat = (puuid: string, teamId: 100 | 200 = 100): Seat => ({ puuid, teamId, championId: 1 });
  const has = async (id: number) => (await sql`SELECT 1 FROM match WHERE match_id = ${`COL_${id}`}`).length === 1;

  // ── 만들기 · 범위 ─────────────────────────────────────────────
  const made = await apply((tx) => col.createOrderInTx(tx, {
    slug: "col-duo", title: "지명 시험 듀오", owner: "module:verify/col-duo", queue_ids: [420],
    starts_at: day("2031-03-01"), members: ["col-a", "col-b"],
  }));
  check("지명은 사람 단위 — 범위는 두 사람의 연결 계정 × 큐(2칸)", made.scope.length === 2
    && made.scope.every((s) => s.queue_id === 420), JSON.stringify(made.scope.map((s) => s.streamer)));
  await expectFail(check, "목적 하나에 지명 하나 — 같은 owner 로 또 만들 수 없다", () => apply((tx) => col.createOrderInTx(tx, {
    slug: "col-dup", title: "중복", owner: "module:verify/col-duo", queue_ids: [420], starts_at: day("2031-03-01"), members: ["col-a"],
  })), "collection_order_owner_key");
  await expectFail(check, "끝은 시작보다 늦어야 한다", () => apply((tx) => col.createOrderInTx(tx, {
    slug: "col-bad", title: "역순", owner: "module:verify/col-bad", queue_ids: [420], starts_at: day("2031-03-02"), ends_at: day("2031-03-01"), members: ["col-a"],
  })), "늦어야");

  // ── 저장 관문 · 상세 ───────────────────────────────────────────
  const before = await solo(1, "2031-02-28", [seat(pa1), seat(stranger, 200)]);
  const inside = await solo(2, "2031-03-02", [seat(pa1), seat(stranger, 200)]);
  const nobody = await solo(3, "2031-03-02", [seat(stranger)]);
  const [detail] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM lol_participant_detail WHERE match_id = 'COL_2'`;
  check("저장 관문 — 기간 전·범위 밖 계정의 판은 받지 않고, 범위 안 판만 개인 기록", before.state === "out_of_scope"
    && nobody.state === "out_of_scope" && inside.state === "saved" && inside.scope === "personal", JSON.stringify([before.state, inside.state, nobody.state]));
  check("상세는 범위 계정의 행만 — 일반인 행에는 없다", detail.n === 1, `${detail.n}행`);

  // ── 나중에 붙인 계정이 저절로 범위에 들어온다(결정 2) ──────────────────
  const late = await solo(4, "2031-03-03", [seat(pa2)]);
  await link(a.id, pa2);
  const late2 = await solo(5, "2031-03-03", [seat(pa2)]);
  const claimed: string[] = [];
  for (let c = await col.claimBackfillScope(0, at("2031-04-01")); c; c = await col.claimBackfillScope(0, at("2031-04-01"))) {
    if (c.slug === "col-duo") claimed.push(c.puuid);
    await col.saveScopeProgress({ id: c.id, state: "done", reachedEnd: true });
  }
  check("계정을 붙이면 범위가 늘어난다 — 붙이기 전 판은 안 받고, 붙인 뒤엔 받으며, 백필이 새 칸을 집는다",
    late.state === "out_of_scope" && late2.state === "saved" && claimed.includes(pa2) && claimed.length === 3, JSON.stringify({ late: late.state, late2: late2.state, n: claimed.length }));
  const live = (await col.listLiveScopes(at("2031-04-01"), 86_400_000)).filter((s) => s.slug === "col-duo");
  check("실시간 범위 — 활성 계정 3칸, 진척 상태를 함께 준다", live.length === 3 && live.every((s) => s.state === "done"), String(live.length));

  // ── 겹친 지명 · 정리 ───────────────────────────────────────────
  await apply((tx) => col.createOrderInTx(tx, {
    slug: "col-solo", title: "지명가 혼자", owner: "module:verify/col-solo", queue_ids: [420], starts_at: day("2031-03-01"), members: ["col-a"],
  }));
  const dupe = await solo(2, "2031-03-02", [seat(pa1)]);
  check("같은 계정을 지명 둘이 덮어도 판은 하나 — 두 번째는 중복", dupe.state === "duplicate");
  const keep = await preview((tx) => col.removeMemberInTx(tx, "col-duo", "col-a"));
  check("다른 지명이 덮는 판은 사람을 빼도 남는다(미리보기)", keep.pruned.matches.length === 0, keep.pruned.matches.join(","));

  const bOnly = await solo(6, "2031-03-04", [seat(pb1)]);
  const shrinkPreview = await preview((tx) => col.removeMemberInTx(tx, "col-duo", "col-b"));
  const stillThere = await has(6);
  const shrink = await apply((tx) => col.removeMemberInTx(tx, "col-duo", "col-b"));
  check("★ 아무 지명도 덮지 않게 된 판은 지운다 — 미리보기 수 = 실제 수, 미리보기는 아무것도 바꾸지 않는다",
    bOnly.state === "saved" && stillThere && shrinkPreview.pruned.matches.join() === "COL_6"
      && shrink.pruned.matches.join() === "COL_6" && !(await has(6)), JSON.stringify(shrink.pruned));
  check("사람을 빼면 그 사람 계정의 진척도 지운다(다시 넣을 때 옛 커서가 범위를 건너뛰지 않게)",
    (await sql`SELECT 1 FROM collection_progress WHERE puuid = ${pb1}`).length === 0);

  // ── 기간 줄이기 · 진척 다시 열기 ─────────────────────────────────
  const ended = await apply((tx) => col.updateOrderInTx(tx, "col-duo", { ends_at: day("2031-03-03") }));
  const [reset] = await sql<{ n: number }[]>`SELECT count(*)::int n FROM collection_progress p JOIN collection_order o ON o.id = p.order_id
    WHERE o.slug = 'col-duo' AND p.state = 'pending' AND p.cursor_before IS NULL AND NOT p.reached_end`;
  check("기간을 바꾸면 그 지명의 진척을 다시 연다", reset.n === 2, `${reset.n}칸`);
  check("끝을 당겨도 다른 지명(col-solo)이 덮는 판은 남는다", ended.pruned.matches.length === 0 && await has(5));

  // ── 계정 연결 떼기 → 그 계정만의 판은 정리 ─────────────────────────
  await streamers.unlinkAccount(a.id, pa2);
  check("★ 연결을 떼면 그 계정만으로 모은 판은 범위 밖이 되어 지워진다(잘못 붙인 계정의 판이 남지 않는다)", !(await has(5)) && await has(2));

  // ── 내전 세트는 정리 대상이 아니다 ─────────────────────────────────
  // 솔랭내기 행사에 들어간 판(versus)은 지명과 무관하게 남는다 — 사람이 그 판을 내전 세트로 정했다.
  const bet = await solo(7, "2031-03-02", [seat(pa1)]);
  const betEvent = await lolEvent("col-bet", "solo_bet", "지명 시험 솔랭내기");
  await apply((tx) => placeSingleSetInTx(tx, { match_id: "COL_7", game_code: "lol", event_id: betEvent, actor: "admin" }));
  const [{ versus }] = await sql<{ versus: number }[]>`SELECT count(*)::int versus FROM match WHERE scope = 'versus'`;
  const deleted = await apply((tx) => col.deleteOrderInTx(tx, "col-solo"));
  const deletedAll = await apply((tx) => col.deleteOrderInTx(tx, "col-duo"));
  const [{ versusAfter }] = await sql<{ versusAfter: number }[]>`SELECT count(*)::int "versusAfter" FROM match WHERE scope = 'versus'`;
  check("지명을 다 지우면 개인 기록 판은 남지 않고, 내전 세트로 정한 판(솔랭내기)은 그대로다",
    bet.state === "saved" && deleted.pruned.matches.length + deletedAll.pruned.matches.length >= 1 && !(await has(2))
      && await has(7) && versus === versusAfter,
    JSON.stringify({ versus, versusAfter, pruned: [...deleted.pruned.matches, ...deletedAll.pruned.matches] }));

  // ── 이력 · 공개 경로 · 스트리머 삭제 ──────────────────────────────
  const [{ audit }] = await sql<{ audit: number }[]>`SELECT count(*)::int audit FROM admin_audit WHERE scope = 'collection'`;
  check("지명·사람의 만들기·고치기·지우기가 이력(admin_audit)에 남는다", audit >= 8, `${audit}건`);
  await apply((tx) => col.createOrderInTx(tx, {
    slug: "col-pub", title: "공개 시험", owner: "module:verify/col-pub", queue_ids: [420, 440], starts_at: day("2031-03-01"), members: ["col-a", "col-b"],
  }));
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE id = ${b.id}::uuid`;
  const pub = await col.getPublicCollectionOrder("module:verify/col-pub");
  check("공개 경로는 공개 스트리머만 — 숨긴 사람은 빠지고, 큐·기간은 그대로", pub?.members.map((m) => m.streamer_slug).join() === "col-a"
    && pub.queue_ids.join() === "420,440", JSON.stringify(pub));
  await sql`UPDATE streamer SET visibility = 'public' WHERE id = ${b.id}::uuid`;
  await expectFail(check, "지명된 스트리머는 지명에서 빼기 전에 지울 수 없다", () => sql`DELETE FROM streamer WHERE id = ${b.id}::uuid`, "collection_member");
  await apply((tx) => col.deleteOrderInTx(tx, "col-pub"));

  const stray = await col.uncoveredPersonalMatches(sql);
  check("★ 불변식 — 범위 밖 개인 기록 판 0", stray.length === 0, stray.join(","));
}

async function expectFail(check: Check, name: string, fn: () => Promise<unknown>, expected: string): Promise<void> {
  try { await fn(); check(name, false, "거부되어야 하는데 통과했다"); } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    check(name, m.includes(expected), m.includes(expected) ? "" : m);
  }
}

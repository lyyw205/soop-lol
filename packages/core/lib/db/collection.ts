/**
 * **지명 수집의 단일 출처** — docs/COLLECTION-DESIGNATION-PLAN.md (0090).
 *
 * 지명 하나 = 목적 하나(솔랭 도전·솔랭내기 행사 …) + 큐 + 기간 + 사람(스트리머) 여러 명. 그 사람에게 **지금 연결된 계정 전부**가
 * 범위(collection_scope 뷰)다. 공개 큐 경기 기록은 이 범위 안의 것만 저장하고, 범위 밖이 된 개인 기록 판은 지운다.
 *
 *   쓰기(사람)  createOrderInTx · updateOrderInTx · addMemberInTx · removeMemberInTx · deleteOrderInTx — 끝에서 언제나 정리
 *   정리        pruneUncoveredPersonalInTx — 범위 밖 개인 기록 판·범위 밖 계정의 상세를 지운다(계정 연결을 뗄 때도 부른다)
 *   수집(엔진)  listLiveScopes · claimBackfillScope · saveScopeProgress · newestCoveredAt · coveredPuuidsInTx(저장 관문)
 *   읽기(모듈)  getPublicCollectionOrder — 공개 스트리머만
 *
 * ★ 정의(지명·사람)와 진척(커서)을 섞지 않는다. 지명의 기간·큐를 바꾸면 그 지명의 진척만 다시 연다 — 이미 가진 판은
 *   엔진이 API 상세 조회 없이 지나가므로(matchCoverage) 다시 도는 비용은 목록 조회뿐이다.
 * ★ 계정 숨김은 범위를 바꾸지 않는다 — 숨김은 화면의 일이고 데이터는 남긴다. 연결을 떼면(잘못 붙인 계정) 범위에서 빠지고 정리된다.
 */
import type postgres from "postgres";

import { db } from "./client.ts";

type Tx = postgres.TransactionSql;
type Sql = postgres.Sql | Tx;

// ── 지명(정의) ────────────────────────────────────────────────────────────

export interface CollectionOrder {
  id: string; slug: string; title: string; owner: string; queue_ids: number[];
  starts_at: Date; ends_at: Date | null; note: string | null; members: { streamer_id: string; slug: string; name: string }[];
}

export interface OrderInput {
  slug: string; title: string;
  /** `event:<행사 uuid>` 또는 `module:<모듈>/<키>`. 목적 하나에 지명 하나. */
  owner: string;
  queue_ids: number[]; starts_at: Date; ends_at?: Date | null; note?: string | null;
  /** 스트리머 slug. 그 사람에게 연결된 계정 전부가 범위가 된다. */
  members: string[];
}

export interface PruneReport { matches: string[]; details: number }
export interface ChangeReport { order: CollectionOrder | null; scope: { puuid: string; queue_id: number; streamer: string }[]; pruned: PruneReport }

function validate(input: Partial<OrderInput>): void {
  if (input.queue_ids && (!input.queue_ids.length || input.queue_ids.some((q) => !Number.isInteger(q) || q <= 0))) {
    throw new Error(`큐 번호가 올바르지 않다: ${input.queue_ids.join(",")}`);
  }
  if (input.starts_at && input.ends_at && input.ends_at <= input.starts_at) throw new Error("지명의 끝은 시작보다 늦어야 한다.");
}

async function streamerIdsBySlug(tx: Sql, slugs: string[]): Promise<Map<string, string>> {
  const rows = await tx<{ slug: string; id: string }[]>`SELECT slug, id FROM streamer WHERE slug = ANY(${slugs})`;
  const found = new Map(rows.map((r) => [r.slug, r.id]));
  const missing = slugs.filter((s) => !found.has(s));
  if (missing.length) throw new Error(`없는 스트리머: ${missing.join(", ")}`);
  return found;
}

export async function getOrderInTx(tx: Sql, slug: string): Promise<CollectionOrder | null> {
  const [o] = await tx<Omit<CollectionOrder, "members">[]>`
    SELECT id, slug, title, owner, queue_ids, starts_at, ends_at, note FROM collection_order WHERE slug = ${slug}`;
  if (!o) return null;
  const members = await tx<{ streamer_id: string; slug: string; name: string }[]>`
    SELECT m.streamer_id, s.slug, s.display_name AS name FROM collection_member m JOIN streamer s ON s.id = m.streamer_id
     WHERE m.order_id = ${o.id}::uuid ORDER BY s.slug`;
  return { ...o, members };
}

export async function listOrders(): Promise<CollectionOrder[]> {
  const sql = db();
  const slugs = await sql<{ slug: string }[]>`SELECT slug FROM collection_order ORDER BY starts_at DESC, slug`;
  return (await Promise.all(slugs.map((s) => getOrderInTx(sql, s.slug)))).filter((o): o is CollectionOrder => !!o);
}

async function scopeOf(tx: Sql, orderId: string): Promise<ChangeReport["scope"]> {
  return tx<ChangeReport["scope"]>`
    SELECT c.puuid, c.queue_id, s.slug AS streamer FROM collection_scope c JOIN streamer s ON s.id = c.streamer_id
     WHERE c.order_id = ${orderId}::uuid ORDER BY s.slug, c.puuid, c.queue_id`;
}

async function report(tx: Tx, slug: string, pruned: PruneReport): Promise<ChangeReport> {
  const order = await getOrderInTx(tx, slug);
  return { order, scope: order ? await scopeOf(tx, order.id) : [], pruned };
}

/** 지명을 만든다. 사람은 스트리머 slug — 그 사람에게 연결된 계정 전부가 범위가 된다. */
export async function createOrderInTx(tx: Tx, input: OrderInput): Promise<ChangeReport> {
  validate(input);
  if (!input.members.length) throw new Error("지명에는 사람이 한 명 이상 있어야 한다.");
  const ids = await streamerIdsBySlug(tx, input.members);
  const [o] = await tx<{ id: string }[]>`
    INSERT INTO collection_order (slug, title, owner, queue_ids, starts_at, ends_at, note)
    VALUES (${input.slug}, ${input.title.trim()}, ${input.owner}, ${input.queue_ids}, ${input.starts_at}, ${input.ends_at ?? null}, ${input.note ?? null})
    RETURNING id`;
  for (const id of ids.values()) await tx`INSERT INTO collection_member (order_id, streamer_id) VALUES (${o.id}::uuid, ${id}::uuid)`;
  return report(tx, input.slug, { matches: [], details: 0 });
}

/** 지명의 제목·큐·기간·메모를 고친다. 범위가 줄면 범위 밖 판을 정리하고, 기간·큐가 바뀌면 그 지명의 진척을 다시 연다. */
export async function updateOrderInTx(tx: Tx, slug: string, patch: Partial<Pick<OrderInput, "title" | "queue_ids" | "starts_at" | "ends_at" | "note">>): Promise<ChangeReport> {
  const before = await getOrderInTx(tx, slug);
  if (!before) throw new Error(`지명 ${slug} 가 없다.`);
  validate({ starts_at: patch.starts_at ?? before.starts_at, ends_at: patch.ends_at === undefined ? before.ends_at : patch.ends_at, queue_ids: patch.queue_ids });
  const set: Record<string, unknown> = {};
  for (const k of ["title", "queue_ids", "starts_at", "ends_at", "note"] as const) if (patch[k] !== undefined) set[k] = patch[k];
  if (!Object.keys(set).length) return report(tx, slug, { matches: [], details: 0 });
  await tx`UPDATE collection_order SET ${tx(set, ...Object.keys(set))}, updated_at = now() WHERE id = ${before.id}::uuid`;
  if (set.queue_ids !== undefined || set.starts_at !== undefined || set.ends_at !== undefined) {
    // 기간·큐가 바뀌면 진척을 다시 연다 — 늘어난 범위를 아무도 안 보게 되는 것을 막는다. 없어진 큐의 진척은 지운다.
    await tx`DELETE FROM collection_progress p USING collection_order o
              WHERE o.id = p.order_id AND o.id = ${before.id}::uuid AND NOT (p.queue_id = ANY(o.queue_ids))`;
    await tx`UPDATE collection_progress SET cursor_before = NULL, reached_end = false, state = 'pending', last_error = NULL, updated_at = now()
              WHERE order_id = ${before.id}::uuid`;
  }
  return report(tx, slug, await pruneUncoveredPersonalInTx(tx));
}

export async function addMemberInTx(tx: Tx, slug: string, streamerSlug: string): Promise<ChangeReport> {
  const o = await getOrderInTx(tx, slug);
  if (!o) throw new Error(`지명 ${slug} 가 없다.`);
  const id = (await streamerIdsBySlug(tx, [streamerSlug])).get(streamerSlug)!;
  await tx`INSERT INTO collection_member (order_id, streamer_id) VALUES (${o.id}::uuid, ${id}::uuid) ON CONFLICT DO NOTHING`;
  return report(tx, slug, { matches: [], details: 0 });
}

export async function removeMemberInTx(tx: Tx, slug: string, streamerSlug: string): Promise<ChangeReport> {
  const o = await getOrderInTx(tx, slug);
  if (!o) throw new Error(`지명 ${slug} 가 없다.`);
  const id = (await streamerIdsBySlug(tx, [streamerSlug])).get(streamerSlug)!;
  const gone = await tx`DELETE FROM collection_member WHERE order_id = ${o.id}::uuid AND streamer_id = ${id}::uuid RETURNING 1`;
  if (!gone.length) throw new Error(`${streamerSlug} 는 지명 ${slug} 에 없다.`);
  // 그 사람 계정의 진척은 더 쓸 데가 없다(범위 밖) — 남기면 다음에 다시 넣을 때 옛 커서가 범위를 건너뛴다.
  await tx`DELETE FROM collection_progress p WHERE p.order_id = ${o.id}::uuid
            AND NOT EXISTS (SELECT 1 FROM collection_scope s WHERE s.order_id = p.order_id AND s.puuid = p.puuid AND s.queue_id = p.queue_id)`;
  return report(tx, slug, await pruneUncoveredPersonalInTx(tx));
}

export async function deleteOrderInTx(tx: Tx, slug: string): Promise<ChangeReport> {
  const gone = await tx`DELETE FROM collection_order WHERE slug = ${slug} RETURNING 1`;
  if (!gone.length) throw new Error(`지명 ${slug} 가 없다.`);
  return { order: null, scope: [], pruned: await pruneUncoveredPersonalInTx(tx) };
}

// ── 정리 — "개인 기록 판은 언제나 어느 범위 안에 있다" ────────────────────────

/** 범위 덮기 조건 — 판 m 의 참가자 p 가 범위 s 에 들고, 큐·기간이 맞다. 저장 관문·정리·검사가 이 한 정의를 쓴다. */
const COVERS = `s.puuid = p.puuid AND s.queue_id = m.queue_id
  AND m.game_creation >= s.starts_at AND (s.ends_at IS NULL OR m.game_creation < s.ends_at)`;

/**
 * 범위 밖 개인 기록 판(어떤 지명도 덮지 않는 API 판). 지우지 않고 셀 때 — 미리보기·검사.
 * ★ 지명이 다스리는 것은 **API 로 모은** 개인 기록뿐이다(collected_via='api'). 사람이 손으로 넣거나 VOD 로 읽은 판은 지명과 무관하다 —
 *   지명이 없다고 사람의 기록을 지우면 안 된다.
 */
export async function uncoveredPersonalMatches(sql: Sql): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT m.match_id FROM match m
     WHERE m.game_code = 'lol' AND m.scope = 'personal' AND m.collected_via = 'api'
       AND NOT EXISTS (SELECT 1 FROM match_participant p JOIN collection_scope s ON ${COVERS}
                        WHERE p.match_id = m.match_id)
     ORDER BY m.match_id`);
  return rows.map((r) => r.match_id as string);
}

/**
 * 범위 밖 개인 기록 API 판을 지우고(참가자·상세는 FK 로 함께), 남은 판에서 범위 밖 계정의 상세를 지운다.
 * ★ 내전 세트(versus)는 건드리지 않는다 — 솔랭내기 시리즈에 들어간 판은 지명과 무관하게 남는다.
 */
export async function pruneUncoveredPersonalInTx(tx: Tx): Promise<PruneReport> {
  const matches = await uncoveredPersonalMatches(tx);
  if (matches.length) await tx`DELETE FROM match WHERE match_id = ANY(${matches}) AND scope = 'personal' AND collected_via = 'api'`;
  const details = await tx.unsafe(`
    DELETE FROM lol_participant_detail d USING match_participant p, match m
     WHERE p.match_id = d.match_id AND p.participant_id = d.participant_id AND m.match_id = d.match_id
       AND m.scope = 'personal' AND m.collected_via = 'api'
       AND NOT EXISTS (SELECT 1 FROM collection_scope s WHERE ${COVERS})
    RETURNING 1`);
  return { matches, details: details.length };
}

// ── 수집(엔진) ─────────────────────────────────────────────────────────────

/** 범위 한 칸 + 그 칸의 진척. 엔진이 다루는 단위다. */
export interface CollectionScope {
  /** 진척 행 id(백필이 집은 칸). 실시간 따라잡기는 진척 없이 범위만 쓴다(빈 글자). */
  id: string;
  order_id: string; slug: string; puuid: string; queue_id: number; starts_at: Date; ends_at: Date | null;
  cursor_before: Date | null; reached_end: boolean; state: "pending" | "running" | "done" | "error";
  streamer_id: string; label: string;
}

/**
 * 실시간(B)이 따라잡을 범위 — 기간이 시작됐고, 열려 있거나 최근(`lookbackMs` 안)에 끝난 칸. 활성 계정만.
 * 같은 계정이 지명 둘에 걸리면 칸이 둘이다 — 저장 관문이 판 단위로 중복을 거른다.
 */
export async function listLiveScopes(now: Date, lookbackMs: number): Promise<CollectionScope[]> {
  const sql = db();
  const since = new Date(now.getTime() - lookbackMs);
  return sql<CollectionScope[]>`
    SELECT coalesce(p.id::text, '') AS id, c.order_id, c.slug, c.puuid, c.queue_id, c.starts_at, c.ends_at,
           p.cursor_before, coalesce(p.reached_end, false) AS reached_end, coalesce(p.state, 'pending') AS state,
           c.streamer_id, coalesce(st.display_name, left(c.puuid, 8)) AS label
      FROM collection_scope c
      JOIN riot_account ra ON ra.puuid = c.puuid AND ra.is_active
      JOIN streamer st ON st.id = c.streamer_id
      LEFT JOIN collection_progress p ON p.order_id = c.order_id AND p.puuid = c.puuid AND p.queue_id = c.queue_id
     WHERE c.starts_at <= ${now} AND (c.ends_at IS NULL OR c.ends_at > ${since})
     ORDER BY c.puuid, c.queue_id, c.starts_at`;
}

/**
 * 백필 칸 하나를 집는다. 범위에 새로 생긴 칸(계정을 새로 붙였거나 사람을 더함)은 여기서 진척을 만든다.
 * `FOR UPDATE SKIP LOCKED` — 워커 둘이 같은 칸을 겹쳐 긁지 않는다. 실패한 칸은 `retryAfterMs` 뒤 다시 집는다.
 */
export async function claimBackfillScope(retryAfterMs = 60 * 60 * 1000, now = new Date()): Promise<CollectionScope | null> {
  const sql = db();
  await sql`
    INSERT INTO collection_progress (order_id, puuid, queue_id)
    SELECT c.order_id, c.puuid, c.queue_id FROM collection_scope c
      JOIN riot_account ra ON ra.puuid = c.puuid
    ON CONFLICT DO NOTHING`;
  const retryBefore = new Date(now.getTime() - retryAfterMs);
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE collection_progress SET state = 'running', updated_at = now()
     WHERE id = (
       SELECT p.id FROM collection_progress p
         JOIN collection_scope c ON c.order_id = p.order_id AND c.puuid = p.puuid AND c.queue_id = p.queue_id
         JOIN riot_account ra ON ra.puuid = p.puuid AND ra.is_active
        WHERE p.state <> 'done' AND NOT p.reached_end
          AND (p.state <> 'error' OR p.updated_at < ${retryBefore})
          AND c.starts_at < ${now}
        ORDER BY p.updated_at
        LIMIT 1
        FOR UPDATE OF p SKIP LOCKED)
    RETURNING id`;
  if (!claimed) return null;
  const [row] = await sql<CollectionScope[]>`
    SELECT p.id::text AS id, c.order_id, c.slug, c.puuid, c.queue_id, c.starts_at, c.ends_at,
           p.cursor_before, p.reached_end, p.state, c.streamer_id, coalesce(st.display_name, left(c.puuid, 8)) AS label
      FROM collection_progress p
      JOIN collection_scope c ON c.order_id = p.order_id AND c.puuid = p.puuid AND c.queue_id = p.queue_id
      JOIN streamer st ON st.id = c.streamer_id
     WHERE p.id = ${claimed.id}::uuid`;
  return row ?? null;
}

/** 백필 한 조각의 결과. 커서는 아래로만 간다(coalesce — 안 주면 그대로). */
export async function saveScopeProgress(patch: { id: string; before?: Date | null; state: CollectionScope["state"]; reachedEnd?: boolean; error?: string | null }): Promise<void> {
  const sql = db();
  await sql`
    UPDATE collection_progress SET
      cursor_before = coalesce(${patch.before ?? null}, cursor_before),
      state         = ${patch.state},
      reached_end   = ${patch.reachedEnd ?? false} OR reached_end,
      last_error    = ${patch.state === "error" ? patch.error ?? "unknown" : null},
      updated_at    = now()
     WHERE id = ${patch.id}::uuid`;
}

/** 이 범위 칸으로 이미 가진 가장 최근 판의 시각 — 실시간 따라잡기의 시작점(저장된 원본에서 구한다). */
export async function newestCoveredAt(s: Pick<CollectionScope, "puuid" | "queue_id" | "starts_at" | "ends_at">): Promise<Date | null> {
  const sql = db();
  const [row] = await sql<{ at: Date | null }[]>`
    SELECT max(m.game_creation) AS at FROM match_participant p JOIN match m ON m.match_id = p.match_id
     WHERE p.puuid = ${s.puuid} AND m.game_code = 'lol' AND m.queue_id = ${s.queue_id}
       AND m.game_creation >= ${s.starts_at} AND (${s.ends_at}::timestamptz IS NULL OR m.game_creation < ${s.ends_at})`;
  return row?.at ?? null;
}

/** 저장 관문 — 이 판의 참가 계정 중 범위가 덮는 계정. 비면 저장하지 않는다(공개 큐 판이 저장되는 유일한 근거). */
export async function coveredPuuidsInTx(tx: Tx, puuids: string[], queueId: number | null, at: Date): Promise<Set<string>> {
  if (!puuids.length || queueId == null) return new Set();
  const rows = await tx<{ puuid: string }[]>`
    SELECT DISTINCT puuid FROM collection_scope
     WHERE puuid = ANY(${puuids}::text[]) AND queue_id = ${queueId}
       AND starts_at <= ${at} AND (ends_at IS NULL OR ${at} < ends_at)`;
  return new Set(rows.map((r) => r.puuid));
}

// ── 읽기(모듈) ─────────────────────────────────────────────────────────────

export interface PublicCollectionOrder {
  slug: string; title: string; owner: string; queue_ids: number[]; starts_at: Date; ends_at: Date | null;
  /** 공개 스트리머만. */
  members: { streamer_id: string; streamer_slug: string }[];
}

/** 목적(owner)으로 지명을 찾는다 — 모듈이 자기 콘텐츠의 지명을 읽는 길(계약). 공개 경로(core_public)만 읽는다. */
export async function getPublicCollectionOrder(owner: string): Promise<PublicCollectionOrder | null> {
  const sql = db();
  const [o] = await sql<Omit<PublicCollectionOrder, "members">[]>`
    SELECT slug, title, owner, queue_ids, starts_at, ends_at FROM core_public.collection_order WHERE owner = ${owner}`;
  if (!o) return null;
  const members = await sql<PublicCollectionOrder["members"]>`
    SELECT streamer_id, streamer_slug FROM core_public.collection_member WHERE slug = ${o.slug} ORDER BY streamer_slug`;
  return { ...o, members: [...members] };
}

/**
 * FC 구단 수집 — 공식 구단가치(①)·스쿼드 6칸(②)·카드 시세(③). 워커와 수동 명령이 같은 함수를 쓴다.
 * 표와 원칙: db/migrations/0060_fco_club_value.sql, docs/FCO-CLUB-VALUE-PLAN.md.
 *
 * 세 가지를 뭉개지 않는다:
 *   ok      — ① 한 행 + ② 6칸을 한 트랜잭션으로. 칸 하나라도 못 받으면 아무것도 쓰지 않는다(반쪽 보유는 합집합을 속인다)
 *   missing — 구단주 검색이 "존재하지 않습니다" 를 줬다. 확인했는데 없다는 사실이라 행으로 남긴다
 *   error   — 조회 실패·형식 변경·신원 불일치. 행을 만들지 않고 이유를 돌려준다
 */

import { db } from "../../../db/client.ts";
import { kstDateString } from "../../../time.ts";
import type { FcoUserBasic } from "../types.ts";
import type { Squad } from "./parse.ts";
import type { FcoSiteClient } from "./site-client.ts";

/** 감독명의 현재 값을 알려 주는 곳(NexonClient). 없으면 저장된 감독명으로 찾는다. */
export interface ClubNicknameSource {
  userBasic(ouid: string): Promise<FcoUserBasic | null>;
}

type ClubSite = Pick<FcoSiteClient, "profile" | "tooltip" | "squad">;

export type ClubSyncResult =
  | { outcome: "ok"; ouid: string; nickname: string; snapshotId: string; clubValue: number; cards: number }
  | { outcome: "missing"; ouid: string; nickname: string }
  | { outcome: "error"; ouid: string; nickname: string | null; reason: string };

/** 6칸 — 대표팀 A/B/C, 클럽팀 A/B/C. */
export const SQUAD_SLOTS: readonly { teamType: 0 | 1; slot: 1 | 2 | 3 }[] = [
  { teamType: 1, slot: 1 }, { teamType: 1, slot: 2 }, { teamType: 1, slot: 3 },
  { teamType: 0, slot: 1 }, { teamType: 0, slot: 2 }, { teamType: 0, slot: 3 },
];

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function syncClub(site: ClubSite, names: ClubNicknameSource | null, ouid: string): Promise<ClubSyncResult> {
  const sql = db();
  const [account] = await sql<{ nickname: string }[]>`SELECT nickname FROM fco_account WHERE ouid = ${ouid}`;
  if (!account) return { outcome: "error", ouid, nickname: null, reason: "fco_account 에 없는 계정" };

  // 감독명은 바뀐다. 옛 이름으로 찾으면 그 이름을 새로 쓴 남이 걸린다 — 조회 직전에 넥슨 API 로 갱신한다.
  let nickname = account.nickname;
  if (names) {
    let basic: FcoUserBasic | null;
    try { basic = await names.userBasic(ouid); } catch (e) {
      return { outcome: "error", ouid, nickname, reason: `감독명 갱신 실패: ${errorText(e)}` };
    }
    if (!basic) return { outcome: "error", ouid, nickname, reason: "넥슨 API 가 이 ouid 를 모른다" };
    if (basic.nickname !== nickname) {
      await sql`UPDATE fco_account SET nickname = ${basic.nickname}, seen_at = now() WHERE ouid = ${ouid}`;
      nickname = basic.nickname;
    }
  }

  try {
    const profile = await site.profile(nickname);
    if (profile.kind === "missing") {
      await sql`INSERT INTO fco_club_snapshot (ouid, status, nickname) VALUES (${ouid}, 'missing', ${nickname})`;
      return { outcome: "missing", ouid, nickname };
    }
    // 구단주 검색은 대소문자를 무시한다 — `뀨뀨RR` 로 `뀨뀨rr` 이 나온다. 정확히 같은 사람만 받는다.
    if (profile.nickname !== null && profile.nickname !== nickname) {
      return { outcome: "error", ouid, nickname, reason: `구단주 검색이 다른 감독명 "${profile.nickname}" 을 줬다` };
    }
    // 같은 ouid 의 회원번호가 바뀌었다면 감독명이 남에게 넘어간 것이다.
    const [previous] = await sql<{ nexon_sn: string }[]>`
      SELECT nexon_sn::text FROM fco_club_snapshot
       WHERE ouid = ${ouid} AND status = 'ok' ORDER BY captured_at DESC LIMIT 1`;
    if (previous && Number(previous.nexon_sn) !== profile.sn) {
      return { outcome: "error", ouid, nickname, reason: `회원번호가 ${previous.nexon_sn} → ${profile.sn} 로 바뀌었다` };
    }
    const tooltip = await site.tooltip(profile.sn);
    if (tooltip.nickname !== nickname) {
      return { outcome: "error", ouid, nickname, reason: `툴팁 감독명 "${tooltip.nickname}" 이 다르다` };
    }
    const squads: { teamType: 0 | 1; slot: 1 | 2 | 3; squad: Squad }[] = [];
    for (const { teamType, slot } of SQUAD_SLOTS) {
      squads.push({ teamType, slot, squad: await site.squad(profile.sn, profile.characterId, teamType, slot) });
    }

    const snapshotId = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO fco_club_snapshot (ouid, status, nickname, nexon_sn, club_value)
        VALUES (${ouid}, 'ok', ${nickname}, ${profile.sn}, ${tooltip.clubValue}) RETURNING id::text`;
      for (const { teamType, slot, squad } of squads) {
        await tx`
          INSERT INTO fco_squad_snapshot (snapshot_id, team_type, slot, total_price, coach_id)
          VALUES (${row.id}, ${teamType}, ${slot}, ${squad.totalPrice}, ${squad.coachId})`;
        if (!squad.players.length) continue;
        await tx`INSERT INTO fco_squad_player ${tx(squad.players.map((p) => ({
          snapshot_id: row.id, team_type: teamType, slot, idx: p.idx, role: p.role, is_starter: p.isStarter,
          spid: p.spid, grade: p.grade, price: p.price, name: p.name, season: p.season, ovr: p.ovr,
        })))}`;
      }
      return row.id;
    });
    const cards = new Set(squads.flatMap(({ squad }) => squad.players.map((p) => `${p.spid}:${p.grade}`))).size;
    return { outcome: "ok", ouid, nickname, snapshotId, clubValue: tooltip.clubValue, cards };
  } catch (e) {
    return { outcome: "error", ouid, nickname, reason: errorText(e) };
  }
}

// ── ③ 카드 시세 ──────────────────────────────────────────────────────

export interface CardPriceSyncResult {
  cards: number;
  /** 오늘 이미 받아서 건너뛴 카드. */
  fresh: number;
  fetched: number;
  inserted: number;
  /** 이미 있던 날의 값이 바뀐 행 — 넥슨이 과거 일별 값을 고치는지 보는 단서다. */
  revised: number;
  errors: string[];
}

/**
 * 시세를 받을 카드 = 공개 계정마다 **가장 최근 ok 스냅샷**의 6칸에 든 카드(강화를 아는 것만).
 * 시세는 스트리머와 무관한 시장 데이터라 카드 하나에 한 번만 받는다.
 */
export async function heldCards(): Promise<{ spid: number; grade: number }[]> {
  const rows = await db()<{ spid: string; grade: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (cs.ouid) cs.id
        FROM fco_club_snapshot cs
        JOIN streamer_fco_account link ON link.ouid = cs.ouid AND link.visibility = 'public'
       WHERE cs.status = 'ok'
       ORDER BY cs.ouid, cs.captured_at DESC
    )
    SELECT DISTINCT p.spid::text, p.grade
      FROM fco_squad_player p JOIN latest ON latest.id = p.snapshot_id
     WHERE p.grade IS NOT NULL
     ORDER BY 1, 2`;
  return rows.map((r) => ({ spid: Number(r.spid), grade: r.grade }));
}

export async function syncCardPrices(
  site: Pick<FcoSiteClient, "priceGraph">,
  cards: { spid: number; grade: number }[],
  now = new Date(),
): Promise<CardPriceSyncResult> {
  const sql = db();
  const today = kstDateString(now);
  const result: CardPriceSyncResult = { cards: cards.length, fresh: 0, fetched: 0, inserted: 0, revised: 0, errors: [] };
  for (const card of cards) {
    const [seen] = await sql<{ last: string | null }[]>`
      SELECT (max(fetched_at) AT TIME ZONE 'Asia/Seoul')::date::text AS last
        FROM fco_card_price_daily WHERE spid = ${card.spid} AND grade = ${card.grade}`;
    if (seen?.last === today) { result.fresh++; continue; }
    let points;
    try { points = (await site.priceGraph(card.spid, card.grade, today)).points; } catch (e) {
      result.errors.push(`${card.spid}/${card.grade}: ${errorText(e)}`);
      continue;
    }
    result.fetched++;
    if (!points.length) continue;
    const before = new Map((await sql<{ day: string; price: string }[]>`
      SELECT day::text, price::text FROM fco_card_price_daily WHERE spid = ${card.spid} AND grade = ${card.grade}`)
      .map((r) => [r.day, Number(r.price)]));
    for (const p of points) {
      if (!before.has(p.day)) result.inserted++;
      else if (before.get(p.day) !== p.price) result.revised++;
    }
    // 바뀌지 않은 행도 fetched_at 을 새로 찍는다 — "오늘 받았나" 를 이 칸으로 판단한다.
    await sql`
      INSERT INTO fco_card_price_daily ${sql(points.map((p) => ({ spid: card.spid, grade: card.grade, day: p.day, price: p.price })))}
      ON CONFLICT (spid, grade, day) DO UPDATE SET price = EXCLUDED.price, fetched_at = now()`;
  }
  return result;
}

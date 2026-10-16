/**
 * FC 구단 수집 — 공식 구단가치(①)·스쿼드 6칸(②)·카드 시세(③). 워커와 수동 명령이 같은 함수를 쓴다.
 * 표와 원칙: db/migrations/0060_fco_club_value.sql, docs/FCO-CLUB-VALUE-PLAN.md.
 *
 * 세 가지를 뭉개지 않는다:
 *   ok      — ① 한 행 + ② 6칸을 한 트랜잭션으로. 칸 하나라도 못 받으면 아무것도 쓰지 않는다(반쪽 보유는 합집합을 속인다)
 *   missing — 구단주 검색이 "존재하지 않습니다" 를 줬다. 확인했는데 없다는 사실이라 행으로 남긴다
 *   error   — 조회 실패·형식 변경·신원 불일치. 시도 결과만 남기고 마지막 성공은 보존한다
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

  const [attempt] = await sql<{ id: string; started_at: Date }[]>`
    INSERT INTO fco_club_attempt (ouid) VALUES (${ouid}) RETURNING id::text, started_at`;
  const fail = async (code: string, reason: string): Promise<ClubSyncResult> => {
    await sql`UPDATE fco_club_attempt SET completed_at = clock_timestamp(), outcome = 'error', failure_code = ${code}
               WHERE id = ${attempt.id}`;
    return { outcome: "error", ouid, nickname, reason };
  };
  // 감독명은 바뀐다. 옛 이름으로 찾으면 그 이름을 새로 쓴 남이 걸린다 — 조회 직전에 넥슨 API 로 갱신한다.
  let nickname = account.nickname;
  try {
  if (names) {
    let basic: FcoUserBasic | null;
    try { basic = await names.userBasic(ouid); } catch (e) {
      return await fail("nickname_lookup", `감독명 갱신 실패: ${errorText(e)}`);
    }
    if (!basic) return await fail("unknown_account", "넥슨 API 가 이 ouid 를 모른다");
    if (basic.nickname !== nickname) {
      await sql`UPDATE fco_account SET nickname = ${basic.nickname}, seen_at = now() WHERE ouid = ${ouid}`;
      nickname = basic.nickname;
    }
  }

    const profile = await site.profile(nickname);
    if (profile.kind === "missing") {
      await sql.begin(async tx => {
        const [snapshot] = await tx<{id: string}[]>`INSERT INTO fco_club_snapshot (ouid, status, nickname, captured_at)
          VALUES (${ouid}, 'missing', ${nickname}, ${attempt.started_at}) RETURNING id::text`;
        await tx`UPDATE fco_club_attempt SET completed_at = clock_timestamp(), outcome = 'missing', snapshot_id = ${snapshot.id} WHERE id = ${attempt.id}`;
      });
      return { outcome: "missing", ouid, nickname };
    }
    // 구단주 검색은 대소문자를 무시한다 — `뀨뀨RR` 로 `뀨뀨rr` 이 나온다. 정확히 같은 사람만 받는다.
    if (profile.nickname !== null && profile.nickname !== nickname) {
      return await fail("identity_mismatch", `구단주 검색이 다른 감독명 "${profile.nickname}" 을 줬다`);
    }
    // 같은 ouid 의 회원번호가 바뀌었다면 감독명이 남에게 넘어간 것이다.
    const [previous] = await sql<{ nexon_sn: string }[]>`
      SELECT nexon_sn::text FROM fco_club_snapshot
       WHERE ouid = ${ouid} AND status = 'ok' ORDER BY captured_at DESC LIMIT 1`;
    if (previous && Number(previous.nexon_sn) !== profile.sn) {
      return await fail("identity_mismatch", `회원번호가 ${previous.nexon_sn} → ${profile.sn} 로 바뀌었다`);
    }
    const tooltip = await site.tooltip(profile.sn);
    if (tooltip.nickname !== nickname) {
      return await fail("identity_mismatch", `툴팁 감독명 "${tooltip.nickname}" 이 다르다`);
    }
    const squads: { teamType: 0 | 1; slot: 1 | 2 | 3; squad: Squad }[] = [];
    for (const { teamType, slot } of SQUAD_SLOTS) {
      squads.push({ teamType, slot, squad: await site.squad(profile.sn, profile.characterId, teamType, slot) });
    }

    const snapshotId = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO fco_club_snapshot (ouid, status, nickname, nexon_sn, club_value, captured_at)
        VALUES (${ouid}, 'ok', ${nickname}, ${profile.sn}, ${tooltip.clubValue}, ${attempt.started_at}) RETURNING id::text`;
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
      await tx`UPDATE fco_club_attempt SET completed_at = clock_timestamp(), outcome = 'ok', snapshot_id = ${row.id} WHERE id = ${attempt.id}`;
      return row.id;
    });
    const cards = new Set(squads.flatMap(({ squad }) => squad.players.map((p) => `${p.spid}:${p.grade}`))).size;
    return { outcome: "ok", ouid, nickname, snapshotId, clubValue: tooltip.clubValue, cards };
  } catch (e) {
    return await fail("fetch_error", errorText(e));
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
  // "오늘 받았나" 는 카드별 수집 기록 한 줄로 본다(0084). 카드마다 묻지 않고 한 번에 받는다.
  const fresh = new Set((await sql<{ k: string }[]>`
    SELECT spid::text || '/' || grade AS k FROM fco_card_price_fetch
     WHERE (fetched_at AT TIME ZONE 'Asia/Seoul')::date = ${today}::date`).map((r) => r.k));
  for (const card of cards) {
    if (fresh.has(`${card.spid}/${card.grade}`)) { result.fresh++; continue; }
    let points;
    try { points = (await site.priceGraph(card.spid, card.grade, today)).points; } catch (e) {
      result.errors.push(`${card.spid}/${card.grade}: ${errorText(e)}`);
      continue;
    }
    result.fetched++;
    if (!points.length) continue;
    // ★ 새 날짜와 값이 바뀐 날짜만 쓴다 — 같은 값을 다시 쓰면 매일 30만 줄 넘는 새 줄 버전과 WAL 이 쌓였다(0084).
    //   비교는 DB 가 하고 쓴 줄만 돌려준다 — 이력 전체를 받아 와 비교하면 그게 하루 약 14MB 전송이었다.
    // ★ 시각은 위의 today 와 같은 now 를 쓴다. DB now() 를 쓰면 판단(now)과 기록(DB 시계)의 기준이 갈려,
    //   now 를 주입한 검증에서 "오늘 받은 카드" 를 못 알아봤다(verify:fco-club).
    await sql.begin(async (tx) => {
      const written = await tx<{ inserted: boolean }[]>`
        INSERT INTO fco_card_price_daily (spid, grade, day, price, fetched_at)
        SELECT ${card.spid}::bigint, ${card.grade}::smallint, v.day, v.price, ${now}::timestamptz
          FROM jsonb_to_recordset(${tx.json(points as never)}) AS v(day date, price bigint)
          LEFT JOIN fco_card_price_daily d ON d.spid = ${card.spid} AND d.grade = ${card.grade} AND d.day = v.day
         WHERE d.price IS DISTINCT FROM v.price
        ON CONFLICT (spid, grade, day) DO UPDATE SET price = EXCLUDED.price, fetched_at = EXCLUDED.fetched_at
        RETURNING (xmax = 0) AS inserted`;
      for (const w of written) w.inserted ? result.inserted++ : result.revised++;
      await tx`
        INSERT INTO fco_card_price_fetch (spid, grade, fetched_at) VALUES (${card.spid}, ${card.grade}, ${now})
        ON CONFLICT (spid, grade) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`;
    });
  }
  return result;
}

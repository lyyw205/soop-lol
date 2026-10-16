/**
 * FC 구단 공개 조회 — 구단가치 순위표와 스트리머 구단(가치 차트·스쿼드 등록 선수·6칸).
 *
 * 원본(db/migrations/0060)을 읽어 metrics/club-value.ts 로 계산만 한다. 저장된 파생은 없다.
 * 공개 범위: 공개 스트리머의 공개 계정만. ouid·회원번호는 내보내지 않는다(감독명만).
 * 줄 세우는 규칙(무엇이 먼저인가)은 화면 모듈의 것이다 — 여기는 재료만 준다.
 */
import { kstDateString } from "../time.ts";
import {
  backcastSeries, cardKey, currentValue, decomposeChange, holdingsSeries, shiftDay, squadLabel, unionHoldings,
  type Card, type DayHoldings, type HeldCard, type HoldingRow, type ValueChange, type ValuePoint,
} from "../metrics/club-value.ts";
import { resolveClubState, pickRepresentative, type ClubAttempt } from "../metrics/club-state.ts";
import { db } from "./client.ts";

import type { FcoDivision } from "../games/fconline/club/grades.ts";
import type { FcoTeamColors } from "../games/fconline/club/team-colors.ts";

export interface FcoClubPoint { day: string; value: number }

export interface FcoClubAccountSummary {
  rating: { score: number | null; sourceAt: string; checkedAt: string; currentGrade: FcoDivision | null; previousBestGrade: FcoDivision | null; gradesCheckedAt: string | null } | null;
  officialRank: { rank: number | null; day: string } | null;
  teamColors: (FcoTeamColors & { checkedAt: string }) | null;
  nickname: string;
  /** null = 아직 한 번도 조회하지 않았다. missing = 구단주 검색이 "존재하지 않습니다" 를 줬다. */
  status: "ok" | "missing" | "error" | "pending" | null;
  checked_at: string | null;
  completed_at: string | null;
  history_complete: boolean;
  fresh: boolean;
  rank_eligible: boolean;
  club_value: number | null;
  captured_at: string | null;
  /** 공식 구단가치 일별(그날 마지막 성공 조회). 등락 계산용. */
  history: FcoClubPoint[];
  /** 가장 최근 ok 스냅샷의 스쿼드 등록 선수(6칸 합집합). */
  cards: number;
  squad_value: number;
  unpriced: number;
}

export interface FcoClubBoardRow {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  channel_id: string | null;
  /** 대표 계정 = 순위 포함 가능한 공개 계정 중 공식 구단가치 최대. 사람별 한 줄로 표시한다. */
  account: FcoClubAccountSummary;
  accounts: number;
}

interface AccountRow {
  id: string; slug: string; name: string; image: string | null; channel_id: string | null;
  rating: FcoClubAccountSummary["rating"];
  official_rank: FcoClubAccountSummary["officialRank"];
  ouid: string; nickname: string; team_colors: FcoClubAccountSummary["teamColors"];
}
interface SnapshotRow { id: string; ouid: string; day: string; status: "ok" | "missing"; club_value: string | null; captured_at: string }
interface PlayerRow {
  snapshot_id: string; team_type: 0 | 1; slot: 1 | 2 | 3; role: string; is_starter: boolean; spid: string; grade: number | null;
  price: string | null; name: string; season: string | null; ovr: number | null;
}

const toHolding = (r: PlayerRow): HoldingRow => ({
  teamType: r.team_type, slot: r.slot, role: r.role, isStarter: r.is_starter, spid: Number(r.spid), grade: r.grade,
  price: r.price === null ? null : Number(r.price), name: r.name, season: r.season, ovr: r.ovr,
});

async function publicAccounts(slug?: string): Promise<AccountRow[]> {
  return db()<AccountRow[]>`
    SELECT s.id, s.slug, s.display_name AS name, s.profile_image_url AS image,
           (SELECT c.channel_id FROM core_public.streamer_channel c
             WHERE c.streamer_id = s.id AND c.platform = 'soop'
             ORDER BY c.is_primary DESC LIMIT 1) AS channel_id,
           link.ouid, a.nickname,
           CASE WHEN rating.ouid IS NULL THEN NULL ELSE jsonb_build_object(
             'score', rating.score, 'sourceAt', rating.source_at, 'checkedAt', rating.checked_at,
             'currentGrade', rating.current_grade, 'previousBestGrade', rating.previous_best_grade, 'gradesCheckedAt', rating.grades_checked_at
           ) END AS rating,
           CASE WHEN tc.ouid IS NULL THEN NULL ELSE jsonb_build_object(
             'source', tc.source, 'slot', tc.source_slot, 'colors', tc.colors, 'sourceAt', tc.source_at, 'checkedAt', tc.checked_at
           ) END AS team_colors,
           CASE WHEN vr.day IS NULL THEN NULL ELSE jsonb_build_object(
             'day', vr.day::text, 'rank', (re.entry->>'rank')::int
           ) END AS official_rank
      FROM streamer s
      JOIN streamer_fco_account link ON link.streamer_id = s.id AND link.visibility = 'public'
      JOIN fco_account a ON a.ouid = link.ouid
      LEFT JOIN fco_rating rating ON rating.ouid = a.ouid AND rating.nickname = a.nickname
      LEFT JOIN fco_team_colors tc ON tc.ouid = a.ouid AND tc.nickname = a.nickname
      LEFT JOIN LATERAL (SELECT day, entries FROM fco_value_ranking ORDER BY day DESC LIMIT 1) vr ON true
      LEFT JOIN LATERAL (
        SELECT nexon_sn FROM fco_club_snapshot WHERE ouid = a.ouid AND status = 'ok' AND nickname = a.nickname
        ORDER BY captured_at DESC, id DESC LIMIT 1
      ) identity ON true
      LEFT JOIN LATERAL (
        SELECT entry FROM jsonb_array_elements(vr.entries) entry
        WHERE (entry->>'sn')::bigint = identity.nexon_sn AND entry->>'nickname' = a.nickname
      ) re ON true
     WHERE s.visibility = 'public' AND (${slug ?? null}::text IS NULL OR s.slug = ${slug ?? null})
     ORDER BY s.display_name, a.nickname`;
}

/** 계정마다 KST 하루에 마지막 성공 조회 하나. */
async function dailySnapshots(ouids: string[], sinceDay: string): Promise<SnapshotRow[]> {
  if (!ouids.length) return [];
  return db()<SnapshotRow[]>`
    SELECT DISTINCT ON (ouid, day) id::text, ouid, day, status, club_value::text, captured_at::text
      FROM (SELECT *, (captured_at AT TIME ZONE 'Asia/Seoul')::date::text AS day FROM fco_club_snapshot
             WHERE ouid = ANY(${ouids}) AND captured_at >= ${sinceDay}::date - 1) s
     WHERE day >= ${sinceDay} AND status = 'ok'
     ORDER BY ouid, day, captured_at DESC, id DESC`;
}

async function playersOf(snapshotIds: string[]): Promise<Map<string, HoldingRow[]>> {
  const out = new Map<string, HoldingRow[]>();
  if (!snapshotIds.length) return out;
  const rows = await db()<PlayerRow[]>`
    SELECT snapshot_id::text, team_type, slot, role, is_starter, spid::text, grade, price::text, name, season, ovr
      FROM fco_squad_player WHERE snapshot_id = ANY(${snapshotIds}::bigint[])
     ORDER BY snapshot_id, team_type DESC, slot, idx`;
  for (const r of rows) {
    const list = out.get(r.snapshot_id) ?? [];
    list.push(toHolding(r));
    out.set(r.snapshot_id, list);
  }
  return out;
}

/** 차트 조회 창과 독립적인 최신 조회·최신 성공. */
async function currentStates(ouids: string[]) {
  const rows = ouids.length ? await db()<{ouid: string; attempt: ClubAttempt | null; snapshot: SnapshotRow | null}[]>`
    SELECT a.ouid,
      CASE WHEN attempt.id IS NULL THEN NULL ELSE jsonb_build_object(
        'startedAt', attempt.started_at, 'completedAt', attempt.completed_at,
        'outcome', attempt.outcome, 'legacy', attempt.legacy) END AS attempt,
      CASE WHEN snapshot.id IS NULL THEN NULL ELSE jsonb_build_object(
        'id', snapshot.id::text, 'ouid', snapshot.ouid, 'day', (snapshot.captured_at AT TIME ZONE 'Asia/Seoul')::date::text,
        'status', snapshot.status, 'club_value', snapshot.club_value::text, 'captured_at', snapshot.captured_at) END AS snapshot
    FROM fco_account a
    LEFT JOIN LATERAL (SELECT * FROM fco_club_attempt t WHERE t.ouid = a.ouid ORDER BY started_at DESC, id DESC LIMIT 1) attempt ON true
    LEFT JOIN LATERAL (SELECT * FROM fco_club_snapshot s WHERE s.ouid = a.ouid AND s.status = 'ok'
      ORDER BY captured_at DESC, id DESC LIMIT 1) snapshot ON true
    WHERE a.ouid = ANY(${ouids})` : [];
  return new Map(rows.map(r => [r.ouid, r]));
}
function summarize(a: AccountRow, state: Awaited<ReturnType<typeof currentStates>> extends Map<string, infer T> ? T | undefined : never,
  snaps: SnapshotRow[], players: Map<string, HoldingRow[]>, now: Date): FcoClubAccountSummary {
  const latestOk = state?.snapshot;
  const cards = latestOk ? unionHoldings(players.get(latestOk.id) ?? []) : [];
  const { value, unpriced } = currentValue(cards);
  const clubValue = latestOk?.club_value !== null && latestOk?.club_value !== undefined ? Number(latestOk.club_value) : null;
  return {
    nickname: a.nickname, rating: a.rating, teamColors: a.team_colors, officialRank: a.official_rank,
    ...resolveClubState({ attempt: state?.attempt ?? null, value: clubValue, valueAt: latestOk?.captured_at ?? null }, now),
    club_value: clubValue, captured_at: latestOk?.captured_at ?? null,
    history: snaps.map(s => ({ day: s.day, value: Number(s.club_value) })),
    cards: cards.length, squad_value: value, unpriced,
  };
}
// 순위 후보가 없을 때는 참고 계정만 돌려준다. rank_eligible=false를 소비처가 보존한다.
const referenceAccount = (list: FcoClubAccountSummary[]) => pickRepresentative(list)
  ?? [...list].sort((a,b) => (b.captured_at ?? "").localeCompare(a.captured_at ?? "") || a.nickname.localeCompare(b.nickname, "ko"))[0];

/** 구단가치 순위표 재료. 공식 구단가치 이력은 등락용으로 40일만. */
export async function listFcoClubBoard(now = new Date()): Promise<FcoClubBoardRow[]> {
  const accounts = await publicAccounts();
  const snaps = await dailySnapshots(accounts.map((a) => a.ouid), shiftDay(kstDateString(now), -40));
  const states = await currentStates(accounts.map(a => a.ouid));
  const players = await playersOf([...states.values()].flatMap(s => s.snapshot ? [s.snapshot.id] : []));
  const byPerson = new Map<string, { row: AccountRow; summaries: FcoClubAccountSummary[] }>();
  for (const a of accounts) {
    const entry = byPerson.get(a.id) ?? { row: a, summaries: [] };
    entry.summaries.push(summarize(a, states.get(a.ouid), snaps.filter((s) => s.ouid === a.ouid), players, now));
    byPerson.set(a.id, entry);
  }
  return [...byPerson.values()].map(({ row, summaries }) => ({
    id: row.id, slug: row.slug, name: row.name, image: row.image, channel_id: row.channel_id,
    account: referenceAccount(summaries), accounts: summaries.length,
  }));
}

export interface FcoClubSquad { label: string; total_price: number; coach_id: string | null; players: HoldingRow[] }

export interface FcoClub {
  id: string; slug: string; name: string; image: string | null; channel_id: string | null;
  account: FcoClubAccountSummary;
  /** 다른 공개 계정(부계정). 값만 보여 주고 차트는 대표 계정 것이다. */
  others: FcoClubAccountSummary[];
  /** 가장 최근 ok 스냅샷 — 스쿼드 등록 선수(현재가)와 6칸. */
  holdings: HeldCard[];
  squads: FcoClubSquad[];
  /** 실제 가치 이력(그날 들고 있던 카드 × 그날 일별 시세). 날짜는 보유 기준일 = 조회일 전날. 스냅샷이 쌓인 날부터. */
  actual: ValuePoint[];
  /** 현재 스쿼드 소급 추정(지금 카드 × 과거 일별 시세). 실제 이력이 아니다. */
  backcast: ValuePoint[];
  /** 연속한 스냅샷 날 사이의 변동 분해. */
  changes: ValueChange[];
  /** 지금 등록된 카드별 일별 시세(키 = cardKey, 날짜 오름차순). 강화를 모르는 카드는 없다. */
  cardSeries: Record<string, { day: string; value: number }[]>;
}

/** 스트리머 구단. days = 차트 기간(최대 365, 넥슨 시세 그래프 한도). */
export async function getFcoClub(slug: string, days = 365, now = new Date()): Promise<FcoClub | null> {
  const accounts = await publicAccounts(slug);
  if (!accounts.length) return null;
  const today = kstDateString(now);
  const since = shiftDay(today, -Math.min(365, Math.max(7, days)));
  const snaps = await dailySnapshots(accounts.map((a) => a.ouid), since);
  const okSnaps = snaps.filter((s) => s.status === "ok");
  const states = await currentStates(accounts.map(a => a.ouid));
  const players = await playersOf([...new Set([...okSnaps.map(s => s.id), ...[...states.values()].flatMap(s => s.snapshot ? [s.snapshot.id] : [])])]);
  const summaries = accounts.map((a) => ({ ouid: a.ouid, summary: summarize(a, states.get(a.ouid), snaps.filter((s) => s.ouid === a.ouid), players, now) }));
  const best = summaries.find((s) => s.summary === referenceAccount(summaries.map((x) => x.summary)))!;
  const mine = okSnaps.filter((s) => s.ouid === best.ouid);
  const latest = states.get(best.ouid)?.snapshot;

  // 넥슨 스쿼드 화면은 "전일 자정 기준" 이고 시세 그래프도 전날까지다 — 조회한 날의 보유는 **전날의 보유**로 놓고
  // 같은 날 시세로 평가한다. 그래야 보유와 시세가 같은 날을 가리키고, 마지막 점이 늘 비지 않는다.
  const dayHoldings: DayHoldings[] = mine.map((s) => ({
    day: shiftDay(s.day, -1),
    cards: unionHoldings(players.get(s.id) ?? []).map((c): Card => ({ spid: c.spid, grade: c.grade })),
  }));
  const latestRows = latest ? players.get(latest.id) ?? [] : [];
  const holdings = unionHoldings(latestRows);

  // 시세: 이 계정이 기간 안에 한 번이라도 들고 있던 카드만.
  const wanted = new Map<string, Card>();
  for (const d of dayHoldings) for (const c of d.cards) if (c.grade !== null) wanted.set(cardKey(c), c);
  for (const c of holdings) if (c.grade !== null) wanted.set(cardKey(c), c);
  const priceTable = new Map<string, number>();
  const cardSeries: Record<string, { day: string; value: number }[]> = {};
  if (wanted.size) {
    const list = [...wanted.values()];
    const rows = await db()<{ spid: string; grade: number; day: string; price: string }[]>`
      SELECT p.spid::text, p.grade, p.day::text, p.price::text
        FROM fco_card_price_daily p
        JOIN unnest(${list.map((c) => c.spid)}::bigint[], ${list.map((c) => c.grade!)}::smallint[]) AS w(spid, grade)
          ON w.spid = p.spid AND w.grade = p.grade
       WHERE p.day >= ${since}`;
    for (const r of rows) priceTable.set(`${r.spid}:${r.grade}|${r.day}`, Number(r.price));
    rows.sort((x, y) => x.day < y.day ? -1 : x.day > y.day ? 1 : 0);
    for (const r of rows) (cardSeries[`${r.spid}:${r.grade}`] ??= []).push({ day: r.day, value: Number(r.price) });
  }
  const priceAt = (c: Card, day: string) => priceTable.get(`${cardKey(c)}|${day}`);

  const chartDays: string[] = [];
  for (let d = since; d <= today; d = shiftDay(d, 1)) chartDays.push(d);
  const changes: ValueChange[] = [];
  for (let i = 1; i < dayHoldings.length; i++) changes.push(decomposeChange(dayHoldings[i - 1], dayHoldings[i], priceAt));

  const squads: FcoClubSquad[] = [];
  if (latest) {
    const totals = await db()<{ team_type: number; slot: number; total_price: string; coach_id: string | null }[]>`
      SELECT team_type, slot, total_price::text, coach_id FROM fco_squad_snapshot
       WHERE snapshot_id = ${latest.id} ORDER BY team_type DESC, slot`;
    for (const t of totals) {
      squads.push({
        label: squadLabel(t.team_type, t.slot), total_price: Number(t.total_price), coach_id: t.coach_id,
        players: latestRows.filter((p) => p.teamType === t.team_type && p.slot === t.slot),
      });
    }
  }
  const person = accounts[0];
  return {
    id: person.id, slug: person.slug, name: person.name, image: person.image, channel_id: person.channel_id,
    account: best.summary,
    others: summaries.filter((s) => s !== best).map((s) => s.summary),
    holdings, squads,
    // 시세를 아직 못 받은 날(카드 하나도 평가 못 함)은 0원 점이 아니라 점이 없다.
    actual: holdingsSeries(dayHoldings, priceAt).filter((p) => p.priced > 0),
    backcast: backcastSeries(holdings.map((c) => ({ spid: c.spid, grade: c.grade })), chartDays, priceAt),
    changes,
    cardSeries: Object.fromEntries(holdings.filter((c) => cardSeries[cardKey(c)]).map((c) => [cardKey(c), cardSeries[cardKey(c)]])),
  };
}

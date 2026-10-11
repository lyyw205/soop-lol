/**
 * **경기 검수 화면의 시리즈 칸** — 지금 경기가 속한 시리즈의 세트 전부, 또는 (시리즈 미지정이면) 묶을 후보.
 *
 * ★ 왜(2026-10-12): 경기 화면을 경기 하나 기준으로 바꾸자 검수하면서 시리즈(세트 순서·스코어·팀 구성 변화)를
 *   볼 길이 없어졌다. 판정은 시리즈 비교 화면과 같은 metrics/series-check.ts 하나다.
 * ★ 묶기는 사람의 검수 저장 경로(applyMatchReviewInTx) 그대로다 — 수정 이력·대회 소속 검사(시리즈와 경기의
 *   대회가 다르면 거부)·형식(best_of) 보호가 같이 따라온다. 세트 번호는 경기 시각 순서로 정하되, 기존 세트 사이에
 *   끼면 번호를 지어내지 않고 거부한다. 순서를 출처에서 확인한 게 아니므로 set_order_known 은 올리지 않는다.
 */
import type postgres from "postgres";

import { db } from "./client.ts";
import { applyMatchReviewInTx } from "./ck.ts";
import { rosterKey, sharedPlayers, type SeriesSetInput } from "../metrics/series-check.ts";

type Tx = postgres.TransactionSql;

export interface SeriesContextSet extends SeriesSetInput {
  series_id: string | null;
  set_role: string;
  set_label: string | null;
  best_of: number | null;
  set_order_known: boolean;
  completed: boolean;
  visibility: string;
}

export interface MatchSeriesContext {
  series: { id: string; best_of: number | null; best_of_evidence: string | null; set_order_known: boolean; round_label: string | null } | null;
  /** 시리즈의 세트 전부(목록과 같은 순서). 시리즈 미지정이면 지금 경기 하나. */
  sets: SeriesContextSet[];
  /** 시리즈 미지정일 때만 — 같은 대회의 앞뒤 경기(시각 순)와 함께 나온 사람 수. */
  candidates: Array<SeriesContextSet & { shared: number }>;
}

/** 시리즈 미지정 경기의 후보를 찾는 시간 범위와 개수. */
const CANDIDATE_WINDOW_HOURS = 12;
const CANDIDATE_LIMIT = 8;

interface Row extends Omit<SeriesContextSet, "game_creation_epoch_ms" | "participants"> {
  game_creation: Date;
  event_id: string | null;
  participants: Array<{ participant_id: number; team_id: number; streamer_slug: string | null; observed_name: string | null; name: string | null }>;
}

const SET_COLUMNS = `
  m.match_id, m.series_id, m.series_game_no, m.set_role, m.set_label, m.game_creation, m.game_creation_precision, m.winning_team,
  m.review_completed_at IS NOT NULL AS completed, m.visibility, bt.name AS blue_team, rt.name AS red_team,
  ms.best_of, COALESCE(ms.set_order_known, false) AS set_order_known, COALESCE(ms.event_id, m.event_id) AS event_id,
  COALESCE((SELECT json_agg(json_build_object(
      'participant_id', mp.participant_id, 'team_id', mp.team_id, 'streamer_slug', s.slug, 'observed_name', mp.observed_name,
      'name', COALESCE(s.display_name, mp.observed_name, ra.game_name)) ORDER BY mp.participant_id)
     FROM match_participant mp
     LEFT JOIN LATERAL (SELECT sa.streamer_id FROM streamer_account sa WHERE sa.puuid = mp.puuid AND sa.active_to IS NULL LIMIT 1) acc ON true
     LEFT JOIN streamer s ON s.id = COALESCE(acc.streamer_id, mp.streamer_id)
     LEFT JOIN riot_account ra ON ra.puuid = mp.puuid
    WHERE mp.match_id = m.match_id), '[]'::json) AS participants`;
const SET_FROM = `
  FROM match m
  LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
  LEFT JOIN event_team bt ON bt.id = m.blue_team_id
  LEFT JOIN event_team rt ON rt.id = m.red_team_id`;

const toSet = (r: Row): SeriesContextSet => ({
  match_id: r.match_id, series_id: r.series_id, series_game_no: r.series_game_no, set_role: r.set_role, set_label: r.set_label,
  game_creation_epoch_ms: r.game_creation.getTime(), game_creation_precision: r.game_creation_precision, winning_team: r.winning_team,
  blue_team: r.blue_team, red_team: r.red_team, best_of: r.best_of, set_order_known: r.set_order_known,
  completed: r.completed, visibility: r.visibility,
  participants: r.participants.map((p) => ({ participant_id: p.participant_id, team_id: p.team_id, key: rosterKey(p), name: p.name ?? "?" })),
});

export async function getMatchSeriesContext(matchId: string): Promise<MatchSeriesContext | null> {
  const sql = db();
  const [current] = await sql<Row[]>`SELECT ${sql.unsafe(SET_COLUMNS)} ${sql.unsafe(SET_FROM)} WHERE m.match_id = ${matchId}`;
  if (!current) return null;
  if (current.series_id) {
    const [series] = await sql<NonNullable<MatchSeriesContext["series"]>[]>`
      SELECT id, best_of, best_of_evidence, set_order_known, round_label FROM match_series WHERE id = ${current.series_id} AND game_code = 'lol'`;
    const sets = await sql<Row[]>`
      SELECT ${sql.unsafe(SET_COLUMNS)} ${sql.unsafe(SET_FROM)}
       WHERE m.game_code = 'lol' AND m.series_id = ${current.series_id}
       ORDER BY m.series_game_no NULLS LAST, m.game_creation, m.match_id`;
    return { series: series ?? null, sets: sets.map(toSet), candidates: [] };
  }
  const rows = await sql<Row[]>`
    SELECT ${sql.unsafe(SET_COLUMNS)} ${sql.unsafe(SET_FROM)}
     WHERE m.game_code = 'lol' AND m.source = 'manual' AND m.visibility = 'public' AND m.match_id <> ${matchId}
       AND COALESCE(ms.event_id, m.event_id) IS NOT DISTINCT FROM ${current.event_id}::uuid
       AND abs(extract(epoch FROM m.game_creation - ${current.game_creation}::timestamptz)) <= ${CANDIDATE_WINDOW_HOURS * 3600}
     ORDER BY abs(extract(epoch FROM m.game_creation - ${current.game_creation}::timestamptz)), m.match_id
     LIMIT ${CANDIDATE_LIMIT}`;
  const self = toSet(current);
  const candidates = rows.map((r) => ({ ...toSet(r), shared: sharedPlayers(self.participants, toSet(r).participants) }))
    .sort((a, b) => a.game_creation_epoch_ms - b.game_creation_epoch_ms || a.match_id.localeCompare(b.match_id));
  return { series: null, sets: [self], candidates };
}

export type SeriesAssignInput = { match_id: string } & ({ join_series: string } | { pair_with: string });

/**
 * 시리즈 미지정 경기를 묶는다. 한 트랜잭션이다.
 * - join_series: 기존 시리즈에 넣는다. 세트 번호 = 그 시리즈에서 이 경기보다 먼저 시작한 본게임 수 + 1.
 *   그 번호에 이미 세트가 있으면(기존 세트 사이에 낀다) 번호를 지어내지 않고 거부한다.
 * - pair_with: 다른 시리즈 미지정 경기와 새 시리즈로 묶는다(먼저 시작한 쪽이 1). 키는 `series:<앞 경기 ID>`.
 */
export async function assignMatchSeries(input: SeriesAssignInput): Promise<{ series_id: string; series_game_no: number }> {
  return db().begin(async (tx) => {
    const lock = async (id: string) => {
      const [row] = await tx<{ match_id: string; series_id: string | null; series_game_no: number | null; game_creation: Date; event_id: string | null }[]>`
        SELECT m.match_id, m.series_id, m.series_game_no, m.game_creation, m.event_id
          FROM match m WHERE m.match_id = ${id} AND m.game_code = 'lol' FOR UPDATE`;
      if (!row) throw new Error(`경기가 없다: ${id}`);
      if (row.series_id) throw new Error(`${id} 는 이미 시리즈(${row.series_id})에 속해 있다 — 옮기려면 경기 정보에서 시리즈 키를 먼저 고친다.`);
      return row;
    };
    const put = (tx2: Tx, row: { match_id: string; series_game_no: number | null }, series_id: string, no: number) =>
      applyMatchReviewInTx(tx2, row.match_id, { match: {
        changes: { series_id, series_game_no: no },
        expect: { series_id: null, series_game_no: row.series_game_no },
      } });
    if ("join_series" in input) {
      const match = await lock(input.match_id);
      const sets = await tx<{ match_id: string; series_game_no: number | null; game_creation: Date; set_role: string }[]>`
        SELECT match_id, series_game_no, game_creation, set_role FROM match
         WHERE series_id = ${input.join_series} AND game_code = 'lol' FOR UPDATE`;
      if (sets.length === 0) throw new Error(`없는 시리즈다: ${input.join_series}`);
      const main = sets.filter((s) => s.set_role !== "bonus");
      const no = 1 + main.filter((s) => s.game_creation.getTime() < match.game_creation.getTime()).length;
      if (main.some((s) => s.series_game_no === no)) {
        throw new Error(`이 경기는 시각상 ${no}세트 자리인데 그 번호에 이미 세트가 있다 — 기존 세트 번호를 먼저 정리한다.`);
      }
      await put(tx, match, input.join_series, no);
      return { series_id: input.join_series, series_game_no: no };
    }
    // 두 경기를 같은 순서로 잠근다(교착 방지).
    const [first, second] = [input.match_id, input.pair_with].sort();
    const rows = [await lock(first), await lock(second)];
    if (rows[0].match_id === rows[1].match_id) throw new Error("같은 경기다.");
    const [early, late] = rows.sort((a, b) => a.game_creation.getTime() - b.game_creation.getTime() || a.match_id.localeCompare(b.match_id));
    let id = `series:${early.match_id}`;
    for (let n = 2; (await tx`SELECT 1 FROM match_series WHERE id = ${id}`).length > 0; n++) id = `series:${early.match_id}:${n}`;
    // 대회가 다르면 두 번째 저장에서 시리즈 대회 검사가 거부한다(시리즈는 대회 하나에 속한다).
    await put(tx, early, id, 1);
    await put(tx, late, id, 2);
    return { series_id: id, series_game_no: early.match_id === input.match_id ? 1 : 2 };
  }) as Promise<{ series_id: string; series_game_no: number }>;
}

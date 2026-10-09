/**
 * **이미 저장된 공개 수기 LoL 경기 중 같은 판으로 보이는 쌍** — 저장을 막지 않고 의심만 보여 준다.
 *
 * ★ 왜 조회 시점에 계산하나 (2026-10-09)
 *   저장 검사(`assertNotDuplicateGameInTx`)는 새 경기 ID 를 만들 때 한 번만 돈다. 그런데 먼저 저장된 쪽이
 *   이름만 있는 뼈대(KDA·챔피언·길이 비어 있음)였다가 나중에 자동 판독이 채운 경우, 저장 순간엔 비교할 값이
 *   없어 통과했다 — 확정 중복 14쌍 중 11쌍이 이 경우였다. 값이 바뀌는 쓰기 경로마다 재검사를 다는 대신
 *   지금 값으로 그때그때 계산한다. 경로를 하나 빠뜨려 다시 새는 일이 없다.
 * ★ 판정은 저장 검사와 같은 함수다(`metrics/ck-duplicate.ts` — 시간 범위·사람 대응·이름 무관 일치).
 * ★ 사람이 "다른 판" 이라고 확인한 쌍(`distinct_from`, review_change 에 남는다)은 다시 띄우지 않는다.
 * ★ 숨긴 경기는 보지 않는다 — 중복으로 정리된 쪽이다.
 */
import { db } from "./client.ts";
import {
  blindOverlap, duplicateParticipantCounts, isDuplicateGame, withinDuplicateWindow, type DuplicateParticipant,
} from "../metrics/ck-duplicate.ts";

export interface DuplicateSuspect {
  a: string;
  b: string;
  /** a 의 시작 시각(KST 표시는 화면이 한다). */
  played_at: Date;
  kda: number;
  champ: number;
  blind: number;
  duration_a: number | null;
  duration_b: number | null;
}

interface Row {
  match_id: string;
  game_duration: number | null;
  game_creation: Date;
  game_creation_precision: string;
  participants: DuplicateParticipant[];
}

/** 같은 날짜 판정이 24시간을 넘지 않으므로 그 안에서만 짝을 본다(시각 순서로 — 경기 ID 순서가 아니다). */
const PAIR_HORIZON_MS = 26 * 3600_000;

export async function listDuplicateSuspects(): Promise<DuplicateSuspect[]> {
  const sql = db();
  const rows = await sql<Row[]>`
    SELECT m.match_id, m.game_duration, m.game_creation, m.game_creation_precision,
           jsonb_agg(jsonb_build_object(
             'person_id', COALESCE(sa.streamer_id, p.streamer_id),
             'puuid', p.puuid, 'observed_name', p.observed_name,
             'win', CASE WHEN p.outcome IN ('win', 'loss') THEN p.outcome = 'win' ELSE NULL END,
             'champion_id', p.champion_id, 'kills', p.kills, 'deaths', p.deaths, 'assists', p.assists
           ) ORDER BY p.participant_id) AS participants
      FROM match m JOIN match_participant p ON p.match_id = m.match_id
      LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
     WHERE m.game_code = 'lol' AND m.source = 'manual' AND m.visibility = 'public'
     GROUP BY m.match_id, m.game_duration, m.game_creation, m.game_creation_precision
     ORDER BY m.game_creation, m.match_id`;
  const distinct = await sql<{ match_id: string; other: string }[]>`
    SELECT match_id, jsonb_array_elements_text(after) AS other
      FROM review_change WHERE field = 'distinct_from' AND jsonb_typeof(after) = 'array'`;
  const confirmedDifferent = new Set(distinct.flatMap((d) => [`${d.match_id}|${d.other}`, `${d.other}|${d.match_id}`]));
  const out: DuplicateSuspect[] = [];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      if (b.game_creation.getTime() - a.game_creation.getTime() > PAIR_HORIZON_MS) break;
      if (confirmedDifferent.has(`${a.match_id}|${b.match_id}`)) continue;
      if (!withinDuplicateWindow({ at: a.game_creation, precision: a.game_creation_precision },
        { at: b.game_creation, precision: b.game_creation_precision })) continue;
      const counts = { ...duplicateParticipantCounts(a.participants, b.participants), blind: blindOverlap(a.participants, b.participants) };
      if (!isDuplicateGame(a.game_duration, b.game_duration, counts)) continue;
      out.push({ a: a.match_id, b: b.match_id, played_at: a.game_creation, ...counts, duration_a: a.game_duration, duration_b: b.game_duration });
    }
  }
  return out;
}

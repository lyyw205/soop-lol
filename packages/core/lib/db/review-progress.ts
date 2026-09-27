/** 관리자 경기 목록과 상세가 같은 참가 자리 수를 센다. LoL 5 대 5의 분모는 항상 10. */
export interface ReviewProgress {
  participant_count: number;
  position_count: number;
  linked_count: number;
  champion_count: number;
  kda_count: number;
}

/** 외부 입력이 없는 SQL 조각. m은 match 별칭, rp는 경기당 정확히 한 행이다. */
export const REVIEW_PROGRESS_JOIN = `LEFT JOIN LATERAL (
  SELECT count(*)::int AS participant_count,
         count(*) FILTER (WHERE mp.team_position IN ('TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'))::int AS position_count,
         count(*) FILTER (WHERE mp.streamer_id IS NOT NULL OR EXISTS (
           SELECT 1 FROM streamer_account sa WHERE sa.puuid = mp.puuid AND sa.active_to IS NULL
         ))::int AS linked_count,
         count(*) FILTER (WHERE mp.champion_id > 0)::int AS champion_count,
         count(*) FILTER (WHERE mp.kills IS NOT NULL AND mp.deaths IS NOT NULL AND mp.assists IS NOT NULL)::int AS kda_count
    FROM match_participant mp WHERE mp.match_id = m.match_id
) rp ON true`;

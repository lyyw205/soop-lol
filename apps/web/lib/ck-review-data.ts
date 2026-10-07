import type { MatchDetail } from "@soop-lol/core/lib/db/ck";
import { toKstInputValue } from "@soop-lol/core/lib/time";
import type { ReviewMatch } from "@/components/admin/CkReviewer";

export const reviewMatchData: (detail: MatchDetail) => ReviewMatch = ({ match, participants }) => ({
    match_id: match.match_id,
    // 화면은 KST 벽시계로 쓴다 — datetime-local 왕복에서 값이 밀리지 않게(time.ts).
    game_creation: toKstInputValue(match.game_creation),
    game_creation_epoch_ms: match.game_creation.getTime(),
    game_duration: match.game_duration,
    winning_team: match.winning_team,
    visibility: match.visibility,
    review_completed_at: match.review_completed_at?.toISOString() ?? null,
    review_version: match.review_version,
    position_count: match.position_count,
    linked_count: match.linked_count,
    champion_count: match.champion_count,
    kda_count: match.kda_count,
    origin: match.origin,
    source: match.source,
    event_id: match.event_id,
    series_id: match.series_id,
    series_game_no: match.series_game_no,
    best_of: match.best_of,
    best_of_evidence: match.best_of_evidence,
    game_creation_precision: match.game_creation_precision,
    set_order_known: match.set_order_known,
    source_url: match.source_url,
    participants: participants.map((p) => ({
      participant_id: p.participant_id,
      puuid: p.puuid,
      streamer_id: p.streamer_id,
      account_streamer_id: p.account_streamer_id ?? null,
      riot_id: p.riot_id ?? null,
      observed_name: p.observed_name,
      team_id: p.team_id,
      team_position: p.team_position,
      champion_id: p.champion_id,
      champion_name: p.champion_name,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
    })),
  });

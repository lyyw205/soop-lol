-- 2026-10-13: 챔피언/개인/대회 맞라인이 encounter와 같은 포지션 규칙을 쓴다.
-- metrics/matchup.ts resolvePosition과 전 조합을 검증한다. 공개 신원 조건은 0069 그대로다.
CREATE FUNCTION core_public.resolve_position(team text, individual text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN upper(coalesce(team, '')) IN ('TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY')
    AND (coalesce(individual, '') = '' OR upper(individual) = upper(team))
    THEN upper(team) ELSE NULL END
$$;
CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.outcome,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges,
         CASE WHEN s.id IS NULL THEN mp.observed_name ELSE NULL END AS observed_name,
         mp.participant_id,
         mp.items,
         mp.summoner1_id,
         mp.summoner2_id,
         (mp.perks #>> '{styles,0,selections,0,perk}')::int AS keystone_id,
         (mp.perks #>> '{styles,1,style}')::int AS sub_style_id,
         mp.individual_position
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                        AND s.visibility = 'public'
   WHERE s.id IS NOT NULL
      OR (mp.puuid IS NULL AND mp.streamer_id IS NULL AND mp.observed_name IS NOT NULL);


-- 공개 계약에 "얼마나 확실한가" 두 칸을 내보낸다 (0035 의 후속).
--
-- ★ 왜: 0035 가 세트 순서 확인 여부(match_series.set_order_known)와 시각 정확도
--   (match.game_creation_precision)를 저장했지만, 공개 뷰가 그 값을 내보내지 않아
--   상대전적·개인 기록은 여전히 시드가 만든 순서를 "1세트·2세트" 로 단정하고 있었다.
--   화면 규칙(core 의 setLabel·kstPlayedAt)만 고쳐서는 안 되고 조회 → 계약 → 표시가
--   이어져야 한다. 기존 컬럼 순서는 그대로 두고 뒤에만 붙인다(CREATE OR REPLACE 규칙).

CREATE OR REPLACE VIEW core_public.match AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source,
         COALESCE(ms.event_id, m.event_id) AS event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id,
           (SELECT kind FROM event WHERE event.id = COALESCE(ms.event_id, m.event_id))) AS category,
         ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM match m
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_outcome, se.b_outcome, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no, se.category, ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

COMMENT ON COLUMN core_public.streamer_encounter.set_order_known IS
  '세트 순서를 출처에서 확인했나. false 면 화면은 "N세트" 로 단정하지 않는다(core setLabel).';
COMMENT ON COLUMN core_public.streamer_encounter.game_creation_precision IS
  '''date'' 면 시각은 모른다 — 날짜만 보여준다(core kstPlayedAt).';

-- 0035 는 VOD 판독 경기만으로 된 시리즈를 "순서 확인됨" 으로 자동 채웠다. VOD 에서 찾았다는
-- 이유만으로 순서를 확인했다고 볼 수 없다 — 조사 결과(set_order_known)나 검수에서 사람이
-- 명시한 경우에만 참이어야 한다. 이 시점의 참은 전부 그 자동 판정이라 되돌린다.
UPDATE match_series SET set_order_known = false, updated_at = now() WHERE set_order_known;

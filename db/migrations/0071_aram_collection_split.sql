-- 2026-10-04: 칼바람 내전도 수집하되 소환사의 협곡 전적·CK·대회 집계와 분리한다.
-- 경기 mode는 화면으로 확인한 사실이다. 과거 CUSTOM 기록을 이름으로 추측해 바꾸지 않는다.
-- 기존 3인자 함수는 구형 호출의 호환 경로이고 새 쓰기/공개 뷰는 4인자를 쓴다.
CREATE FUNCTION lol_match_category(p_source text, p_queue_id integer, p_event_kind text, p_game_mode text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog, public AS $$
  SELECT CASE WHEN p_game_mode='ARAM' THEN
    CASE WHEN p_source='public_queue' THEN 'aram' ELSE 'aram_custom' END
    ELSE lol_match_category(p_source,p_queue_id,p_event_kind) END
$$;

-- 모든 모드의 공개 사실. 향후 칼바람 모듈도 이 공개 경계만 사용한다.
CREATE VIEW core_public.lol_match_all_modes AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source,
         COALESCE(ms.event_id, m.event_id) AS event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id,
           (SELECT kind FROM event WHERE event.id = COALESCE(ms.event_id, m.event_id)), m.game_mode) AS category,
         ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM match m
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

-- 기존 모듈의 모든 경기/기본 조회에도 칼바람이 섞이지 않는 구조적 경계.
CREATE OR REPLACE VIEW core_public.match AS
 SELECT * FROM core_public.lol_match_all_modes WHERE category NOT IN ('aram','aram_custom');
CREATE VIEW core_public.aram_match AS
 SELECT * FROM core_public.lol_match_all_modes WHERE category IN ('aram','aram_custom');

CREATE VIEW core_public.lol_encounter_all_modes AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_outcome, se.b_outcome, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no, lol_match_category(m.source,m.queue_id,
           (SELECT kind FROM event WHERE id=COALESCE(ms.event_id,m.event_id)),m.game_mode) AS category, ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';
CREATE OR REPLACE VIEW core_public.streamer_encounter AS
 SELECT * FROM core_public.lol_encounter_all_modes WHERE category NOT IN ('aram','aram_custom');
CREATE VIEW core_public.aram_encounter AS
 SELECT * FROM core_public.lol_encounter_all_modes WHERE category IN ('aram','aram_custom');

UPDATE streamer_encounter se SET category=pm.category
 FROM core_public.lol_match_all_modes pm WHERE pm.match_id=se.match_id;

-- 저장된 챔피언 집계를 새 분류로 재계산한다. 기존 집계 행의 category만 바꾸면 혼합/PK 충돌이 생긴다.
DELETE FROM champion_stat;
INSERT INTO champion_stat
        (streamer_id, champion_id, queue_id, season, games, wins, kills, deaths, assists, cs,
         seconds_played, category, kda_games)
      SELECT sid.streamer_id, mp.champion_id, m.queue_id, s.season,
             count(*)::int                             AS games,
             count(*) FILTER (WHERE mp.outcome = 'win')::int AS wins,
             -- ★★ 분자와 분모가 **같은 판을 센다.** 셋을 다 읽은 판만 더한다.
             --   왜 sum() 에 FILTER 를 거나 — sum 은 NULL 을 건너뛰고 coalesce 가 0 을
             --   씌우므로, kills=5 · deaths=NULL · assists=NULL 한 판이 **5/0/0** 이 된다.
             --   "모른다" 가 "안 죽었다" 로 바뀌는 것이고, 그건 숫자로 거짓말하는 것이다
             --   (CLAUDE.md 3). 분모만 고치면 더 나쁘다 — 분모 0 에 분자 5 가 남는다.
             coalesce(sum(mp.kills)    FILTER (WHERE kda.all_read), 0)::int AS kills,
             coalesce(sum(mp.deaths)   FILTER (WHERE kda.all_read), 0)::int AS deaths,
             coalesce(sum(mp.assists)  FILTER (WHERE kda.all_read), 0)::int AS assists,
             coalesce(sum(mp.cs), 0)::bigint           AS cs,
             coalesce(sum(m.game_duration), 0)::bigint AS seconds_played,
             lol_match_category(m.source, m.queue_id, ev.kind, m.game_mode)  AS category,
             -- ★ 평균의 분모. games 로 나누면 못 읽은 판이 분모에만 남아 평균이 묽어진다
             --   (0020 ⑧). 결과 화면은 셋을 같이 주거나 안 주므로 손실은 거의 없고,
             --   부분 판독(툴팁 가림 등)은 **읽은 것으로 치지 않는다.**
             count(*) FILTER (WHERE kda.all_read)::int     AS kda_games
        FROM match_participant mp
        -- ★ 검수에서 뺀 경기와 다른 게임은 통계에도 없어야 한다. champion_stat 은 뷰가
        --   아니라 core_public 의 visibility/game_code 필터가 여기까지 오지 않는다 (0020·0026).
        JOIN match m             ON m.match_id = mp.match_id
                                AND m.visibility = 'public'
                                AND m.game_code = 'lol'
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
        LEFT JOIN event ev       ON ev.id = COALESCE(ms.event_id, m.event_id)
        -- ★ 계정이 붙었으면 매핑으로, 아니면 참가자 행에 적힌 사람으로.
        --   계정 없는 참가자를 빼면 그 사람의 모스트 챔피언이 통째로 빈다(0017).
        LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
        JOIN LATERAL (SELECT COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id) sid ON true
        -- 「이 판의 KDA 를 다 읽었나」. 분자와 분모가 이 하나를 같이 본다.
        CROSS JOIN LATERAL (
          SELECT (mp.kills IS NOT NULL AND mp.deaths IS NOT NULL AND mp.assists IS NOT NULL) AS all_read
        ) kda
        -- KST 고정 오프셋(+9h). tzdata 에 의존하지 않는다 — core 의 kstYear 와 같은 규칙.
        CROSS JOIN LATERAL (
          VALUES ('ALL'), (to_char(m.game_creation + interval '9 hours', 'YYYY'))
        ) AS s(season)
        -- ★ champion_id 0 은 챔피언이 아니라 **'모른다'** 다. 수기 대회 경기는
        --   누가 어느 팀으로 이겼는지는 근거가 있어도 챔피언까진 없을 때가 많고,
        --   saveTournamentGame 이 그런 참가자를 0 으로 넣는다(없는 값을 지어내지 않는다).
        --   거르지 않으면 모스트 챔피언 1위가 '알 수 없는 챔피언'이 되어 버린다.
       WHERE mp.champion_id > 0 AND sid.streamer_id IS NOT NULL
         -- 범위 재계산일 때는 지운 사람만 다시 넣는다. 위 DELETE 와 같은 조건이어야 한다.

       -- ⚠ 위치 번호다: 1=streamer_id 2=champion_id 3=queue_id 4=season **12=category**.
       --   ★ 이 다섯이 champion_stat 의 PK 와 **정확히 같아야** INSERT 가 자기와 충돌하지
       --     않는다(0016 이 category 를 여기 넣고 PK 엔 안 넣어서 실제로 터졌다 — 0020 ⑦).
       --   SELECT 목록에 컬럼을 끼워 넣으면 번호가 밀린다. 넣을 땐 **맨 뒤에** 넣을 것.
       GROUP BY 1, 2, 3, 4, 12;

CREATE VIEW core_public.lol_champion_stat_all_modes AS
  SELECT cs.streamer_id, cs.champion_id, cs.queue_id, cs.season,
         cs.games, cs.wins, cs.kills, cs.deaths, cs.assists, cs.cs, cs.seconds_played,
         cs.computed_at, cs.category,
         cs.kda_games
    FROM champion_stat cs
    JOIN streamer s ON s.id = cs.streamer_id AND s.visibility = 'public';
CREATE OR REPLACE VIEW core_public.champion_stat AS
 SELECT * FROM core_public.lol_champion_stat_all_modes WHERE category NOT IN ('aram','aram_custom');
CREATE VIEW core_public.aram_champion_stat AS
 SELECT * FROM core_public.lol_champion_stat_all_modes WHERE category IN ('aram','aram_custom');

COMMENT ON VIEW core_public.aram_match IS '칼바람 나락 공개 경기. 일반 CK/대회/협곡 전적과 별도 조회한다.';

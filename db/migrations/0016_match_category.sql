-- 경기 분류 — "어떤 맥락에서 붙었나". 화면 필터(전체 / 솔로랭크 / 내전 / 대회 …)의 기준.
--
-- 왜 `source` 하나로 안 되나: source 는 **어떻게 알게 됐나**를 말하지 무슨 판이었나를
-- 말하지 않는다. 실제 분포가 이렇다 —
--     manual q=0 event.kind='tournament'  776건   (멸망전 같은 공식 대회)
--     manual q=0 event.kind='scrim'         5건   (내전 CK)
-- 둘 다 source='manual' 이라 source 로는 못 가른다. source·queue_id·event.kind 를 같이 본다.
--
-- ★ 규칙은 packages/core 의 matchCategory() 와 **같은 모양**이어야 한다.
--   질의에서 걸러야 빠르고 화면에서 이름을 붙이려면 TS 가 필요해서 양쪽에 둔다.
--   어긋나면 필터가 조용히 거짓말을 하므로 verify:db 가 전 조합을 대조한다
--   (lol_lp_absolute 를 같은 방식으로 묶어 뒀다).

CREATE OR REPLACE FUNCTION lol_match_category(
  p_source text, p_queue_id integer, p_event_kind text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
-- ★ search_path 고정 (마이그레이션 0003 과 같은 이유 — 함수 안에서 이름을 찾을 때
--   호출자의 search_path 를 따라가면 남이 심어 둔 객체를 볼 수 있다)
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    -- 대회가 붙어 있으면 그게 가장 확실한 근거다 (사람이 판단해 넣은 값)
    WHEN p_event_kind = 'scrim'                          THEN 'scrim'
    WHEN p_event_kind IN ('tournament', 'showmatch')     THEN 'tournament'
    WHEN p_source = 'public_queue' THEN CASE p_queue_id
      WHEN 420 THEN 'solo'
      WHEN 440 THEN 'flex'
      WHEN 450 THEN 'aram'
      WHEN 400 THEN 'normal'   -- 일반 드래프트
      WHEN 430 THEN 'normal'   -- 일반 블라인드
      WHEN 490 THEN 'normal'   -- 빠른 대전
      WHEN 700 THEN 'clash'
      -- 모르는 큐를 임의로 '일반' 에 넣지 않는다. other 로 모여 눈에 띄어야 한다.
      ELSE 'other'
    END
    -- 코드로 만든 커스텀인데 대회가 안 붙었다 → 아직 이름을 못 붙인 내전
    -- (토너먼트 코드는 애초에 내전을 API 로 잡으려고 쓰는 물건이다. CLAUDE.md 제약 1)
    WHEN p_source = 'tournament_code'                    THEN 'scrim'
    -- 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
    ELSE 'other'
  END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text) IS
  '경기 분류 (solo/flex/aram/normal/clash/scrim/tournament/other). '
  'packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다.';

-- ── 파생 테이블에 비정규화 ──────────────────────────────────────────
--
-- ★ 왜 컬럼으로 두나
--   조우·챔피언 집계는 필터가 걸린 채로 자주 읽힌다. 매번 match·event 를 조인하면
--   "이 사람의 내전 상대전적" 같은 질의가 통째로 느려진다. 이미 source·queue_id 를
--   같은 이유로 비정규화해 뒀다.
--
-- ★ 언제나 재계산 가능하다 (§11-5)
--   원본은 match 다. rederiveEncounters / recomputeChampionStats 가 다시 채운다.
--   그래서 NOT NULL 로 걸지 않는다 — 재파생 전의 낡은 행이 있을 수 있고,
--   그걸 막으면 마이그레이션이 배포를 세운다.

ALTER TABLE streamer_encounter ADD COLUMN category text;
ALTER TABLE champion_stat      ADD COLUMN category text;

-- 지금 있는 행을 즉시 채운다. 재파생을 기다리면 그 사이 화면이 빈다.
UPDATE streamer_encounter e
   SET category = lol_match_category(m.source, m.queue_id, ev.kind)
  FROM match m LEFT JOIN event ev ON ev.id = m.event_id
 WHERE m.match_id = e.match_id;

UPDATE champion_stat cs
   SET category = sub.category
  FROM (
    SELECT sa.streamer_id, mp.champion_id, m.queue_id,
           lol_match_category(m.source, m.queue_id, ev.kind) AS category
      FROM match_participant mp
      JOIN match m             ON m.match_id = mp.match_id
      LEFT JOIN event ev       ON ev.id = m.event_id
      JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
     GROUP BY 1, 2, 3, 4
  ) sub
 WHERE sub.streamer_id = cs.streamer_id AND sub.champion_id = cs.champion_id
   AND sub.queue_id = cs.queue_id;

-- 필터가 걸린 조회를 위한 인덱스. 조우는 "누구의" 가 항상 앞에 온다.
CREATE INDEX enc_a_category_idx ON streamer_encounter (streamer_a_id, category, game_creation DESC);
CREATE INDEX enc_b_category_idx ON streamer_encounter (streamer_b_id, category, game_creation DESC);

-- ── core_public 갱신 ────────────────────────────────────────────────
-- 공개 화면이 필터를 걸 수 있어야 한다. CREATE OR REPLACE VIEW 는 기존 컬럼 순서를
-- 유지하고 **뒤에 덧붙일 때만** 통한다.

-- ★ CREATE OR REPLACE VIEW 는 **기존 컬럼을 그대로 두고 뒤에 덧붙일 때만** 통한다.
--   순서를 바꾸거나 하나라도 빠뜨리면 "cannot drop columns from view" 로 막힌다.
--   그래서 현재 컬럼을 한 자도 안 건드리고 category 만 끝에 붙인다.

CREATE OR REPLACE VIEW core_public.match AS
  SELECT match_id, queue_id, game_mode, game_version, game_creation, game_duration,
         winning_team, ended_in_surrender, source, event_id,
         series_id, series_game_no, blue_team_id, red_team_id,
         lol_match_category(source, queue_id,
           (SELECT kind FROM event WHERE event.id = match.event_id)) AS category
    FROM match;

-- ⚠ 여기서 **숨김 조인을 반드시 다시 쓴다.** core_public 은 보안 경계다(계약 5조).
--   뷰를 다시 정의하면서 `JOIN streamer … visibility='public'` 을 빼면
--   삭제 요청으로 숨긴 스트리머가 그대로 새어 나간다. 실제로 한 번 빠뜨렸고
--   verify:db 의 '한쪽이라도 숨겨지면 조우가 사라진다' 가 잡아냈다.
CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no,
         se.category
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

CREATE OR REPLACE VIEW core_public.champion_stat AS
  SELECT cs.streamer_id, cs.champion_id, cs.queue_id, cs.season,
         cs.games, cs.wins, cs.kills, cs.deaths, cs.assists, cs.cs, cs.seconds_played,
         cs.computed_at, cs.category
    FROM champion_stat cs
    JOIN streamer s ON s.id = cs.streamer_id AND s.visibility = 'public';

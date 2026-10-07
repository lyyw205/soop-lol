-- 0079 — 랜드와 보너스판(범인찾기)을 구조로 표현한다 · 신속 대전은 일반이다 (2026-10-07 운영자 결정).
--
-- 진행 방식의 정의는 docs/CK-COLLECTION.md §3.5 다. 지금까지는 문서에만 있고 스키마엔 없어서,
-- 랜드 한 판 한 판과 CK 뒤의 범인찾기가 전부 "단판 CK/기타" 로 히스토리 한 줄씩을 차지하고
-- 범인찾기는 CK 승률·상대전적에 그대로 섞였다.
--
-- ① event.kind 'land' — 정해진 인원이 맞라인을 정하고 **매 판 팀을 섞어** 돌리는 판.
--    분류(category)는 'land'. 칼바람으로 한 랜드는 맵이 먼저라 칼바람(aram_custom)이다.
--    한 랜드 이벤트의 판들은 match_series 하나로 묶는다 — **히스토리 화면의 묶음일 뿐이다.**
--    팀이 매 판 바뀌므로 묶음 단위 승패(3:2 승)는 뜻이 없다. 그래서 공개 조우 뷰는 랜드의
--    series_key 를 판(match_id)으로 내보낸다 — 상대전적의 "매치" 는 랜드에서 언제나 한 판이다.
--
-- ② match.set_role 'bonus' — 본게임(CK·이벤트전)이 끝난 뒤 재미로 하는 추가 판(범인찾기·미드
--    바꿔서 단판…). 앞 시리즈에 붙어 히스토리에서 같이 펼쳐지지만 **어떤 집계에도 들어가지 않는다.**
--    공개 경기·조우·챔피언 통계(core_public.match / streamer_encounter / champion_stat)는 본게임만 낸다.
--    히스토리는 보너스까지 보여 주는 core_public.match_with_bonus 를 쓴다.
--    보너스는 언제나 어떤 시리즈에 붙어 있다(제약). 붙일 본게임이 없으면 보너스로 표시하지 않는다.
--
-- ③ 신속 대전(Swiftplay, 480) — 협곡 일반 게임이다. 'other' → 'normal'.
--
-- ★ packages/core/lib/metrics/category.ts 와 같은 규칙이어야 한다(verify:db 가 전 조합 대조).
-- ★ SET search_path 를 달지 않는다 — 달면 inline 이 막힌다(0075).

-- ── ③ + ① 분류 함수 ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION lol_match_category(
  p_source text, p_queue_id integer, p_event_kind text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    -- 대회가 붙어 있으면 그게 가장 확실한 근거다 (사람이 판단해 넣은 값)
    WHEN p_event_kind = 'ck'                             THEN 'ck'
    WHEN p_event_kind = 'land'                           THEN 'land'
    WHEN p_event_kind = 'scrim'                          THEN 'scrim'
    WHEN p_event_kind IN ('tournament', 'showmatch')     THEN 'tournament'
    WHEN p_source = 'public_queue' THEN CASE p_queue_id
      WHEN 420 THEN 'solo'
      WHEN 440 THEN 'flex'
      WHEN 450 THEN 'aram'
      WHEN 400 THEN 'normal'   -- 일반 드래프트
      WHEN 430 THEN 'normal'   -- 일반 블라인드
      WHEN 480 THEN 'normal'   -- 신속 대전(Swiftplay) — 협곡 일반 게임(0079)
      WHEN 490 THEN 'normal'   -- 빠른 대전
      WHEN 700 THEN 'clash'
      -- 모르는 큐를 임의로 '일반' 에 넣지 않는다. other 로 모여 눈에 띄어야 한다.
      ELSE 'other'
    END
    -- 코드로 만든 커스텀인데 대회가 안 붙었다 → 무슨 판인지 모르는 코드 내전. CK 로 단정하지 않는다.
    WHEN p_source = 'tournament_code'                    THEN 'code_custom'
    -- 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
    ELSE 'other'
  END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text) IS
  '경기 분류 (solo/flex/aram/normal/clash/ck/land/code_custom/scrim/tournament/other). '
  'packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다. '
  'SET search_path 를 달지 않는다 — 달면 inline 이 막혀 공개 뷰가 행마다 함수를 부른다(0075).';

-- ── ① event.kind 'land' ────────────────────────────────────────────
ALTER TABLE event DROP CONSTRAINT event_kind_check;
ALTER TABLE event ADD CONSTRAINT event_kind_check
  CHECK (kind IN ('ck','land','scrim','tournament','showmatch','other'));
COMMENT ON COLUMN event.kind IS
  'ck=승패·보상이 걸린 스트리머 매치(내전, 팀 고정 다전제), land=맞라인을 정하고 매 판 팀을 섞는 랜드(0079), '
  'scrim=대회 준비 연습게임, tournament=공식 대회, showmatch=이벤트전, other=그 외.';

-- ── ② match.set_role ───────────────────────────────────────────────
ALTER TABLE match ADD COLUMN set_role text NOT NULL DEFAULT 'main'
  CONSTRAINT match_set_role_check CHECK (set_role IN ('main', 'bonus'));
ALTER TABLE match ADD COLUMN set_label text;
ALTER TABLE match ADD CONSTRAINT match_bonus_in_series
  CHECK (set_role = 'main' OR series_id IS NOT NULL);
ALTER TABLE match ADD CONSTRAINT match_set_label_only_bonus
  CHECK (set_label IS NULL OR set_role = 'bonus');
COMMENT ON COLUMN match.set_role IS
  'main=본게임, bonus=본게임이 끝난 뒤의 추가 판(범인찾기 등). bonus 는 앞 시리즈에 붙고 어떤 집계에도 들어가지 않는다(0079).';
COMMENT ON COLUMN match.set_label IS
  '보너스 판을 방송에서 부른 이름(범인찾기·미드 바꿔서 단판…). 모르면 NULL — 화면은 "보너스" 로 쓴다.';

-- ── 공개 뷰 ─────────────────────────────────────────────────────────
-- 기존 칸은 이름·순서·형을 그대로 두고 set_role·set_label 만 끝에 붙인다.
CREATE OR REPLACE VIEW core_public.lol_match_all_modes AS
  SELECT m.match_id, m.queue_id, m.game_mode, m.game_version, m.game_creation, m.game_duration,
         m.winning_team, m.ended_in_surrender, m.source,
         COALESCE(ms.event_id, m.event_id) AS event_id,
         m.series_id, m.series_game_no, m.blue_team_id, m.red_team_id,
         lol_match_category(m.source, m.queue_id, ev.kind, m.game_mode) AS category,
         ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision,
         m.set_role, m.set_label
    FROM match m
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
   WHERE m.visibility = 'public' AND m.game_code = 'lol';

-- ★ 랜드의 series_key 는 판 자신이다 — 묶음은 히스토리 화면용이고, 상대전적의 매치 단위는 판이다.
CREATE OR REPLACE VIEW core_public.lol_encounter_all_modes AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_outcome, se.b_outcome, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         CASE WHEN ev.kind = 'land' THEN se.match_id ELSE COALESCE(m.series_id, se.match_id) END AS series_key,
         m.series_game_no, lol_match_category(m.source, m.queue_id, ev.kind, m.game_mode) AS category, ms.best_of,
         COALESCE(ms.set_order_known, false) AS set_order_known,
         m.game_creation_precision,
         m.set_role
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

-- 집계용 공개 뷰는 본게임만. 보너스는 히스토리(match_with_bonus)에서만 보인다.
CREATE OR REPLACE VIEW core_public.match AS
 SELECT * FROM core_public.lol_match_all_modes
  WHERE category NOT IN ('aram', 'aram_custom', 'excluded') AND set_role = 'main';
CREATE OR REPLACE VIEW core_public.aram_match AS
 SELECT * FROM core_public.lol_match_all_modes
  WHERE category IN ('aram', 'aram_custom') AND set_role = 'main';
CREATE VIEW core_public.match_with_bonus AS
 SELECT * FROM core_public.lol_match_all_modes WHERE category NOT IN ('aram', 'aram_custom', 'excluded');
COMMENT ON VIEW core_public.match_with_bonus IS
  '협곡 공개 경기 + 보너스 판. **히스토리 표시 전용** — 승패·승률을 셀 때는 core_public.match(본게임만)를 쓴다(0079).';

CREATE OR REPLACE VIEW core_public.streamer_encounter AS
 SELECT * FROM core_public.lol_encounter_all_modes
  WHERE category NOT IN ('aram', 'aram_custom', 'excluded') AND set_role = 'main';
CREATE OR REPLACE VIEW core_public.aram_encounter AS
 SELECT * FROM core_public.lol_encounter_all_modes
  WHERE category IN ('aram', 'aram_custom') AND set_role = 'main';

-- ── 데이터 이관 ─────────────────────────────────────────────────────
-- 경기 값(승패·참가자·시각)은 하나도 바뀌지 않는다 — 소속 묶음만 옮긴다. 그런데 match 의 검수 무효화
-- 트리거는 series_id·event_id 변경을 값 변경으로 본다. 이관 전 검수 완료를 잡아 두고 되돌린다
-- (참가자 일괄 수정이 442경기의 완료를 푼 사고와 같은 모양을 피한다).
CREATE TEMP TABLE _0079_review AS
  SELECT match_id, review_completed_at, review_version FROM match WHERE game_code = 'lol';

-- ① 랜드: 이름이 '랜드' 인 'other' 이벤트. (ck 로 분류된 랜드 이름 이벤트·'랜덤 내전' 은
--    사람이 다르게 판단했을 수 있어 건드리지 않는다 — 검수에서 바꾼다.)
UPDATE event SET kind = 'land'
 WHERE game_code = 'lol' AND kind = 'other' AND name LIKE '%랜드%';

INSERT INTO match_series (id, game_code, event_id, best_of, set_order_known)
SELECT ev.slug || ':land', 'lol', ev.id, NULL,
       bool_and(m.game_creation_precision = 'datetime')
  FROM event ev JOIN match m ON m.event_id = ev.id AND m.game_code = 'lol'
 WHERE ev.kind = 'land' AND m.series_id IS NULL
 GROUP BY ev.id, ev.slug;

UPDATE match m SET series_id = o.series_id, series_game_no = o.no, event_id = NULL
  FROM (SELECT m2.match_id, ev.slug || ':land' AS series_id,
               row_number() OVER (PARTITION BY ev.id ORDER BY m2.game_creation, m2.match_id)::int AS no
          FROM match m2 JOIN event ev ON ev.id = m2.event_id
         WHERE ev.kind = 'land' AND m2.series_id IS NULL AND m2.game_code = 'lol') o
 WHERE m.match_id = o.match_id;

-- ② 보너스: 수집 관례상 경기 키 끝이 bonus 인 판. 같은 이벤트에서 그 판보다 먼저 시작한
--    가장 늦은 시리즈에 붙인다. 붙일 시리즈가 없으면 그대로 둔다(본게임 없는 보너스는 만들지 않는다).
UPDATE match m SET series_id = o.series_id, series_game_no = o.no, event_id = NULL, set_role = 'bonus'
  FROM (
    SELECT b.match_id, p.series_id,
           (SELECT max(series_game_no) FROM match WHERE series_id = p.series_id)
             + row_number() OVER (PARTITION BY p.series_id ORDER BY b.game_creation, b.match_id)::int AS no
      FROM match b
      CROSS JOIN LATERAL (
        SELECT ms.id AS series_id
          FROM match_series ms JOIN match s ON s.series_id = ms.id
         WHERE ms.event_id = b.event_id AND ms.game_code = 'lol'
         GROUP BY ms.id
        HAVING min(s.game_creation) < b.game_creation
         ORDER BY min(s.game_creation) DESC LIMIT 1
      ) p
     WHERE b.game_code = 'lol' AND b.series_id IS NULL AND b.event_id IS NOT NULL
       AND b.match_id ~ '[-:]bonus[0-9]*$'
  ) o
 WHERE m.match_id = o.match_id;

UPDATE match m SET review_completed_at = k.review_completed_at, review_version = k.review_version
  FROM _0079_review k
 WHERE m.match_id = k.match_id
   AND (m.review_completed_at IS DISTINCT FROM k.review_completed_at OR m.review_version <> k.review_version);
DROP TABLE _0079_review;

-- 저장된 조우 분류를 새 함수로 다시 계산한다(뷰와 같은 함수). champion_stat 은 적용 뒤
-- recomputeChampionStats() 로 다시 만든다(분류가 PK 라 UPDATE 로 못 옮긴다 — 0077 과 같다).
UPDATE streamer_encounter se SET category = pm.category
  FROM core_public.lol_match_all_modes pm
 WHERE pm.match_id = se.match_id AND se.category IS DISTINCT FROM pm.category;

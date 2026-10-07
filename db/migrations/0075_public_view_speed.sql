-- 0075 — 공개 화면이 참가자 표를 통째로 훑어 프로필 한 탭이 20초를 넘겼다(2026-10-07 실측).
-- 값은 바꾸지 않는다.
--
-- 배경: match_participant 는 1.2GB(행 평균 3.1KB — Riot 공개 큐의 challenges JSON 이 2.2KB)이고
--       DB 캐시(shared_buffers)는 224MB 다. 한 번이라도 통째로 훑으면 디스크에서 읽어 30만 행에 20초가 든다.
--       공개 질의는 이 표를 **인덱스로만** 찾아야 한다.
--
-- ① lol_match_category — SET search_path 를 뺀다.
--    SET 절이 붙은 SQL 함수는 Postgres 가 질의 안에 펼치지(inline) 못해 **행마다 진짜 함수 호출**을 한다.
--    core_public.match 를 세는 데 3.0초(29,467행) → 펼치면 0.37초.
--    고정의 목적(0003: 호출자 search_path 가 다른 객체를 잡지 않게)은 그대로 지킨다 —
--    본문은 글자 비교뿐이고, 부르는 함수는 public. 으로 적었다. 이름으로 찾는 객체가 없다.
--
-- ② core_public.streamer_match — "이 사람이 나온 자리" 목록(사람 · 경기 · 자리 번호).
--    core_public.match_participant 의 streamer_id 는 COALESCE(계정의 사람, 행에 적힌 사람) 계산값이라
--    `streamer_id = $1` 이 어떤 인덱스로도 안 찾아진다(한 사람 534행 찾는 데 20.5초).
--    이 뷰는 같은 판정을 겹치지 않는 두 갈래로 나눠 각 갈래가 인덱스를 탄다(0.05초):
--      갈래 1: 활성 공개 계정이 붙은 자리 → 그 계정의 사람
--      갈래 2: 그런 계정이 없는 자리 → 행에 적힌 사람
--    (활성 계정은 puuid 당 하나 — streamer_account_one_owner_idx — 라 두 갈래는 겹치지 않는다.)
--    ★ 참가자 뷰 자체를 두 갈래로 바꾸지 않은 이유: UNION ALL 뷰에는 바깥 조인의 "이 경기" 조건이
--      갈래 안으로 내려가지 못해, 경기로 참가자를 찾는 질의(맞라인 상대·대회 명단)가 오히려 전체를 훑었다
--      (실측 13초 → 37초). 그래서 **사람으로 찾을 땐 이 뷰에서 출발해** 참가자 뷰를 (경기, 자리)로 붙인다.
--    0069 의 공개 판정(숨긴 경기·계정·사람)을 그대로 옮겼다 — 이 뷰의 행 = 참가자 뷰에서 streamer_id 가 있는 행.

CREATE OR REPLACE FUNCTION lol_match_category(
  p_source text, p_queue_id integer, p_event_kind text
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    -- 대회가 붙어 있으면 그게 가장 확실한 근거다 (사람이 판단해 넣은 값)
    WHEN p_event_kind = 'ck'                             THEN 'ck'
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
    -- 코드로 만든 커스텀인데 대회가 안 붙었다 → 아직 이름을 못 붙인 내전(CK).
    WHEN p_source = 'tournament_code'                    THEN 'ck'
    -- 수기인데 대회조차 없다. 무슨 판이었는지 근거가 없으므로 지어내지 않는다.
    ELSE 'other'
  END
$$;

CREATE OR REPLACE FUNCTION lol_match_category(p_source text, p_queue_id integer, p_event_kind text, p_game_mode text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_game_mode='ARAM' THEN
    CASE WHEN p_source='public_queue' THEN 'aram' ELSE 'aram_custom' END
    ELSE public.lol_match_category(p_source,p_queue_id,p_event_kind) END
$$;

COMMENT ON FUNCTION lol_match_category(text, integer, text) IS
  '경기 분류 (solo/flex/aram/normal/clash/ck/scrim/tournament/other). '
  'packages/core 의 matchCategory() 와 같은 규칙 — verify:db 가 전 조합을 대조한다. '
  'SET search_path 를 달지 않는다 — 달면 inline 이 막혀 공개 뷰가 행마다 함수를 부른다(0075).';

CREATE VIEW core_public.streamer_match AS
  -- 갈래 1: 활성 공개 계정이 붙은 자리
  SELECT sa.streamer_id, mp.match_id, mp.participant_id
    FROM streamer_account sa
    JOIN streamer s ON s.id = sa.streamer_id AND s.visibility = 'public'
    JOIN match_participant mp ON mp.puuid = sa.puuid
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
   WHERE sa.active_to IS NULL AND sa.visibility = 'public'
  UNION ALL
  -- 갈래 2: 활성 공개 계정이 없는 자리 — 행에 적힌 사람
  SELECT mp.streamer_id, mp.match_id, mp.participant_id
    FROM match_participant mp
    JOIN streamer s ON s.id = mp.streamer_id AND s.visibility = 'public'
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
   WHERE NOT EXISTS (SELECT 1 FROM streamer_account sa
                      WHERE sa.puuid = mp.puuid AND sa.active_to IS NULL AND sa.visibility = 'public');

COMMENT ON VIEW core_public.streamer_match IS
  '공개 롤 경기에서 공개 스트리머가 나온 자리(사람·경기·자리 번호). core_public.match_participant 에서 streamer_id 가 있는 행과 같다. '
  '사람으로 참가 기록을 찾을 땐 여기서 출발해 match_participant 를 (match_id, participant_id) 로 붙인다 — '
  '참가자 뷰의 streamer_id 는 계산값이라 직접 거르면 표 전체를 훑는다(0075).';

COMMENT ON VIEW core_public.match_participant IS
  '공개 롤 경기의 참가자. ⚠ streamer_id 로 직접 거르지 않는다 — 계산값이라 인덱스를 못 타 1GB 표를 통째로 훑는다. '
  '사람으로 찾을 땐 core_public.streamer_match 를 거친다(0075). 경기(match_id)로 찾는 건 빠르다.';

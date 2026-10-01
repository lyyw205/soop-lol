-- 올스타전·이벤트 매치를 **우승 집계(우승 N회·준우승 N회)에서 분리**한다. 대회 목록·경기·조우는 그대로다.
--
-- 왜: 2014~2019 올스타전은 두 팀이 한 판을 하는 이벤트전이고(2019 는 4팀), 2020 프릭스 매치는 프로가 섞인 즉석 팀이다.
--   정규 시즌 우승과 같은 무게로 세면 "우승 6회" 같은 숫자가 부풀려진다(꿀탱탱 DB 6 vs 나무위키 개인별 표 3).
--   사용자 결정(2026-10-01): 올스타전·이벤트 매치는 우승 횟수에서 빼고 따로 보여 준다(docs/MELJANG-VERIFY.md).
-- 왜 event.kind 를 'showmatch' 로 바꾸지 않나: 공개 대회 목록이 kind='tournament' 만 보여 주므로(public-tournaments.ts)
--   올스타전이 대회 화면에서 사라진다. 경기 분류(match_category)는 둘 다 'tournament' 라 바뀌지 않지만,
--   "목록에는 그대로, 우승 숫자에서만 뺀다" 가 결정이라 분류와 별개의 칸을 둔다.
ALTER TABLE event ADD COLUMN counts_toward_titles boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN event.counts_toward_titles IS
  '이 대회의 우승·준우승을 프로필 우승 집계에 넣는가. 올스타전·이벤트 매치는 false — 목록·경기·조우에는 그대로 나온다. '
  'seed:tournament 는 이 칸을 건드리지 않는다(재적재가 되돌리지 않게).';

-- 지금 있는 올스타전·이벤트 매치. 새 DB(검증용)에는 이 행들이 없어 아무 일도 안 한다.
UPDATE event SET counts_toward_titles = false
 WHERE game_code = 'lol'
   AND slug IN ('meljang-2014-allstar', 'meljang-2015-allstar', 'meljang-2017-allstar', 'meljang-2018-allstar',
                'meljang-2019-allstar', 'meljang-2024-allstar', 'meljang-2020-freecs');

-- 공개 뷰에 칸을 더한다. 기존 칸 순서는 그대로 두고 끝에 붙인다(CREATE OR REPLACE VIEW 규칙).
CREATE OR REPLACE VIEW core_public.event AS
  SELECT id AS event_id, slug, name, kind, organizer, starts_at, ends_at, source_url, counts_toward_titles
    FROM event;

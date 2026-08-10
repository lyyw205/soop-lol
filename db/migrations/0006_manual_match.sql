-- 대회(내전) 경기를 받을 수 있게 match 를 푼다.
--
-- 왜: 멸망전 같은 내전은 커스텀 게임이라 Riot API 로 조회할 수 없다(CLAUDE.md 제약 1).
-- 그래서 대회 기록은 주최측 발표를 근거로 **수기로** 넣는다. 그런데 지금 스키마는
-- 공개 큐 매치만 상정하고 있어서 Riot 이 주는 값들이 NOT NULL 이다.
--
-- ★ 없는 값을 합성해서 채우지 않는다. game_id 를 가짜로 만들어 넣으면
--   "이 값이 진짜 Riot game_id 인가"를 나중에 아무도 판단할 수 없게 된다.
--   NULL 이 정직하다 — match_id 는 어차피 우리가 만드는 텍스트 PK 다.

ALTER TABLE match ALTER COLUMN game_id DROP NOT NULL;
ALTER TABLE match ALTER COLUMN platform_id DROP NOT NULL;

-- 수기 매치는 어디서 왔는지가 있어야 한다. 근거 없는 전적은 만들지 않는다는
-- 원칙(§11-2)은 계정 매핑만의 것이 아니다.
ALTER TABLE match ADD COLUMN source_url text;

COMMENT ON COLUMN match.game_id IS
  'Riot 이 준 gameId. 수기/대회 매치는 NULL — 없는 값을 합성하지 않는다.';
COMMENT ON COLUMN match.source_url IS
  '수기 매치의 근거 URL (대회 공지·중계 VOD·위키 리비전). source=manual 이면 사실상 필수.';

-- 공개 큐 매치는 Riot 이 주는 값이 반드시 있어야 한다. 수기만 비울 수 있다.
-- 이 CHECK 가 없으면 수집 버그로 game_id 가 빠진 공개 큐 매치가 조용히 들어온다.
ALTER TABLE match ADD CONSTRAINT match_public_queue_has_riot_ids
  CHECK (source <> 'public_queue' OR (game_id IS NOT NULL AND platform_id IS NOT NULL));

-- 대회 경기를 event 로 묶어 조회하는 일이 잦다 (한 대회의 전 경기).
CREATE INDEX match_event_created_idx ON match (event_id, game_creation DESC)
  WHERE event_id IS NOT NULL;

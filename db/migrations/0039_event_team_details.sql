-- 대회 팀·선수에 대해 주최측이 발표한 사실을 담는다: 상금·팀 투표 순위·팀장·선수 등급·개인 수상.
-- 대회 하나에 출처 링크가 여럿일 수 있고(공식 안내·등급 산정 안내·다시보기·기사),
-- 운영 방식·경기장·패치·중계진 같은 대회 안내 사실도 있다.
--
-- 왜 core 인가: "누가 그 대회에서 어느 팀의 팀장이었나 / 몇 등급이었나 / 상금이 얼마였나" 는
-- 해석이 아니라 **사실**이다(docs/ARCHITECTURE.md — core 는 사실·공개 정책). 예전엔 대회 화면
-- 코드에 Gen.G 멸망전 값이 상수로 박혀 있었다 — 근거가 코드 주석뿐이었고 다른 화면은 못 썼다.
--
-- 어디서 오나: seed/lineups/<event>.json(사람이 출처를 보고 적은 정본) → apply-meljang-lineups →
-- seed:tournament. 전부 **수기**다 — 화면은 `수기` 로 표시한다.
--
-- ★ 모르면 NULL 이다. 팀장을 모른다는 것과 팀장이 아니라는 것은 다르다 — is_captain 에
--   기본값 false 를 두지 않는다. 등급·상금도 발표가 없으면 비워 둔다. 지어내지 않는다.

ALTER TABLE event_team ADD COLUMN prize     text;
ALTER TABLE event_team ADD COLUMN vote_rank smallint CHECK (vote_rank > 0);

COMMENT ON COLUMN event_team.prize IS
  '출처가 쓴 그대로의 상금 표기 (예: 2,500만 원). 모르거나 없으면 NULL.';
COMMENT ON COLUMN event_team.vote_rank IS
  '출처가 발표한 팀 투표 순위. 그런 절차가 없던 대회면 NULL.';

ALTER TABLE event_team_member ADD COLUMN is_captain    boolean;
ALTER TABLE event_team_member ADD COLUMN rating_label  text;
ALTER TABLE event_team_member ADD COLUMN rating_points numeric;
ALTER TABLE event_team_member ADD COLUMN award         text;

COMMENT ON COLUMN event_team_member.is_captain IS
  '주최측이 발표한 팀장이면 true. 모르면 NULL — false 는 "팀장이 아님을 안다" 는 뜻이다.';
COMMENT ON COLUMN event_team_member.rating_label IS
  '주최측이 선수에게 매긴 등급 표기 그대로 (예: S · F- · Transcended). 등급제가 없으면 NULL.';
COMMENT ON COLUMN event_team_member.rating_points IS
  '그 등급의 점수(팀 구성 상한을 맞추는 포인트). rating_label 과 같은 출처.';
COMMENT ON COLUMN event_team_member.award IS
  '그 대회에서 받은 개인상 표기 그대로 (예: FINAL MVP). 없거나 모르면 NULL.';

CREATE TABLE event_link (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  label    text NOT NULL,
  url      text NOT NULL CHECK (url ~ '^https?://'),
  sort     smallint NOT NULL DEFAULT 0,
  UNIQUE (event_id, url)
);

COMMENT ON TABLE event_link IS
  '대회의 출처·공식 링크. event.source_url 은 대회 기록의 대표 근거 하나이고, 이건 그 밖의 링크들이다.';

-- 대회 안내 사실 — "구역 · 항목 · 값" 한 줄씩. 화면은 구역마다 표 하나로 그린다.
-- ★ 값은 출처가 쓴 표기 그대로다. 줄바꿈이 필요하면 값 안에 \n 을 둔다.
CREATE TABLE event_fact (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  section  text NOT NULL,
  label    text NOT NULL,
  value    text NOT NULL,
  sort     smallint NOT NULL DEFAULT 0,
  UNIQUE (event_id, section, label)
);

COMMENT ON TABLE event_fact IS
  '대회 안내 사실(운영 방식·경기장·패치·상금 구성·중계진 …). 전부 수기 — 근거는 같은 대회의 event_link.';

-- 0002 와 같은 이유 — public 스키마의 표는 PostgREST 로 노출되므로 RLS 를 켠다.
ALTER TABLE event_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_fact ENABLE ROW LEVEL SECURITY;

-- 뷰는 칸을 **뒤에만** 붙인다(CREATE OR REPLACE VIEW 규칙). 숨긴 사람은 여전히 빠진다.
CREATE OR REPLACE VIEW core_public.event_team AS
  SELECT id AS event_team_id, event_id, name, placement, placement_rank, prize, vote_rank
    FROM event_team;

CREATE OR REPLACE VIEW core_public.event_team_member AS
  SELECT m.event_id, m.event_team_id, m.streamer_id, m.position,
         m.is_captain, m.rating_label, m.rating_points, m.award
    FROM event_team_member m
    JOIN streamer s ON s.id = m.streamer_id AND s.visibility = 'public';

CREATE VIEW core_public.event_link AS
  SELECT event_id, label, url, sort FROM event_link;

CREATE VIEW core_public.event_fact AS
  SELECT event_id, section, label, value, sort FROM event_fact;

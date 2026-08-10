-- 팀의 대회 순위(우승·준우승·4강·예선 탈락 …)를 담는다.
--
-- 어디서 오나: 나무위키 참가팀 표는 순위를 **텍스트가 아니라 행 배경색**으로 적는다.
-- 표 위 범례(■우승 ■준우승 ■4강 ■8강 ■2차예선 탈락)의 색과 행 색을 맞춰 읽는다.
-- 색이 없는 회차(2018~2020, 2026)는 대진의 '결승'·'4강' 라운드에서 유도한다.
--
-- ★ 둘 다 안 되면 비워 둔다. 순위를 지어내지 않는다 —
--   화면에서 뱃지가 안 보이는 게, 틀린 순위가 보이는 것보다 낫다.

ALTER TABLE event_team ADD COLUMN placement      text;
ALTER TABLE event_team ADD COLUMN placement_rank smallint;

COMMENT ON COLUMN event_team.placement IS
  '출처가 쓴 그대로의 순위 표기 (우승 / 준우승 / 4강 / 10강 / 2차예선 탈락 …). 모르면 NULL.';
COMMENT ON COLUMN event_team.placement_rank IS
  '정렬·집계용 숫자. 1=우승, 2=준우승, 4=4강, 8=8강 … 99=예선 탈락. 표기가 제각각이라 이걸로 묶는다.';

CREATE INDEX event_team_placement_idx ON event_team (placement_rank)
  WHERE placement_rank IS NOT NULL;

CREATE OR REPLACE VIEW core_public.event_team AS
  SELECT id AS event_team_id, event_id, name, placement, placement_rank FROM event_team;

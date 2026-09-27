-- 몰수 경기에서는 실제 득점(goalTotal)과 표시 스코어(goalTotalDisplay)가 다르다.
-- 스탯표의 골은 전자, 경기 스코어는 후자를 쓴다.
ALTER TABLE fco_match_participant ADD COLUMN score_display integer;
COMMENT ON COLUMN fco_match_participant.goals IS '실제 득점(goalTotal). 몰수로 부여된 표시 점수를 더하지 않는다.';
COMMENT ON COLUMN fco_match_participant.score_display IS '경기 화면 표시 점수(goalTotalDisplay). 몰수 경기에서 goals와 다를 수 있다.';

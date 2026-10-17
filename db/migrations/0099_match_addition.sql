-- 빠진 경기 직접 입력 — docs/SUBMISSION-POLICY-PLAN.md §7 가 (2026-10-17 사용자 결정)
--
-- 회원이 기록에 없는 시리즈를 직접 등록한다. 사람·날짜로 중복을 막고(이미 있으면 받지 않는다 — 그 경기 고치기로),
-- 중복이 아니면 **바로 공개**하되 검증 전이다 — 목록에는 보이고 집계에서는 빠진다(확인 전과 같은 자리: submission_effect + applied).
-- 판정의 할 일 vod_priority → 판독 요청(0097). 판독이 만든 경기들에 시점을 붙이면(match_pov) 판독 값으로 덮고 검증(addition_found),
-- 판독할 수 없으면(영상 없음·못 찾음·VOD 를 못 찾음) 검증 전 그대로 + 운영자(§9). 반려 = 만든 판 숨기기(visibility hidden).
--
-- 만든 판은 기존 쓰기 길로 만든다 — 판 행 + 분류 쓰기(placeSetInTx, 시리즈 sub:<제보>, 행사는 고른 것 또는 그날의 회원 등록 묶음).
-- collected_via = 'manual'(수기). 판 번호는 sub:<제보>:<세트>. 제보와 판은 submission_effect 로 잇는다(여러 판이라 submission.match_id 는 비운다).

ALTER TABLE submission DROP CONSTRAINT submission_kind_check;
ALTER TABLE submission ADD CONSTRAINT submission_kind_check
  CHECK (kind IN ('match_correction', 'schedule_report', 'vod_hint', 'match_addition'));

ALTER TABLE submission ADD CONSTRAINT submission_addition_shape CHECK (
  kind <> 'match_addition' OR (match_id IS NULL AND schedule_entry_id IS NULL AND jsonb_typeof(payload->'sets') = 'array'));

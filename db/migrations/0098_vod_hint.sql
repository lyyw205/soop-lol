-- VOD 단서 제보 — docs/SUBMISSION-POLICY-PLAN.md §7 나 (2026-10-17 사용자 결정)
--
-- 회원이 "이 VOD 에 내전이 있다"를 알린다(SOOP VOD 링크 필수 · 대략의 시점·누가 나왔나 선택). **공개하지 않는다** —
-- 판정은 숨김·대기(vod_pending) + 할 일 vod_priority → 판독 요청 표(0097 vod_request)에 한 줄, ck-auto 대기열 맨 앞.
-- 판독이 그 VOD 의 경기를 기록하면 경기는 판독 경기로 바로 집계에 들어가고(회원 값이 없어 비교할 것이 없다), 단서는 확인 완료(vod_found).
-- 판독이 끝났는데 경기가 없으면(vod_not_found)·영상이 없으면(vod_unavailable) 운영자 대기로 남는다(§9 "검증 불가 → 검증 전 + 운영자").
-- 대상은 경기도 일정도 아니다 — VOD 번호는 제안(payload.vod)과 요청 표에 있다.

ALTER TABLE submission DROP CONSTRAINT submission_kind_check;
ALTER TABLE submission ADD CONSTRAINT submission_kind_check CHECK (kind IN ('match_correction', 'schedule_report', 'vod_hint'));

ALTER TABLE submission DROP CONSTRAINT submission_hold_reason_check;
ALTER TABLE submission ADD CONSTRAINT submission_hold_reason_check
  CHECK (hold_reason IN ('review_completed', 'api_observed', 'account_identity', 'contested', 'not_public', 'schedule_review',
                         'vod_pending', 'vod_not_found', 'vod_unavailable'));

-- 단서는 경기·일정을 가리키지 않고 공개 기록을 바꾸지 않는다 — 바로 반영(applied)·되돌림(reverted)이 없다.
ALTER TABLE submission ADD CONSTRAINT submission_vod_hint_shape CHECK (
  kind <> 'vod_hint' OR (match_id IS NULL AND schedule_entry_id IS NULL AND state NOT IN ('applied', 'reverted')
                         AND jsonb_typeof(payload->'vod') = 'number'));

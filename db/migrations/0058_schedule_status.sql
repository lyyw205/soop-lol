-- 공개 상태는 예정·진행중·취소·연기·완료. 기존 held 데이터와 결과 연결 조건을 보존한다.
ALTER TABLE schedule_entry DROP CONSTRAINT schedule_entry_status_check;
ALTER TABLE schedule_entry ADD CONSTRAINT schedule_entry_status_check
  CHECK (status IN ('scheduled', 'in_progress', 'cancelled', 'postponed', 'held'));

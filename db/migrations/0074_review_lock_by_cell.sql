-- 0074 — 검수 보호를 경기 단위에서 칸 단위로.
--
-- 사람이 참가자 연결 하나만 고쳐도 reviewed_at 이 찍혀, 자동 판독이 그 경기의 **빈 칸**까지
-- 못 채웠다(2026-10-05 연결 작업으로 약 140경기의 챔피언 칸이 빈 채로 굳었다).
-- 새 컬럼·표를 만들지 않는다. "누가 어느 칸을 바꿨나" 는 review_change(0042)가 이미 안다 —
-- 판정은 core/lib/db/review-lock.ts 한 곳이 그 기록으로 한다.
--
-- 여기서 바꾸는 것은 둘뿐이다:
--   1. review_change.actor 에 'auto' — 자동 판독이 검수 경기의 빈 칸을 채운 기록. 사람 기록(admin)과
--      섞이면 "사람이 바꾼 칸" 이 자동 채움으로 늘어나 다음 판독을 막는다. 그래서 이름을 가른다.
--   2. reviewed_at 의 뜻을 주석으로 고친다. 과거 잠금은 풀지 않는다 — 칸 기록이 없는 검수 경기는
--      판정 함수가 지금처럼 경기 전체를 보호한다.

ALTER TABLE review_change DROP CONSTRAINT review_change_actor_check;
ALTER TABLE review_change ADD CONSTRAINT review_change_actor_check CHECK (actor IN ('admin', 'auto'));

COMMENT ON TABLE review_change IS
  '경기 값 수정 이력 — 무엇을 무엇에서 무엇으로 바꿨나. actor=admin 은 사람, auto 는 자동 판독의 빈 칸 채움. '
  '사람이 바꾼 칸의 보호 판정이 이 표를 읽는다(review-lock.ts). 변경과 같은 트랜잭션에서 기록한다. 공개하지 않는다.';

COMMENT ON COLUMN match.reviewed_at IS
  '사람이 이 경기를 만졌다(고쳤거나 보호했다). 자동 수집은 행을 통째로 덮지 않는다. '
  '자동 판독의 빈 칸 채우기는 review_change 로 사람이 바꾼 칸을 가릴 수 있을 때만, 그 칸을 빼고 한다 — '
  '가릴 수 없거나(이력 없음·보호 표시·관리자 생성) 검수 완료면 경기 전체를 지킨다.';

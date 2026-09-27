-- 근거 프레임의 역할 — 경기 흐름의 어느 장면인가.
--
-- ★ 왜 필요한가 (2026-09-24 뿌챔스 검수)
--   경기마다 「경기 전 · 시작 · 종료 · 종료 후」 4종과 **결과 화면**을 뽑는데, 역할이 근거 설명
--   글(why)의 「[종료]」 같은 머리말에만 있었다. 검수 화면이 결과 화면을 먼저 띄우려면
--   글이 아니라 칸이어야 한다. 결과 화면은 모든 경기에서 5분할로 찾는다(스킬 절차) —
--   API 가 승자를 못 가리는 무승부·승부차기에서는 결과 화면이 유일한 근거다.
--
-- NULL 은 「역할 없음」(대회 공통 화면·조사 중 연 프레임)이다. 추측해서 채우지 않는다.

ALTER TABLE fco_context_evidence ADD COLUMN role text
  CHECK (role IS NULL OR role IN ('pre', 'start', 'end', 'post', 'result'));

COMMENT ON COLUMN fco_context_evidence.role IS
  'pre=경기 전(대기실·브래킷), start=킥오프, end=종료 직전 경기 화면, post=종료 후, '
  'result=결과 화면(최종 스코어·득점자). 검수 화면은 result 를 먼저 띄운다.';

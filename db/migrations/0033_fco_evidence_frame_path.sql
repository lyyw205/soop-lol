-- 검수는 근거 화면을 눈으로 대조해야 한다 — 좌표(vod, 초)만으로는 승인 화면에서
-- 프레임을 다시 찾아 열어야 해서, 조사자가 이미 열어 본 프레임이 검수에 재사용되지 않는다.
-- 조사(ck:probe)가 뽑아 둔 로컬 프레임 파일을 근거 행에 건다.
--
-- ★ 서빙은 기존 /admin/ck/frame 라우트를 읽기 전용으로 재사용한다 (CK 파이프라인은
--   수정하지 않는다). 경로 형식도 같다: out/ck/<vod>/g<전체초>.jpg.
-- ★ 프레임 파일이 있는 기계에서만 보인다 — CK 프레임과 같은 제약(0019 라우트 주석).
--   파일이 없어도 근거 행 자체(좌표·관찰)는 유효하다.

ALTER TABLE fco_context_evidence ADD COLUMN frame_path text;

COMMENT ON COLUMN fco_context_evidence.frame_path IS
  '조사가 실제로 연 프레임의 로컬 경로 (out/ck/<vod>/g<전체초>.jpg). '
  '검수 화면이 이 파일을 띄워 관찰과 대조한다. 파일 존재는 보장하지 않는다.';

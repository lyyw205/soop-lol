-- 대회 팀 순위 표기의 같은 뜻 흔들림을 저장 값에서 통일한다.
--
-- ★ 왜 (2026-10-02): 같은 뜻을 회차마다 '4강' / '4강 탈락', '8강' / '8강 탈락' 으로 적어 4강까지 간 팀이 화면에
--   "4강 탈락" 으로 보였다. 화면마다 고쳐 부르면 한 곳만 빠져도 어긋나므로 저장 값을 맞춘다.
--   앞으로 들어오는 값은 저장 경로(saveEventTeams → normalizePlacement)가 같은 규칙으로 맞춘다.
-- 순위 숫자(placement_rank)는 이미 두 표기를 같은 값으로 세고 있어 바뀌지 않는다.
UPDATE event_team SET placement = regexp_replace(placement, '^\s*(\d+)강\s*탈락\s*$', '\1강')
 WHERE placement ~ '^\s*\d+강\s*탈락\s*$';
UPDATE event_team SET placement = regexp_replace(placement, '^(\d)차예선', '\1차 예선')
 WHERE placement ~ '^\d차예선';

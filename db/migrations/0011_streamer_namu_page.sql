-- 나무위키 인물 문서를 **신원 키**로 삼는다.
--
-- 왜 필요한가:
--   옛 회차 로스터는 표기가 제각각이다 — '이상호'·'BJ이상호'·'탈론장인이상호'.
--   SOOP 검색으로는 못 가른다. '이상호' 를 찾으면 lshooooo(이상호) 와 tlshtkw(이상호^) 가
--   같이 나오고, 'BJ이상호' 를 찾으면 아예 다른 두 사람이 나온다. 그래서 포기하고 있었다.
--
--   그런데 나무위키 로스터 셀은 **인물 문서로 링크**돼 있다. 위 세 표기가 전부
--   `/w/이상호` 하나로 링크된다. 출처가 직접 "같은 사람"이라고 말하는 것이다.
--   닉네임 유사도 추측과 다르다 — 이건 근거다(§11-2).
--
-- ★ 문서 하나에 스트리머 하나다. 두 스트리머가 같은 문서를 가리키면 둘 중 하나가
--   잘못 이어진 것이므로 UNIQUE 로 막는다. 조용히 겹치면 전적이 남에게 붙는다.

ALTER TABLE streamer ADD COLUMN namu_page text;

COMMENT ON COLUMN streamer.namu_page IS
  '나무위키 인물 문서 제목 (예: 이상호, 김민교(인터넷 방송인)). '
  '대회 로스터의 옛 표기를 현재 스트리머로 잇는 근거로 쓴다. 모르면 NULL.';

CREATE UNIQUE INDEX streamer_namu_page_uq ON streamer (namu_page) WHERE namu_page IS NOT NULL;

-- 참가자 구분 키(0050)를 「스트리머 → 넥슨 계정 → 화면 이름」 순으로 바꾼다.
--
-- 0050 은 ouid 를 먼저 봤다. 그러면 같은 사람이 API 경기에선 ouid 로, 화면 경기(ouid NULL)에선 streamer 로 잡혀
-- **서로 다른 사람**으로 판정된다 — 화면 경기가 API 경기와 같은 시리즈에 들어갈 때 "다른 대진"으로 잘못 거부된다.
-- 스트리머가 붙어 있으면(공개 연결된 계정, 또는 근거 있는 화면 매칭) 그게 사람의 정체다. 부계정 둘로 같은 사람이
-- 나온 시리즈도 같은 대진으로 본다(사람이 같다). 스트리머가 없을 때만 계정, 그것도 없으면 화면 이름.
-- 이 함수를 쓰는 곳: 시리즈 대진 비교(context.ts). 0050 이후 아직 다른 곳은 없다.
CREATE OR REPLACE FUNCTION fco_participant_key(p_ouid text, p_streamer_id uuid, p_nickname text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE('streamer:' || p_streamer_id::text, p_ouid, 'name:' || p_nickname)
$$;

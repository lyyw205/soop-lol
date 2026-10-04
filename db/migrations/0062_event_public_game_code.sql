-- 공개 대회 뷰에 게임을 붙인다.
--
-- ★ 왜 (2026-10-02): 0061 로 FC 대회에도 참가 단위(event_team, 개인전은 1인 팀)가 생기자, 「참가 팀이 있는 대회」를
--   고르던 롤 쪽 공개 질의(대회 목록·프로필 대회 이력·수상 요약)가 FC 뿌챔스를 롤 대회로 섞어 냈다.
--   core_public.event 에 게임이 없어 그 질의들은 걸러낼 방법이 없었다. 대회를 읽는 질의는 게임을 걸어야 한다.
--   회귀 검사: verify:bracket 「FC 대회 참가 단위가 롤 목록·프로필에 나오지 않는다」.

-- 뷰는 칸을 **뒤에만** 붙인다(CREATE OR REPLACE VIEW 규칙).
CREATE OR REPLACE VIEW core_public.event AS
  SELECT id AS event_id, slug, name, kind, organizer, starts_at, ends_at, source_url, counts_toward_titles, game_code
    FROM event;

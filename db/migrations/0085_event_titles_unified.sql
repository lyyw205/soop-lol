-- 2026-10-13 사용자 결정: 2026-10-01의 올스타·이벤트전 우승 제외(0052·0053)를 되돌린다.
-- 우승 = kind='tournament'의 팀 순위 1위. 과거 마이그레이션은 변경하지 않는다.
-- 이 뷰를 참조하는 다른 저장 뷰는 없다. 외부 의존성이 생겼다면 DROP이 실패하도록 CASCADE를 쓰지 않는다.
-- 명시적 뷰 권한은 재생성 후 복구한다(기본 권한만 존재하는 DB도 지원).
CREATE TEMP TABLE event_view_grants AS
  SELECT grantee, privilege_type, is_grantable
    FROM information_schema.table_privileges
   WHERE table_schema = 'core_public' AND table_name = 'event';
DROP VIEW core_public.event;
ALTER TABLE event DROP COLUMN counts_toward_titles;
CREATE VIEW core_public.event AS
  SELECT id AS event_id, slug, name, kind, organizer, starts_at, ends_at, source_url, game_code
    FROM event;
DO $$ DECLARE g record;
BEGIN
  FOR g IN SELECT * FROM event_view_grants LOOP
    EXECUTE format('GRANT %s ON core_public.event TO %s%s', g.privilege_type,
      CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
      CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
END $$;
DROP TABLE event_view_grants;

-- 목록과 개인 이력의 유효 날짜. 수집 경로와 관계없이 공개 경기만 보완 근거로 쓴다.
CREATE VIEW core_public.event_dates AS
  SELECT e.*, COALESCE(e.starts_at, g.first_match) AS effective_starts_at,
         COALESCE(e.ends_at, g.last_match) AS effective_ends_at
    FROM core_public.event e LEFT JOIN (
      SELECT event_id, min(game_creation) AS first_match, max(game_creation) AS last_match
        FROM core_public.match WHERE event_id IS NOT NULL GROUP BY event_id
    ) g ON g.event_id = e.event_id;

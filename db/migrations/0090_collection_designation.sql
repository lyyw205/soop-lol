-- 지명 수집 — docs/COLLECTION-DESIGNATION-PLAN.md (2026-10-16 확정)
--
-- 0089 의 collection_target 은 계정 한 줄에 정의(계정·큐·기간)와 기계 상태(커서)를 함께 담았고, 솔랭 도전 화면은 같은 계정·시작일을
-- 모듈 파일에 따로 적었다. 같은 사실이 두 곳 → 어긋난다. 여기서 지명을 "목적 하나 = 지명 하나"로 다시 세운다:
--
--   collection_order    지명 — 목적(owner) · 제목 · 큐[] · 기간. 사람이 정한 것만
--   collection_member   지명된 사람 = 스트리머(결정 2: 그 사람에게 연결된 계정 전부가 자동으로 범위)
--   collection_scope    범위(뷰) — 지명 × 사람 × 현재 연결 계정 × 큐. 수집 엔진·저장 관문·정리·검사가 읽는 유일한 범위
--   collection_progress 진척 — 범위 한 칸(지명, 계정, 큐)의 커서·끝 도달·상태. 기계 상태만
--
-- ★ API 로 모은 개인 기록 판(scope='personal', collected_via='api')은 언제나 어느 범위 안에 있다 — 저장 관문이 범위를 확인하고, 지명을 줄이거나 연결을 떼면
--   core 의 정리(pruneUncoveredPersonalInTx)가 범위 밖 판을 지운다. verify 가 "범위 밖 개인 기록 0" 을 단언한다.

CREATE TABLE collection_order (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  title       text NOT NULL CHECK (btrim(title) <> ''),
  -- 누구의 지명인가. 행사(솔랭내기 등) 또는 모듈 콘텐츠(core 는 모듈을 모르므로 글자 키). 목적 하나에 지명 하나.
  owner       text NOT NULL UNIQUE CHECK (owner ~ '^(event:[0-9a-f-]{36}|module:[a-z_]+/[a-z0-9-]+)$'),
  game_code   text NOT NULL DEFAULT 'lol' CHECK (game_code = 'lol'),
  queue_ids   integer[] NOT NULL CHECK (cardinality(queue_ids) > 0 AND 0 <> ALL (queue_ids)),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
COMMENT ON TABLE collection_order IS
  '지명 — 공개 큐 경기 기록을 모으는 유일한 근거. 목적 하나에 하나. 사람은 collection_member, 범위는 collection_scope 뷰.';

CREATE TABLE collection_member (
  order_id    uuid NOT NULL REFERENCES collection_order(id) ON DELETE CASCADE,
  -- ★ 스트리머를 지우려면 지명에서 먼저 뺀다 — 지명이 조용히 사라지면 그 판들이 왜 정리됐는지 남지 않는다.
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE RESTRICT,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, streamer_id)
);
COMMENT ON TABLE collection_member IS '지명된 사람. 그 스트리머에 지금 연결된 계정 전부가 범위가 된다(계정 연결은 근거 필수 — 원칙 2).';

-- 범위 — 지명 × 사람 × 현재 연결 계정 × 큐. 계정 숨김은 범위를 바꾸지 않는다(숨김은 화면의 일, 데이터는 남긴다).
-- ★ security_invoker: 뷰를 부른 쪽의 권한으로 읽는다 — 기반 표가 RLS 라 공개 키(anon)로는 아무것도 안 보인다(Supabase 는 public 스키마를 노출한다).
CREATE VIEW collection_scope WITH (security_invoker = true) AS
  SELECT o.id AS order_id, o.slug, o.owner, m.streamer_id, sa.puuid, q.queue_id, o.starts_at, o.ends_at
    FROM collection_order o
    JOIN collection_member m ON m.order_id = o.id
    JOIN streamer_account sa ON sa.streamer_id = m.streamer_id AND sa.active_to IS NULL
    CROSS JOIN LATERAL unnest(o.queue_ids) AS q(queue_id);
COMMENT ON VIEW collection_scope IS '지명의 범위(계정·큐·기간). 수집·저장 관문·정리·검사가 읽는 유일한 범위. 계산은 지명·사람·계정 연결에서만.';

CREATE TABLE collection_progress (
  id            uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  order_id      uuid NOT NULL REFERENCES collection_order(id) ON DELETE CASCADE,
  puuid         text NOT NULL REFERENCES riot_account(puuid) ON DELETE CASCADE,
  queue_id      integer NOT NULL,
  -- 백필 커서 — 이 시각 **이전**을 아직 덜 봤다. NULL 이면 아직 시작 전(위쪽 끝부터).
  cursor_before timestamptz,
  reached_end   boolean NOT NULL DEFAULT false,
  state         text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'error')),
  last_error    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (order_id, puuid, queue_id)
);
COMMENT ON TABLE collection_progress IS '범위 한 칸의 수집 진척(기계 상태). 범위에 새 칸이 생기면 엔진이 처음 집을 때 만든다. 지명 정의를 바꾸면 그 지명의 진척을 다시 연다.';

ALTER TABLE collection_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_progress ENABLE ROW LEVEL SECURITY;

-- 이력 — 누가·언제·무엇을(행사 표와 같은 admin_audit). 진척은 기계 상태라 남기지 않는다.
CREATE TRIGGER collection_order_audit AFTER INSERT OR UPDATE OR DELETE ON collection_order
  FOR EACH ROW EXECUTE FUNCTION audit_admin_row('collection', 'id');
CREATE TRIGGER collection_member_audit AFTER INSERT OR UPDATE OR DELETE ON collection_member
  FOR EACH ROW EXECUTE FUNCTION audit_admin_row('collection', 'order_id');

-- ── 옮겨 담기: 0089 의 첫 지명(뜨교듀오 솔랭 도전) ───────────────────────────────
INSERT INTO collection_order (slug, title, owner, queue_ids, starts_at, note)
SELECT 'ttgyo-duo', '뜨교듀오 마스터 도전', 'module:solo_challenge/ttgyo-duo', ARRAY[420], timestamptz '2026-08-21 00:00:00+09',
       '0089 collection_target 에서 옮김 — 솔랭 도전 모듈'
 WHERE EXISTS (SELECT 1 FROM collection_target WHERE purpose = 'solo_challenge:ttgyo-duo');
INSERT INTO collection_member (order_id, streamer_id)
SELECT DISTINCT o.id, sa.streamer_id
  FROM collection_target t
  JOIN streamer_account sa ON sa.puuid = t.puuid AND sa.active_to IS NULL
  JOIN collection_order o ON o.slug = 'ttgyo-duo'
 WHERE t.purpose = 'solo_challenge:ttgyo-duo';
INSERT INTO collection_progress (order_id, puuid, queue_id, cursor_before, reached_end, state, last_error, updated_at)
SELECT o.id, t.puuid, t.queue_id, t.cursor_before, t.reached_end, t.state, t.last_error, t.updated_at
  FROM collection_target t JOIN collection_order o ON o.slug = 'ttgyo-duo'
 WHERE t.purpose = 'solo_challenge:ttgyo-duo'
   AND EXISTS (SELECT 1 FROM collection_scope s WHERE s.order_id = o.id AND s.puuid = t.puuid AND s.queue_id = t.queue_id);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM collection_target t WHERE t.purpose <> 'solo_challenge:ttgyo-duo') THEN
    RAISE EXCEPTION 'collection_target 에 옮길 곳을 모르는 지명이 있다 — 0090 이 아는 것은 뜨교듀오 도전뿐이다';
  END IF;
  -- 옛 지명이 덮던 개인 기록 판은 새 범위에서도 덮여야 한다(결정 2 로 범위는 넓어질 뿐 좁아지지 않는다).
  IF EXISTS (
    SELECT 1 FROM match m
     WHERE m.game_code = 'lol' AND m.scope = 'personal' AND m.collected_via = 'api'
       AND NOT EXISTS (
         SELECT 1 FROM match_participant p JOIN collection_scope s ON s.puuid = p.puuid
          WHERE p.match_id = m.match_id AND s.queue_id = m.queue_id
            AND m.game_creation >= s.starts_at AND (s.ends_at IS NULL OR m.game_creation < s.ends_at))) THEN
    RAISE EXCEPTION '새 범위 밖에 남는 개인 기록 판이 있다 — 옮겨 담기가 범위를 좁혔다';
  END IF;
END $$;
DROP TABLE collection_target;

-- ── 공개 경로 — 모듈(솔랭 도전)이 계약으로 읽는다. 공개 스트리머만 ─────────────────
CREATE VIEW core_public.collection_order AS
  SELECT o.slug, o.title, o.owner, o.queue_ids, o.starts_at, o.ends_at FROM collection_order o;
CREATE VIEW core_public.collection_member AS
  SELECT o.slug, m.streamer_id, s.slug AS streamer_slug
    FROM collection_member m
    JOIN collection_order o ON o.id = m.order_id
    JOIN streamer s ON s.id = m.streamer_id AND s.visibility = 'public';
-- 다른 core_public 뷰와 같은 권한(core_public.event 의 권한을 그대로 받는다).
DO $$ DECLARE g record; v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['collection_order', 'collection_member'] LOOP
    FOR g IN SELECT grantee, privilege_type, is_grantable FROM information_schema.table_privileges
              WHERE table_schema = 'core_public' AND table_name = 'event' LOOP
      EXECUTE format('GRANT %s ON core_public.%I TO %s%s', g.privilege_type, v,
        CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
        CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $$;

-- 0082 — 커뮤니티 기록. docs/COMMUNITY-PLAN.md §3
--
-- ★ 편성표와 같은 나눔이다 — 기록·규칙·관리자 화면은 core, 공개 화면은 플랫폼 모듈(packages/modules/community).
--   모듈은 core_public 뷰를 읽고, 쓰기는 계약으로 연 core 접근자(core/lib/db/community*.ts)만 부른다.
-- ★ 분류는 두 축이다 — 게임(game_code: NULL = 공통) × 말머리(topic). 'platform'·'common' 같은 값은 저장하지 않는다.
-- ★ 상태는 공개·숨김·삭제 하나다. 숨긴 글은 작성자가 고쳐도 다시 공개되지 않고(접근자), 해제는 숨김 → 공개만 된다.
--   임시조치는 숨김의 한 종류다 — 운영 기록에 'blind' 로 남기고, 30일 검토·파기 보류는 기록에서 계산한다.
-- ★ 파기: 삭제 30일 뒤 제목·본문을 비우고 태그·추천을 지운다. 글을 파기할 때 그 댓글도 함께. 행의 뼈대는 남긴다.
-- ★ 추천·댓글 수는 저장하지 않는다 — 공개 뷰가 셀 때마다 센다(숨김·해제·삭제마다 수를 맞출 일이 없다).
-- ★ 운영 기록을 admin_audit 에 넣지 않는 이유: admin_audit 은 행 전체(본문 포함)를 영구 보관한다 — 파기 규칙이 깨진다.

CREATE TABLE community_post (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- 공유하기 쉬운 숫자 주소 /community/48213
  author_id   uuid REFERENCES member(id),                         -- NULL = 운영자 공지
  game_code   text CHECK (game_code IN ('lol', 'fconline')),      -- NULL = 공통. 게임을 추가할 때 함께 넓힌다
  topic       text NOT NULL CHECK (topic IN ('free', 'question', 'info', 'match', 'notice')),
  title       text CHECK (char_length(btrim(title)) BETWEEN 1 AND 100),   -- 파기 뒤 NULL
  body        text CHECK (char_length(body) BETWEEN 1 AND 10000),        -- 파기 뒤 NULL
  status      text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  deleted_at  timestamptz,                                        -- 파기 30일의 기준
  created_at  timestamptz NOT NULL DEFAULT now(),
  edited_at   timestamptz,
  -- 수정 충돌 판정(version). 편집 폼이 저장하는 내용(제목·본문·게임·말머리·태그)이나 상태가 바뀔 때만 바꾼다 — 추천·댓글은 제외.
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((author_id IS NULL) = (topic = 'notice')),                  -- '작성자 없음 = 공지' 짝. 요청자가 관리자인지는 접근자가 본다
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK ((title IS NULL) = (body IS NULL)),
  CHECK (status = 'deleted' OR body IS NOT NULL)                     -- 비우는 것(파기)은 삭제된 글만
);
CREATE INDEX community_post_feed_idx ON community_post (created_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX community_post_game_feed_idx ON community_post (game_code, created_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX community_post_author_idx ON community_post (author_id, created_at);   -- 내 글 · 쓰기 한도
CREATE INDEX community_post_deleted_idx ON community_post (deleted_at) WHERE status = 'deleted' AND body IS NOT NULL;  -- 파기 대상

CREATE TABLE community_post_streamer (
  post_id     bigint NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, streamer_id)
);
CREATE INDEX community_post_streamer_streamer_idx ON community_post_streamer (streamer_id);

CREATE TABLE community_comment (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id    bigint NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  parent_id  bigint,                                                -- 같은 글의 공개된 최상위 댓글만(최상위·공개는 접근자가 확인)
  author_id  uuid NOT NULL REFERENCES member(id),
  body       text CHECK (char_length(body) BETWEEN 1 AND 1000),          -- 파기 뒤 NULL
  status     text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'deleted')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, id),
  -- 대댓글은 같은 글의 댓글에만. 다른 글의 댓글을 부모로 삼을 수 없다.
  FOREIGN KEY (post_id, parent_id) REFERENCES community_comment (post_id, id) ON DELETE CASCADE,
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CHECK (status = 'deleted' OR body IS NOT NULL)
);
CREATE INDEX community_comment_post_idx ON community_comment (post_id, id);
CREATE INDEX community_comment_author_idx ON community_comment (author_id, created_at);
CREATE INDEX community_comment_parent_idx ON community_comment (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE community_post_vote (
  post_id    bigint NOT NULL REFERENCES community_post(id) ON DELETE CASCADE,
  member_id  uuid NOT NULL REFERENCES member(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, member_id)
);

CREATE TABLE community_report (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('post', 'comment')),
  target_id      bigint NOT NULL,
  reporter_id    uuid NOT NULL REFERENCES member(id),
  reason         text NOT NULL CHECK (reason IN ('spam', 'abuse', 'privacy', 'defamation', 'illegal', 'other')),
  detail         text CHECK (char_length(detail) <= 1000),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  -- 신고 당시 내용. 관리자만 본다. 처리 30일 뒤 또는 대상이 파기될 때 NULL.
  -- 신고만으로 수정을 막지 않는 대신 이걸 남긴다 — 신고자 한 명이 남의 편집을 막을 수 있게 되지 않도록.
  snapshot_title text,                                          -- 글이면 제목, 댓글이면 NULL
  snapshot_body  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  handled_at     timestamptz,
  UNIQUE (kind, target_id, reporter_id),                         -- 같은 대상을 두 번 신고하지 않는다
  CHECK (reason <> 'other' OR detail IS NOT NULL),
  CHECK (status <> 'open' OR snapshot_body IS NOT NULL),         -- 열린 신고는 당시 내용을 반드시 갖는다
  CHECK ((status = 'open') = (handled_at IS NULL))
);
CREATE INDEX community_report_open_idx ON community_report (kind, target_id) WHERE status = 'open';
CREATE INDEX community_report_reporter_idx ON community_report (reporter_id, created_at);   -- 신고 한도

-- 쓰기 제한. 탈퇴 회원의 재가입 제한 기간도 이 기록에서 계산한다.
CREATE TABLE community_sanction (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  member_id  uuid NOT NULL REFERENCES member(id),
  ends_at    timestamptz,                    -- NULL = 영구
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  actor      text NOT NULL,                  -- 지금은 ADMIN_USER
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at  timestamptz,
  CHECK (ends_at IS NULL OR ends_at > created_at)
);
CREATE INDEX community_sanction_member_idx ON community_sanction (member_id);

-- 운영 조치는 전부 사유와 함께 남긴다. 임시조치(blind)·파기 보류·"확정할 것" 은 여기서 계산한다. 본문은 남기지 않는다.
CREATE TABLE community_moderation_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('post', 'comment')),
  target_id  bigint NOT NULL,
  action     text NOT NULL CHECK (action IN ('keep', 'hide', 'blind', 'delete', 'restore')),
  reason     text NOT NULL CHECK (btrim(reason) <> ''),
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX community_moderation_log_target_idx ON community_moderation_log (kind, target_id, created_at);

ALTER TABLE community_post           ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_post_streamer  ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_comment        ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_post_vote      ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_report         ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_sanction       ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_moderation_log ENABLE ROW LEVEL SECURITY;

-- ── 공개 경계 ────────────────────────────────────────────────────────
-- ★ core_public 은 누구나 읽어도 되는 것만 낸다. 하위 뷰는 부모 공개 뷰와 조인해서 거른다(편성표 뷰와 같은 방식).
--   운영 칸(신고·제재·기록)은 공개 뷰에 없다.
-- 작성자 이름: author_id 가 NULL 이면 운영자, author_nickname 이 NULL 이면 탈퇴한 회원.

CREATE VIEW core_public.community_post AS
  SELECT p.id AS post_id, p.game_code, p.topic, p.title, p.body,
         p.author_id, m.nickname AS author_nickname,
         (SELECT count(*) FROM community_post_vote v WHERE v.post_id = p.id)::int AS like_count,
         (SELECT count(*) FROM community_comment c WHERE c.post_id = p.id AND c.status = 'published')::int AS comment_count,
         p.created_at, p.edited_at, p.updated_at::text AS version
    FROM community_post p
    LEFT JOIN member m ON m.id = p.author_id
   WHERE p.status = 'published';

-- 공개가 아닌 댓글은 공개 대댓글이 있을 때만 자리로 나온다(본문·작성자 없이). 대댓글이 같은 글이라는 건 복합 FK 가 보장한다.
CREATE VIEW core_public.community_comment AS
  SELECT c.id AS comment_id, c.post_id, c.parent_id,
         (c.status = 'published') AS visible,
         CASE WHEN c.status = 'published' THEN c.body END AS body,
         CASE WHEN c.status = 'published' THEN c.author_id END AS author_id,
         CASE WHEN c.status = 'published' THEN m.nickname END AS author_nickname,
         c.created_at, c.edited_at, c.updated_at::text AS version
    FROM community_comment c
    JOIN core_public.community_post pp ON pp.post_id = c.post_id
    LEFT JOIN member m ON m.id = c.author_id
   WHERE c.status = 'published'
      OR EXISTS (SELECT 1 FROM community_comment r WHERE r.parent_id = c.id AND r.status = 'published');

-- 숨긴 스트리머의 태그는 나오지 않는다.
CREATE VIEW core_public.community_post_streamer AS
  SELECT ps.post_id, ps.streamer_id
    FROM community_post_streamer ps
    JOIN core_public.community_post pp ON pp.post_id = ps.post_id
    JOIN core_public.streamer st ON st.streamer_id = ps.streamer_id;

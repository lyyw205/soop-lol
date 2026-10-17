-- R2 바이트는 DB에 저장하지 않는다. 원본 PUT 주소와 검증 완료 파일은 다른 키다.
CREATE TABLE community_attachment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 author_id uuid NOT NULL REFERENCES member(id),
 post_id bigint REFERENCES community_post(id),
 name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
 mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','image/gif','video/mp4')),
 bytes integer NOT NULL CHECK (bytes>0 AND bytes <= CASE WHEN mime='video/mp4' THEN 30000000 ELSE 10000000 END),
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verifying','ready','deleting','deleted')),
 width integer, height integer, duration double precision,
 attached boolean NOT NULL DEFAULT false,
 position integer NOT NULL DEFAULT 0,
 retired_at timestamptz,
 staging_cleaned boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT attached OR post_id IS NOT NULL),
 CHECK (state <> 'ready' OR (width>0 AND height>0 AND width IS NOT NULL AND height IS NOT NULL)),
 CHECK (mime <> 'video/mp4' OR state <> 'ready' OR (duration>0 AND duration<=60 AND duration IS NOT NULL))
);
CREATE INDEX community_attachment_author_idx ON community_attachment(author_id,created_at);
CREATE INDEX community_attachment_post_idx ON community_attachment(post_id);
CREATE INDEX community_attachment_cleanup_idx ON community_attachment(state,created_at);
ALTER TABLE community_attachment ENABLE ROW LEVEL SECURITY;
CREATE VIEW core_public.community_attachment WITH (security_barrier=true) AS
 SELECT a.id,a.post_id,a.name,a.mime,a.bytes,a.width,a.height,a.position
 FROM public.community_attachment a JOIN core_public.community_post p ON p.post_id=a.post_id
 WHERE a.state='ready' AND a.attached;

ALTER TABLE community_report ADD COLUMN snapshot_attachment_ids uuid[] NOT NULL DEFAULT '{}';

-- 첨부만 있는 글 허용. 빈 글 거부는 동일 트랜잭션의 접근자 검증에서 한다.
ALTER TABLE community_post DROP CONSTRAINT community_post_body_check;
ALTER TABLE community_post ADD CONSTRAINT community_post_body_check CHECK (char_length(body) <= 10000);

-- Historical event rosters can name a participant even when they are not a site streamer.
-- Keep that display fact on the same team-membership row; it does not create a streamer identity.
ALTER TABLE event_team_member DROP CONSTRAINT event_team_member_pkey;
ALTER TABLE event_team_member ALTER COLUMN streamer_id DROP NOT NULL;
ALTER TABLE event_team_member ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE event_team_member ADD COLUMN display_name text;
ALTER TABLE event_team_member ADD CONSTRAINT event_team_member_identity_check CHECK (
  (streamer_id IS NOT NULL AND display_name IS NULL)
  OR (streamer_id IS NULL AND NULLIF(BTRIM(display_name), '') IS NOT NULL)
);
ALTER TABLE event_team_member ADD PRIMARY KEY (id);
CREATE UNIQUE INDEX event_team_member_streamer_uq ON event_team_member (event_id, streamer_id)
  WHERE streamer_id IS NOT NULL;
CREATE UNIQUE INDEX event_team_member_display_name_uq ON event_team_member (event_id, event_team_id, display_name)
  WHERE streamer_id IS NULL;

CREATE OR REPLACE VIEW core_public.event_team_member AS
  SELECT m.event_id, m.event_team_id, m.streamer_id, m.position,
         m.is_captain, m.rating_label, m.rating_points, m.award,
         COALESCE(s.display_name, m.display_name) AS member_display_name,
         s.slug, s.profile_image_url
    FROM event_team_member m
    LEFT JOIN streamer s ON s.id = m.streamer_id AND s.visibility = 'public'
   WHERE (m.streamer_id IS NULL AND NULLIF(BTRIM(m.display_name), '') IS NOT NULL)
      OR s.id IS NOT NULL;

COMMENT ON COLUMN event_team_member.display_name IS
  '등록 스트리머가 아닌 대회 참가자의 출처 표기 이름. streamer_id 없이 공식 로스터에만 표시한다.';

-- Restore the original event roster model after reverting 0047.
DELETE FROM event_team_member WHERE streamer_id IS NULL;

DROP VIEW core_public.event_team_member;

DROP INDEX event_team_member_streamer_uq;
DROP INDEX event_team_member_display_name_uq;

ALTER TABLE event_team_member DROP CONSTRAINT event_team_member_identity_check;
ALTER TABLE event_team_member DROP CONSTRAINT event_team_member_pkey;
ALTER TABLE event_team_member DROP COLUMN display_name;
ALTER TABLE event_team_member DROP COLUMN id;
ALTER TABLE event_team_member ALTER COLUMN streamer_id SET NOT NULL;
ALTER TABLE event_team_member ADD PRIMARY KEY (event_id, streamer_id);

CREATE VIEW core_public.event_team_member AS
  SELECT m.event_id, m.event_team_id, m.streamer_id, m.position,
         m.is_captain, m.rating_label, m.rating_points, m.award
    FROM event_team_member m
    JOIN streamer s ON s.id = m.streamer_id AND s.visibility = 'public';

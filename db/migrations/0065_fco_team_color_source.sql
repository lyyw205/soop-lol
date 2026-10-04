-- Distinguish currently displayed profile squad from the former last-ranked-match source.
ALTER TABLE fco_team_colors ADD COLUMN source text NOT NULL DEFAULT 'rank-1vs1'
  CHECK (source IN ('rank-1vs1', 'profile-squad'));
ALTER TABLE fco_team_colors ADD COLUMN source_slot text;

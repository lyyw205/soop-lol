-- Official current 1v1 ELO, separate from club-value TOP 50 and profile chemistry.
CREATE TABLE fco_rating (
  ouid text PRIMARY KEY REFERENCES fco_account(ouid) ON DELETE CASCADE,
  nickname text NOT NULL,
  nexon_sn bigint NOT NULL,
  score numeric CHECK (score >= 0),
  source_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE fco_rating ENABLE ROW LEVEL SECURITY;

-- Latest independently observed official 1v1 team colors. Never infer from six squad slots.
CREATE TABLE fco_team_colors (
  ouid text PRIMARY KEY REFERENCES fco_account(ouid) ON DELETE CASCADE,
  nickname text NOT NULL,
  nexon_sn bigint NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  source_at timestamptz NOT NULL,
  colors jsonb NOT NULL CHECK (jsonb_typeof(colors) = 'array')
);
ALTER TABLE fco_team_colors ENABLE ROW LEVEL SECURITY;

-- Official daily TOP 50, stored once for all accounts. Unlisted does not mean rank 51.
CREATE TABLE fco_value_ranking (
  day date PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT now(),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) = 50)
);
ALTER TABLE fco_value_ranking ENABLE ROW LEVEL SECURITY;

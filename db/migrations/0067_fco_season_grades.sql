-- Profile 1v1 current division and immediately previous season's best division.
ALTER TABLE fco_rating ADD COLUMN current_grade jsonb;
ALTER TABLE fco_rating ADD COLUMN previous_best_grade jsonb;
ALTER TABLE fco_rating ADD COLUMN grades_checked_at timestamptz;

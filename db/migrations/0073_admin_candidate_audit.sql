-- Automatic sightings update counters, names and timestamps frequently. Keep the
-- internal audit for candidate decisions and deletion; do not copy every sighting.
DROP TRIGGER candidate_audit ON account_candidate;
CREATE TRIGGER candidate_state_audit AFTER UPDATE ON account_candidate
FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
EXECUTE FUNCTION audit_admin_row('candidate', 'id');
CREATE TRIGGER candidate_delete_audit AFTER DELETE ON account_candidate
FOR EACH ROW EXECUTE FUNCTION audit_admin_row('candidate', 'id');

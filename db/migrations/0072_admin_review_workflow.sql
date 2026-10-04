-- FC: event/context confirmation and match-value review are independent.
-- Historical value completions are preserved. Do not infer context approval from them.
ALTER TABLE match ADD COLUMN context_review_completed_at timestamptz;
ALTER TABLE match ADD COLUMN context_review_version integer NOT NULL DEFAULT 0;
ALTER TABLE event ADD COLUMN admin_version integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN match.context_review_completed_at IS 'FC 대회 소속·분류 판단 확인. 경기값 검수 및 공개 여부와 독립.';

CREATE OR REPLACE FUNCTION invalidate_match_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.game_code = 'fconline' AND OLD.game_code = 'fconline' THEN
    IF ROW(NEW.game_creation, NEW.game_creation_precision, NEW.game_duration, NEW.winning_team,
           NEW.blue_team_id, NEW.red_team_id, NEW.source, NEW.origin, NEW.mode_key)
       IS DISTINCT FROM ROW(OLD.game_creation, OLD.game_creation_precision, OLD.game_duration, OLD.winning_team,
           OLD.blue_team_id, OLD.red_team_id, OLD.source, OLD.origin, OLD.mode_key) THEN
      NEW.review_completed_at := NULL;
      NEW.review_version := OLD.review_version + 1;
    END IF;
    IF ROW(NEW.event_id, NEW.series_id, NEW.series_game_no, NEW.source_url)
       IS DISTINCT FROM ROW(OLD.event_id, OLD.series_id, OLD.series_game_no, OLD.source_url) THEN
      NEW.context_review_completed_at := NULL;
      NEW.context_review_version := OLD.context_review_version + 1;
    END IF;
  ELSIF ROW(NEW.game_code, NEW.game_creation, NEW.game_creation_precision, NEW.game_duration,
         NEW.winning_team, NEW.event_id, NEW.series_id, NEW.series_game_no,
         NEW.blue_team_id, NEW.red_team_id, NEW.visibility, NEW.source, NEW.origin, NEW.source_url)
     IS DISTINCT FROM
     ROW(OLD.game_code, OLD.game_creation, OLD.game_creation_precision, OLD.game_duration,
         OLD.winning_team, OLD.event_id, OLD.series_id, OLD.series_game_no,
         OLD.blue_team_id, OLD.red_team_id, OLD.visibility, OLD.source, OLD.origin, OLD.source_url) THEN
    NEW.review_completed_at := NULL;
    NEW.review_version := OLD.review_version + 1;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION invalidate_series_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.event_id, NEW.best_of, NEW.set_order_known, NEW.round_label, NEW.best_of_evidence)
     IS DISTINCT FROM ROW(OLD.event_id, OLD.best_of, OLD.set_order_known, OLD.round_label, OLD.best_of_evidence) THEN
    IF NEW.game_code = 'fconline' THEN
      UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
       WHERE series_id = NEW.id AND game_code = NEW.game_code;
    ELSE
      UPDATE match SET review_completed_at = NULL, review_version = review_version + 1
       WHERE series_id = NEW.id AND game_code = NEW.game_code;
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION invalidate_fco_context_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND to_jsonb(NEW) = to_jsonb(OLD) THEN RETURN NULL; END IF;
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.match_id ELSE NEW.match_id END;
  UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
   WHERE match_id = target AND game_code = 'fconline';
  RETURN NULL;
END $$;
CREATE TRIGGER fco_context_review AFTER INSERT OR UPDATE OR DELETE ON fco_match_context
FOR EACH ROW EXECUTE FUNCTION invalidate_fco_context_review();
CREATE TRIGGER fco_decision_review AFTER INSERT OR UPDATE OR DELETE ON fco_event_match_decision
FOR EACH ROW EXECUTE FUNCTION invalidate_fco_context_review();
CREATE TRIGGER fco_evidence_review AFTER INSERT OR UPDATE OR DELETE ON fco_context_evidence
FOR EACH ROW EXECUTE FUNCTION invalidate_fco_context_review();

CREATE FUNCTION version_admin_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.name, NEW.kind, NEW.organizer, NEW.source_url, NEW.starts_at, NEW.ends_at)
     IS DISTINCT FROM ROW(OLD.name, OLD.kind, OLD.organizer, OLD.source_url, OLD.starts_at, OLD.ends_at) THEN
    NEW.admin_version := OLD.admin_version + 1;
    IF NEW.game_code = 'fconline' THEN
      UPDATE match m SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
       WHERE m.game_code = 'fconline' AND (m.event_id = NEW.id
         OR EXISTS (SELECT 1 FROM match_series ms WHERE ms.id = m.series_id AND ms.event_id = NEW.id)
         OR EXISTS (SELECT 1 FROM fco_event_match_decision d WHERE d.event_id = NEW.id AND d.match_id = m.match_id));
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_admin_version BEFORE UPDATE ON event FOR EACH ROW EXECUTE FUNCTION version_admin_event();

-- API ingestion, identity links and direct correction paths also invalidate FC values.
CREATE FUNCTION invalidate_fco_participant_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE target text;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.match_id, NEW.side_no, NEW.ouid, NEW.nickname, NEW.streamer_id, NEW.outcome, NEW.goals, NEW.score_display, NEW.identity_basis)
    IS NOT DISTINCT FROM ROW(OLD.match_id, OLD.side_no, OLD.ouid, OLD.nickname, OLD.streamer_id, OLD.outcome, OLD.goals, OLD.score_display, OLD.identity_basis) THEN RETURN NULL; END IF;
  target := CASE WHEN TG_OP = 'DELETE' THEN OLD.match_id ELSE NEW.match_id END;
  UPDATE match SET review_completed_at = NULL, review_version = review_version + 1 WHERE match_id = target AND game_code = 'fconline';
  RETURN NULL;
END $$;
CREATE TRIGGER fco_participant_review AFTER INSERT OR UPDATE OR DELETE ON fco_match_participant
FOR EACH ROW EXECUTE FUNCTION invalidate_fco_participant_review();

-- Internal history is independent of public schedule-change announcements.
CREATE TABLE admin_audit (
  id bigserial PRIMARY KEY,
  scope text NOT NULL,
  scope_key text NOT NULL,
  entity text NOT NULL,
  operation text NOT NULL,
  before jsonb,
  after jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_scope_idx ON admin_audit (scope, scope_key, id DESC);
ALTER TABLE admin_audit ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE admin_audit IS '내부 변경 이력. 자동 갱신 포함. 삭제된 대상의 이력도 보존하며 공개 뷰에 노출하지 않는다.';
CREATE FUNCTION audit_admin_row() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE prev jsonb; nxt jsonb; scope_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN prev := to_jsonb(OLD) - 'updated_at'; END IF;
  IF TG_OP <> 'DELETE' THEN nxt := to_jsonb(NEW) - 'updated_at'; END IF;
  IF prev IS NOT DISTINCT FROM nxt THEN RETURN NULL; END IF;
  scope_id := COALESCE(nxt, prev) ->> TG_ARGV[1];
  INSERT INTO admin_audit (scope, scope_key, entity, operation, before, after)
    VALUES (TG_ARGV[0], scope_id, TG_TABLE_NAME, TG_OP, prev, nxt);
  RETURN NULL;
END $$;
CREATE TRIGGER streamer_audit AFTER INSERT OR UPDATE OR DELETE ON streamer FOR EACH ROW EXECUTE FUNCTION audit_admin_row('streamer', 'id');
CREATE TRIGGER account_link_audit AFTER INSERT OR UPDATE OR DELETE ON streamer_account FOR EACH ROW EXECUTE FUNCTION audit_admin_row('streamer', 'streamer_id');
CREATE TRIGGER career_audit AFTER INSERT OR UPDATE OR DELETE ON career_event FOR EACH ROW EXECUTE FUNCTION audit_admin_row('streamer', 'streamer_id');
CREATE TRIGGER candidate_audit AFTER UPDATE OR DELETE ON account_candidate FOR EACH ROW EXECUTE FUNCTION audit_admin_row('candidate', 'id');
CREATE TRIGGER context_audit AFTER INSERT OR UPDATE OR DELETE ON fco_match_context FOR EACH ROW EXECUTE FUNCTION audit_admin_row('match', 'match_id');
CREATE TRIGGER decision_audit AFTER INSERT OR UPDATE OR DELETE ON fco_event_match_decision FOR EACH ROW EXECUTE FUNCTION audit_admin_row('match', 'match_id');
ALTER TABLE career_event ADD COLUMN admin_version integer NOT NULL DEFAULT 0;
CREATE TRIGGER event_audit AFTER UPDATE ON event FOR EACH ROW EXECUTE FUNCTION audit_admin_row('event', 'id');
CREATE FUNCTION audit_fco_context_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.game_code = 'fconline' AND NEW.context_review_completed_at IS DISTINCT FROM OLD.context_review_completed_at THEN
    INSERT INTO admin_audit(scope, scope_key, entity, operation, before, after)
      VALUES ('match', NEW.match_id, '대회·분류 확정', 'UPDATE',
        to_jsonb(OLD.context_review_completed_at), to_jsonb(NEW.context_review_completed_at));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER context_confirmation_audit AFTER UPDATE ON match FOR EACH ROW EXECUTE FUNCTION audit_fco_context_confirmation();

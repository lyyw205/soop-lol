-- 사람의 경기 검수 완료와 자동 갱신 보호(reviewed_at)는 별개다.
-- 기존 보호 도장을 완료로 추정하지 않는다. 빈칸이 있어도 명시적으로 완료할 수 있다.
ALTER TABLE match ADD COLUMN review_completed_at timestamptz;
ALTER TABLE match ADD COLUMN review_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN match.review_completed_at IS '사람이 현재 경기 값을 확인하고 명시적으로 검수를 완료한 시각. 값이 달라지면 해제된다.';
COMMENT ON COLUMN match.review_version IS '검수 대상 값의 변경 번호. 오래된 화면에서 완료를 누르는 것을 막는다.';

-- 어느 저장 경로에서 바뀌든 완료를 해제한다. 같은 값의 재저장은 완료를 유지한다.
CREATE FUNCTION invalidate_match_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.game_code, NEW.game_creation, NEW.game_creation_precision, NEW.game_duration,
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
CREATE TRIGGER match_review_values BEFORE UPDATE ON match
FOR EACH ROW EXECUTE FUNCTION invalidate_match_review();

CREATE FUNCTION invalidate_participant_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.match_id, NEW.participant_id, NEW.streamer_id, NEW.puuid,
       NEW.observed_name, NEW.team_id, NEW.team_position, NEW.individual_position,
       NEW.champion_id, NEW.champion_name, NEW.kills, NEW.deaths, NEW.assists)
     IS NOT DISTINCT FROM ROW(OLD.match_id, OLD.participant_id, OLD.streamer_id, OLD.puuid,
       OLD.observed_name, OLD.team_id, OLD.team_position, OLD.individual_position,
       OLD.champion_id, OLD.champion_name, OLD.kills, OLD.deaths, OLD.assists) THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE match SET review_completed_at = NULL, review_version = review_version + 1
     WHERE match_id = OLD.match_id AND game_code = 'lol';
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.match_id IS DISTINCT FROM OLD.match_id) THEN
    UPDATE match SET review_completed_at = NULL, review_version = review_version + 1
     WHERE match_id = NEW.match_id AND game_code = 'lol';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER participant_review_values AFTER INSERT OR UPDATE OR DELETE ON match_participant
FOR EACH ROW EXECUTE FUNCTION invalidate_participant_review();

-- 같은 시리즈의 BO·분류·순서 변경은 모든 세트에 영향을 준다.
CREATE FUNCTION invalidate_series_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF ROW(NEW.event_id, NEW.best_of, NEW.set_order_known, NEW.round_label)
     IS DISTINCT FROM ROW(OLD.event_id, OLD.best_of, OLD.set_order_known, OLD.round_label) THEN
    UPDATE match SET review_completed_at = NULL, review_version = review_version + 1
     WHERE series_id = NEW.id AND game_code = NEW.game_code;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER series_review_values AFTER UPDATE ON match_series
FOR EACH ROW EXECUTE FUNCTION invalidate_series_review();

-- 아키텍처 감사(2026-08-12)에서 걸린 스키마 구멍 두 개를 메운다.
--
-- 1) 0008 의 event_team·event_team_member 에 RLS 가 빠져 있었다.
--    0002 가 세운 방침은 "모든 테이블 deny-all, 접근은 core_public 뷰로만"인데
--    이 두 테이블만 예외로 남아 있었다 — 0012 를 기존 관례와 대조하다 발견.
--    지금은 PostgREST 를 안 쓰니 실해가 없지만, 방침의 구멍은 쓰기 시작한 날 사고가 된다.
--
-- 2) event_lead_participant 는 UPSERT(DO UPDATE)와 재연결 UPDATE 를 받는 가변
--    테이블인데 updated_at 이 없어서 "이 관측이 언제 마지막으로 갱신됐나"를
--    알 수 없었다. 같은 성격의 다른 테이블(streamer_account 등)은 전부 있다.

ALTER TABLE event_team        ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_team_member ENABLE ROW LEVEL SECURITY;

ALTER TABLE event_lead_participant
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE TRIGGER event_lead_participant_touch BEFORE UPDATE ON event_lead_participant
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- observed_at 은 **처음 관측된 시각**이다. UPSERT 가 일부러 안 건드린다 —
-- 갱신 시각은 updated_at 이 맡는다. 이 구분이 없으면 "언제 신청했나"가 사라진다.
COMMENT ON COLUMN event_lead_participant.observed_at IS
  '처음 관측된 시각. 재수집으로 갱신되지 않는다 — 갱신 시각은 updated_at.';

-- 확정 승격 규칙도 여기 못박는다. event_lead.kind 의 'unknown' 은 event.kind 에 없다.
-- 조사 없이 승격하면 CHECK 위반으로 죽는 게 **의도된 동작**이다 —
-- 무엇인지 모르는 채로 공개 테이블에 넣지 않는다(§11-8 관측/수기 구분과 같은 정신).
COMMENT ON COLUMN event_lead.kind IS
  '단서 단계의 분류. ''unknown'' 은 event 로 승격할 수 없다(event.kind CHECK 에 없음) — '
  '검수에서 scrim/tournament/showmatch/other 중 하나로 정한 뒤에만 승격한다.';

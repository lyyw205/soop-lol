-- 대회 후보 경기의 포함/제외 결정과 브래킷 위치 (FC 검수 [경기] 탭).
--
-- ★ 왜 필요한가 (2026-09-24 뿌챔스 검수)
--   지금까지 「match.event_id 가 있다 = 대회 경기」 하나뿐이라, 조사자가 개막 전 연습으로 본 경기를
--   빼는 방법도, 뺐다는 사실을 남길 곳도 없었다. 뺀 경기가 목록에서 사라지면 「안 붙인 건지 뺀 건지」
--   알 수 없고 되돌릴 수도 없다. 브래킷 번호(「1경기」「8위 결정전」)를 둘 곳도 없었다.
--
-- ★ 정본은 이 표의 **최신 행**이다 (fco_match_context 와 같은 append-only — 결정 이력이 남는다).
--   match.event_id(공개 화면이 읽는 값)는 저장 코드가 같은 트랜잭션에서 맞춘다:
--   include → 그 행사로 연결, exclude → 그 행사 연결을 푼다. 둘이 어긋나지 않는지는
--   verify:fco-context 가 검사한다.
--
-- ★ 조사(auto)가 제안하고 사람(admin)이 바꾼다. 최신 행이 admin 이면 자동 경로가 못 덮는다.
--   사람이 안 건드린 경기는 조사 제안이 그대로 저장·공개되고, 대회 일괄 승인이 admin 으로 굳힌다.

CREATE TABLE fco_event_match_decision (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  match_id      text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  decision      text NOT NULL CHECK (decision IN ('include', 'exclude')),
  -- 브래킷 위치. 번호는 정렬용, 이름표는 화면에 그대로 쓴다(「13경기 · 7위 결정전」).
  bracket_no    smallint CHECK (bracket_no IS NULL OR bracket_no > 0),
  bracket_label text CHECK (bracket_label IS NULL OR btrim(bracket_label) <> ''),
  -- 결정의 근거. 제외는 이유 없이 못 한다(저장 코드가 막는다) — 「왜 뺐나」가 남아야 되돌릴 수 있다.
  note          text,
  created_by    text NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fco_event_match_decision_latest_idx
  ON fco_event_match_decision (event_id, match_id, created_at DESC);
CREATE INDEX fco_event_match_decision_match_idx ON fco_event_match_decision (match_id);
ALTER TABLE fco_event_match_decision ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fco_event_match_decision IS
  '대회 후보 경기의 포함/제외·브래킷 위치 결정 이력. (event, match) 의 최신 행이 현재 결정이다. '
  'match.event_id 는 저장 코드가 이 결정에 맞춘다.';

-- 0024 — 검수 서술 기록을 한 표로 모은다.
--
-- 기존에는 프레임 note, 후보 JSON의 observed/why/open_questions, match.result_evidence가
-- 각각 텍스트를 들고 있었다. 모두 "무엇을 보고 어떻게 판단했나"라는 같은 종류의
-- 기록이므로 review_record 하나로 이관한다. 승패·시간·연결 같은 구조화된 사실은 옮기지 않는다.

CREATE TABLE review_record (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      uuid REFERENCES event_lead(id) ON DELETE CASCADE,
  match_id     text REFERENCES match(match_id) ON DELETE CASCADE,
  candidate_id text,
  frame_id     uuid REFERENCES match_evidence_frame(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('observation','assessment','question','final_evidence')),
  body         text NOT NULL CHECK (btrim(body) <> ''),
  created_by   text NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto','admin','migration')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 연결을 중복해서 들고 있지 않는다. 그래야 match 삭제가 남겨야 할 frame 기록을
  -- 지우거나, lead 삭제가 match의 최종 근거를 지우는 연쇄 삭제가 생기지 않는다.
  CHECK (
    (type = 'final_evidence' AND match_id IS NOT NULL
      AND lead_id IS NULL AND candidate_id IS NULL AND frame_id IS NULL)
    OR
    (type = 'observation' AND lead_id IS NOT NULL AND match_id IS NULL
      AND ((candidate_id IS NOT NULL AND frame_id IS NULL)
        OR (candidate_id IS NULL AND frame_id IS NOT NULL)))
    OR
    (type IN ('assessment','question') AND lead_id IS NOT NULL
      AND candidate_id IS NOT NULL AND match_id IS NULL AND frame_id IS NULL)
  )
);

CREATE INDEX review_record_lead_idx ON review_record (lead_id, created_at);
CREATE INDEX review_record_match_idx ON review_record (match_id, created_at) WHERE match_id IS NOT NULL;
CREATE INDEX review_record_frame_idx ON review_record (frame_id) WHERE frame_id IS NOT NULL;
CREATE UNIQUE INDEX review_record_final_match_uq ON review_record (match_id) WHERE type = 'final_evidence';
CREATE UNIQUE INDEX review_record_frame_observation_uq ON review_record (frame_id) WHERE type = 'observation';
CREATE UNIQUE INDEX review_record_candidate_kind_uq
  ON review_record (lead_id, candidate_id, type) WHERE candidate_id IS NOT NULL AND type <> 'question';

-- 프레임에서 읽은 사실.
INSERT INTO review_record (lead_id, frame_id, type, body, created_by, created_at)
SELECT lead_id, id, 'observation', note, 'migration', created_at
  FROM match_evidence_frame
 WHERE note IS NOT NULL AND btrim(note) <> '';

-- 후보 관찰·판단·질문. 후보의 구조(구간·결론·연결)는 raw.candidates에 남고,
-- 사람이 읽는 서술만 이 표로 옮긴다.
INSERT INTO review_record (lead_id, match_id, candidate_id, type, body, created_by)
SELECT el.id, NULL, c ->> 'id', 'observation', c ->> 'observed', 'migration'
  FROM event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
 WHERE c ->> 'observed' IS NOT NULL AND btrim(c ->> 'observed') <> '';

INSERT INTO review_record (lead_id, match_id, candidate_id, type, body, created_by)
SELECT el.id, NULL, c ->> 'id', 'assessment', c ->> 'why', 'migration'
  FROM event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
 WHERE c ->> 'why' IS NOT NULL AND btrim(c ->> 'why') <> '';

INSERT INTO review_record (lead_id, match_id, candidate_id, type, body, created_by)
SELECT el.id, NULL, c ->> 'id', 'question', q.value, 'migration'
  FROM event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
 CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(c -> 'open_questions', '[]'::jsonb)) q(value)
 WHERE btrim(q.value) <> '';

-- 최종 승패 근거. 과거 행은 lead가 없을 수 있으므로 match 연결만 보장한다.
INSERT INTO review_record (match_id, type, body, created_by)
SELECT match_id, 'final_evidence', result_evidence, 'migration'
  FROM match
 WHERE result_evidence IS NOT NULL AND btrim(result_evidence) <> '';

-- ★ 이 마이그레이션에서는 원본 텍스트 컬럼을 아직 제거하지 않는다. 기존 수집 결과·시드·
-- 검수 저장 경로가 모두 review_record를 쓰도록 전환한 다음, 별도 마이그레이션에서
-- raw.candidates의 서술 키와 아래 두 레거시 칼럼을 제거한다. 백필과 삭제를 한 번에 하면
-- 구버전 작업자가 결과를 반영하는 순간 기록이 유실될 수 있다.
--   match_evidence_frame.note
--   match.result_evidence

-- PostgREST에는 노출하지 않는다. 관리자 서버와 조사 도구는 DB 역할로만 접근한다.
ALTER TABLE review_record ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE review_record IS
  'VOD 검수의 서술 기록 단일 원천. 프레임 관찰·후보 판단·남은 질문·최종 승패 근거를 type으로 구분한다.';

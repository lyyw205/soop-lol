-- 0040 — 검수 서술 기록의 정본 전환을 끝낸다 (0024 의 contract 단계, docs/CK-REVIEW-RECORD-MODEL.md).
--
-- 0024 는 review_record 를 만들고 옛 칸(프레임 note, 후보 JSON 의 observed/why/open_questions,
-- match.result_evidence)을 **남겨 둔** expand 단계였다. 그 뒤로 모든 저장이 두 곳에 같이 썼고,
-- 화면은 "새 곳에 없으면 옛 곳" 으로 읽었다. 이제 코드가 review_record 만 읽고 쓰므로 옛 칸을 걷는다.
--
-- 적용 전 운영 DB 대조(2026-09-26, 읽기 전용):
--   · 프레임 메모·후보 관찰/해석·경기 결과 근거 — review_record 누락 0
--   · 결과 근거 88건은 review_record 에만 있다(옛 칸이 비어 있음) → review_record 가 기준이다
--   · 후보 2건의 open_questions 가 배열이 아니라 **문자열**이었다. 0024 이후 병합 코드가 그 문자열을
--     글자마다 질문 하나로 쪼개 저장해 **한 글자짜리 질문 121행**이 생겼다(원인: for..of 가 문자열을 돈다).
--
-- ★ 순서: ① 누락 보강 → ② 글자 조각 질문 복구 → ③ 후보 JSON 에서 서술 키 제거 → ④ 옛 칸 제거.
--   ①②를 ③④보다 먼저 해야 옛 칸에만 있던 글이 사라지지 않는다. 모두 멱등이다.

-- ① 옛 칸에만 있는 서술을 정본으로 옮긴다 (실측 0건이지만, 적용 사이에 옛 코드가 쓴 것을 잃지 않게).
INSERT INTO review_record (lead_id, frame_id, type, body, created_by)
SELECT f.lead_id, f.id, 'observation', btrim(f.note), 'migration'
  FROM match_evidence_frame f
 WHERE nullif(btrim(f.note), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM review_record r WHERE r.frame_id = f.id AND r.type = 'observation');

INSERT INTO review_record (match_id, type, body, created_by)
SELECT m.match_id, 'final_evidence', btrim(m.result_evidence), 'migration'
  FROM match m
 WHERE nullif(btrim(m.result_evidence), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM review_record r WHERE r.match_id = m.match_id AND r.type = 'final_evidence');

INSERT INTO review_record (lead_id, candidate_id, type, body, created_by)
SELECT el.id, c ->> 'id', v.type, btrim(v.body), 'migration'
  FROM event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(el.raw -> 'candidates') = 'array' THEN el.raw -> 'candidates' ELSE '[]'::jsonb END) c
 CROSS JOIN LATERAL (VALUES ('observation', c ->> 'observed'), ('assessment', c ->> 'why')) v(type, body)
 WHERE nullif(btrim(v.body), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM review_record r
                    WHERE r.lead_id = el.id AND r.candidate_id = c ->> 'id' AND r.type = v.type);

-- ② 질문. 문자열로 적힌 질문은 **하나의 질문**이다. 그 후보의 기존 질문 행(글자 조각)을 지우고 되살린다.
DELETE FROM review_record r
 USING event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(el.raw -> 'candidates') = 'array' THEN el.raw -> 'candidates' ELSE '[]'::jsonb END) c
 WHERE r.lead_id = el.id AND r.candidate_id = c ->> 'id' AND r.type = 'question'
   AND jsonb_typeof(c -> 'open_questions') = 'string';

INSERT INTO review_record (lead_id, candidate_id, type, body, created_by)
SELECT el.id, c ->> 'id', 'question', btrim(q.body), 'migration'
  FROM event_lead el
 CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(el.raw -> 'candidates') = 'array' THEN el.raw -> 'candidates' ELSE '[]'::jsonb END) c
 CROSS JOIN LATERAL (
   SELECT value AS body FROM jsonb_array_elements_text(
     CASE jsonb_typeof(c -> 'open_questions')
       WHEN 'array'  THEN c -> 'open_questions'
       WHEN 'string' THEN jsonb_build_array(c -> 'open_questions')
       ELSE '[]'::jsonb END)
 ) q
 WHERE nullif(btrim(q.body), '') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM review_record r
                    WHERE r.lead_id = el.id AND r.candidate_id = c ->> 'id'
                      AND r.type = 'question' AND btrim(r.body) = btrim(q.body));

-- ③ 후보 JSON 에는 구조(id·구간·결론·연결·대체 관계)만 남긴다. 순서는 그대로 둔다.
UPDATE event_lead el
   SET raw = jsonb_set(el.raw, '{candidates}', (
         SELECT COALESCE(jsonb_agg(c - 'observed' - 'why' - 'open_questions' ORDER BY ord), '[]'::jsonb)
           FROM jsonb_array_elements(el.raw -> 'candidates') WITH ORDINALITY t(c, ord)))
 WHERE jsonb_typeof(el.raw -> 'candidates') = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(el.raw -> 'candidates') c
                WHERE c ? 'observed' OR c ? 'why' OR c ? 'open_questions');

-- ④ 옛 칸 제거. 이 칸들을 읽는 뷰·함수는 없다(0024 이후 마이그레이션 대조).
ALTER TABLE match_evidence_frame DROP COLUMN note;
ALTER TABLE match DROP COLUMN result_evidence;

COMMENT ON TABLE review_record IS
  '검수 서술 기록의 유일한 정본 — 프레임 관찰, 후보 관찰·판단·질문, 경기 최종 근거. '
  '승패·시간·연결 같은 구조화된 사실은 각 표에 있고, 사람이 읽는 문장은 여기에만 있다(0040).';

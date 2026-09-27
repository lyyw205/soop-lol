-- 경기 분류의 주인을 event.kind 하나로 되돌린다. 그리고 대회 상세 화면이 "모르는 걸 아는 척"
-- 하지 않도록 순서·시각의 확실성을 저장한다.
--
-- ★ 왜 (2026-09-24 사고)
--   ① 멸망전 4개 대회(153경기)가 공개 화면에서 "내전"으로 집계됐다. VOD 조사 반영(ck-merge)이
--      기존 대회를 찾아 **연결만** 해야 하는데 upsertEvent 로 분류·주최·기간·출처·이름까지
--      덮었고, 분류를 안 적은 입력에 기본값 'ck' 가 들어갔다.
--   ② 검수 목록이 event_lead.kind 로 탭을 나눠 멸망전 VOD 가 CK 탭에 섰다. 이 칸은 세 가지
--      뜻(시트가 경기 화면 감지 / 조사자의 분류 추정 / 탭 기준)으로 쓰이며 event.kind 와 따로 놀았다.
--      event_lead.event_id 는 0/62 로 한 번도 쓰이지 않았다 — VOD 하나에 경기가 여럿이라
--      단일 연결이 맞지 않는다(ck.ts upsertEventLead 주석).
--   ③ 단서→경기 연결 규칙이 SQL 네 곳에 복사돼 있었고, 후보 JSON 의 match_id 는 FK 가 없어
--      존재하지 않는 경기를 가리키는 참조 12건이 들어가 있었다.
--
-- 이 마이그레이션 뒤의 규칙:
--   · 경기 분류 = 그 경기가 속한 event 의 kind. 다른 곳에 분류를 적지 않는다.
--   · event.kind 에 기본값이 없다. 만드는 쪽이 반드시 정한다.
--   · 단서↔경기 연결은 lead_match 뷰 하나가 정의한다.

-- ── 1. event.kind 기본값 제거 ────────────────────────────────────────
-- 0031 이 'scrim' → 'ck' 로 바꿔 둔 기본값이다. 기본값이 있으면 분류를 빠뜨린 입력이
-- 오류 대신 "내전" 이 된다 — 사고 ① 이 정확히 그 길로 났다.
ALTER TABLE event ALTER COLUMN kind DROP DEFAULT;

-- ── 2. event_lead 의 분류·대회 칸 제거 ───────────────────────────────
-- 분류는 연결된 경기의 event 에서 계산한다(lead_match). 시트의 "경기 화면 감지" 는
-- 이미 raw.games / raw.notices 에 근거째 남아 있으므로 그걸 직접 읽는다(prep-ck-frames).
ALTER TABLE event_lead DROP COLUMN kind;
ALTER TABLE event_lead DROP COLUMN event_id;

-- ── 3. 후보가 가리키는 경기 ID 오기 복구 ─────────────────────────────
-- 'meljang-2022-s2-g25s1' 처럼 ':' 대신 '-' 로 적힌 12건. 고친 ID 가 실제로 있을 때만 바꾼다.
UPDATE event_lead el
   SET raw = jsonb_set(el.raw, '{candidates}', fixed.candidates)
  FROM (
    SELECT el2.id,
           jsonb_agg(
             CASE WHEN c ->> 'match_id' IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM match WHERE match_id = c ->> 'match_id')
                   AND EXISTS (SELECT 1 FROM match
                                WHERE match_id = regexp_replace(c ->> 'match_id', '-(g\d+s\d+)$', ':\1'))
                  THEN jsonb_set(c, '{match_id}',
                                 to_jsonb(regexp_replace(c ->> 'match_id', '-(g\d+s\d+)$', ':\1')))
                  ELSE c END
             ORDER BY ord) AS candidates
      FROM event_lead el2
      CROSS JOIN LATERAL jsonb_array_elements(el2.raw -> 'candidates') WITH ORDINALITY AS t(c, ord)
     WHERE jsonb_typeof(el2.raw -> 'candidates') = 'array'
     GROUP BY el2.id
  ) fixed
 WHERE fixed.id = el.id AND el.raw -> 'candidates' IS DISTINCT FROM fixed.candidates;

-- ── 4. 단서↔경기 연결: 정의를 한 곳에 ────────────────────────────────
-- 세 갈래를 합친다. 저장하지 않고 계산하므로 새 쓰기 경로가 생기지 않는다.
--   frame     근거 프레임이 가리키는 경기
--   candidate 후보 결론이 가리키는 경기
--   source    이 VOD 를 출처로 적은 경기 (①②가 비어도 남는 고아를 놓치지 않으려고)
-- 존재하는 경기만 돌려준다. 끊어진 후보 참조는 lead_candidate_dangling 이 따로 보여준다.
CREATE VIEW lead_match AS
SELECT DISTINCT r.lead_id, r.match_id
  FROM (
    SELECT lead_id, match_id FROM match_evidence_frame WHERE match_id IS NOT NULL
    UNION ALL
    SELECT el.id, c ->> 'match_id'
      FROM event_lead el
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
     WHERE c ->> 'match_id' IS NOT NULL
    UNION ALL
    SELECT el.id, m.match_id FROM event_lead el JOIN match m ON m.source_url = el.url
     WHERE el.url IS NOT NULL
  ) r
  JOIN match m ON m.match_id = r.match_id;

COMMENT ON VIEW lead_match IS
  '단서(VOD)와 경기의 연결 — 근거 프레임·후보 결론·출처 URL 을 합친 유일한 정의. (lead_id, match_id) 중복 없음.';

-- 후보 JSON 은 FK 를 걸 수 없다. 저장 시 검사하고, 사후에 생긴 끊김은 여기서 드러난다.
CREATE VIEW lead_candidate_dangling AS
SELECT el.id AS lead_id, c ->> 'id' AS candidate_id, c ->> 'match_id' AS match_id
  FROM event_lead el
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
 WHERE c ->> 'match_id' IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM match m WHERE m.match_id = c ->> 'match_id');

COMMENT ON VIEW lead_candidate_dangling IS
  '존재하지 않는 경기를 가리키는 후보. 비어 있어야 정상이다(verify:db 가 검사한다).';

-- ── 5. 단판도 시리즈로 ───────────────────────────────────────────────
-- 대회는 event → 시리즈(라운드) → 세트 한 가지 모양이어야 라운드명을 둘 곳이 하나다.
-- 공개 화면은 이미 단판을 COALESCE(series_id, match_id) 로 "혼자인 시리즈" 처럼 다룬다.
-- 시리즈 ID 는 경기 ID 를 그대로 쓴다 — 시드의 `${slug}:${series ?? id}` 규칙과 같다.
INSERT INTO match_series (id, game_code, event_id)
SELECT m.match_id, m.game_code, m.event_id
  FROM match m
 WHERE m.origin = 'wiki_seed' AND m.series_id IS NULL AND m.event_id IS NOT NULL;

UPDATE match
   SET series_id = match_id, series_game_no = 1, event_id = NULL
 WHERE origin = 'wiki_seed' AND series_id IS NULL AND event_id IS NOT NULL;

-- ── 6. 라운드명과 순서·시각의 확실성 ─────────────────────────────────
ALTER TABLE match_series
  ADD COLUMN round_label text CHECK (round_label IS NULL OR btrim(round_label) <> ''),
  -- 세트 순서를 출처에서 확인했나. 시드 생성기는 세트별 승자가 없으면 승리 세트를 앞에
  -- 몰아 넣는다(build-meljang.mjs) — 그 순서는 우리가 만든 것이라 false 다.
  ADD COLUMN set_order_known boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN match_series.round_label IS
  '대회 안의 위치 (예: "8강 2경기", "조별리그 4일차 3경기"). 세트 번호는 붙이지 않는다.';
COMMENT ON COLUMN match_series.set_order_known IS
  '세트 순서를 출처에서 확인했으면 true. false 면 화면은 "1세트·2세트" 로 단정하지 않는다.';

-- VOD 판독으로 세트를 하나하나 본 시리즈만 순서를 안다고 본다.
UPDATE match_series ms SET set_order_known = true
 WHERE NOT EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id AND m.origin = 'wiki_seed')
   AND EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id);

ALTER TABLE match
  ADD COLUMN game_creation_precision text NOT NULL DEFAULT 'datetime'
    CHECK (game_creation_precision IN ('datetime', 'date'));

COMMENT ON COLUMN match.game_creation_precision IS
  '''date'' 면 game_creation 의 시각은 의미가 없다(날짜만 안다). 시드 생성기는 19시·20시를 지어 넣으므로 '
  '자정이 아니라고 시각을 아는 것이 아니다. 기본값은 API·VOD 판독처럼 실제 시각을 아는 경로 기준이다.';

-- 시드 경기는 시각을 모른다고 본다. 시드가 시각을 확인했다고 적은 경우만 나중에 되돌린다.
UPDATE match SET game_creation_precision = 'date' WHERE origin = 'wiki_seed';

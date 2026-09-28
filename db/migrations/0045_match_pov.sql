-- 0045 — 한 경기를 여러 VOD(시점)가 보면, 경기 값은 한 벌로 두고 시점만 여러 벌 붙인다.
--
-- ★ 왜: 같은 CK 를 9명이 방송했다. 두 번째 VOD 부터는 "그 경기와 같다" 를 남길 길이
--   `resultType: match` 재제출뿐이었고, 재제출은 참가자 10명을 지우고 다시 썼다. 덮어쓰기가
--   무서운 조사자는 사진을 안 붙였고(임아니 VOD 41장이 검수 화면에서 0장), 대담한 조사자는
--   못 본 값까지 옮겨 적어 확인 안 한 값이 "일치" 로 보였다(2026-09-27). docs/CK-MULTI-POV-PLAN.md
--
-- ★ 일치·불일치는 저장하지 않는다. `observed`(이 화면에서 직접 읽은 값)만 저장하고, 볼 때마다
--   현재 경기 값과 비교해 계산한다. 사람이 값을 고치면 모든 시점의 비교가 그 즉시 바뀐다.
--   불일치를 사람이 봤는지는 match.review_completed_at 과 칸별 제출 시각으로 구분한다(0043).

CREATE TABLE match_pov (
  match_id     text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES event_lead(id) ON DELETE CASCADE,
  -- 이 VOD 방송 주인. 채널이 등록 안 됐으면 비어 있다.
  streamer_id  uuid REFERENCES streamer(id) ON DELETE SET NULL,
  -- created: 이 시점이 경기를 만들었다 · added: 이미 있던 경기에 시점을 더했다.
  role         text NOT NULL CHECK (role IN ('created', 'added')),
  -- 2단계(가벼운 모드)에서 'light' 가 추가된다.
  mode         text NOT NULL DEFAULT 'full' CHECK (mode IN ('full')),
  -- own: 방송 주인 본인 클라이언트 화면 · rebroadcast: 남의 방송을 띄운 화면(독립 시점이 아니다).
  source       text NOT NULL CHECK (source IN ('own', 'rebroadcast')),
  -- 직접 읽은 칸만. 칸마다 {"v": 값, "at": 제출 시각}. 못 읽은 칸은 키가 없다.
  --   { "match": { "winning_team": {v,at}, "duration": {v,at}, "series_game_no": {v,at} },
  --     "participants": { "<사람 키>": { "ident": {...}, "team": {v,at}, "position": {v,at},
  --                                      "champion_id": {v,at}, "kills": {v,at}, ... } } }
  observed     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- 같은 경기라고 본 근거(조사자 관찰). 시점 추가에는 필수다(검사는 저장 도구가 한다).
  link_basis   text,
  -- 이 시점의 제출로 실제로 채운 경기 칸. 검수 보호 등으로 안 채웠으면 넣지 않는다.
  filled       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- 관측값이 바뀌거나 철회된 이력. 재제출만으로 불일치가 조용히 사라지지 않게 한다.
  --   review_record 는 후보·프레임 단위 제약(0024)이라 한 시점의 반복 이력을 담을 수 없어 여기 둔다.
  history      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, lead_id)
);

CREATE INDEX match_pov_lead_idx ON match_pov (lead_id);

COMMENT ON TABLE match_pov IS
  '경기 × VOD 시점. 경기 값은 match 에 한 벌, 이 시점이 직접 읽은 값은 observed 에. 일치 여부는 저장하지 않고 계산한다.';

-- 0002 와 같은 이유 — public 스키마의 표는 PostgREST 로 노출되므로 RLS 를 켠다.
ALTER TABLE match_pov ENABLE ROW LEVEL SECURITY;

-- ★ lead_match 의 URL 연결은 VOD 단서에만 적용한다. FC 단서(fc:208178709:13100)가 같은 VOD 주소라는
--   이유만으로 롤 경기에 이어져 CK 검수 목록에 섞였다. 시점 기록도 VOD-경기 연결로 인정한다.
CREATE OR REPLACE VIEW lead_match AS
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
     WHERE el.url IS NOT NULL AND el.source_key LIKE 'vod:%'
    UNION ALL
    SELECT lead_id, match_id FROM match_pov
  ) r
  JOIN match m ON m.match_id = r.match_id;

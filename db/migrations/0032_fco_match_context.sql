-- FC 온라인 경기의 "맥락" 저장 구조 (FCO-MATCH-CONTEXT-SKILL-PLAN 구현 순서 2)
--
-- 경기 사실(누가 이겼나)은 넥슨 API가 정본이고 이미 match·fco_*에 있다.
-- 여기서 담는 것은 "무슨 판이었나"다 — 단순 친선인가, CK인가, 대회인가, 아직 모르는가.
--
-- ★ 현재 맥락의 파생 규칙 (읽는 쪽은 이 순서 하나만 쓴다):
--     1. event 연결이 있으면(직접 또는 match_series 경유) → 그 event.kind 가 맥락이다.
--     2. 없으면 fco_match_context 의 최신 행이 맥락이다 ('casual' 또는 'unresolved').
--     3. 그것도 없으면 '미조사'다.
--   CK·대회 결론을 여기 문자열로 두지 않는다 — event 연결과 중복 저장하면 반드시 어긋난다
--   (MULTI-GAME-FCONLINE-PLAN §4: event_linked 는 상태가 아니라 event_id IS NOT NULL 이 답한다).
--
-- ★ 왜 append-only 인가: 계획이 "판단 변경 이력도 보존한다"를 요구한다. UPDATE 로 덮으면
--   이력이 죽고, 별도 이력 표를 두면 두 벌이 어긋난다. 최신 행이 곧 현재 판단이므로
--   "경기당 현재 최종 판단 하나"가 구조로 성립하고, 옛 판단은 그대로 이력이 된다.
--
-- ★ 재수집 보호: 공급자 재수집(saveFcoMatch)은 이 두 표를 아예 모른다. 사람이 남긴
--   맥락·근거를 자동 경로가 덮을 방법이 구조적으로 없다. 반대 방향 보호(자동 조사가
--   admin 판단을 덮는 것)는 저장 코드가 막고 verify:fco-context 가 회귀 검증한다.

CREATE TABLE fco_match_context (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  -- casual     = 단순 친선으로 판단했다 (근거 필수)
  -- unresolved = 조사했으나 아직 모른다 (남은 질문 필수)
  -- ⚠ 'ck'·'tournament' 는 여기 없다. 그 결론은 event 를 만들어 연결하는 것이다.
  judgment     text NOT NULL CHECK (judgment IN ('casual', 'unresolved')),
  note         text NOT NULL CHECK (btrim(note) <> ''),
  created_by   text NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto', 'admin')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fco_match_context_match_idx ON fco_match_context (match_id, created_at DESC);
ALTER TABLE fco_match_context ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE fco_match_context IS
  'FC 경기 맥락 판단의 append-only 이력. 최신 행 = 현재 판단. '
  'event 연결이 있으면 그쪽이 정본이고 이 표의 행은 이력일 뿐이다.';
COMMENT ON COLUMN fco_match_context.note IS
  '판단 근거(casual) 또는 남은 질문(unresolved). 빈 도장은 못 찍는다 — 지어내지 않기 위한 강제.';

-- 확인된 근거 — 한 경기에 여러 개. 다른 POV·공지·채팅·음성이 각각 한 행이다.
-- ⚠ 경기당 accepted 하나 같은 유일성을 두지 않는다 (계획 데이터 계약 3).
--   현재 최종 판단의 유일성은 fco_match_context 의 최신 행이 담당하고,
--   근거는 많을수록 좋다. 근거 행은 판단이 바뀌어도 지우지 않는다.
CREATE TABLE fco_context_evidence (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id     text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  -- 멱등 재전송 키. 조사자가 정한다 (예: 'vod:207643193@1479', 'notice:pick-182785').
  -- 같은 키 재전송은 중복을 만들지 않는다. 내용 수정은 admin 경로만 허용된다(저장 코드).
  evidence_key text NOT NULL CHECK (btrim(evidence_key) <> ''),
  kind         text NOT NULL CHECK (kind IN ('vod_frame', 'chat', 'audio', 'notice', 'url')),
  vod_title_no bigint,
  channel_id   text,
  at_sec       integer,          -- VOD 전체 초 (분할 파일 로컬 시각이 아니다 — ck:probe 축 그대로)
  end_sec      integer,
  url          text,
  observed     text NOT NULL CHECK (btrim(observed) <> ''),  -- 본 것
  why          text,                                          -- 그래서 어떻게 봤나. 관찰과 섞지 않는다
  created_by   text NOT NULL DEFAULT 'auto' CHECK (created_by IN ('auto', 'admin')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, evidence_key),
  -- 근거 종류가 요구하는 최소 좌표. "프레임을 봤다"는 어느 VOD 몇 초인지 없이는 근거가 아니다.
  CONSTRAINT fco_evidence_vod_coords CHECK (kind <> 'vod_frame' OR (vod_title_no IS NOT NULL AND at_sec IS NOT NULL)),
  CONSTRAINT fco_evidence_url_target CHECK (kind <> 'url' OR url IS NOT NULL)
);

CREATE INDEX fco_context_evidence_match_idx ON fco_context_evidence (match_id, created_at);
CREATE INDEX fco_context_evidence_vod_idx ON fco_context_evidence (vod_title_no) WHERE vod_title_no IS NOT NULL;
ALTER TABLE fco_context_evidence ENABLE ROW LEVEL SECURITY;

-- LoL 전량 조사(ck-research) 중 실제로 연 화면에서 FC 온라인이 보였을 때의 가벼운 교차 단서.
-- 단서는 채널·VOD 좌표라서 event_lead 가 이미 맞는 그릇이다 — matchId 와 연결하지 않는다
-- (연결은 fco-match-context 조사가 API 경기와 대조한 뒤에 한다).
ALTER TABLE event_lead DROP CONSTRAINT event_lead_source_check;
ALTER TABLE event_lead ADD CONSTRAINT event_lead_source_check
  CHECK (source IN ('vod_title', 'board_post', 'chat_notice', 'live_title', 'official_hub', 'manual', 'fc_screen'));
COMMENT ON CONSTRAINT event_lead_source_check ON event_lead IS
  'fc_screen = LoL 조사 중 실제로 연 프레임에 FC 화면이 보였다는 교차 단서(0032). '
  '프레임을 뽑기만 한 것은 단서가 아니다 — 연 것만 남긴다.';

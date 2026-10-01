-- FC 온라인: 넥슨 API 없이 VOD 화면으로만 아는 경기를 저장할 자리 (docs/FCO-SCREEN-MATCH-DESIGN.md §3·§10).
--
-- 넥슨 목록 API 는 한국 날짜 기준 최근 30일만 준다. 그 이전 경기, 그리고 등록 계정의 API 기록에서
-- 빠진 경기는 화면에서 읽을 수밖에 없다. 롤은 이미 같은 문제를 풀었다(0006·0017·0020) —
-- 모르는 값은 NULL 로 두고 `match.source='manual'` + `origin='vod_scan'` 으로 출처를 밝힌다. FC 도 같은 방식이다.
--
-- ★ 이 마이그레이션은 **제약을 푸는 것**이다. 기존 API 경기의 행·값·조회 결과는 바뀌지 않는다
--   (scripts/fco-public-snapshot.ts 로 전후 동일을 확인한다).
-- ★ 화면 경기는 `fco_match_detail` 행이 없다 — provider_match_id·payload 는 "넥슨이 준 원본"이라 지어내지 않는다.
--   기존 공개 조회는 전부 fco_match_detail 조인 또는 ouid 연결로 시작하므로 **화면 경기는 구조상 공개 조회에 안 나온다.**
--   공개 표시는 검수 뒤의 별도 단계다(설계 §10).

-- ── 참가자: 원본(detail)이 아니라 경기(match)에 매단다 ──────────────
-- 지금 참가자는 fco_match_detail 을 직접 참조한다(0029). 화면 경기는 detail(넥슨 원본) 행이 없으므로 그대로는 참가자를 못 넣는다.
-- 참조 대상을 match 로 옮긴다. API 경기는 detail → match 가 CASCADE 라 경기를 지우면 참가자도 지워지는 동작이 그대로다.
-- (detail 행만 지우는 코드는 없다 — 확인함.)
ALTER TABLE fco_match_participant DROP CONSTRAINT fco_match_participant_match_id_fkey;
ALTER TABLE fco_match_participant ADD CONSTRAINT fco_match_participant_match_id_fkey
  FOREIGN KEY (match_id) REFERENCES match(match_id) ON DELETE CASCADE;

-- ── 참가자: ouid 는 키가 아니다 ───────────────────────────────────────
-- 키를 (match_id, ouid) → (match_id, side_no) 로 옮긴다. side_no 는 이미 유일했다(0029).
-- saveFcoMatch 의 ON CONFLICT (match_id, ouid) 가 계속 동작하도록 같은 열의 유일 인덱스를 남긴다
-- (ouid 가 NULL 인 행은 서로 충돌하지 않는다 — Postgres 의 NULL 은 서로 다르다).
ALTER TABLE fco_match_participant DROP CONSTRAINT fco_match_participant_pkey;
ALTER TABLE fco_match_participant ADD PRIMARY KEY (match_id, side_no);
ALTER TABLE fco_match_participant DROP CONSTRAINT fco_match_participant_match_id_side_no_key;
CREATE UNIQUE INDEX fco_participant_match_ouid_key ON fco_match_participant (match_id, ouid);

ALTER TABLE fco_match_participant ALTER COLUMN ouid DROP NOT NULL;
-- 화면 경기는 스쿼드·슈팅 원본이 없다. 비어 있는 것이 정직하다.
ALTER TABLE fco_match_participant ALTER COLUMN match_info SET DEFAULT '{}'::jsonb;

-- ouid 가 없는 자리에서 "이 사람이 누구인가"의 근거. API 참가자(ouid 있음)는 NULL 이다 — ouid 가 근거다.
--   nickname_match  화면 닉네임이 등록된 FC 계정의 닉네임과 일치
--   vod_owner       그 VOD 방송 주인의 본인 시점 화면
--   manual          사람이 지정
ALTER TABLE fco_match_participant ADD COLUMN identity_basis text
  CHECK (identity_basis IN ('nickname_match', 'vod_owner', 'manual'));

-- 근거 없이 스트리머를 붙이지 않는다(CLAUDE.md 원칙 2). ouid 도 근거도 없으면 닉네임만 남는다.
ALTER TABLE fco_match_participant ADD CONSTRAINT fco_participant_identity CHECK (
  btrim(nickname) <> ''
  AND (ouid IS NOT NULL OR streamer_id IS NULL OR identity_basis IS NOT NULL)
  AND (ouid IS NULL OR identity_basis IS NULL)
);

COMMENT ON COLUMN fco_match_participant.ouid IS
  '넥슨 계정 번호. 화면에서 읽은 경기(match.source=manual)에서는 NULL 이다 — 없는 값을 합성하지 않는다. '
  '참가자 구분에는 fco_participant_key() 를 쓴다.';
COMMENT ON COLUMN fco_match_participant.nickname IS
  'API 경기: 경기 당시 닉네임. 화면 경기: 그 화면에 보인 이름. 같은 뜻이다(읽은 그대로).';
COMMENT ON COLUMN fco_match_participant.identity_basis IS
  'ouid 가 없는 자리에서 스트리머를 붙인 근거. API 참가자는 NULL(ouid 가 근거).';

-- 참가자 구분 키 — "같은 사람인가"를 비교하는 곳(시리즈 대진 비교 등)이 ouid 를 직접 쓰지 않고 이걸 쓴다.
-- ouid 가 있으면 그대로(API 경기의 기존 동작과 같다), 없으면 스트리머, 그것도 없으면 화면 닉네임.
CREATE FUNCTION fco_participant_key(p_ouid text, p_streamer_id uuid, p_nickname text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_ouid, 'streamer:' || p_streamer_id::text, 'name:' || p_nickname)
$$;

-- ── 화면 경기 ↔ API 경기 합침 기록 ────────────────────────────────────
-- 화면으로 먼저 안 경기가 나중에 API 로 들어오면 두 번 세지 않게 한다(설계 §3.4 R2).
-- 합쳐도 화면 경기는 지우지 않고 숨긴다(match.visibility='hidden') — 복구와 재생성 방지를 공짜로 얻는다(0020 과 같은 관용구).
CREATE TABLE fco_screen_link (
  screen_match_id text PRIMARY KEY REFERENCES match(match_id) ON DELETE CASCADE,
  api_match_id    text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  -- 무엇이 맞았나: {participants, time_gap_sec, score}
  basis           jsonb NOT NULL CHECK (jsonb_typeof(basis) = 'object'),
  decided_by      text NOT NULL CHECK (decided_by IN ('auto', 'admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (screen_match_id <> api_match_id)
);
CREATE INDEX fco_screen_link_api_idx ON fco_screen_link (api_match_id);
ALTER TABLE fco_screen_link ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE fco_screen_link IS
  '화면으로 먼저 안 경기(screen)가 나중에 들어온 API 경기(api)와 같은 경기라고 합친 기록. '
  '자동 합침은 참가자·종료 시각(±3분)·스코어가 모두 맞을 때만 한다(설계 §3.4).';

-- 판단에 쓰인 프레임의 기록 — 검수 어드민이 "왜 이렇게 판단했나"를 보여주는 근거다.
--
-- 왜 필요한가:
--   지금까지 `match.result_evidence`(0015)는 자유 텍스트로 "VOD 시각 · 프레임 파일명"을
--   적는 자리였다. 사람이 CLI로 판독하고 사람이 다시 읽는 흐름에선 그걸로 충분했다.
--   그런데 어드민 화면이 그 프레임 **이미지 자체**를 타임라인에 띄우려면 파일 경로가
--   구조화된 값이어야 한다 — 자유 텍스트를 파싱해서 이미지를 찾을 수는 없다.
--
--   `event_lead` 에 걸어 두는 이유는 매치가 아직 없거나(후보가 기각됨) 나중에 지워져도
--   "이 VOD를 스캔하며 무엇을 봤는지"는 남아야 하기 때문이다 — 어드민이 **놓친 것**을
--   검수하려면 매치로 이어지지 않은 프레임도 볼 수 있어야 한다.
--
-- docs/CK-COLLECTION.md · .claude/skills/ck-research/SKILL.md

CREATE TABLE match_evidence_frame (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 이 프레임이 나온 VOD 스캔 단서. 후보가 기각돼도 남아야 하므로 lead 가 지워질 때만 같이 지운다.
  lead_id     uuid NOT NULL REFERENCES event_lead(id) ON DELETE CASCADE,
  -- 판단이 실제 경기로 이어졌을 때만 채운다. 매치가 지워져도 프레임 자체는 남긴다(SET NULL).
  match_id    text REFERENCES match(match_id) ON DELETE SET NULL,

  -- out/ck/... 아래의 상대 경로. 로컬 디스크 파일을 그대로 서빙한다 —
  -- 지금은 배포 전이라(CLAUDE.md M4) 이 프로젝트의 모든 수집·판독이 로컬에서 돈다.
  frame_path  text NOT NULL,
  -- VOD **전체** 시각(초). 분할 파일의 로컬 시각이 아니다 — 뒤의 프레임·음성·근거가
  -- 이 시간축을 공유해야 어드민 타임라인에서 같은 자리를 가리킨다.
  at_sec      integer,
  kind        text NOT NULL DEFAULT 'other'
                CHECK (kind IN ('result','roster','other')),
  -- 이 프레임에서 무엇을 읽었는지 — 판단 근거를 사람이 읽을 말로.
  note        text,

  -- ★★ **뽑은 것과 읽은 것은 다르다.**
  --   프레임 파일이 생겼다는 사실은 근거가 아니다 — 뽑아 놓고 안 열고서 "간판이 화면에
  --   없었다" 고 단정한 사고가 실제로 세 번 있었고, 나중에 열어 보니 셋 다 화면 가득이었다
  --   (onair-map 의 같은 교훈). 그래서 **실제로 열어 읽은 뒤에만** 이 칸이 찬다.
  --   ⚠ 추출 도구가 이 값을 채우면 안 된다. 채우는 것은 판독한 쪽이다.
  read_at     timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now(),

  -- ★ 같은 VOD 의 같은 프레임은 한 행이다. 재실행이 근거를 중복 생성하면 어드민
  --   타임라인에 같은 지점이 여러 개 쌓이고, "몇 장을 읽었나" 가 부풀어 보인다.
  UNIQUE (lead_id, frame_path)
);

CREATE INDEX match_evidence_frame_lead_idx  ON match_evidence_frame (lead_id, at_sec);
CREATE INDEX match_evidence_frame_match_idx ON match_evidence_frame (match_id) WHERE match_id IS NOT NULL;
-- "뽑았지만 아직 안 본" 프레임 — 어드민이 미확인 근거를 찾는 질의다.
CREATE INDEX match_evidence_frame_unread_idx ON match_evidence_frame (lead_id) WHERE read_at IS NULL;

ALTER TABLE match_evidence_frame ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE match_evidence_frame IS
  '판단에 쓰인 프레임의 근거 기록. 검수 어드민이 지점별로 "왜 이렇게 판단했나"를 '
  '보여주는 데 쓴다. 매치가 없어도(기각된 후보) 남아 재검수 대상이 된다.';
COMMENT ON COLUMN match_evidence_frame.read_at IS
  '실제로 열어서 읽은 시각. ★ 추출(파일 생성)이 아니라 **열람**을 뜻한다 — '
  '추출 도구가 채우면 안 된다. NULL 이면 "뽑았지만 아직 안 본 프레임"이다.';
COMMENT ON COLUMN match_evidence_frame.match_id IS
  '이 근거가 붙은 경기. NULL 은 누락이 아니라 **미연결 근거**다 — 아직 경기로 만들지 '
  '않았거나 대상이 아니라고 본 구간이고, 어드민에서 다시 볼 수 있어야 한다.';

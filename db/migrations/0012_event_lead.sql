-- 그날 무엇이 열렸고 누가 참가했나를 **먼저 쌓는다**. 확정은 나중에 한다.
--
-- 왜 필요한가:
--   내전·대회·이벤트전은 **놓치면 복구가 안 된다.** 참가 신청 게시글은 지워지고,
--   방송 채팅은 VOD 가 사라지면 같이 사라진다. rank_snapshot 과 같은 성격이라
--   "오늘 안 쌓으면 오늘은 영원히 구멍"이다.
--
--   그런데 이 단서들은 **확정이 아니다.** 예고만 하고 안 연 내전, 신청만 하고
--   안 나온 사람이 섞인다. 그걸 event 에 바로 넣으면 공개 화면에 거짓이 나간다.
--   그래서 층을 나눈다 — 단서는 여기 쌓이고, 사람이 VOD 로 검수한 것만 event 가 된다.
--
-- 확정 경로: event_lead → (VOD 프레임 판독으로 검수) → event / match / streamer_encounter
-- docs/CK-COLLECTION.md

-- ── 매일 훑을 대상 ──────────────────────────────────────────────────
--
-- 전부를 매일 돌 수는 없다(현재 418명). **대형 스트리머 50~60명만** 자동으로
-- 훑고, 그들이 연 내전에 참가한 사람은 등록 여부와 무관하게 아래 테이블에 남긴다.
-- 소·중형 스트리머는 그 기록이 쌓인 뒤에 사람이(또는 팬이) 등록한다.
ALTER TABLE streamer ADD COLUMN watch boolean NOT NULL DEFAULT false;
CREATE INDEX streamer_watch_idx ON streamer (watch) WHERE watch;

COMMENT ON COLUMN streamer.watch IS
  '매일 자동 수집 대상인가. 수집 대상이지 중요도 표시가 아니다 — '
  '이 사람이 연 내전의 참가자는 watch 가 아니어도 전부 기록한다.';


-- ── 단서: 그날 무엇이 열렸나 ────────────────────────────────────────
CREATE TABLE event_lead (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 어디서 알았나. 출처를 지우면 나중에 이 행을 신뢰할 근거가 없어진다.
  source        text NOT NULL
                  CHECK (source IN ('vod_title','board_post','chat_notice','live_title','official_hub','manual')),
  -- 출처 쪽의 원래 식별자. 같은 단서를 두 번 쌓지 않기 위한 키.
  --   예) 'vod:203783047' · 'post:1113444:203753929'
  source_key    text NOT NULL,
  url           text,

  -- 주최·방송 주체. 등록 안 된 채널이어도 채널 아이디는 남긴다.
  channel_id    text,
  streamer_id   uuid REFERENCES streamer(id) ON DELETE SET NULL,

  kind          text NOT NULL DEFAULT 'unknown'
                  CHECK (kind IN ('scrim','tournament','showmatch','other','unknown')),
  title         text NOT NULL,
  -- 그 단서가 가리키는 시각(방송 시각·글 작성 시각). 수집 시각이 아니다.
  observed_at   timestamptz NOT NULL,

  -- 원문 그대로. 나중에 파싱 규칙을 고쳐도 **다시 긁지 않고** 재처리할 수 있어야 한다.
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- 검수 결과. event_id 가 차면 확정된 것이다.
  state         text NOT NULL DEFAULT 'new'
                  CHECK (state IN ('new','confirmed','rejected','ignored')),
  event_id      uuid REFERENCES event(id) ON DELETE SET NULL,
  note          text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (source, source_key)
);
CREATE INDEX event_lead_observed_idx ON event_lead (observed_at DESC);
CREATE INDEX event_lead_new_idx      ON event_lead (state, observed_at DESC) WHERE state = 'new';
CREATE INDEX event_lead_channel_idx  ON event_lead (channel_id, observed_at DESC);

CREATE TRIGGER event_lead_touch BEFORE UPDATE ON event_lead
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ── 관측된 참가자 ───────────────────────────────────────────────────
--
-- ★ **SOOP 채널 아이디가 키다.** streamer_id 가 아니다.
--   참가 신청 댓글은 `user_id`(채널 아이디)를 그대로 준다 — 닉네임과 달리 안 바뀌고,
--   우리 streamer_channel.channel_id 와 정확히 같은 값이다.
--
--   등록 안 된 사람도 여기 남는다. 나중에 그 사람이 등록되면 `streamer_id` 만
--   채우면 과거 참가 기록이 통째로 되살아난다 — account_candidate 가 puuid 로
--   하는 것과 같은 방식이다(§11-5, 신규 등록 시 과거 재파생).
CREATE TABLE event_lead_participant (
  lead_id       uuid NOT NULL REFERENCES event_lead(id) ON DELETE CASCADE,
  channel_id    text NOT NULL,

  -- 표시용 캐시. 바뀐다. 조인에 쓰지 않는다(§11-1 과 같은 이유).
  nickname      text,
  -- 등록되면 채워진다. NULL 이면 "아직 우리가 모르는 사람".
  streamer_id   uuid REFERENCES streamer(id) ON DELETE SET NULL,

  -- 어떻게 알았나. 신청 댓글인지, 화면에서 읽었는지.
  source        text NOT NULL
                  CHECK (source IN ('board_comment','chat','vod_frame','manual')),
  -- 원문. '탑 골중 / 원딜 플하' 같은 신청 문구를 그대로 둔다 —
  -- 포지션 파싱이 틀려도 원문이 있으면 다시 할 수 있다.
  note          text,
  observed_at   timestamptz NOT NULL,

  -- ⚠ 신청했다고 참가한 것은 아니다. 확정은 VOD 검수가 한다.
  confirmed     boolean NOT NULL DEFAULT false,

  PRIMARY KEY (lead_id, channel_id)
);
CREATE INDEX event_lead_participant_channel_idx ON event_lead_participant (channel_id);
-- 미등록 참가자 찾기 — 새 스트리머가 등록되면 이걸로 과거를 잇는다.
CREATE INDEX event_lead_participant_unlinked_idx
  ON event_lead_participant (channel_id) WHERE streamer_id IS NULL;

ALTER TABLE event_lead             ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_lead_participant ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE event_lead IS
  '관측된 내전·대회 단서. **확정이 아니다** — 공개 화면에 그대로 내보내지 않는다. '
  'state=confirmed 이고 event_id 가 있는 것만 확정된 대회다.';
COMMENT ON TABLE event_lead_participant IS
  '그 자리에 있었다고 관측된 사람. 등록 여부와 무관하게 채널 아이디로 남긴다. '
  'confirmed=false 는 "신청했다"이지 "참가했다"가 아니다.';

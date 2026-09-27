-- FC 온라인 경기 상세와 스트리머 계정 연결. 원본 API 응답은 경기 시점의
-- 스쿼드·슛·선수별 지표를 다시 계산할 수 있도록 그대로 보존한다.

ALTER TABLE event ADD COLUMN game_code text NOT NULL DEFAULT 'lol'
  CHECK (game_code IN ('lol', 'fconline'));
CREATE INDEX event_game_starts_idx ON event (game_code, starts_at DESC);

CREATE TABLE fco_account (
  ouid text PRIMARY KEY,
  nickname text NOT NULL,
  level integer,
  seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE streamer_fco_account (
  ouid text PRIMARY KEY REFERENCES fco_account(ouid) ON DELETE CASCADE,
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  source_url text,
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX streamer_fco_account_streamer_idx ON streamer_fco_account (streamer_id);

CREATE TABLE fco_match_detail (
  match_id text PRIMARY KEY REFERENCES match(match_id) ON DELETE CASCADE,
  provider_match_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fco_match_participant (
  match_id text NOT NULL REFERENCES fco_match_detail(match_id) ON DELETE CASCADE,
  ouid text NOT NULL,
  nickname text NOT NULL,
  streamer_id uuid REFERENCES streamer(id) ON DELETE SET NULL,
  side_no smallint NOT NULL CHECK (side_no IN (1, 2)),
  outcome text NOT NULL CHECK (outcome IN ('win', 'draw', 'loss', 'unknown')),
  goals integer,
  division integer,
  match_info jsonb NOT NULL CHECK (jsonb_typeof(match_info) = 'object'),
  PRIMARY KEY (match_id, ouid),
  UNIQUE (match_id, side_no)
);
CREATE INDEX fco_participant_streamer_idx ON fco_match_participant (streamer_id, match_id)
  WHERE streamer_id IS NOT NULL;

ALTER TABLE fco_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_fco_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE fco_match_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE fco_match_participant ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN fco_match_detail.payload IS
  'NEXON match-detail 원본. 경기 당시 스쿼드·슛 좌표·선수별 스탯의 정본.';
COMMENT ON COLUMN fco_match_participant.streamer_id IS
  '명시적으로 연결된 공개 스트리머만 넣는다. 닉네임 일치만으로 추정하지 않는다.';

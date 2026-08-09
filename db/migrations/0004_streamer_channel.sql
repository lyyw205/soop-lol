-- 방송 채널을 스트리머에서 떼어내 1:N 으로 만든다.
--
-- 왜: 라이엇 계정은 이미 streamer_account 로 1:N 인데 방송 채널만 streamer 의
-- 컬럼(platform / platform_user_id / channel_url)으로 1:1 이었다. 그래서
--   · SOOP + 치지직 동시 송출을 기록할 수 없고
--   · 본채널 + 서브채널을 구분할 수 없고
--   · 채널 변경 이력이 남지 않는다
-- 구조가 비대칭인 채로 화면을 그리기 시작하면 되돌리기 훨씬 비싸진다.
--
-- 이름도 같이 고친다: platform_user_id → channel_id.
-- "user_id" 는 우리 것처럼 들리는데 실제로는 **플랫폼이 발급한 채널 아이디**다.
-- 이 프로젝트에는 주인이 다른 식별자가 세 종류 있어서(우리 / 방송플랫폼 / Riot)
-- 이름만 보고 주인을 알 수 있어야 한다. docs/ARCHITECTURE.md §식별자 참조.

CREATE TABLE streamer_channel (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id   uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,

  platform      text NOT NULL DEFAULT 'soop'
                  CHECK (platform IN ('soop','chzzk','youtube','twitch','other')),
  -- ★ 플랫폼이 발급한 채널 아이디. SOOP 이면 방송국 아이디(예: 'phonics1').
  --   우리 키가 아니고, 게임 계정과도 무관하다.
  channel_id    text NOT NULL,
  channel_url   text,
  label         text,                                   -- '본채널', '서브채널'
  is_primary    boolean NOT NULL DEFAULT false,

  -- 채널 양도·폐쇄 대응. NULL 이면 현재도 유효 (streamer_account 와 같은 규칙).
  active_from   timestamptz,
  active_to     timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 한 채널이 두 스트리머에게 동시에 붙는 건 사고다.
CREATE UNIQUE INDEX streamer_channel_one_owner_idx
  ON streamer_channel (platform, channel_id) WHERE active_to IS NULL;
-- 대표 채널은 스트리머당 하나.
CREATE UNIQUE INDEX streamer_channel_primary_idx
  ON streamer_channel (streamer_id) WHERE is_primary AND active_to IS NULL;
CREATE INDEX streamer_channel_by_streamer_idx ON streamer_channel (streamer_id, is_primary DESC);

CREATE TRIGGER streamer_channel_touch BEFORE UPDATE ON streamer_channel
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE streamer_channel ENABLE ROW LEVEL SECURITY;

-- 기존 데이터 이관. platform_user_id 가 있는 행만 옮긴다.
INSERT INTO streamer_channel (streamer_id, platform, channel_id, channel_url, label, is_primary)
SELECT id, platform, platform_user_id, channel_url, '본채널', true
  FROM streamer
 WHERE platform_user_id IS NOT NULL AND platform_user_id <> '';

-- 옛 컬럼을 지운다. 두 곳에 같은 사실이 남아 있으면 반드시 어긋난다.
ALTER TABLE streamer DROP CONSTRAINT IF EXISTS streamer_platform_platform_user_id_key;
ALTER TABLE streamer DROP COLUMN platform_user_id;
ALTER TABLE streamer DROP COLUMN channel_url;
ALTER TABLE streamer DROP COLUMN platform;

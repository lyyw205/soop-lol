-- 0083 — 라이엇 계정의 **옛 닉네임**을 남긴다.
--
-- 무엇이 틀려 있었나
--   매일 랭크 크론(Engine A, soop-rank.timer)이 puuid 로 현재 닉네임을 받아
--   `riot_account.game_name` 을 **덮어쓴다.** 이전 이름은 어디에도 남지 않았다.
--   VOD 판독은 화면에 보인 **그 당시** 이름으로 사람을 찾는다(ck:who). 8월에 'A' 였던 계정이
--   지금 'B' 면 DB 엔 'B' 만 있어, 8월 VOD 백필에서 'A' 를 못 찾는다.
--   Riot API 는 현재 이름만 준다 — **받아온 날 남기지 않으면 옛 이름은 영영 모른다**
--   (rank_snapshot 과 같은 시한부다. 매일 받아오면서 버리고 있었다).
--
-- 어떻게
--   `riot_account` 에 이름이 써질 때마다 트리거가 남긴다. 이름을 쓰는 길이 여럿이라
--   (saveProfile·upsertRiotAccount·linkAccount·repointPuuid·시드) 앱 코드가 아니라 트리거 한 곳에서 잡는다 —
--   길 하나를 빠뜨리면 그 길로 바뀐 이름이 사라진다.
--
-- ★ 시각의 뜻 — "우리가 기록한 시각" 이지 Riot 에서 바꾼 시각이 아니다.
--   first_seen_at: 이 이름을 처음 기록한 때. replaced_at: 다른 이름으로 바뀐 걸 기록한 때(NULL = 지금 이름).
--   실제로 바꾼 날은 그 사이 어딘가다. 매일 갱신하므로 갱신 대상 계정은 하루 안쪽 오차다.
--   같은 값을 다시 쓰는 갱신(계정 조회 실패 시 coalesce 로 옛 값을 다시 씀)은 아무것도 남기지 않는다.
--
-- ★ 태그를 모르는 계정이 있다(tag_line NULL). 기본키에 NULL 을 못 넣으므로 '' 로 적는다.

CREATE TABLE riot_account_name (
  puuid         text NOT NULL REFERENCES riot_account(puuid) ON DELETE CASCADE,
  game_name     text NOT NULL,
  tag_line      text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  replaced_at   timestamptz,
  PRIMARY KEY (puuid, game_name, tag_line)
);

COMMENT ON TABLE riot_account_name IS
  '라이엇 계정의 닉네임 이력. riot_account 에 이름이 써질 때 트리거가 남긴다(0083). '
  'replaced_at NULL 이 지금 이름. 시각은 우리가 기록한 때다. ck:who 가 옛 VOD 의 이름을 사람으로 바꿀 때 읽는다.';

-- 옛 이름으로 찾는 쪽이 주 용도다(ck:who). 정확 일치는 이 인덱스, 퍼지는 전체를 읽는다(행 수가 작다).
CREATE INDEX riot_account_name_name_idx ON riot_account_name (lower(game_name));

CREATE FUNCTION record_riot_account_name() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.game_name IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.game_name IS NOT DISTINCT FROM OLD.game_name
     AND NEW.tag_line IS NOT DISTINCT FROM OLD.tag_line THEN
    RETURN NULL;
  END IF;
  UPDATE riot_account_name SET replaced_at = now()
   WHERE puuid = NEW.puuid AND replaced_at IS NULL
     AND (game_name, tag_line) IS DISTINCT FROM (NEW.game_name, COALESCE(NEW.tag_line, ''));
  -- 예전 이름으로 되돌아온 경우: 처음 본 때는 그대로 두고 "지금 이름" 으로 되살린다.
  INSERT INTO riot_account_name (puuid, game_name, tag_line)
  VALUES (NEW.puuid, NEW.game_name, COALESCE(NEW.tag_line, ''))
  ON CONFLICT (puuid, game_name, tag_line) DO UPDATE SET replaced_at = NULL;
  RETURN NULL;
END $$;

CREATE TRIGGER riot_account_name_history
AFTER INSERT OR UPDATE OF game_name, tag_line ON riot_account
FOR EACH ROW EXECUTE FUNCTION record_riot_account_name();

-- 지금 이름부터 적어 둔다. 이전 이름은 이미 덮여 구할 수 없다 — 이력은 오늘부터 쌓인다.
INSERT INTO riot_account_name (puuid, game_name, tag_line, first_seen_at)
SELECT puuid, game_name, COALESCE(tag_line, ''), created_at
  FROM riot_account
 WHERE game_name IS NOT NULL
ON CONFLICT DO NOTHING;

-- 0002 와 같은 이유 — public 스키마의 표는 PostgREST 로 노출되므로 RLS 를 켠다.
ALTER TABLE riot_account_name ENABLE ROW LEVEL SECURITY;

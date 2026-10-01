-- 백필 "마지막 요청 기간"을 게임별로 둔다. 같은 채널에 롤 백필과 FC 백필을 따로 요청한다(FC 6단계, docs/FCO-SCREEN-MATCH-DESIGN.md §4.1).
-- 채널 하나에 한 줄이면 FC 기간을 요청하는 순간 롤의 마지막 기간이 덮인다. 진척은 여전히 event_lead.raw 의 게임별 도장(scan · fco_scan)이 정본이다.
ALTER TABLE ck_backfill_request ADD COLUMN game_code text NOT NULL DEFAULT 'lol'
  CHECK (game_code IN ('lol', 'fconline'));
ALTER TABLE ck_backfill_request DROP CONSTRAINT ck_backfill_request_pkey;
ALTER TABLE ck_backfill_request ADD PRIMARY KEY (channel_id, game_code);
COMMENT ON COLUMN ck_backfill_request.game_code IS '어느 게임 백필의 요청 기간인가. 기존 행은 전부 롤(lol)이었다.';

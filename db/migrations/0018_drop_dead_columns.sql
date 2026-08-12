-- **쓰지 않는 칸을 걷어낸다.**
--
-- 판정 기준은 "지금 NULL 인가" 가 아니라 **"읽거나 쓰는 코드가 있는가"** 다.
-- 100% NULL 이어도 살아 있는 칸이 있다 — `streamer_account.active_to` 는
-- `IS NULL` 이 곧 "현재 유효한 계정" 이라는 뜻이라 아홉 군데가 그걸로 거른다.
-- 그래서 전수로 참조를 세고, **참조 0** 인 것만 지운다.
--
--   지운다 (참조 0)                          남긴다 (참조 있음 / NULL 이 정상)
--   ───────────────────────────────────      ─────────────────────────────────────
--   event.riot_tournament_id                 streamer_account.active_to   (9곳)
--   event.riot_provider_id                   dead_match                   (5곳)
--   match.raw_s3_key                         riot_account.summoner_id     (7곳)
--   account_candidate.suggested_streamer_id  streamer.team_name           (12곳)
--   account_candidate.note                   career_event                 (관리자 CRUD)
--   season_record (테이블 통째)                event_lead_participant       (수집기가 INSERT)

-- ── 토너먼트 코드 예약 칸 ────────────────────────────────────────────
-- Production Key 를 받으면 provider·tournament 를 Riot 에 등록해야 하는데,
-- 그때 응답이 어떤 모양일지는 아직 모른다. 미리 잡아 둔 자리가 실제와 맞을 거라는
-- 보장이 없고, 그때 가서 마이그레이션 한 줄이면 된다. docs/TOURNAMENT-CODE.md
ALTER TABLE event DROP COLUMN riot_tournament_id;
ALTER TABLE event DROP COLUMN riot_provider_id;

-- ── S3 원본 보관 ─────────────────────────────────────────────────────
-- "원본 JSON 은 S3 에" 로 잡아 뒀는데 S3 를 쓰지 않는다. 필요해지면 그때 만든다.
ALTER TABLE match DROP COLUMN raw_s3_key;

-- ── 후보 식별 ────────────────────────────────────────────────────────
-- 식별 잡이 "이 계정은 아마 이 스트리머" 를 제안하기로 했는데 그런 코드가 없다.
-- 지금 후보 28건의 이 칸은 전부 NULL 이고, 아무도 읽지 않는다.
-- (식별은 identify-candidates 가 FA 명단과 **정확히** 대조해서 하지, 추측하지 않는다)
ALTER TABLE account_candidate DROP COLUMN suggested_streamer_id;
ALTER TABLE account_candidate DROP COLUMN note;

-- ── 시즌 기록 ────────────────────────────────────────────────────────
-- 0행이고, 읽는 코드도 쓰는 코드도 없다. verify:db 의 테이블 목록에만 이름이 있었다.
-- 시즌별 집계가 필요해지면 match 에서 다시 만들 수 있다(파생은 언제나 재계산 가능, §11-5).
DROP VIEW IF EXISTS core_public.season_record;
DROP TABLE IF EXISTS season_record;

-- ── 살아 있는 NULL 에 이유를 적어 둔다 ──────────────────────────────
-- 다음 사람이 같은 감사를 다시 하지 않도록. "비어 있다 = 죽었다" 가 아니다.
COMMENT ON COLUMN streamer_account.active_to IS
  'NULL 이 정상이다 — 현재 유효한 계정이라는 뜻. 수집·조우·집계가 전부 IS NULL 로 거른다. 양도·폐기 때만 채운다.';
COMMENT ON COLUMN streamer_account.active_from IS
  'active_to 와 짝. 계정 유효 구간을 기록한다. 보통 비어 있다.';
COMMENT ON COLUMN streamer_account.verified_by IS
  '사람이 확인한 매핑의 확인자. 부계정 오노출은 분쟁이 되므로 근거를 소급할 수 있어야 한다(§11-2). 검증 UI 가 생기면 채워진다.';
COMMENT ON COLUMN streamer_channel.active_to IS
  'NULL 이 정상 — 현재 쓰는 채널. 방송국을 옮기면 채운다.';
COMMENT ON COLUMN riot_account.summoner_id IS
  'league-v4·spectator 가 쓴다. 프로필 동기화가 채운다 — 지금 비어 있는 건 그 잡이 아직 안 돌아서다.';
COMMENT ON COLUMN ingest_cursor.last_error IS
  'NULL 이 정상 — 마지막 시도가 성공했다는 뜻.';

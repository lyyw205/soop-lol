-- soop-lol schema
-- PostgreSQL 15+
-- 설계 근거는 docs/PLAN.md, docs/RESEARCH.md 참조.
--
-- 핵심 원칙 3가지 (docs/PLAN.md §2)
--   1. puuid가 유일한 불변 키다. Riot ID는 표시용 캐시.
--   2. 계정 매핑에는 항상 근거(evidence)를 남긴다.
--   3. streamer_encounter는 파생 테이블이다 — 언제든 지우고 다시 만들 수 있어야 한다.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";    -- 스트리머 이름 검색


-- ============================================================
-- 공용 함수
-- ============================================================

-- 티어/디비전/LP를 정렬 가능한 단일 정수로 환산한다.
-- 티어 추이 그래프의 y축이자 리더보드 정렬 키.
--   IRON~DIAMOND : tier_base + division*100 + lp
--   MASTER 이상  : 2800 + lp   (M/GM/C는 LP 사다리가 연속이므로 구간을 나누지 않는다)
CREATE OR REPLACE FUNCTION lol_lp_absolute(p_tier text, p_division text, p_lp integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE upper(coalesce(p_tier, ''))
    WHEN 'MASTER'      THEN 2800 + coalesce(p_lp, 0)
    WHEN 'GRANDMASTER' THEN 2800 + coalesce(p_lp, 0)
    WHEN 'CHALLENGER'  THEN 2800 + coalesce(p_lp, 0)
    ELSE
      CASE upper(coalesce(p_tier, ''))
        WHEN 'IRON'     THEN 0
        WHEN 'BRONZE'   THEN 400
        WHEN 'SILVER'   THEN 800
        WHEN 'GOLD'     THEN 1200
        WHEN 'PLATINUM' THEN 1600
        WHEN 'EMERALD'  THEN 2000
        WHEN 'DIAMOND'  THEN 2400
        ELSE NULL
      END
      + CASE upper(coalesce(p_division, 'IV'))
        WHEN 'IV' THEN 0 WHEN 'III' THEN 100 WHEN 'II' THEN 200 WHEN 'I' THEN 300
        ELSE 0
      END
      + coalesce(p_lp, 0)
  END
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;


-- ============================================================
-- 1. 아이덴티티
-- ============================================================

-- 스트리머 = 사람. 라이엇 계정과 1:N.
CREATE TABLE streamer (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE,               -- URL용. /s/{slug}
  display_name      text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',       -- 별명·구닉네임 검색용

  platform          text NOT NULL DEFAULT 'soop'
                      CHECK (platform IN ('soop','chzzk','youtube','other')),
  platform_user_id  text,                               -- SOOP BJ 아이디 등
  channel_url       text,
  profile_image_url text,                               -- 자체 캐싱한 URL (핫링크 금지)

  is_pro            boolean NOT NULL DEFAULT false,     -- 프로게이머 출신
  team_name         text,

  -- visibility: 본인 요청 시 즉시 숨김. hidden은 관리자만 조회 가능.
  visibility        text NOT NULL DEFAULT 'public'
                      CHECK (visibility IN ('public','hidden')),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','inactive','retired')),

  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (platform, platform_user_id)
);
CREATE INDEX streamer_name_trgm_idx ON streamer USING gin (display_name gin_trgm_ops);
CREATE INDEX streamer_visible_idx   ON streamer (visibility, status);
CREATE TRIGGER streamer_touch BEFORE UPDATE ON streamer
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- 라이엇 계정. PK는 puuid — 이것만이 불변이다.
CREATE TABLE riot_account (
  puuid                 text PRIMARY KEY,               -- 78자
  game_name             text,                           -- 바뀐다. 하루 1회 갱신
  tag_line              text,
  platform_region       text NOT NULL DEFAULT 'kr',     -- summoner/league/spectator 라우팅
  routing_region        text NOT NULL DEFAULT 'asia',   -- account/match 라우팅

  summoner_id           text,                           -- 폐기 예정. 어댑터용으로만 보관
  summoner_level        integer,
  profile_icon_id       integer,
  revision_date         timestamptz,

  -- 동기화 커서
  last_profile_synced_at timestamptz,
  last_rank_synced_at    timestamptz,
  last_match_synced_at   timestamptz,                   -- 이 시각 이후 매치만 신규 조회
  is_active              boolean NOT NULL DEFAULT true, -- false면 폴링 대상에서 제외

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX riot_account_riot_id_idx ON riot_account (lower(game_name), lower(tag_line));
CREATE INDEX riot_account_poll_idx    ON riot_account (is_active, last_match_synced_at NULLS FIRST);
CREATE TRIGGER riot_account_touch BEFORE UPDATE ON riot_account
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- 스트리머 ↔ 계정 매핑. 단순 매핑이 아니라 "증거 테이블"이다.
-- 부계정 오노출은 실제 분쟁이 된다 — 근거 없는 행은 만들지 않는다.
CREATE TABLE streamer_account (
  streamer_id   uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  puuid         text NOT NULL REFERENCES riot_account(puuid) ON DELETE CASCADE,

  label         text,                                   -- '본계', '부계1', '섭계'
  is_main       boolean NOT NULL DEFAULT false,          -- 대표 계정 (자동: 해당 시즌 판수 최다)

  -- 어떻게 알았나. {source, url, note, reported_by, verified_by}
  --   source: 'stream_clip' | 'broadcast_notice' | 'self_declared'
  --         | 'community_post' | 'user_report' | 'rso' | 'manual'
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence    text NOT NULL DEFAULT 'unverified'
                  CHECK (confidence IN ('verified','likely','unverified')),
  visibility    text NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','hidden')),

  -- 계정 양도·폐기 대응. NULL이면 현재도 유효.
  active_from   timestamptz,
  active_to     timestamptz,

  verified_by   text,
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (streamer_id, puuid)
);
-- 한 계정이 두 스트리머에게 동시에 붙는 건 사고다. 유효기간이 겹치지 않는 한 1:1로 강제.
CREATE UNIQUE INDEX streamer_account_one_owner_idx
  ON streamer_account (puuid) WHERE active_to IS NULL;
CREATE INDEX streamer_account_by_streamer_idx ON streamer_account (streamer_id, is_main DESC);
CREATE TRIGGER streamer_account_touch BEFORE UPDATE ON streamer_account
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- spectator로 발굴한 계정 후보. 자동 등록 금지 — 관리자 승인 큐.
CREATE TABLE account_candidate (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  puuid          text NOT NULL,
  game_name      text,
  tag_line       text,
  -- 어떤 스트리머와 같은 게임에 있었나 (동행 근거)
  seen_with      uuid[] NOT NULL DEFAULT '{}',
  seen_count     integer NOT NULL DEFAULT 1,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  suggested_streamer_id uuid REFERENCES streamer(id) ON DELETE SET NULL,
  state          text NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','approved','rejected','ignored')),
  note           text,
  UNIQUE (puuid)
);
CREATE INDEX account_candidate_pending_idx
  ON account_candidate (state, seen_count DESC) WHERE state = 'pending';


-- ============================================================
-- 2. 경기
-- ============================================================

-- 내전·대회 묶음. MVP에선 수기 대회 등록용, 2단계에서 토너먼트 코드가 붙는다.
CREATE TABLE event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text UNIQUE,
  name           text NOT NULL,                          -- '2026 SOOP 멸망전', '목요 내전 12회차'
  kind           text NOT NULL DEFAULT 'scrim'
                   CHECK (kind IN ('scrim','tournament','showmatch','other')),
  organizer      text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  -- 토너먼트 코드 확장용 (docs/TOURNAMENT-CODE.md)
  riot_tournament_id  bigint,
  riot_provider_id    bigint,
  source_url     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE match (
  match_id       text PRIMARY KEY,                       -- 'KR_1234567890'
  platform_id    text NOT NULL,                          -- 'KR'
  game_id        bigint NOT NULL,

  queue_id       integer NOT NULL,                       -- 420 솔랭 / 440 자유랭 / 450 칼바람 / 700 클래시 / 0 커스텀
  game_mode      text,
  game_type      text,
  map_id         integer,
  game_version   text,                                   -- 패치 버전

  game_creation  timestamptz NOT NULL,
  game_start     timestamptz,
  game_end       timestamptz,
  game_duration  integer,                                -- 초
  winning_team   smallint CHECK (winning_team IN (100, 200)),
  ended_in_surrender boolean NOT NULL DEFAULT false,

  -- 공개 큐 전적과 내전 전적은 절대 섞지 않는다 (docs/PLAN.md §11-8)
  source         text NOT NULL DEFAULT 'public_queue'
                   CHECK (source IN ('public_queue','tournament_code','manual')),
  tournament_code text,
  event_id       uuid REFERENCES event(id) ON DELETE SET NULL,

  -- 원본 JSON은 S3에. DB엔 정규화만.
  raw_s3_key     text,
  has_timeline   boolean NOT NULL DEFAULT false,

  ingested_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_created_idx  ON match (game_creation DESC);
CREATE INDEX match_queue_idx    ON match (queue_id, game_creation DESC);
CREATE INDEX match_source_idx   ON match (source, game_creation DESC);
CREATE INDEX match_event_idx    ON match (event_id) WHERE event_id IS NOT NULL;


CREATE TABLE match_participant (
  match_id        text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  puuid           text NOT NULL,
  participant_id  smallint NOT NULL,                     -- 1..10
  team_id         smallint NOT NULL CHECK (team_id IN (100, 200)),

  -- 포지션은 Riot의 추론값이다. 둘이 불일치하면 맞라인 판정에서 보수적으로 제외한다.
  team_position       text,                              -- TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY/''
  individual_position text,
  lane                text,
  role                text,

  champion_id     integer NOT NULL,
  champion_name   text,
  champ_level     smallint,
  win             boolean NOT NULL,

  kills           smallint NOT NULL DEFAULT 0,
  deaths          smallint NOT NULL DEFAULT 0,
  assists         smallint NOT NULL DEFAULT 0,
  gold_earned     integer,
  cs              integer,                               -- totalMinionsKilled + neutralMinionsKilled
  damage_to_champions integer,
  damage_taken    integer,
  vision_score    integer,
  wards_placed    smallint,
  wards_killed    smallint,
  control_wards   smallint,
  turret_kills    smallint,
  first_blood_kill boolean NOT NULL DEFAULT false,

  summoner1_id    integer,
  summoner2_id    integer,
  items           integer[],                             -- item0..item6
  perks           jsonb,

  -- 라인전 지표의 금광. soloKills / laneMinionsFirst10Minutes /
  -- maxLevelLeadLaneOpponent / killParticipation / teamDamagePercentage 등
  challenges      jsonb,

  PRIMARY KEY (match_id, puuid)
);
CREATE INDEX mp_puuid_idx     ON match_participant (puuid);
CREATE INDEX mp_champion_idx  ON match_participant (puuid, champion_id);
CREATE INDEX mp_match_team_idx ON match_participant (match_id, team_id);


-- ============================================================
-- 3. 파생 — 재계산 가능해야 한다. 원본은 언제나 match_participant.
-- ============================================================

-- ★ 이 프로젝트의 심장.
-- 두 스트리머가 같은 경기에 있었던 사건. 상대전적·맞라인·상성이 전부 여기서 나온다.
-- 정규화: 항상 streamer_a_id < streamer_b_id (쌍 중복 원천 차단)
CREATE TABLE streamer_encounter (
  match_id       text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  streamer_a_id  uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  streamer_b_id  uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  a_puuid        text NOT NULL,
  b_puuid        text NOT NULL,

  relation       text NOT NULL CHECK (relation IN ('opponent','ally')),
  a_position     text,
  b_position     text,
  -- 반대 팀 + 같은 포지션 + 포지션 신뢰 가능할 때만 true
  is_lane_matchup boolean NOT NULL DEFAULT false,

  a_win          boolean NOT NULL,
  b_win          boolean NOT NULL,
  a_champion_id  integer,
  b_champion_id  integer,

  -- 조회 편의를 위한 스냅샷 (원본은 match_participant)
  a_kills smallint, a_deaths smallint, a_assists smallint, a_cs integer,
  a_gold integer, a_damage integer,
  b_kills smallint, b_deaths smallint, b_assists smallint, b_cs integer,
  b_gold integer, b_damage integer,

  -- 필터용 비정규화
  queue_id       integer NOT NULL,
  source         text NOT NULL,
  game_creation  timestamptz NOT NULL,
  game_duration  integer,

  derived_at     timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (match_id, streamer_a_id, streamer_b_id),
  CONSTRAINT encounter_ordered CHECK (streamer_a_id < streamer_b_id)
);
-- "A가 만난 사람들" 은 양방향 조회가 필요하다
CREATE INDEX enc_a_idx    ON streamer_encounter (streamer_a_id, game_creation DESC);
CREATE INDEX enc_b_idx    ON streamer_encounter (streamer_b_id, game_creation DESC);
CREATE INDEX enc_pair_idx ON streamer_encounter (streamer_a_id, streamer_b_id, relation, source);
CREATE INDEX enc_lane_idx ON streamer_encounter (streamer_a_id, streamer_b_id)
  WHERE is_lane_matchup;


-- 스트리머×챔피언 집계 (모스트 챔피언). 야간 재계산.
CREATE TABLE champion_stat (
  streamer_id   uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  champion_id   integer NOT NULL,
  queue_id      integer NOT NULL,
  season        text NOT NULL,                            -- '2026-S2' 등. 'ALL'도 가능
  games         integer NOT NULL DEFAULT 0,
  wins          integer NOT NULL DEFAULT 0,
  kills         integer NOT NULL DEFAULT 0,
  deaths        integer NOT NULL DEFAULT 0,
  assists       integer NOT NULL DEFAULT 0,
  cs            bigint  NOT NULL DEFAULT 0,
  seconds_played bigint NOT NULL DEFAULT 0,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (streamer_id, champion_id, queue_id, season)
);
CREATE INDEX champion_stat_top_idx ON champion_stat (streamer_id, season, queue_id, games DESC);


-- ============================================================
-- 4. 커리어
-- ============================================================

-- 매일 09:00 KST 스냅샷. 티어 추이 그래프의 유일한 원천.
-- 오늘부터 안 쌓으면 그날은 영원히 구멍이다 (Riot API에 과거 티어는 없다).
CREATE TABLE rank_snapshot (
  puuid          text NOT NULL REFERENCES riot_account(puuid) ON DELETE CASCADE,
  queue_type     text NOT NULL,                           -- RANKED_SOLO_5x5 / RANKED_FLEX_SR
  snapshot_date  date NOT NULL,

  tier           text,
  division       text,                                    -- I/II/III/IV
  league_points  integer,
  wins           integer,
  losses         integer,
  hot_streak     boolean,

  lp_absolute    integer GENERATED ALWAYS AS
                   (lol_lp_absolute(tier, division, league_points)) STORED,
  captured_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (puuid, queue_type, snapshot_date)
);
CREATE INDEX rank_snapshot_series_idx ON rank_snapshot (puuid, queue_type, snapshot_date DESC);
CREATE INDEX rank_snapshot_board_idx  ON rank_snapshot (queue_type, snapshot_date, lp_absolute DESC);


-- 시즌별 최고 티어. observed(우리가 관측) / manual(수기)를 반드시 구분해서 표시한다.
CREATE TABLE season_record (
  streamer_id  uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  season       text NOT NULL,                             -- '2025-S1'
  queue_type   text NOT NULL DEFAULT 'RANKED_SOLO_5x5',
  best_tier    text,
  best_division text,
  best_lp      integer,
  best_lp_absolute integer GENERATED ALWAYS AS
                   (lol_lp_absolute(best_tier, best_division, best_lp)) STORED,
  games        integer,
  source       text NOT NULL DEFAULT 'observed'
                 CHECK (source IN ('observed','manual')),
  source_url   text,
  PRIMARY KEY (streamer_id, season, queue_type)
);


-- 대회 참가·성적. Riot API에 없다 — 100% 수기.
CREATE TABLE career_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  streamer_id  uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  event_id     uuid REFERENCES event(id) ON DELETE SET NULL,
  title        text NOT NULL,                             -- '2026 SOOP 멸망전'
  role         text,                                      -- '선수', '감독', '해설'
  team_name    text,
  placement    text,                                      -- '준우승', '4강'
  date_from    date,
  date_to      date,
  source_url   text,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX career_event_streamer_idx ON career_event (streamer_id, date_from DESC);


-- ============================================================
-- 5. 수집 운영
-- ============================================================

-- puuid별 백필 진행상황. 양방향 커서.
CREATE TABLE ingest_cursor (
  puuid            text PRIMARY KEY REFERENCES riot_account(puuid) ON DELETE CASCADE,
  -- 과거로 파고드는 커서. 이 시각 이전을 계속 요청한다.
  backfill_before  timestamptz,
  backfill_state   text NOT NULL DEFAULT 'pending'
                     CHECK (backfill_state IN ('pending','running','done','error')),
  backfill_reached_end boolean NOT NULL DEFAULT false,    -- 2년 경계 도달
  matches_ingested integer NOT NULL DEFAULT 0,
  error_count      integer NOT NULL DEFAULT 0,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_cursor_queue_idx ON ingest_cursor (backfill_state, updated_at);


-- 404난 매치 ID. 2년 지나 삭제된 경기다. 정상 케이스이므로 재시도하지 않는다.
CREATE TABLE dead_match (
  match_id    text PRIMARY KEY,
  reason      text NOT NULL DEFAULT 'not_found',
  noticed_at  timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE job_run (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,                              -- 'engine_a_rank' 등
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  state       text NOT NULL DEFAULT 'running'
                CHECK (state IN ('running','ok','failed')),
  processed   integer NOT NULL DEFAULT 0,
  api_calls   integer NOT NULL DEFAULT 0,
  error       text,
  detail      jsonb
);
CREATE INDEX job_run_recent_idx ON job_run (job, started_at DESC);


-- ============================================================
-- 6. 노출 차단
-- ============================================================

-- search_path 고정 — 호출자의 search_path 에 따라 다른 객체가 잡히는 걸 막는다.
ALTER FUNCTION lol_lp_absolute(text, text, integer) SET search_path = pg_catalog, public;
ALTER FUNCTION touch_updated_at() SET search_path = pg_catalog, public;

-- ★ 정책을 하나도 만들지 않고 RLS 만 켠다 = PostgREST(anon/authenticated) 로는 아무것도 못 읽는다.
--   웹과 워커는 postgres.js 로 소유자 롤에 직접 붙으므로 영향이 없다 (소유자는 RLS 를 우회한다).
--
--   이건 형식적인 조치가 아니다. Supabase 는 public 스키마를 REST 로 자동 노출하는데,
--   그러면 `streamer_account.visibility = 'hidden'` 인 부계정과 `evidence`(제보자 메모)가
--   anon 키만으로 그대로 읽힌다. 삭제 요청 경로를 살려둔 의미가 통째로 사라진다
--   (docs/PLAN.md §11-2). 공개 API 가 필요해지면 그때 뷰 + 명시적 정책으로 연다.
ALTER TABLE streamer            ENABLE ROW LEVEL SECURITY;
ALTER TABLE riot_account        ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_account    ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_candidate   ENABLE ROW LEVEL SECURITY;
ALTER TABLE event               ENABLE ROW LEVEL SECURITY;
ALTER TABLE match               ENABLE ROW LEVEL SECURITY;
ALTER TABLE match_participant   ENABLE ROW LEVEL SECURITY;
ALTER TABLE streamer_encounter  ENABLE ROW LEVEL SECURITY;
ALTER TABLE champion_stat       ENABLE ROW LEVEL SECURITY;
ALTER TABLE rank_snapshot       ENABLE ROW LEVEL SECURITY;
ALTER TABLE season_record       ENABLE ROW LEVEL SECURITY;
ALTER TABLE career_event        ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_cursor       ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_match          ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_run             ENABLE ROW LEVEL SECURITY;

COMMIT;

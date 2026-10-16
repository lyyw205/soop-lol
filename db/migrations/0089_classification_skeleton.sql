-- 경기 분류·수집 뼈대 — docs/CLASSIFICATION-REDESIGN-PLAN.md (2026-10-16 확정)
--
-- ⚠ 운영 적용은 전환 절차(계획 §8 4단계)로만 한다 — 쓰는 진입점 정지·백업·대조. scripts/verify-skeleton.ts(메모리 DB)와
--   scripts/skeleton-rehearsal.ts(운영 복사본)가 0088 까지의 옛 구조에 실제 경우를 넣고 이 파일을 적용해 대조한다.
--
-- 새 뼈대: 행사(format) → 시리즈(event 필수) → 세트(scope·map·collected_via) → 참가자(기본 칸) → 상세(지명한 사람만).
-- 진행 방식을 찾는 길은 세트 → 시리즈 → 행사 하나뿐이다. 옛 분류(lol_match_category·event.kind·match.event_id·
-- source/origin·저장된 category)는 여기서 옮겨 담고 지운다 — 변환층을 두지 않는다.
--
-- ★ 분류를 옮기는 것은 경기 값의 변경이 아니다. 검수 무효화 트리거를 이 파일 동안 끄고 끝에서 다시 켠다
--   (0079 의 잡아 두기·되돌리기와 같은 목적. 검수 완료·버전·잠금이 그대로인지는 verify-skeleton 이 집합으로 대조한다).

ALTER TABLE match            DISABLE TRIGGER match_review_values;
ALTER TABLE match_series     DISABLE TRIGGER series_review_values;
ALTER TABLE match_participant DISABLE TRIGGER participant_review_values;
ALTER TABLE event            DISABLE TRIGGER event_admin_version;

-- ── 0. 바꿀 공개 뷰의 권한을 잡아 두고 옛 뷰를 지운다 ─────────────────────────────
-- CASCADE 를 쓰지 않는다 — 모르는 의존이 있으면 여기서 멈춰야 한다.
CREATE TEMP TABLE skel_view_grants AS
  SELECT table_name, grantee, privilege_type, is_grantable
    FROM information_schema.table_privileges
   WHERE table_schema = 'core_public'
     AND table_name IN ('match', 'event', 'schedule_entry', 'schedule_change', 'schedule_participant',
                        'schedule_slot', 'schedule_source', 'event_dates');

DROP VIEW core_public.tournament_match;
DROP VIEW core_public.event_dates;
DROP VIEW core_public.match;
DROP VIEW core_public.match_with_bonus;
DROP VIEW core_public.aram_match;
DROP VIEW core_public.lol_match_all_modes;
DROP VIEW core_public.streamer_encounter;
DROP VIEW core_public.aram_encounter;
DROP VIEW core_public.lol_encounter_all_modes;
DROP VIEW core_public.champion_stat;
DROP VIEW core_public.aram_champion_stat;
DROP VIEW core_public.lol_champion_stat_all_modes;
DROP VIEW core_public.match_participant;
DROP VIEW core_public.match_lineup;
DROP VIEW core_public.streamer_match;
DROP VIEW core_public.event;
DROP VIEW core_public.schedule_change;
DROP VIEW core_public.schedule_participant;
DROP VIEW core_public.schedule_slot;
DROP VIEW core_public.schedule_source;
DROP VIEW core_public.schedule_entry;

-- ── 1. 진행 방식 (event.format) ───────────────────────────────────────────────
-- 게임별 허용값. 모르면 unclassified — concept 은 사람이 고르는 값이지 모를 때 떨어지는 칸이 아니다.
ALTER TABLE event ADD COLUMN format text;
ALTER TABLE event ADD COLUMN auto_bucket boolean NOT NULL DEFAULT false;
UPDATE event SET format = CASE kind
    WHEN 'ck' THEN 'ck'
    WHEN 'land' THEN CASE game_code WHEN 'lol' THEN 'land' ELSE 'unclassified' END
    WHEN 'tournament' THEN 'tournament'
    WHEN 'scrim' THEN CASE game_code WHEN 'lol' THEN 'scrim' ELSE 'unclassified' END  -- FC 는 스크림이 없다(§10 결정 8): 사용자가 다시 지정
    WHEN 'showmatch' THEN 'concept'                                                   -- 이벤트매치 = concept (사용자 결정 3)
    ELSE 'unclassified'                                                               -- other: 보상 미확인 친목 내전·모름
  END;
ALTER TABLE event ALTER COLUMN format SET NOT NULL;
ALTER TABLE event ADD CONSTRAINT event_format_by_game CHECK (
  (game_code = 'lol'      AND format IN ('ck', 'land', 'tournament', 'scrim', 'solo_bet', 'concept', 'unclassified')) OR
  (game_code = 'fconline' AND format IN ('ck', 'tournament', 'concept', 'friendly', 'unclassified')));
-- 자동 묶음은 자동 수집 전용 그릇이다 — 영원히 미분류. 사람은 시리즈를 실제 행사로 옮겨 분류한다(§3.4).
ALTER TABLE event ADD CONSTRAINT event_auto_bucket_unclassified CHECK (NOT auto_bucket OR format = 'unclassified');
ALTER TABLE event ADD CONSTRAINT event_id_game_uq UNIQUE (id, game_code);
COMMENT ON COLUMN event.format IS
  '진행 방식. lol: ck·land·tournament·scrim·solo_bet·concept·unclassified, fconline: ck·tournament·concept·friendly·unclassified. '
  'unclassified = 아직 판단하지 않음·판단 불가(공개는 하되 라벨 없음).';
COMMENT ON COLUMN event.auto_bucket IS
  '자동 수집이 행사 없이 들어온 판을 담는 미분류 묶음(slug 가 판 자체에서 정해지는 결정적 키). 사람은 relabel 하지 않는다.';

-- 일정의 예정 분류도 같은 어휘를 쓴다.
ALTER TABLE schedule_entry ADD COLUMN planned_format text;
UPDATE schedule_entry SET planned_format = CASE planned_kind
    WHEN 'tournament' THEN 'tournament' WHEN 'ck' THEN 'ck' WHEN 'showmatch' THEN 'concept' ELSE 'unclassified' END;
ALTER TABLE schedule_entry ALTER COLUMN planned_format SET NOT NULL;
ALTER TABLE schedule_entry ADD CONSTRAINT schedule_entry_planned_format_check CHECK (
  (game_code = 'lol'      AND planned_format IN ('ck', 'land', 'tournament', 'scrim', 'solo_bet', 'concept', 'unclassified')) OR
  (game_code = 'fconline' AND planned_format IN ('ck', 'tournament', 'concept', 'friendly', 'unclassified')));
ALTER TABLE schedule_entry DROP COLUMN planned_kind;

-- ── 2. 세트의 속성 ─────────────────────────────────────────────────────────────
-- 수집 경로: 어떻게 알았나. 분류 판정에 쓰지 않는다.
ALTER TABLE match ADD COLUMN collected_via text;
UPDATE match SET collected_via = CASE
    WHEN source IN ('public_queue', 'tournament_code', 'provider_api') THEN 'api'
    WHEN origin = 'vod_scan' THEN 'vod'
    ELSE 'manual' END;                                   -- wiki_seed·admin(엑셀·검수 화면)
ALTER TABLE match ALTER COLUMN collected_via SET NOT NULL;
ALTER TABLE match ADD CONSTRAINT match_collected_via_check CHECK (collected_via IN ('api', 'vod', 'manual'));

-- 맵: Riot 사실(game_mode·queue_id)에서만 정해진다 — 생성 칼럼이라 모드를 고치면 따라 바뀐다. FC 는 맵이 없다.
ALTER TABLE match ADD COLUMN map text GENERATED ALWAYS AS (CASE
    WHEN game_code <> 'lol' THEN NULL
    WHEN game_mode = 'ARAM' OR queue_id IN (450, 2400) THEN 'aram'
    WHEN game_mode IN ('CHERRY', 'URF', 'ARURF') OR queue_id IN (1700, 1710, 1740, 1750, 900, 1900) THEN 'unsupported'
    ELSE 'rift' END) STORED;
ALTER TABLE match ADD CONSTRAINT match_map_by_game CHECK (
  (game_code = 'lol' AND map IN ('rift', 'aram', 'unsupported')) OR (game_code <> 'lol' AND map IS NULL));

-- ── 3. 공개 큐 정리 (사용자 결정 12·13) ─────────────────────────────────────────
-- 지명 수집 대상. 솔랭 도전(뜨교듀오)이 첫 지명이다 — challenges.json 의 계정·시작일.
CREATE TABLE collection_target (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_code   text NOT NULL DEFAULT 'lol' CHECK (game_code = 'lol'),
  puuid       text NOT NULL REFERENCES riot_account(puuid) ON DELETE CASCADE,
  queue_id    integer NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  purpose     text NOT NULL CHECK (btrim(purpose) <> ''),
  note        text,
  -- 수집 진척(옛 ingest_cursor 의 커서 로직을 지명 단위로).
  cursor_before   timestamptz,
  reached_end     boolean NOT NULL DEFAULT false,
  state       text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'error')),
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at),
  UNIQUE (puuid, queue_id, starts_at)
);
ALTER TABLE collection_target ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE collection_target IS
  '롤 경기 기록의 유일한 수집 대상(계정·큐·기간). 목록 밖 공개 큐 판을 저장하는 경로는 없다. 랭크 점수는 별개(연결 계정 전원).';

INSERT INTO collection_target (puuid, queue_id, starts_at, purpose, note)
SELECT p.puuid, 420, timestamptz '2026-08-21 00:00:00+09', 'solo_challenge:ttgyo-duo', '뜨교듀오 마스터 도전 — challenges.json'
  FROM (VALUES ('jAu-Fy-yQ96GJFQtR4mbyYIiumZdM8v3dmyaPu4dQuAslWnjeiGfKLJmu2-yQe79gBdWbKDpZmTivA'),
               ('hmeMsJn7_kn3-w6SLpjVBC59hkbzfdiTi6hOWv2aSpbIgYBJCnf8hUigsdf7seukt7x0eV610pO9fw')) AS p(puuid)
 WHERE EXISTS (SELECT 1 FROM riot_account ra WHERE ra.puuid = p.puuid);

-- 지명 범위 밖의 공개 큐 판은 지운다. 범위: 지명 계정이 그 큐로, 기간 안에 한 판.
DELETE FROM match m
 WHERE m.game_code = 'lol' AND m.source = 'public_queue'
   AND NOT EXISTS (
     SELECT 1 FROM match_participant p JOIN collection_target t ON t.puuid = p.puuid
      WHERE p.match_id = m.match_id AND m.queue_id = t.queue_id
        AND m.game_creation >= t.starts_at AND (t.ends_at IS NULL OR m.game_creation < t.ends_at));
DROP TABLE ingest_cursor;

-- ── 4. 모든 내전 판을 시리즈 안으로 ─────────────────────────────────────────────
-- (a) 행사에 직접 붙은 판 → 같은 행사 아래 한 판짜리 시리즈. 묶음을 지어내지 않는다(§10 결정 6).
INSERT INTO match_series (id, game_code, event_id)
SELECT 'set:' || m.match_id, m.game_code, m.event_id FROM match m
 WHERE m.series_id IS NULL AND m.event_id IS NOT NULL;
UPDATE match SET series_id = 'set:' || match_id, series_game_no = 1, event_id = NULL
 WHERE series_id IS NULL AND event_id IS NOT NULL;

-- (b) 엑셀 CK(롤 수기 admin, 행사 없음) → 엑셀 날짜(KST)별 CK 행사 하나(사용자 결정 16, §10 결정 7).
CREATE TEMP TABLE skel_excel AS
  SELECT m.match_id, m.series_id, (m.game_creation AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id
   WHERE m.game_code = 'lol' AND m.source = 'manual' AND m.origin = 'admin'
     AND COALESCE(ms.event_id, m.event_id) IS NULL;
INSERT INTO event (slug, name, kind, format, game_code, starts_at)
SELECT DISTINCT 'ck-import-' || day, day || ' CK', 'ck', 'ck', 'lol', day::timestamp AT TIME ZONE 'Asia/Seoul' FROM skel_excel
ON CONFLICT (slug) DO NOTHING;
-- 시리즈는 있는데 행사가 없던 것: 그 시리즈를 날짜 행사에 붙인다(한 시리즈의 판이 여러 날이면 첫 날).
UPDATE match_series ms SET event_id = e.id
  FROM (SELECT series_id, min(day) AS day FROM skel_excel WHERE series_id IS NOT NULL GROUP BY series_id) x
  JOIN event e ON e.slug = 'ck-import-' || x.day
 WHERE ms.id = x.series_id AND ms.event_id IS NULL;
-- 시리즈도 없던 것: 한 판짜리 시리즈.
INSERT INTO match_series (id, game_code, event_id)
SELECT 'set:' || x.match_id, 'lol', e.id FROM skel_excel x JOIN event e ON e.slug = 'ck-import-' || x.day
 WHERE x.series_id IS NULL;
UPDATE match m SET series_id = 'set:' || m.match_id, series_game_no = 1
  FROM skel_excel x WHERE x.match_id = m.match_id AND x.series_id IS NULL;

-- (c) 토너먼트 코드 판 → KST 날짜별 자동 미분류 묶음(§3.4). 사람이 시리즈를 실제 행사로 옮겨 분류한다.
CREATE TEMP TABLE skel_code AS
  SELECT m.match_id, (m.game_creation AT TIME ZONE 'Asia/Seoul')::date AS day
    FROM match m WHERE m.game_code = 'lol' AND m.source = 'tournament_code' AND m.series_id IS NULL;
INSERT INTO event (slug, name, kind, format, auto_bucket, game_code, starts_at)
SELECT DISTINCT 'lol-code-auto-' || day, day || ' 토너먼트 코드 경기', 'other', 'unclassified', true, 'lol',
       day::timestamp AT TIME ZONE 'Asia/Seoul' FROM skel_code
ON CONFLICT (slug) DO NOTHING;
INSERT INTO match_series (id, game_code, event_id)
SELECT 'set:' || x.match_id, 'lol', e.id FROM skel_code x JOIN event e ON e.slug = 'lol-code-auto-' || x.day;
UPDATE match m SET series_id = 'set:' || m.match_id, series_game_no = 1 FROM skel_code x WHERE x.match_id = m.match_id;

-- (d) FC 스트리머끼리 판(두 자리 모두 스트리머, 서로 다름) 중 행사 없는 것 → (두 사람, KST 날짜) 자동 미분류 묶음.
--     스트리머가 한쪽뿐인 판은 개인 기록(personal)이다(§10 결정 3).
CREATE TEMP TABLE skel_fc_pair AS
  SELECT m.match_id, (m.game_creation AT TIME ZONE 'Asia/Seoul')::date AS day,
         least(a.streamer_id, b.streamer_id) AS s1, greatest(a.streamer_id, b.streamer_id) AS s2
    FROM match m
    JOIN fco_match_participant a ON a.match_id = m.match_id AND a.side_no = 1 AND a.streamer_id IS NOT NULL
    JOIN fco_match_participant b ON b.match_id = m.match_id AND b.side_no = 2 AND b.streamer_id IS NOT NULL
   WHERE m.game_code = 'fconline' AND m.series_id IS NULL AND a.streamer_id <> b.streamer_id;
INSERT INTO event (slug, name, kind, format, auto_bucket, game_code, starts_at)
SELECT DISTINCT 'fc-auto-' || x.day || '-' || x.s1 || '-' || x.s2, x.day || ' ' || sa.display_name || ' vs ' || sb.display_name,
       'other', 'unclassified', true, 'fconline', x.day::timestamp AT TIME ZONE 'Asia/Seoul'
  FROM skel_fc_pair x JOIN streamer sa ON sa.id = x.s1 JOIN streamer sb ON sb.id = x.s2
ON CONFLICT (slug) DO NOTHING;
INSERT INTO match_series (id, game_code, event_id)
SELECT 'set:' || x.match_id, 'fconline', e.id FROM skel_fc_pair x
  JOIN event e ON e.slug = 'fc-auto-' || x.day || '-' || x.s1 || '-' || x.s2;
UPDATE match m SET series_id = 'set:' || m.match_id, series_game_no = 1 FROM skel_fc_pair x WHERE x.match_id = m.match_id;

-- ── 5. 판의 범위(scope): 내전 세트 = 시리즈 안 / 개인 기록 = 그 밖 ───────────────
ALTER TABLE match ADD COLUMN scope text;
UPDATE match SET scope = CASE WHEN series_id IS NOT NULL THEN 'versus' ELSE 'personal' END;
-- 롤 수기·영상 판은 전부 내전이어야 한다 — 하나라도 남았으면 위 옮겨 담기가 빠뜨린 것이다.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM match WHERE game_code = 'lol' AND source IN ('manual', 'tournament_code') AND series_id IS NULL) THEN
    RAISE EXCEPTION '시리즈 밖에 남은 롤 내전 판이 있다 — 옮겨 담기 규칙이 빠뜨렸다';
  END IF;
END $$;
ALTER TABLE match ALTER COLUMN scope SET NOT NULL;
ALTER TABLE match ADD CONSTRAINT match_scope_check CHECK (scope IN ('versus', 'personal'));
ALTER TABLE match ADD CONSTRAINT match_scope_series CHECK ((scope = 'versus') = (series_id IS NOT NULL));

-- ── 6. 행사 → 시리즈 한 길 ──────────────────────────────────────────────────────
ALTER TABLE match DROP CONSTRAINT match_series_owns_event;
ALTER TABLE match DROP COLUMN event_id;
ALTER TABLE match_series DROP CONSTRAINT match_series_event_id_fkey;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM match_series WHERE event_id IS NULL) THEN
    RAISE EXCEPTION '행사 없는 시리즈가 남았다';
  END IF;
END $$;
ALTER TABLE match_series ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE match_series ADD CONSTRAINT match_series_event_fk
  FOREIGN KEY (event_id, game_code) REFERENCES event (id, game_code);
-- 판이 남은 시리즈는 지울 수 없다(기존 match_series_fk). 판이 없는 시리즈는 남기지 않는다 — 옛 경로가 남긴 빈 시리즈 정리.
DELETE FROM match_series ms WHERE NOT EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id);
-- 경기 없는 옛 행사(롤 other 2개 등)는 지운다 — 대진·팀·일정이 매달린 행사는 남긴다.
DELETE FROM event e
 WHERE NOT EXISTS (SELECT 1 FROM match_series ms WHERE ms.event_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM event_team t WHERE t.event_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM event_stage s WHERE s.event_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM schedule_entry se WHERE se.event_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM career_event ce WHERE ce.event_id = e.id)
   AND NOT e.auto_bucket;

-- ── 7. "이 행사가 아니다" — 현재 제약 (§3.7) ─────────────────────────────────────
CREATE TABLE event_exclusion (
  event_id    uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  match_id    text NOT NULL REFERENCES match(match_id) ON DELETE CASCADE,
  decided_by  text NOT NULL CHECK (decided_by IN ('auto', 'admin')),
  note        text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, match_id)
);
ALTER TABLE event_exclusion ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE event_exclusion IS
  '판을 그 행사에 붙이면 안 된다는 현재 판단. 판을 행사에 붙이는 모든 경로가 확인한다 — 사람(admin)의 제외는 자동 경로가 넘지 못한다. '
  '이력이 아니라 제약이다(풀면 행을 지우고 이력은 review_change).';
INSERT INTO event_exclusion (event_id, match_id, decided_by, note, decided_at)
SELECT d.event_id, d.match_id, d.created_by, d.note, d.created_at
  -- 마지막 결정이 현재 판단이다. 같은 시각(한 트랜잭션)이면 사람의 결정이 이긴다.
  FROM (SELECT DISTINCT ON (event_id, match_id) * FROM fco_event_match_decision
         ORDER BY event_id, match_id, created_at DESC, (created_by = 'admin') DESC) d
 WHERE d.decision = 'exclude';

-- 판단 이력은 review_change 로 — FC 맥락 판단(casual/unresolved)의 메모와 포함·제외 결정.
-- casual 은 친선으로 옮기지 않는다(§10 결정 4, 확인된 것만 라벨) — 메모만 이력으로 남는다.
ALTER TABLE review_change DROP CONSTRAINT review_change_entity_check;
ALTER TABLE review_change ADD CONSTRAINT review_change_entity_check
  CHECK (entity IN ('match', 'series', 'participant', 'frame', 'classification'));
INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor, changed_at)
SELECT c.match_id, 'classification', c.match_id, 'fco_match_context', NULL,
       jsonb_build_object('judgment', c.judgment, 'note', c.note), c.created_by, c.created_at
  FROM fco_match_context c;
INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor, changed_at)
SELECT d.match_id, 'classification', d.event_id::text, 'fco_event_match_decision', NULL,
       jsonb_build_object('decision', d.decision, 'bracket_no', d.bracket_no, 'bracket_label', d.bracket_label, 'note', d.note),
       d.created_by, d.created_at
  FROM fco_event_match_decision d;
DROP TABLE fco_match_context;
DROP TABLE fco_event_match_decision;

-- ── 8. 옛 분류 체계 지우기 ──────────────────────────────────────────────────────
ALTER TABLE match DROP CONSTRAINT match_manual_has_origin;
ALTER TABLE match DROP CONSTRAINT match_origin_check;
ALTER TABLE match DROP CONSTRAINT match_public_queue_has_riot_ids;
ALTER TABLE match DROP COLUMN source;
ALTER TABLE match DROP COLUMN origin;
ALTER TABLE match DROP COLUMN game_type, DROP COLUMN game_start, DROP COLUMN game_end, DROP COLUMN has_timeline;
ALTER TABLE event DROP COLUMN kind;
DROP FUNCTION lol_match_category(text, integer, text, text);
DROP FUNCTION lol_match_category(text, integer, text);
-- 파생 표는 뷰 계산으로 바꾼다(§10 결정 5 — 성능 측정으로 확정).
DROP TABLE streamer_encounter;
DROP TABLE champion_stat;

-- ── 9. 참가자: 기본 칸 / 상세(지명한 사람만) ────────────────────────────────────
CREATE TABLE lol_participant_detail (
  match_id            text NOT NULL,
  participant_id      smallint NOT NULL,
  cs                  integer,
  gold_earned         integer,
  damage_to_champions integer,
  vision_score        integer,
  items               integer[],
  summoner1_id        integer,
  summoner2_id        integer,
  perks               jsonb,
  challenges          jsonb,
  PRIMARY KEY (match_id, participant_id),
  FOREIGN KEY (match_id, participant_id) REFERENCES match_participant (match_id, participant_id) ON DELETE CASCADE
);
ALTER TABLE lol_participant_detail ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE lol_participant_detail IS '상세 지표 — 지명한 계정(collection_target)의 행만. 나머지 참가자는 기본 칸만 둔다.';
INSERT INTO lol_participant_detail
SELECT p.match_id, p.participant_id, p.cs, p.gold_earned, p.damage_to_champions, p.vision_score,
       p.items, p.summoner1_id, p.summoner2_id, p.perks, p.challenges
  FROM match_participant p JOIN match m ON m.match_id = p.match_id
 WHERE m.scope = 'personal' AND p.puuid IN (SELECT puuid FROM collection_target);
ALTER TABLE match_participant
  DROP COLUMN lane, DROP COLUMN role, DROP COLUMN damage_taken, DROP COLUMN wards_placed, DROP COLUMN wards_killed,
  DROP COLUMN control_wards, DROP COLUMN turret_kills, DROP COLUMN first_blood_kill,
  DROP COLUMN cs, DROP COLUMN gold_earned, DROP COLUMN damage_to_champions, DROP COLUMN vision_score,
  DROP COLUMN items, DROP COLUMN summoner1_id, DROP COLUMN summoner2_id, DROP COLUMN perks, DROP COLUMN challenges;

-- ── 10. 트리거 함수: 옛 칸을 읽던 곳 ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invalidate_match_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF NEW.game_code = 'fconline' AND OLD.game_code = 'fconline' THEN
    IF ROW(NEW.game_creation, NEW.game_creation_precision, NEW.game_duration, NEW.winning_team,
           NEW.blue_team_id, NEW.red_team_id, NEW.collected_via, NEW.mode_key, NEW.scope)
       IS DISTINCT FROM ROW(OLD.game_creation, OLD.game_creation_precision, OLD.game_duration, OLD.winning_team,
           OLD.blue_team_id, OLD.red_team_id, OLD.collected_via, OLD.mode_key, OLD.scope) THEN
      NEW.review_completed_at := NULL;
      NEW.review_version := OLD.review_version + 1;
    END IF;
    IF ROW(NEW.series_id, NEW.series_game_no, NEW.source_url)
       IS DISTINCT FROM ROW(OLD.series_id, OLD.series_game_no, OLD.source_url) THEN
      NEW.context_review_completed_at := NULL;
      NEW.context_review_version := OLD.context_review_version + 1;
    END IF;
  ELSIF ROW(NEW.game_code, NEW.game_creation, NEW.game_creation_precision, NEW.game_duration,
         NEW.winning_team, NEW.series_id, NEW.series_game_no, NEW.set_role, NEW.set_label,
         NEW.blue_team_id, NEW.red_team_id, NEW.visibility, NEW.collected_via, NEW.scope, NEW.source_url)
     IS DISTINCT FROM
     ROW(OLD.game_code, OLD.game_creation, OLD.game_creation_precision, OLD.game_duration,
         OLD.winning_team, OLD.series_id, OLD.series_game_no, OLD.set_role, OLD.set_label,
         OLD.blue_team_id, OLD.red_team_id, OLD.visibility, OLD.collected_via, OLD.scope, OLD.source_url) THEN
    NEW.review_completed_at := NULL;
    NEW.review_version := OLD.review_version + 1;
  END IF;
  RETURN NEW;
END $function$;

-- 행사 내용(진행 방식 포함)이 바뀌면 판단 버전이 오른다. FC 는 그 행사 판의 맥락 확인이 풀린다(지금과 같은 규칙, 길만 시리즈 경유로).
-- 롤 검수 완료는 경기 값의 확인이라 진행 방식 변경으로 풀지 않는다(지금과 같다).
CREATE OR REPLACE FUNCTION public.version_admin_event() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $function$
BEGIN
  IF ROW(NEW.name, NEW.format, NEW.organizer, NEW.source_url, NEW.starts_at, NEW.ends_at)
     IS DISTINCT FROM ROW(OLD.name, OLD.format, OLD.organizer, OLD.source_url, OLD.starts_at, OLD.ends_at) THEN
    NEW.admin_version := OLD.admin_version + 1;
    IF NEW.game_code = 'fconline' THEN
      UPDATE match m SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
       WHERE m.game_code = 'fconline'
         AND EXISTS (SELECT 1 FROM match_series ms WHERE ms.id = m.series_id AND ms.event_id = NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END $function$;

-- 대진표 칸에 잇는 경기는 그 대회의 같은 게임 경기여야 한다 — 시리즈 경유 한 길로(옛 COALESCE 두 길 제거).
CREATE OR REPLACE FUNCTION public.event_slot_match_same_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM match m
      JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
     WHERE m.match_id = NEW.match_id AND ms.event_id = NEW.event_id
  ) THEN
    RAISE EXCEPTION '경기 %는 대회 %에 연결된 같은 게임의 경기가 아니다', NEW.match_id, NEW.event_id;
  END IF;
  RETURN NEW;
END $$;

-- ── 11. 공개 뷰 ────────────────────────────────────────────────────────────────
CREATE VIEW core_public.event AS
  SELECT id AS event_id, slug, name, format, auto_bucket, organizer, starts_at, ends_at, source_url, game_code
    FROM event;

-- 공개 내전 세트 — 공개 집계가 고르는 유일한 곳(§5.1). 한 행 = (사람, 세트). 게임마다 평평한 뷰 하나씩이고
-- versus_set 은 둘을 이어 붙인 것이다. ★ 게임별로 나누는 이유: 이어 붙인(UNION) 뷰를 자기 자신과 다시 잇는 상대전적에서
-- PostgreSQL 이 "같은 경기의 상대"를 색인으로 찾지 못한다(운영 복사본 실측: 상대전적 상세 9초). 평평한 뷰끼리는 찾는다.
--
-- 참가자가 누구로 확인됐나에 따라 공개 규칙이 하나씩(게임마다 이 뷰에만 있다):
--   계정으로 확인 → 계정·스트리머 둘 다 공개 / 계정 없이 사람만 확인 → 스트리머 공개 / 둘 다면 계정 규칙이 이긴다(숨긴 계정이면 빠진다).
-- 기간은 시리즈 첫 공개 본게임의 KST 날짜로 판단한다 — 시리즈가 통째로 들어오거나 빠진다. 상관 부질의라 그 칸을 쓰는 질의의
-- 결과 행에만 (series_id, series_game_no) 색인으로 계산된다.
CREATE VIEW core_public.lol_versus_set AS
  SELECT 'lol'::text AS game_code, m.match_id, p.participant_id AS slot, p.team_id AS side, s.id AS streamer_id, p.outcome,
         p.champion_id, core_public.resolve_position(p.team_position, p.individual_position) AS position,
         p.kills, p.deaths, p.assists, NULL::integer AS goals,
         m.series_id, m.series_game_no, ms.best_of, ms.set_order_known,
         e.id AS event_id, e.format, e.auto_bucket, m.map, m.mode_key,
         m.game_creation AS played_at, m.game_creation_precision, m.game_duration,
         ((SELECT min(f.game_creation) FROM match f
            WHERE f.series_id = m.series_id AND f.set_role = 'main' AND f.visibility = 'public') AT TIME ZONE 'Asia/Seoul')::date AS series_started_on
    FROM match m
    JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN event e ON e.id = ms.event_id
    JOIN match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
    JOIN streamer s ON s.visibility = 'public' AND s.id =
      CASE WHEN sa.puuid IS NOT NULL THEN CASE WHEN sa.visibility = 'public' THEN sa.streamer_id END ELSE p.streamer_id END
   WHERE m.game_code = 'lol' AND m.visibility = 'public' AND m.scope = 'versus' AND m.set_role = 'main'
     AND m.map IN ('rift', 'aram');

CREATE VIEW core_public.fc_versus_set AS
  SELECT 'fconline'::text AS game_code, m.match_id, p.side_no AS slot, p.side_no AS side, s.id AS streamer_id, p.outcome,
         NULL::integer AS champion_id, NULL::text AS position,
         NULL::smallint AS kills, NULL::smallint AS deaths, NULL::smallint AS assists, p.goals,
         m.series_id, m.series_game_no, ms.best_of, ms.set_order_known,
         e.id AS event_id, e.format, e.auto_bucket, m.map, m.mode_key,
         m.game_creation AS played_at, m.game_creation_precision, m.game_duration,
         ((SELECT min(f.game_creation) FROM match f
            WHERE f.series_id = m.series_id AND f.set_role = 'main' AND f.visibility = 'public') AT TIME ZONE 'Asia/Seoul')::date AS series_started_on
    FROM match m
    JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN event e ON e.id = ms.event_id
    JOIN fco_match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_fco_account sfa ON sfa.ouid = p.ouid
    JOIN streamer s ON s.visibility = 'public' AND s.id =
      CASE WHEN sfa.ouid IS NOT NULL THEN CASE WHEN sfa.visibility = 'public' THEN sfa.streamer_id END ELSE p.streamer_id END
   WHERE m.game_code = 'fconline' AND m.visibility = 'public' AND m.scope = 'versus' AND m.set_role = 'main';

CREATE VIEW core_public.versus_set AS
  SELECT * FROM core_public.lol_versus_set UNION ALL SELECT * FROM core_public.fc_versus_set;
COMMENT ON VIEW core_public.versus_set IS
  '공개 내전 세트(본게임만). 공개 집계는 이것(게임별 lol_versus_set·fc_versus_set)과 versus_pair_set 만 읽는다. 세는 규칙은 packages/core/lib/metrics/tally.ts.';

-- 상대전적의 재료 — 같은 판의 두 사람(게임별로 같은 경기 안에서만 잇는다). 결과 짝 → 상대전적 결과는 tally.ts 의 pairSetOutcome 한 곳.
CREATE VIEW core_public.versus_pair_set AS
  SELECT a.game_code, a.match_id, a.streamer_id AS a_streamer_id, b.streamer_id AS b_streamer_id,
         CASE WHEN a.side = b.side THEN 'teammate' ELSE 'opponent' END AS relation,
         a.outcome AS a_outcome, b.outcome AS b_outcome, a.position AS a_position, b.position AS b_position,
         a.champion_id AS a_champion_id, b.champion_id AS b_champion_id,
         a.series_id, a.series_game_no, a.event_id, a.format, a.auto_bucket, a.map, a.mode_key,
         a.played_at, a.series_started_on
    FROM core_public.lol_versus_set a
    JOIN core_public.lol_versus_set b ON b.match_id = a.match_id AND b.streamer_id <> a.streamer_id
  UNION ALL
  SELECT a.game_code, a.match_id, a.streamer_id, b.streamer_id,
         CASE WHEN a.side = b.side THEN 'teammate' ELSE 'opponent' END,
         a.outcome, b.outcome, a.position, b.position, a.champion_id, b.champion_id,
         a.series_id, a.series_game_no, a.event_id, a.format, a.auto_bucket, a.map, a.mode_key,
         a.played_at, a.series_started_on
    FROM core_public.fc_versus_set a
    JOIN core_public.fc_versus_set b ON b.match_id = a.match_id AND b.streamer_id <> a.streamer_id;

-- 개인 기록(지명 수집한 판, FC 의 스트리머 한쪽 판) — 솔랭 도전 같은 전용 화면만 읽는다. 내전 집계에 들어가지 않는다.
CREATE VIEW core_public.personal_game AS
  SELECT m.game_code, m.match_id, m.queue_id, m.game_mode, m.mode_key, m.map,
         m.game_creation AS played_at, m.game_duration, m.winning_team, m.ended_in_surrender,
         p.participant_id AS slot, p.team_id AS side, p.outcome, p.champion_id, p.champion_name,
         p.team_position, p.individual_position, p.kills, p.deaths, p.assists,
         CASE WHEN sa.visibility = 'public' AND s.visibility = 'public' THEN sa.streamer_id END AS streamer_id,
         CASE WHEN sa.visibility = 'public' AND s.visibility = 'public' THEN sa.puuid END AS puuid,
         d.cs, d.gold_earned, d.damage_to_champions, d.vision_score, d.items, d.summoner1_id, d.summoner2_id,
         ((d.perks #>> '{styles,0,selections,0,perk}'))::integer AS keystone_id,
         ((d.perks #>> '{styles,1,style}'))::integer AS sub_style_id, d.challenges
    FROM match m
    JOIN match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
    LEFT JOIN streamer s ON s.id = sa.streamer_id
    LEFT JOIN lol_participant_detail d ON d.match_id = p.match_id AND d.participant_id = p.participant_id
                                      AND sa.visibility = 'public' AND s.visibility = 'public'
   WHERE m.visibility = 'public' AND m.scope = 'personal' AND m.game_code = 'lol';

-- 경기 하나 보기(롤) — 경기·행사 상세 화면. 보너스 판 포함. 미등록 자리는 화면에서 읽은 이름만.
CREATE VIEW core_public.match_detail AS
  SELECT m.match_id, m.series_id, m.series_game_no, m.set_role, m.set_label, ms.event_id, e.format, m.map,
         m.queue_id, m.game_mode, m.game_creation AS played_at, m.game_creation_precision, m.game_duration,
         m.winning_team, m.blue_team_id, m.red_team_id, m.source_url, m.collected_via,
         p.participant_id, p.team_id, p.team_position, p.individual_position,
         core_public.resolve_position(p.team_position, p.individual_position) AS position,
         p.champion_id, p.champion_name, p.champ_level, p.kills, p.deaths, p.assists, p.outcome,
         s.id AS streamer_id,
         CASE WHEN p.puuid IS NULL AND p.streamer_id IS NULL THEN p.observed_name END AS observed_name
    FROM match m
    JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    JOIN event e ON e.id = ms.event_id
    JOIN match_participant p ON p.match_id = m.match_id
    LEFT JOIN streamer_account sa ON sa.puuid = p.puuid AND sa.active_to IS NULL
    LEFT JOIN streamer s ON s.visibility = 'public' AND s.id =
      CASE WHEN sa.puuid IS NOT NULL THEN CASE WHEN sa.visibility = 'public' THEN sa.streamer_id END ELSE p.streamer_id END
   WHERE m.visibility = 'public' AND m.scope = 'versus' AND m.game_code = 'lol'
     -- 지금 규칙 유지: 공개 스트리머 자리와 화면에서 읽은 미등록 이름 자리만. Riot 일반인 자리·숨긴 계정 자리는 행째 빠진다.
     AND (s.id IS NOT NULL OR (p.puuid IS NULL AND p.streamer_id IS NULL AND p.observed_name IS NOT NULL));

-- 행사의 유효 날짜 — 공개 본게임으로 보완한다. 시리즈 경유 한 길.
CREATE VIEW core_public.event_dates AS
  SELECT e.*, COALESCE(e.starts_at, g.first_match) AS effective_starts_at,
         COALESCE(e.ends_at, g.last_match) AS effective_ends_at
    FROM core_public.event e LEFT JOIN (
      SELECT ms.event_id, min(m.game_creation) AS first_match, max(m.game_creation) AS last_match
        FROM match m JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE m.visibility = 'public' AND m.set_role = 'main' GROUP BY ms.event_id
    ) g ON g.event_id = e.event_id;

-- 일정(planned_kind → planned_format)
CREATE VIEW core_public.schedule_entry AS
  SELECT e.id AS schedule_id, e.game_code, e.title, e.planned_format, e.sponsor, e.description,
         e.status, e.event_id, e.origin, e.updated_at
    FROM schedule_entry e
   WHERE e.visibility = 'public'
     AND EXISTS (SELECT 1 FROM schedule_source s WHERE s.entry_id = e.id);
CREATE VIEW core_public.schedule_slot AS
  SELECT s.id AS slot_id, s.entry_id AS schedule_id, s.label, s.on_date, s.starts_at, s.ends_at, s.channel_id
    FROM schedule_slot s JOIN core_public.schedule_entry pe ON pe.schedule_id = s.entry_id;
CREATE VIEW core_public.schedule_source AS
  SELECT s.entry_id AS schedule_id, s.url, s.title, s.posted_at
    FROM schedule_source s JOIN core_public.schedule_entry pe ON pe.schedule_id = s.entry_id;
CREATE VIEW core_public.schedule_participant AS
  SELECT p.entry_id AS schedule_id, p.streamer_id, p.role, p.team
    FROM schedule_participant p
    JOIN core_public.schedule_entry pe ON pe.schedule_id = p.entry_id
    JOIN core_public.streamer st ON st.streamer_id = p.streamer_id;
CREATE VIEW core_public.schedule_change AS
  SELECT c.entry_id AS schedule_id, c.field, c.before, c.after, c.changed_at
    FROM schedule_change c JOIN core_public.schedule_entry pe ON pe.schedule_id = c.entry_id;

-- 권한: 같은 이름으로 다시 만든 뷰는 옛 권한 그대로, 새 공개 뷰는 옛 core_public.match 의 권한을 받는다.
DO $$ DECLARE g record; v text;
BEGIN
  FOR g IN SELECT * FROM skel_view_grants WHERE table_name <> 'match' LOOP
    EXECUTE format('GRANT %s ON core_public.%I TO %s%s', g.privilege_type, g.table_name,
      CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
      CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
  END LOOP;
  FOREACH v IN ARRAY ARRAY['lol_versus_set', 'fc_versus_set', 'versus_set', 'versus_pair_set', 'personal_game', 'match_detail'] LOOP
    FOR g IN SELECT * FROM skel_view_grants WHERE table_name = 'match' LOOP
      EXECUTE format('GRANT %s ON core_public.%I TO %s%s', g.privilege_type, v,
        CASE WHEN g.grantee = 'PUBLIC' THEN 'PUBLIC' ELSE quote_ident(g.grantee) END,
        CASE WHEN g.is_grantable = 'YES' THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
  END LOOP;
END $$;

-- ── 12. 정리 ───────────────────────────────────────────────────────────────────
DROP TABLE skel_view_grants, skel_excel, skel_code, skel_fc_pair;
ALTER TABLE match            ENABLE TRIGGER match_review_values;
ALTER TABLE match_series     ENABLE TRIGGER series_review_values;
ALTER TABLE match_participant ENABLE TRIGGER participant_review_values;
ALTER TABLE event            ENABLE TRIGGER event_admin_version;

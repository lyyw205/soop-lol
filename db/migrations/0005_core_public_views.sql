-- core_public — 모듈이 core 를 읽는 **유일한 창구**.
--
-- 왜 뷰인가: visibility('hidden')는 지금까지 core 의 질의 안에서만 지켜졌다.
-- 모듈이 raw 테이블을 직접 읽으면 숨긴 부계정과 evidence(제보자 메모)가 그대로 샌다.
-- 그건 삭제 요청 경로를 살려둔 의미를 통째로 없애는 구멍이다 (docs/PLAN.md §11-2).
--
-- 그래서 "모듈은 조심해서 짜라"가 아니라 **물리적으로 못 보게** 만든다.
-- 여기 없는 컬럼은 모듈이 볼 수 없다. evidence 는 의도적으로 빠져 있다.

CREATE SCHEMA IF NOT EXISTS core_public;

COMMENT ON SCHEMA core_public IS
  '모듈이 읽는 core 의 공개면. 모듈은 이 스키마와 자기 mod_* 스키마 밖을 건드리지 않는다.';

-- ── 아이덴티티 ───────────────────────────────────────────────────────

CREATE VIEW core_public.streamer AS
  SELECT id AS streamer_id, slug, display_name, aliases,
         profile_image_url, is_pro, team_name, status, created_at
    FROM streamer
   WHERE visibility = 'public';

CREATE VIEW core_public.streamer_channel AS
  SELECT c.streamer_id, c.platform, c.channel_id, c.channel_url, c.label, c.is_primary
    FROM streamer_channel c
    JOIN streamer s ON s.id = c.streamer_id
   WHERE s.visibility = 'public' AND c.active_to IS NULL;

-- ★ evidence · confidence · verified_by 는 노출하지 않는다.
--   근거는 관리자와 공개 프로필이 정해진 형식으로만 보여준다. 모듈의 몫이 아니다.
CREATE VIEW core_public.streamer_account AS
  SELECT sa.streamer_id, sa.puuid, sa.label, sa.is_main,
         ra.game_name, ra.tag_line, ra.summoner_level, ra.profile_icon_id
    FROM streamer_account sa
    JOIN streamer s     ON s.id = sa.streamer_id
    JOIN riot_account ra ON ra.puuid = sa.puuid
   WHERE sa.visibility = 'public' AND s.visibility = 'public' AND sa.active_to IS NULL;

-- ── 경기 ─────────────────────────────────────────────────────────────

CREATE VIEW core_public.match AS
  SELECT match_id, queue_id, game_mode, game_version, game_creation, game_duration,
         winning_team, ended_in_surrender, source, event_id
    FROM match;

-- 참가자는 **공개 스트리머의 행만** 준다. 일반인 puuid 까지 모듈에 흘릴 이유가 없다.
CREATE VIEW core_public.match_participant AS
  SELECT mp.match_id, sa.streamer_id, mp.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges
    FROM match_participant mp
    JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                            AND sa.visibility = 'public'
    JOIN streamer s ON s.id = sa.streamer_id AND s.visibility = 'public';

-- ★ 이 사이트의 심장. 양쪽 스트리머가 모두 공개일 때만 보인다.
CREATE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration
    FROM streamer_encounter se
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

-- ── 커리어 ───────────────────────────────────────────────────────────

CREATE VIEW core_public.rank_snapshot AS
  SELECT sa.streamer_id, rs.puuid, rs.queue_type, rs.snapshot_date,
         rs.tier, rs.division, rs.league_points, rs.wins, rs.losses,
         rs.hot_streak, rs.lp_absolute
    FROM rank_snapshot rs
    JOIN streamer_account sa ON sa.puuid = rs.puuid AND sa.active_to IS NULL
                            AND sa.visibility = 'public'
    JOIN streamer s ON s.id = sa.streamer_id AND s.visibility = 'public';

CREATE VIEW core_public.champion_stat AS
  SELECT cs.* FROM champion_stat cs
    JOIN streamer s ON s.id = cs.streamer_id AND s.visibility = 'public';

CREATE VIEW core_public.career_event AS
  SELECT ce.id, ce.streamer_id, ce.event_id, ce.title, ce.role, ce.team_name,
         ce.placement, ce.date_from, ce.date_to, ce.source_url
    FROM career_event ce
    JOIN streamer s ON s.id = ce.streamer_id AND s.visibility = 'public';

CREATE VIEW core_public.season_record AS
  SELECT sr.* FROM season_record sr
    JOIN streamer s ON s.id = sr.streamer_id AND s.visibility = 'public';

CREATE VIEW core_public.event AS
  SELECT id AS event_id, slug, name, kind, organizer, starts_at, ends_at, source_url
    FROM event;

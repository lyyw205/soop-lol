-- 공개 경기 참가자: 빌드(아이템·소환사 주문·핵심 룬) + 한 판의 양 팀 10자리(이름 없이)
--
-- 왜: 솔랭 도전 모듈(packages/modules/solo_challenge)이 전적 사이트와 같은 판 목록 — 챔피언·스펠·룬·아이템,
--     양 팀 10명의 챔피언 — 을 그린다. 지금 core_public 은 그 칸을 내보내지 않는다.
--
-- ① core_public.match_participant 끝에 칸을 덧붙인다(CREATE OR REPLACE 는 끝에만 붙일 수 있다).
--    숨김 조인 세 개(경기·계정·사람 visibility)와 WHERE 는 0028 그대로 둔다.
--    룬은 원본 JSON 을 통째로 내보내지 않는다 — 화면이 쓰는 핵심 룬·보조 계열 두 숫자만.
--
-- ② core_public.match_lineup — 공개 롤 경기의 **10자리 전부**를 챔피언·포지션·KDA 같은 경기 기록으로만.
--    ★ 신원은 없다: puuid·observed_name(인게임명) 칸이 아예 없다. 사람이 붙는 것은 **공개 계정의 공개 스트리머**
--      자리뿐이다(streamer_id). 숨긴 계정·숨긴 사람·미등록 일반인 자리는 streamer_id 가 비어 익명 챔피언 한 칸으로만 남는다.
--      전적 사이트가 보여 주는 "상대 팀 다섯 챔피언"을 이름 없이 보여 주려는 것이다(일반인 이름은 여전히 공개면에 없다).

CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.outcome,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges,
         CASE WHEN s.id IS NULL THEN mp.observed_name ELSE NULL END AS observed_name,
         mp.participant_id,
         mp.items,
         mp.summoner1_id,
         mp.summoner2_id,
         (mp.perks #>> '{styles,0,selections,0,perk}')::int AS keystone_id,
         (mp.perks #>> '{styles,1,style}')::int AS sub_style_id
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                        AND s.visibility = 'public'
   WHERE s.id IS NOT NULL
      OR (mp.puuid IS NULL AND mp.streamer_id IS NULL AND mp.observed_name IS NOT NULL);

CREATE VIEW core_public.match_lineup AS
  SELECT mp.match_id, mp.participant_id, mp.team_id, mp.team_position,
         mp.champion_id, mp.outcome, mp.kills, mp.deaths, mp.assists, mp.cs,
         mp.damage_to_champions, mp.gold_earned,
         s.id AS streamer_id
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id
                AND m.visibility = 'public'
                AND m.game_code = 'lol'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                        AND s.visibility = 'public';

COMMENT ON VIEW core_public.match_lineup IS
  '공개 롤 경기의 10자리 — 챔피언·포지션·KDA 만. 신원(puuid·인게임명) 칸이 없고, 공개 스트리머 자리에만 streamer_id 가 있다.';

-- 0023 — 공개 로스터도 기존 자리 ID로 식별한다.
-- 이름·챔피언은 중복되거나 교정될 수 있다. 적용된 0022는 그대로 두고 열을 끝에 추가한다.
CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges,
         -- ★ 사람을 못 붙인 자리에서만 화면에서 읽은 이름을 내보낸다.
         --   등록된 스트리머는 display_name 이 있으므로 이 칸이 필요 없고, 그 사람의
         --   인게임명(부계정일 수 있다)을 굳이 덧붙일 이유도 없다.
         CASE WHEN s.id IS NULL THEN mp.observed_name END AS observed_name,
         mp.participant_id
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id AND m.visibility = 'public'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    -- ⚠ INNER 에서 LEFT 로 바꾼다. 대신 어떤 행을 남길지는 아래 WHERE 가 정한다 —
    --   조인만 풀면 **숨긴 것들이 통째로 새어 나온다.**
    LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                        AND s.visibility = 'public'
   WHERE
     -- ① 사람이 붙었고 그 사람이 공개다 (여태까지의 유일한 경로)
     s.id IS NOT NULL
     -- ② 계정도 사람도 아예 없고 **화면에서 읽은 이름만** 있는 자리 — 이번에 여는 문.
     --    세 조건을 다 건다:
     --      · puuid 가 없어야 한다 → 숨긴 계정이 '미확인' 으로 둔갑해 되살아나는 것을 막는다(0021)
     --      · streamer_id 가 없어야 한다 → 숨긴 스트리머가 같은 식으로 되살아나는 것을 막는다
     --      · 읽은 이름이 있어야 한다 → 아무 정보도 없는 빈 자리를 공개면에 띄우지 않는다
     OR (mp.puuid IS NULL AND mp.streamer_id IS NULL AND mp.observed_name IS NOT NULL);

COMMENT ON VIEW core_public.match_participant IS
  '공개 로스터. 미확인 자리는 관찰 이름으로 표시한다. 숨긴 경기·사람은 제외한다. '
  '숨긴 계정은 puuid가 제거되며, 직접 연결한 공개 사람이 있으면 참가 기록은 유지한다. '
  'match_id와 participant_id가 자리의 안정적인 식별자다.';

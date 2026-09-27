-- 0022 — **미확인 참가자도 로스터에 세운다.**
--
-- 무엇이 틀려 있었나
--   2026-09-19 상호팀 vs 만식팀에서 1팀의 `소년가장 원딜` 이 스트리머로 등록돼 있지 않다.
--   결과 화면에서 이름·챔피언·KDA 를 다 읽어 `match_participant` 에 넣었는데,
--   `streamer_id` 가 없다는 이유로 공개 뷰에서 행째로 빠졌다. **화면에 5명 중 4명만 나온다.**
--
--   이건 0017 이 고쳤어야 했던 바로 그 버그의 한 층 위다. 0017 의 첫 줄이
--   "화면에서 성훈팀이 5명 중 4명만 나왔다" 인데, 그때 고친 것은 **저장**뿐이고
--   **표시**는 그대로였다.
--
-- ★ 왜 이게 중요한가 (CLAUDE.md 3 — 숫자로 거짓말하지 않는다)
--   5대5 였던 판을 4명으로 그리면, 보는 사람은 **4대5 였는지 한 명이 누락된 건지
--   구분할 수 없다.** 모르는 것을 감춘 게 아니라 틀린 것을 보여주고 있었다.
--   "다섯이 뛰었고 그중 넷을 안다" 가 정확한 말이고, 화면이 그대로 말해야 한다.
--
-- ★ 조우·통계는 **안 바뀐다**
--   `streamer_encounter` 는 사람과 사람 사이의 사실이라 한쪽을 모르면 쌍을 만들 수 없다.
--   `champion_stat` 도 사람 단위다. 달라지는 것은 **로스터 표시뿐**이다.
--   (뷰를 읽는 다른 질의는 전부 `WHERE mp.streamer_id = <특정 uuid>` 로 걸러 읽으므로
--    NULL 행이 섞여도 경기 수·승률에 영향이 없다 — 이 마이그레이션 전에 다섯 곳 다 확인했다.)

-- ⚠ CREATE OR REPLACE VIEW 는 **끝에 덧붙이는 것만** 된다. 기존 16개 컬럼의 이름·타입·
--   순서를 한 칸도 건드리지 않고 `observed_name` 을 맨 뒤에 붙인다 (0020 ⑨ 와 같은 제약).
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
         CASE WHEN s.id IS NULL THEN mp.observed_name END AS observed_name
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
  '공개 참가자. 사람을 못 붙인 자리도 화면에서 읽은 이름으로 **로스터에 선다**(0022) — '
  '5대5 를 4명으로 그리면 누락인지 인원 차이인지 구분할 수 없다. '
  'puuid 는 공개 계정일 때만 나오고(0021), 숨긴 계정·숨긴 사람은 여전히 행째로 빠진다.';

-- 미확인 자리를 찾는 질의가 어드민 작업 목록에서 자주 돈다.
CREATE INDEX match_participant_unidentified_idx
    ON match_participant (observed_name)
 WHERE streamer_id IS NULL AND puuid IS NULL AND observed_name IS NOT NULL;

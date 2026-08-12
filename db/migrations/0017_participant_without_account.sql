-- **계정이 없는 참가자도 경기에 기록한다.**
--
-- 무엇이 빠져 있었나: 2026-08-08 시그니처CK 에서 이라333 은 우리 명단에 등록돼 있고
-- (SOOP 채널 pushpull2027), 결과 화면에서 팀·포지션·챔피언·KDA 까지 다 읽었다.
-- 그런데 라이엇 계정을 아직 못 붙였다는 이유로 **경기 참가자로 한 줄도 안 들어갔다.**
-- 화면에서 성훈팀이 5명 중 4명만 나왔다.
--
-- 원인은 match_participant 가 puuid 없이는 존재할 수 없는 구조라는 것이다.
-- 그런데 우리가 아는 사실은 "이 **사람**이 이 판에 있었다" 지 "이 **계정**이 있었다" 가
-- 아니다. 공개 큐는 Riot 이 puuid 로 알려주니 그게 맞지만, 방송을 읽어 넣는 내전은
-- 사람이 먼저고 계정은 나중에 붙는다. 표가 그 순서를 못 담고 있었다.
--
-- ★ 없는 puuid 를 만들어 넣지 않는다
--   `local:ira333` 같은 걸 채우면 "이게 진짜 Riot puuid 인가" 를 나중에 아무도
--   판단할 수 없다. 0006 에서 game_id 를 NULL 로 둔 것과 같은 이유다 — NULL 이 정직하다.
--
-- ★ puuid 는 여전히 계정의 유일한 키다 (§11-1)
--   바뀌는 건 "참가자를 무엇으로 식별하는가" 뿐이다. 계정이 붙으면 puuid 로,
--   아직이면 streamer_id 로. 둘 중 하나는 반드시 있어야 한다.

ALTER TABLE match_participant ADD COLUMN streamer_id uuid REFERENCES streamer(id) ON DELETE CASCADE;

-- 지금 있는 행에 사람을 채워 둔다. 이후 질의가 두 경로를 따로 안 타도 되게.
UPDATE match_participant mp
   SET streamer_id = sa.streamer_id
  FROM streamer_account sa
 WHERE sa.puuid = mp.puuid AND sa.active_to IS NULL;

-- ★ PK 를 (match_id, puuid) 에서 (match_id, participant_id) 로 옮긴다.
--   participant_id 는 한 경기 안에서 1..10 이라 계정 유무와 무관하게 늘 있다.
--   ⚠ **PK 를 먼저 옮겨야 한다.** PK 에 든 컬럼은 NOT NULL 을 풀 수 없다.
ALTER TABLE match_participant DROP CONSTRAINT match_participant_pkey;
ALTER TABLE match_participant ADD PRIMARY KEY (match_id, participant_id);
ALTER TABLE match_participant ALTER COLUMN puuid DROP NOT NULL;

-- 같은 계정이 한 경기에 두 번 들어오면 사고다. puuid 가 있을 때만 강제한다.
CREATE UNIQUE INDEX match_participant_puuid_uq
  ON match_participant (match_id, puuid) WHERE puuid IS NOT NULL;
-- 같은 사람이 한 경기에 두 번 있을 수도 없다.
CREATE UNIQUE INDEX match_participant_streamer_uq
  ON match_participant (match_id, streamer_id) WHERE streamer_id IS NOT NULL;
-- 둘 다 비면 "누군지 모르는 참가자" 인데, 그런 행은 아무 쓸모가 없다.
ALTER TABLE match_participant ADD CONSTRAINT match_participant_has_identity
  CHECK (puuid IS NOT NULL OR streamer_id IS NOT NULL);

CREATE INDEX match_participant_streamer_idx ON match_participant (streamer_id)
  WHERE streamer_id IS NOT NULL;

COMMENT ON COLUMN match_participant.streamer_id IS
  '이 자리에 있던 우리 스트리머. 계정을 아직 못 붙였어도 방송에서 확인했으면 채운다. '
  '공개 큐는 puuid 로 들어오고 이 칸은 매핑에서 파생된다.';
COMMENT ON COLUMN match_participant.puuid IS
  'Riot 이 준 puuid. 방송을 읽어 넣은 내전에서 계정을 모르면 NULL — 없는 값을 만들지 않는다.';

-- ── 조우도 계정 없이 맺힐 수 있어야 한다 ────────────────────────────
-- 조우는 **사람 사이**의 사실이다(streamer_a_id · streamer_b_id 가 PK 다).
-- a_puuid 는 어느 계정으로 뛰었는지 되짚는 참고값일 뿐인데 NOT NULL 이라
-- 계정 없는 사람이 낀 조우를 통째로 막고 있었다.
ALTER TABLE streamer_encounter ALTER COLUMN a_puuid DROP NOT NULL;
ALTER TABLE streamer_encounter ALTER COLUMN b_puuid DROP NOT NULL;

-- ── core_public 갱신 ────────────────────────────────────────────────
-- ⚠ 숨김 조인을 반드시 유지한다 (계약 5조). 0016 에서 한 번 빠뜨렸다.
--
-- 두 경로를 합친다: 계정이 붙은 행(streamer_account 경유)과 사람만 아는 행.
-- 어느 쪽이든 **공개 스트리머일 때만** 나간다.
CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         mp.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges
    FROM match_participant mp
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                   AND s.visibility = 'public';

-- 0021 — 숨긴 계정의 식별자를 공개면에서 지우고, 프레임에도 검수 보호를 준다.
--
-- 0019·0020 은 이미 적용됐으므로 고치지 않는다. 뒤에 붙인다.

-- ── ① 숨긴 계정의 puuid 가 공개 계약에 남던 구멍 ────────────────────
--
-- ⚠ 무엇이 새고 있었나
--   `core_public.match_participant` 이 `mp.puuid` 를 **조건 없이** 내보냈다.
--   계정 조인(`sa`)은 `visibility='public'` 을 걸지만, 사람은
--   `COALESCE(sa.streamer_id, mp.streamer_id)` 로 되살아난다. 그래서 계정을 숨겨도
--   **행이 살아남고 숨긴 puuid 가 그대로 나갔다.**
--
--   puuid 와 streamer_id 가 **함께** 있는 행에서만 터진다 — 그게 정확히 VOD 판독으로
--   손수 이은 참가자의 모양이다(0017·0020). 공개 큐 수집분은 streamer_id 가 비어 있어
--   숨기면 조인이 끊기고 행째로 빠졌다. 그래서 여태 안 보였다.
--
-- ★ 고른 방침: **식별자만 지우고 참가 기록은 남긴다.**
--   챔피언·KDA·승패·조우는 그대로 남아 그 사람의 커리어가 비지 않는다.
--   부계정이라는 사실만 공개면에서 사라진다(CLAUDE.md 2 — 부계정 오노출은 실제 분쟁이 된다).
--   ⚠ "그 계정으로 뛴 기록 자체를 내려 달라" 는 요청은 이걸로 부족하다.
--     그때는 스트리머를 숨기거나(`streamer.visibility`) 해당 경기를 뺀다(`match.visibility`).
--
-- 구현은 한 글자다 — `mp.puuid` 대신 **`sa.puuid`**. 조인이 이미 공개 계정만 통과시키므로
-- 숨겼거나 매핑이 없으면 NULL 이 된다. 컬럼 이름·타입·순서는 그대로라 REPLACE 가 된다.
--
-- ⚠ 0020 의 정의를 그대로 옮기고 이 한 줄만 바꾼다. 숨김 조인 세 개(경기·계정·사람)를
--   다시 쓰는 것이 이 뷰의 계약이다 — 0016 에서 한 번 빠뜨린 자리다.
CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         sa.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id AND m.visibility = 'public'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                   AND s.visibility = 'public';

COMMENT ON VIEW core_public.match_participant IS
  '공개 참가자. puuid 는 **공개 계정일 때만** 나온다 — 숨긴 계정은 사람으로 되살아나도 '
  '식별자가 비어 나간다(0021). 관찰 이름(observed_name)은 애초에 넣지 않는다.';


-- ── ② 프레임에도 재수집 보호 ────────────────────────────────────────
--
-- ⚠ 무엇이 되돌아갔나
--   경기에는 `reviewed_at` 이 있어 자동 수집이 못 덮는다(0020). **프레임엔 없었다.**
--   그래서 사람이 어드민에서 메모를 고치거나("실은 리플레이였다") 잘못 붙은 경기 연결을
--   끊어도, 같은 VOD 를 다시 훑으면 `recordEvidenceFrames` 가 원래 메모로 덮고
--   `upsertMatchFromScan` 이 연결을 되살렸다. 고친 사람은 고쳤다고 믿는다.
--
-- ★ 경기와 **같은 말, 같은 뜻**으로 둔다 — 사람이 만진 행은 자동 수집이 건드리지 않는다.
--   추출 도구는 이 칸을 절대 채우지 않는다(0019 의 read_at 과 같은 이유).
ALTER TABLE match_evidence_frame ADD COLUMN reviewed_at timestamptz;

COMMENT ON COLUMN match_evidence_frame.reviewed_at IS
  '사람이 이 프레임의 메모·연결을 고친 시각. 채워져 있으면 재수집이 덮지 않는다(0021). '
  'read_at 과 다르다 — read_at 은 "열어 봤다"(스킬도 찍는다), reviewed_at 은 "사람이 고쳤다".';

-- 재수집이 「사람이 안 만진 것만」 고르는 질의가 자주 돈다.
CREATE INDEX match_evidence_frame_unreviewed_idx
    ON match_evidence_frame (lead_id) WHERE reviewed_at IS NULL;

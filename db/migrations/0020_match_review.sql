-- 검수 어드민이 **고칠 수 있어야 하는 것** + 자동 수집과의 재실행 계약.
--
-- 왜 이 묶음인가:
--   VOD 조사를 사람의 사전 승인 없이 DB 에 바로 쓰기로 정했다(초안 단계 없음).
--   그 대신 **사후에 고칠 수 있어야** 한다 — 안 그러면 규칙을 느슨하게 한 대가를
--   아무도 치울 수 없다. 참고 모델(onair-map 0049)의 핵심은 「기본 공개, 뺄 것만
--   제외」인데, '제외' 를 담을 칸이 match 에 없었다. 절반만 가져오면 안전장치가 없다.
--
--   그리고 고친 값이 **자동 수집 재실행에 덮이면** 고친 의미가 없다. 지금 실제로 덮인다:
--     · pruneEventMatches 는 그 대회에서 시드에 없는 경기를 **전부** 지운다
--     · saveTournamentGame 은 참가자를 지우고 다시 넣는다
--   VOD 조사로 멸망전 event 를 보강하면 다음 seed:meljang 실행이 통째로 날린다.
--
-- docs/CK-COLLECTION.md · .claude/skills/ck-research/SKILL.md

-- ── ① 제외 — 「기본 공개, 뺄 것만 제외」의 '제외' ────────────────────
--
-- ★ 지우지 않고 숨긴다. 지우면 두 가지를 따로 정해야 한다 — 복구 경로와,
--   다음 수집이 같은 것을 다시 만들지 않게 하는 장치. 숨김은 둘 다 공짜다.
--   streamer.visibility · streamer_account.visibility 와 **같은 관용구**를 쓴다.
ALTER TABLE match ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'hidden'));

COMMENT ON COLUMN match.visibility IS
  '공개 화면에 내보내나. 무효판·중복판·시청 구간 오인을 검수에서 뺄 때 hidden. '
  '지우지 않는 이유는 복구와 재수집 재생성 방지를 공짜로 얻기 위해서다.';

-- ── ② origin — 어느 자동 경로가 이 행을 소유하나 ─────────────────────
--
-- ★ prune 의 범위를 가르는 값이다. 지금 pruneEventMatches 는 event 안의 모든 경기를
--   대상으로 삼는데, 그러면 **같은 event 를 공유하는 다른 경로의 산출물**을 지운다.
--   (멸망전 event 하나에 나무위키 시드와 VOD 판독이 같이 들어오는 것이 정상 흐름이다)
--   지우는 쪽이 자기 것만 지우게 만든다 — fail-safe 방향은 「모르면 안 지운다」다.
ALTER TABLE match ADD COLUMN origin text
  CHECK (origin IS NULL OR origin IN ('wiki_seed', 'vod_scan', 'admin'));

-- 지금 있는 수기 경기는 전부 나무위키 시드가 만든 것이다. 채워 두면 시드 재실행의
-- 동작이 **오늘과 완전히 같아진다** — 이 마이그레이션이 기존 워크플로우를 바꾸지 않는다.
UPDATE match SET origin = 'wiki_seed' WHERE source = 'manual' AND origin IS NULL;

-- ★ 수기 매치는 origin 이 **반드시** 있어야 한다.
--   `pruneEventMatches` 가 `origin = 'wiki_seed'` 만 지우도록 좁혀졌으므로,
--   origin 을 안 채우고 수기 매치를 만드는 경로가 생기면 그 행은 **영구히 prune
--   대상이 아니게** 된다. 그러면 prune 이 막으려던 이중 계상이 조용히 돌아온다
--   (시리즈를 세트로 쪼갰을 때 `…:g01` 과 `…:g01s1` 이 같이 남아 조우가 두 배가 된 사고).
--   "안 지워진다"는 조용히 틀리므로 여기서 막는다. 공개 큐·토너먼트 코드는 NULL 이어도 된다
--   (Riot 이 준 것이고 시드가 소유하지 않는다).
ALTER TABLE match ADD CONSTRAINT match_manual_has_origin
  CHECK (source <> 'manual' OR origin IS NOT NULL);

COMMENT ON COLUMN match.origin IS
  '이 행을 만든 자동 경로. prune 은 자기 origin 만 지운다 — 같은 event 를 시드와 '
  'VOD 조사가 공유하기 때문이다. 공개 큐(Riot 수집)는 NULL, 수기는 필수(CHECK).';

-- ── ③ reviewed_at — 사람이 만진 행은 자동 수집이 덮지 않는다 ─────────
ALTER TABLE match ADD COLUMN reviewed_at timestamptz;

CREATE INDEX match_reviewed_idx ON match (reviewed_at DESC) WHERE reviewed_at IS NOT NULL;

COMMENT ON COLUMN match.reviewed_at IS
  '사람이 검수 화면에서 이 경기를 고친 시각. 자동 수집·시드는 이 행의 판독값을 '
  '덮지 않는다(onair-map 0049 와 같은 정책). NULL 이면 아직 자동 산출물이다.';

-- ── ④ 인물이 미확정인 참가자도 자리를 차지한다 ───────────────────────
--
-- 0017 이 「계정을 모르는 **등록 스트리머**」를 허용했다. 그런데 결과 화면에서 이름을
-- 읽었지만 **그게 누군지 모르는** 자리는 여전히 저장할 수 없다 — puuid 도 streamer_id 도
-- 없기 때문이다. 그래서 10칸 로스터가 8칸짜리로 저장되고, 검수 화면은 빈 두 칸이
-- 「없었다」인지 「못 읽었다」인지 구분할 수 없다.
--
-- ★ 0017 의 논리를 한 칸 더 민다. 우리가 아는 사실은 「이 **화면 이름**이 이 자리에
--   있었다」다. 그걸 그대로 적는다 — 없는 puuid 를 만들지 않는 것과 같은 정신이다.
ALTER TABLE match_participant ADD COLUMN observed_name text;

ALTER TABLE match_participant DROP CONSTRAINT match_participant_has_identity;
ALTER TABLE match_participant ADD CONSTRAINT match_participant_has_identity
  CHECK (puuid IS NOT NULL OR streamer_id IS NOT NULL OR observed_name IS NOT NULL);

COMMENT ON COLUMN match_participant.observed_name IS
  '결과 화면에서 읽은 인게임명. 사람을 못 붙였어도 자리를 남기려고 쓴다 — '
  '검수 화면이 "못 읽은 자리"와 "없던 자리"를 구분할 수 있어야 한다. '
  '⚠ core_public 에 노출하지 않는다(일반인일 수 있다).';

-- ── ⑤ 못 읽은 KDA 는 0 이 아니다 ─────────────────────────────────────
--
-- `tournaments.ts` 의 주석이 이미 "결과 화면에서 읽은 값. 모르면 비운다 — 0 으로
-- 채우지 않는다" 라고 적고 있는데, 스키마가 NOT NULL DEFAULT 0 이라 코드가 `?? 0` 으로
-- 채우고 있었다. 문서·스키마·코드가 서로 어긋난 자리다.
--
-- 결과 화면이 그래프 탭이면 승패만 읽힌다(CK-COLLECTION.md §3). 그때 0/0/0 으로
-- 적으면 **"딜 안 하고 안 죽은 사람"** 이 전적에 남는다. NULL 이 정직하다(0006 과 같은 이유).
--
-- 기본값도 없앤다 — 컬럼을 빼고 INSERT 하면 「모른다」가 되어야 한다.
ALTER TABLE match_participant ALTER COLUMN kills   DROP NOT NULL;
ALTER TABLE match_participant ALTER COLUMN deaths  DROP NOT NULL;
ALTER TABLE match_participant ALTER COLUMN assists DROP NOT NULL;
ALTER TABLE match_participant ALTER COLUMN kills   DROP DEFAULT;
ALTER TABLE match_participant ALTER COLUMN deaths  DROP DEFAULT;
ALTER TABLE match_participant ALTER COLUMN assists DROP DEFAULT;

COMMENT ON COLUMN match_participant.kills IS
  '못 읽었으면 NULL. 0 으로 채우지 않는다 — 결과 화면 그래프 탭은 승패만 준다.';

-- ── ⑥ core_public — 숨긴 경기가 새지 않게 ────────────────────────────
--
-- ⚠⚠ 여기서 **숨김 조인을 반드시 다시 쓴다.** core_public 은 보안 경계다(계약 5조).
--    0016 에서 뷰를 다시 정의하며 `JOIN streamer … visibility='public'` 을 빠뜨린
--    사고가 이미 한 번 있었다. 아래 셋 전부 **스트리머 숨김 + 경기 숨김**을 같이 본다.
--    verify:db 가 양쪽을 다 재고 있으므로 하나라도 빠지면 잡힌다.

CREATE OR REPLACE VIEW core_public.match AS
  SELECT match_id, queue_id, game_mode, game_version, game_creation, game_duration,
         winning_team, ended_in_surrender, source, event_id,
         series_id, series_game_no, blue_team_id, red_team_id,
         lol_match_category(source, queue_id,
           (SELECT kind FROM event WHERE event.id = match.event_id)) AS category
    FROM match
   WHERE visibility = 'public';

-- 0017 의 두 경로(계정이 붙은 행 · 사람만 아는 행)를 그대로 유지하고 경기 숨김을 더한다.
-- ★ observed_name 은 넣지 않는다 — 사람을 못 붙인 자리는 애초에 JOIN 에서 빠지고,
--   일반인의 인게임명을 공개면에 흘릴 이유가 없다.
CREATE OR REPLACE VIEW core_public.match_participant AS
  SELECT mp.match_id,
         COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
         mp.puuid, mp.team_id,
         mp.team_position, mp.champion_id, mp.champion_name, mp.win,
         mp.kills, mp.deaths, mp.assists, mp.gold_earned, mp.cs,
         mp.damage_to_champions, mp.vision_score, mp.challenges
    FROM match_participant mp
    JOIN match m ON m.match_id = mp.match_id AND m.visibility = 'public'
    LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
                                 AND sa.visibility = 'public'
    JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
                   AND s.visibility = 'public';

CREATE OR REPLACE VIEW core_public.streamer_encounter AS
  SELECT se.match_id, se.streamer_a_id, se.streamer_b_id,
         se.relation, se.a_position, se.b_position, se.is_lane_matchup,
         se.a_win, se.b_win, se.a_champion_id, se.b_champion_id,
         se.a_kills, se.a_deaths, se.a_assists, se.a_cs, se.a_gold, se.a_damage,
         se.b_kills, se.b_deaths, se.b_assists, se.b_cs, se.b_gold, se.b_damage,
         se.queue_id, se.source, se.game_creation, se.game_duration,
         COALESCE(m.series_id, se.match_id) AS series_key,
         m.series_game_no,
         se.category
    FROM streamer_encounter se
    JOIN match m ON m.match_id = se.match_id AND m.visibility = 'public'
    JOIN streamer a ON a.id = se.streamer_a_id AND a.visibility = 'public'
    JOIN streamer b ON b.id = se.streamer_b_id AND b.visibility = 'public';

-- ⚠ champion_stat 은 뷰가 아니라 **테이블**이다. 숨긴 경기를 빼는 것은 재계산 SQL 의
--   몫이고(`recomputeChampionStats`), 그래서 숨김이 즉시 반영되려면 **재계산이 돌아야**
--   한다. 뷰 필터로는 해결되지 않는다 — 어드민 저장 경로가 범위 재계산을 부른다.


-- ── ⑦ champion_stat 의 PK 가 GROUP BY 와 어긋나 있었다 ───────────────
--
-- ⚠⚠ **이건 0016 이 남긴 버그다.** 0016 이 `category` 를 champion_stat 에 추가하고
--    재계산의 `GROUP BY` 에도 넣었는데, **PK 는 그대로 뒀다**:
--        PK       (streamer_id, champion_id, queue_id, season)
--        GROUP BY (streamer_id, champion_id, queue_id, season, category)
--    집계 키가 PK 보다 넓으면 INSERT 가 자기 자신과 충돌한다. 같은 사람이 같은 챔피언을
--    같은 큐·시즌에 **두 카테고리로** 뛰면 재계산이 통째로 터진다.
--
--    `queue_id=0`(커스텀)에서 category 는 event.kind 로 갈린다 —
--    'tournament'(멸망전) · 'scrim'(CK) · 'other'(대회를 아직 못 붙인 내전).
--    그래서 **멸망전과 CK 에서 같은 챔피언을 한 사람**이면 이미 터지는 상태였고,
--    VOD 조사가 대회 없는 경기를 만들기 시작하면 바로 밟는다
--    (실제로 verify:db 에 그 경우를 넣자마자 champion_stat_pkey 충돌로 죽었다).
--
-- ★ 집계 키와 PK 는 **같아야 한다.** 그게 이 표의 유일한 불변식이다.

-- ★ 먼저 **채운다.** 지우고 재계산에 맡기면 안 된다 —
--   `recomputeChampionStats` 를 부르는 것은 워커의 derive 엔진 하나뿐이어서
--   (`apps/worker/src/engines/derive.ts`), `db:migrate` 직후부터 그 워커가 돌기까지
--   그 사람들의 모스트 챔피언 칸이 **아무 신호 없이 빈 채로** 남는다.
--
--   0016 의 백필이 `streamer_account` 경유 행만 채웠어서 0017 이 허용한
--   '계정 없는 사람' 행에 category 가 비어 있다. 여기서는 재계산 SQL 과 같은
--   COALESCE 순서(계정 우선, 없으면 참가자 행의 사람)로 양쪽을 다 덮는다.
UPDATE champion_stat cs
   SET category = sub.category
  FROM (
    SELECT COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id,
           mp.champion_id, m.queue_id,
           lol_match_category(m.source, m.queue_id, ev.kind) AS category
      FROM match_participant mp
      JOIN match m       ON m.match_id = mp.match_id
      LEFT JOIN event ev ON ev.id = m.event_id
      LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
     WHERE COALESCE(sa.streamer_id, mp.streamer_id) IS NOT NULL
     GROUP BY 1, 2, 3, 4
  ) sub
 WHERE cs.category IS NULL
   AND cs.streamer_id = sub.streamer_id
   AND cs.champion_id = sub.champion_id
   AND cs.queue_id    = sub.queue_id;

-- 그래도 남은 것은 원본이 사라진 낡은 행이다(경기가 지워졌는데 집계만 남은 경우).
-- champion_stat 은 100% 파생이라(원본은 match_participant) 버려도 재계산이 채운다.
DELETE FROM champion_stat WHERE category IS NULL;

ALTER TABLE champion_stat ALTER COLUMN category SET NOT NULL;

ALTER TABLE champion_stat DROP CONSTRAINT champion_stat_pkey;
ALTER TABLE champion_stat ADD PRIMARY KEY (streamer_id, champion_id, queue_id, season, category);

COMMENT ON COLUMN champion_stat.category IS
  '경기 분류. ★ PK 의 일부다 — 재계산의 GROUP BY 와 같아야 INSERT 가 자기와 충돌하지 '
  '않는다(0020 이 0016 의 누락을 고쳤다). 같은 챔피언을 대회와 내전에서 따로 센다.';


-- ── ⑧ KDA 평균의 분모 — "몇 판을 읽었나" ────────────────────────────
--
-- ⚠ 위 ⑤ 에서 KDA 를 nullable 로 풀었는데, 그대로 두면 **파생 테이블이 그 정직함을
--   되돌린다.** champion_stat 은 `sum(kills)` 로 모으고(NULL 은 합에서 빠진다) 화면은
--   `kills / games` 로 나눈다. 분자에선 빠진 판이 분모에는 남으므로 평균이 묽어지고,
--   한 판도 못 읽었으면 `0 / 3 = 0` → **0/0/0 · 0.00** 이 된다.
--   이건 "표본이 작으면 작다고 말한다"(CLAUDE.md 3)의 반대다.
--
-- 그래서 **KDA 를 실제로 읽은 판 수**를 따로 센다. 화면은 이걸 분모로 쓰고,
-- 0 이면 평균을 내지 않고 '—' 를 그린다.
ALTER TABLE champion_stat ADD COLUMN kda_games integer NOT NULL DEFAULT 0;

-- ★ 기존 행은 `kda_games = games` 로 채운다. **이 마이그레이션 전에는 KDA 가
--   NOT NULL DEFAULT 0 이었으므로 모든 판에 값이 있었다** — 따라서 지금 화면에
--   보이는 평균이 그대로 유지된다. 이 마이그레이션은 표시를 바꾸지 않는다.
--   (그 0 중 일부는 '모른다' 를 0 으로 적은 것이지만, 어느 것이 그런지는 이미
--    구분할 수 없다. 새로 들어오는 데이터만 정직해진다.)
--   DEFAULT 0 에 맡기면 전 스트리머의 KDA 평균이 다음 재계산까지 '—' 가 된다.
UPDATE champion_stat SET kda_games = games;

COMMENT ON COLUMN champion_stat.kda_games IS
  'KDA 를 실제로 읽은 판 수. ★ 평균의 분모는 games 가 아니라 이것이다 — '
  '방송 결과 화면이 그래프 탭이면 승패만 읽히고 KDA 는 NULL 이다(0020).';

-- 뷰가 컬럼을 명시하므로 새 칸을 여기도 넣어야 모듈·화면이 볼 수 있다.
-- ⚠ 숨김 조인을 다시 쓴다 (0016:123 과 같은 정의 + kda_games).
-- ⚠⚠ `CREATE OR REPLACE VIEW` 는 컬럼을 **맨 뒤에만** 더할 수 있다. 중간에 끼우면
--     `cannot change name of view column` 으로 마이그레이션이 죽는다(실제로 죽였다).
--     그래서 기존 순서를 한 칸도 건드리지 않고 kda_games 를 끝에 붙인다.
CREATE OR REPLACE VIEW core_public.champion_stat AS
  SELECT cs.streamer_id, cs.champion_id, cs.queue_id, cs.season,
         cs.games, cs.wins, cs.kills, cs.deaths, cs.assists, cs.cs, cs.seconds_played,
         cs.computed_at, cs.category,
         cs.kda_games
    FROM champion_stat cs
    JOIN streamer s ON s.id = cs.streamer_id AND s.visibility = 'public';

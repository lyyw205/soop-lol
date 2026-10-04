-- 0060 — FC 구단가치·스쿼드·카드 시세. docs/FCO-CLUB-VALUE-PLAN.md
--
-- 스트리머 구단을 자산처럼 다룬다(구단가치 순위 · 스쿼드 등록 선수 · 가치 변동 차트).
-- 원본은 서로 독립인 사실 셋뿐이고, 합집합·가치 이력·변동 분해는 전부 여기서 **계산**한다
-- (packages/core/lib/metrics/club-value.ts). 기능마다 표를 만들면 같은 사실이 갈라져 어긋난다.
--
--   ① fco_club_snapshot      공식 구단가치 — 넥슨이 주는 총값. 계산식을 몰라 재현할 수 없다
--   ② fco_squad_*            보유 — 그날 6칸(대표팀·클럽팀 × A/B/C)에 누가 몇 강으로 있었나
--   ③ fco_card_price_daily   카드 시세 — 스트리머와 무관한 시장 데이터
--
-- ★ 시한부: ①② 는 지나간 날을 다시 구할 수 없다(rank_snapshot 과 같다). ③ 은 넥슨 시세 그래프가
--   365일까지 소급해 준다.
--
-- ★ 출처는 공개 API 가 아니라 공식 홈페이지(fconline.nexon.com) 내부 요청이다 — Open API 에 구단가치·스쿼드·
--   시세가 없다. 쓰기는 core/lib/games/fconline/club/sync.ts 하나다.

-- ① 공식 구단가치 + 조회 근거. 계정 × 조회 시각.
--   missing = 구단주 검색이 "구단주 정보가 존재하지 않습니다" 를 줬다(확인했는데 없다).
--   조회 실패·형식 변경은 행을 만들지 않는다 — "없다"와 "못 봤다"를 섞지 않는다.
CREATE TABLE fco_club_snapshot (
  id           bigserial PRIMARY KEY,
  ouid         text NOT NULL REFERENCES fco_account(ouid) ON DELETE CASCADE,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL CHECK (status IN ('ok', 'missing')),
  nickname     text NOT NULL,                 -- 조회에 쓴 감독명(근거). 감독명은 바뀐다
  nexon_sn     bigint,                        -- 넥슨 회원번호. 같은 ouid 에서 바뀌면 저장하지 않는다
  club_value   bigint CHECK (club_value >= 0),
  CHECK ((status = 'ok') = (nexon_sn IS NOT NULL AND club_value IS NOT NULL))
);
CREATE INDEX fco_club_snapshot_ouid_idx ON fco_club_snapshot (ouid, captured_at DESC);

-- ② 보유. ok 스냅샷 하나에 6칸, 칸마다 넥슨이 준 자리(보통 18 = 선발 11 + 교체 7).
--   total_price 는 넥슨이 준 선발 합(현재가) 그대로 — 우리가 더한 값과 다르면 그게 단서다.
CREATE TABLE fco_squad_snapshot (
  snapshot_id  bigint NOT NULL REFERENCES fco_club_snapshot(id) ON DELETE CASCADE,
  team_type    smallint NOT NULL CHECK (team_type IN (0, 1)),   -- 1 대표팀, 0 클럽팀
  slot         smallint NOT NULL CHECK (slot BETWEEN 1 AND 3),  -- A/B/C
  total_price  bigint NOT NULL CHECK (total_price >= 0),
  coach_id     text,
  PRIMARY KEY (snapshot_id, team_type, slot)
);

--   grade 는 넥슨이 비워 준다(lv: ""). price 가 강화 0~13 현재가(eachPrice) 몇 번째와 같은지로 구한다 —
--   경기 상세 spGrade 와 18/18 일치(2026-10-02 실측). 같은 값이 여럿이면 지어내지 않고 NULL.
--   price 는 그날 **현재가**. 차트의 일별 시세(③)와 다른 숫자라 섞지 않는다.
CREATE TABLE fco_squad_player (
  snapshot_id  bigint NOT NULL,
  team_type    smallint NOT NULL,
  slot         smallint NOT NULL,
  idx          smallint NOT NULL CHECK (idx >= 0),   -- 넥슨 응답 순서
  role         text NOT NULL,                        -- 선발 자리(소문자) / 교체(대문자)
  is_starter   boolean NOT NULL,
  spid         bigint NOT NULL,
  grade        smallint CHECK (grade BETWEEN 0 AND 13),
  price        bigint CHECK (price >= 0),
  name         text NOT NULL,
  season       text,
  ovr          smallint,
  PRIMARY KEY (snapshot_id, team_type, slot, idx),
  FOREIGN KEY (snapshot_id, team_type, slot)
    REFERENCES fco_squad_snapshot (snapshot_id, team_type, slot) ON DELETE CASCADE
);
CREATE INDEX fco_squad_player_card_idx ON fco_squad_player (spid, grade);

-- ③ 카드 시세. 넥슨 시세 그래프의 일별 값(일 평균 거래가로 보이지만 미확인). 현재가와 다르다.
--   과거 값이 나중에 바뀌는지 아직 모른다 — upsert 가 바뀐 행 수를 잡 결과에 남긴다.
CREATE TABLE fco_card_price_daily (
  spid        bigint NOT NULL,
  grade       smallint NOT NULL CHECK (grade BETWEEN 0 AND 13),
  day         date NOT NULL,
  price       bigint NOT NULL CHECK (price >= 0),
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (spid, grade, day)
);

ALTER TABLE fco_club_snapshot    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fco_squad_snapshot   ENABLE ROW LEVEL SECURITY;
ALTER TABLE fco_squad_player     ENABLE ROW LEVEL SECURITY;
ALTER TABLE fco_card_price_daily ENABLE ROW LEVEL SECURITY;

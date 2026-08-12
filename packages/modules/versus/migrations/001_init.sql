-- 상대전적 모듈. **코어 테이블은 건드리지 않는다** — 자기 스키마에만 쓴다.
--
-- 여기 두는 건 "많이 붙은 쌍" 롤업 하나뿐이다. 두 사람 사이의 상세 전적은
-- 화면을 열 때 계약(listEncountersBetween)으로 그때그때 읽는다 — 한 쌍의 조우는
-- 많아야 수십 건이라 미리 저장할 이유가 없고, 저장하면 코어가 재파생될 때마다
-- 어긋날 자리가 하나 더 생긴다.
--
-- 반면 첫 화면의 "많이 붙은 쌍" 은 조우 9,000건을 통째로 훑어야 나오므로
-- 미리 접어 둔다. **이벤트 구독이 아니라 재계산이다** — 두 번 돌려도 같고,
-- 나중에 꽂아도 과거가 저절로 채워진다.

CREATE SCHEMA IF NOT EXISTS mod_versus;

CREATE TABLE mod_versus.pair (
  a_slug      text NOT NULL,
  a_name      text NOT NULL,
  b_slug      text NOT NULL,
  b_name      text NOT NULL,
  -- 총 조우 세트. 같은 팀이었던 것까지 포함한다.
  sets        integer NOT NULL,
  -- ★ 정렬 기준은 이것이다. 총 조우로 정렬하면 같은 팀으로만 만난 쌍이 위로 올라와,
  --   이 사이트가 무엇을 세는 곳인지 첫 화면부터 어긋난다.
  vs_sets     integer NOT NULL,
  lane_sets   integer NOT NULL,
  last_met    timestamptz NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (a_slug, b_slug)
);

CREATE INDEX pair_vs_idx ON mod_versus.pair (vs_sets DESC, sets DESC);

-- 모듈 스키마도 PostgREST 로 새어 나가면 안 된다 (코어 0002 와 같은 이유).
ALTER TABLE mod_versus.pair ENABLE ROW LEVEL SECURITY;

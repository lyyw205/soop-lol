-- 대회 형식(대진)을 칸과 화살표로 저장한다. 롤·FC 공통. docs/TOURNAMENT-FORMAT-PLAN.md
--
-- ★ 왜 (2026-10-02 뿌챔스 사고)
--   대회 형식을 담는 칸이 없어 규칙은 글(round_label·event_fact 메모)뿐이었다. FC 대회 화면은 순위를 낼 수 없어
--   승수로 줄을 세웠고, 승수 1위 도현이 우승처럼 보였다(실제 우승 임유진 — 순위 결정전 계단이 있는 변형 대회였다).
--   롤은 대진표를 그리려면 대회마다 연결선을 코드에 박아야 해서 33개 중 1개만 그려져 있었다.
--
-- ★ 모양
--   단계(event_stage) ─ 칸(event_slot) ─ 화살표(event_route: 승자/패자가 가는 곳 = 다음 칸 자리 | 순위 범위 | 탈락)
--   칸 ─ 실제 경기(event_slot_match, 단판이든 세트든 경기 단위로 잇는다 — 대회 단판은 시리즈가 없을 수 있다)
--   칸 ─ 사람의 결정(event_slot_decision: 부전승·기권·취소·주최측 선택·기록 없는 칸의 결과. append-only)
--   계산(누가 어느 칸에 들어가고 몇 위인가)은 저장하지 않는다 — packages/core/lib/tournament/bracket.ts 가 매번 만든다.
--
-- ★ 형식(토너먼트·더블 엘리미네이션)은 저장하지 않는다. 그건 칸과 화살표를 만들어 주는 도우미(templates.ts)이고
--   event_stage.template 은 어떤 도우미로 만들었는지의 출처 표기일 뿐이다. 커스텀 대회는 화살표를 고친 같은 데이터다.

-- ── 1. 공식 최종 순위 ─────────────────────────────────────────────────
-- placement_rank 는 정렬용 분류값이다(4강=4, 8강=8, 예선 탈락=99 — 0010). 「공동 3위」「3–4위」「4강」을 한 숫자로
-- 접으므로 계산 순위와 비교할 수 없다. 정확한 순위(범위)와 그 근거를 따로 둔다. 기존 칸은 건드리지 않는다.
ALTER TABLE event_team
  ADD COLUMN final_rank_min      smallint CHECK (final_rank_min > 0),
  ADD COLUMN final_rank_max      smallint,
  -- official: 주최측·공식 발표 / source_inferred: 출처(문서·방송)에서 사람이 유도
  ADD COLUMN final_rank_basis    text CHECK (final_rank_basis IN ('official', 'source_inferred')),
  ADD COLUMN final_rank_evidence text,
  ADD CONSTRAINT event_team_final_rank_complete CHECK (
    (final_rank_min IS NULL AND final_rank_max IS NULL AND final_rank_basis IS NULL)
    OR (final_rank_min IS NOT NULL AND final_rank_max >= final_rank_min AND final_rank_basis IS NOT NULL
        AND nullif(btrim(final_rank_evidence), '') IS NOT NULL));

COMMENT ON COLUMN event_team.final_rank_min IS
  '최종 순위 범위의 위쪽(공동 3–4위면 3). placement_rank(분류값)와 달리 계산 순위와 비교하는 값이다.';

-- ── 2. 단계 ───────────────────────────────────────────────────────────
CREATE TABLE event_stage (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES event(id) ON DELETE CASCADE,
  stage_no  smallint NOT NULL CHECK (stage_no > 0),
  name      text NOT NULL CHECK (btrim(name) <> ''),
  -- 첫 버전은 bracket 만 계산한다. 리그(승점 순위)는 계산기를 붙일 때 값을 늘린다(문서 §5).
  kind      text NOT NULL DEFAULT 'bracket' CHECK (kind IN ('bracket')),
  template  text,
  evidence  text NOT NULL CHECK (btrim(evidence) <> ''),
  UNIQUE (event_id, stage_no),
  UNIQUE (id, event_id)
);

-- ── 3. 칸 ─────────────────────────────────────────────────────────────
CREATE TABLE event_slot (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL,
  stage_id  uuid NOT NULL,
  slot_no   smallint NOT NULL CHECK (slot_no > 0),
  label     text CHECK (label IS NULL OR btrim(label) <> ''),
  lane      text CHECK (lane IS NULL OR btrim(lane) <> ''),
  -- match: 경기로 가른다(a/b 두 자리) · selection: 주최측이 고른다(투표·지명·재량)
  kind      text NOT NULL DEFAULT 'match' CHECK (kind IN ('match', 'selection')),
  -- 대회 규칙의 세트 수. 이 칸에 이어진 경기에는 이 값이 정본이다(match_series.best_of 는 확인용).
  best_of   smallint CHECK (best_of IS NULL OR (best_of > 0 AND best_of % 2 = 1)),
  picks     smallint CHECK (picks IS NULL OR picks > 0),
  seed_a    uuid,
  seed_b    uuid,
  evidence  text NOT NULL CHECK (btrim(evidence) <> ''),
  UNIQUE (stage_id, slot_no),
  UNIQUE (id, event_id),
  FOREIGN KEY (stage_id, event_id) REFERENCES event_stage (id, event_id) ON DELETE CASCADE,
  -- 시드는 같은 대회의 참가 단위만(복합 키가 강제한다)
  FOREIGN KEY (seed_a, event_id) REFERENCES event_team (id, event_id),
  FOREIGN KEY (seed_b, event_id) REFERENCES event_team (id, event_id),
  CHECK (kind = 'match' OR (seed_a IS NULL AND seed_b IS NULL AND picks IS NOT NULL)),
  CHECK (kind = 'selection' OR picks IS NULL),
  CHECK (seed_a IS NULL OR seed_b IS NULL OR seed_a <> seed_b)
);

-- ── 4. 화살표 ─────────────────────────────────────────────────────────
CREATE TABLE event_route (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL,
  from_slot     uuid NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('winner', 'loser')),
  to_kind       text NOT NULL CHECK (to_kind IN ('slot', 'placement', 'eliminated')),
  to_slot       uuid,
  to_side       text CHECK (to_side IN ('a', 'b')),
  placement_min smallint CHECK (placement_min > 0),
  placement_max smallint,
  UNIQUE (from_slot, outcome),
  FOREIGN KEY (from_slot, event_id) REFERENCES event_slot (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (to_slot, event_id) REFERENCES event_slot (id, event_id) ON DELETE CASCADE,
  CHECK (CASE to_kind
    WHEN 'slot' THEN to_slot IS NOT NULL AND placement_min IS NULL AND placement_max IS NULL
    WHEN 'placement' THEN to_slot IS NULL AND to_side IS NULL AND placement_max >= placement_min
    ELSE to_slot IS NULL AND to_side IS NULL AND placement_min IS NULL AND placement_max IS NULL END)
);
-- 한 자리를 두 화살표가 채우지 못한다. 시드와 화살표가 같은 자리를 채우는지는 구조 검사(validateStructure)가 본다.
CREATE UNIQUE INDEX event_route_target_side_uq ON event_route (to_slot, to_side) WHERE to_side IS NOT NULL;
CREATE INDEX event_route_to_slot_idx ON event_route (to_slot) WHERE to_slot IS NOT NULL;

-- ── 5. 칸 ↔ 실제 경기 ─────────────────────────────────────────────────
-- 경기 하나는 칸 하나에만 들어간다. 세트가 여럿이면 여러 행.
CREATE TABLE event_slot_match (
  match_id  text PRIMARY KEY REFERENCES match(match_id) ON DELETE CASCADE,
  slot_id   uuid NOT NULL,
  event_id  uuid NOT NULL,
  FOREIGN KEY (slot_id, event_id) REFERENCES event_slot (id, event_id) ON DELETE CASCADE
);
CREATE INDEX event_slot_match_slot_idx ON event_slot_match (slot_id);

-- 경기가 그 대회(같은 게임)의 경기여야 한다. 대회 연결은 경기의 event_id 또는 시리즈의 event_id 다.
CREATE FUNCTION event_slot_match_same_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM match m
      LEFT JOIN match_series ms ON ms.id = m.series_id
      JOIN event e ON e.id = NEW.event_id
     WHERE m.match_id = NEW.match_id
       AND m.game_code = e.game_code
       AND COALESCE(ms.event_id, m.event_id) = NEW.event_id
  ) THEN
    RAISE EXCEPTION '경기 %는 대회 %에 연결된 같은 게임의 경기가 아니다', NEW.match_id, NEW.event_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_slot_match_same_event BEFORE INSERT OR UPDATE ON event_slot_match
  FOR EACH ROW EXECUTE FUNCTION event_slot_match_same_event();

-- ── 6. 칸의 결정 ─────────────────────────────────────────────────────
-- ★ 실제 경기 결과와 대회가 채택한 결과는 다를 수 있다(실격·몰수·재경기). 결정이 있으면 결정을 채택하고,
--   경기 기록과 다르면 계산이 경고한다. 최신 행이 정본이고, status='auto' 행은 "결정 철회 — 경기 기록대로"다.
CREATE TABLE event_slot_decision (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id     uuid NOT NULL,
  event_id    uuid NOT NULL,
  status      text NOT NULL CHECK (status IN ('auto', 'result', 'walkover', 'forfeit', 'cancelled')),
  -- match 칸은 승자 1명, selection 칸은 고른 사람들. auto·cancelled 는 비어 있다
  winners     uuid[] NOT NULL DEFAULT '{}',
  score_a     smallint,
  score_b     smallint,
  -- official 공식 발표 · observed 방송에서 직접 봄 · organizer 주최측 재량(투표 등) · inferred 사람이 추론
  basis       text NOT NULL CHECK (basis IN ('official', 'observed', 'organizer', 'inferred')),
  evidence    text NOT NULL CHECK (btrim(evidence) <> ''),
  created_by  text NOT NULL DEFAULT 'admin' CHECK (created_by IN ('admin', 'seed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (slot_id, event_id) REFERENCES event_slot (id, event_id) ON DELETE CASCADE,
  CHECK ((status IN ('auto', 'cancelled')) = (cardinality(winners) = 0))
);
CREATE INDEX event_slot_decision_latest_idx ON event_slot_decision (slot_id, created_at DESC);

-- 결정한 승자는 같은 대회의 참가 단위여야 한다(배열이라 외래키를 못 건다).
CREATE FUNCTION event_slot_decision_winners() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM unnest(NEW.winners) w
     WHERE NOT EXISTS (SELECT 1 FROM event_team t WHERE t.id = w AND t.event_id = NEW.event_id)
  ) THEN
    RAISE EXCEPTION '결정의 승자 중 대회 %의 참가 단위가 아닌 것이 있다', NEW.event_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_slot_decision_winners BEFORE INSERT OR UPDATE ON event_slot_decision
  FOR EACH ROW EXECUTE FUNCTION event_slot_decision_winners();

-- 0002 와 같은 이유 — public 스키마의 표는 PostgREST 로 노출되므로 RLS 를 켠다.
ALTER TABLE event_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_slot ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_slot_match ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_slot_decision ENABLE ROW LEVEL SECURITY;

-- ── 7. 공개 뷰 ───────────────────────────────────────────────────────
-- 근거는 공개 출처(방송 VOD·공지)라 그대로 내보낸다 — 화면이 출처로 보여준다.
CREATE OR REPLACE VIEW core_public.event_team AS
  SELECT id AS event_team_id, event_id, name, placement, placement_rank, prize, vote_rank,
         final_rank_min, final_rank_max, final_rank_basis, final_rank_evidence
    FROM event_team;

CREATE VIEW core_public.event_stage AS
  SELECT id AS stage_id, event_id, stage_no, name, kind, template, evidence FROM event_stage;

CREATE VIEW core_public.event_slot AS
  SELECT id AS slot_id, event_id, stage_id, slot_no, label, lane, kind, best_of, picks, seed_a, seed_b, evidence
    FROM event_slot;

CREATE VIEW core_public.event_route AS
  SELECT event_id, from_slot, outcome, to_kind, to_slot, to_side, placement_min, placement_max FROM event_route;

-- 숨긴 경기는 빠진다(칸은 「기록 없음」으로 보인다).
CREATE VIEW core_public.event_slot_match AS
  SELECT l.event_id, l.slot_id, l.match_id
    FROM event_slot_match l JOIN match m ON m.match_id = l.match_id AND m.visibility = 'public';

CREATE VIEW core_public.event_slot_decision AS
  SELECT DISTINCT ON (slot_id) event_id, slot_id, status, winners, score_a, score_b, basis, evidence, created_at
    FROM event_slot_decision
   ORDER BY slot_id, created_at DESC, id DESC;

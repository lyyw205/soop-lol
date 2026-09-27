-- 0042 — 관리자 수정 이력.
--
-- 검수에서 승자·참가자·챔피언·KDA·공개 여부를 고쳐도 지금까지는 값만 바뀌고 도장(reviewed_at)만
-- 찍혔다. "언제, 무엇을, 무엇에서 무엇으로" 가 남지 않아 되짚을 수도, 잘못 고친 것을 되돌릴 근거도
-- 없었다. review_record 는 **현재** 근거 문장의 정본이라(고치면 덮는다) 이력이 아니다 — 따로 둔다.
--
-- ★ 실제 변경과 **같은 트랜잭션**에서 쓴다. 저장이 실패하면 이력도 없고, 값이 그대로면 쓰지 않는다.
-- ★ 경기가 지워져도 이력은 남긴다 — 그래서 match_id·lead_id 에 외래키를 걸지 않는다.
-- ★ 사람에게 이유를 쓰라고 하지 않는다. 전후 값이 자동으로 남는 것으로 충분하다. 보는 곳은 CLI(ck:record)다.

CREATE TABLE review_change (
  id         bigserial PRIMARY KEY,
  -- 경기 단위로 모아 보는 키. 후보 변경처럼 경기가 없는 것은 NULL.
  match_id   text,
  -- VOD 단서(프레임 연결을 바꿨을 때).
  lead_id    uuid,
  -- 사람이 검수 화면에서 고칠 수 있는 것만 — 경기·시리즈 규정·참가자·근거 프레임 연결.
  entity     text NOT NULL CHECK (entity IN ('match', 'series', 'participant', 'frame')),
  -- 그 안에서 무엇인가 — match_id · series id · 참가자 자리 번호 · 프레임 id.
  entity_key text NOT NULL,
  -- 바뀐 칸. 참가자 행을 통째로 더하거나 뺀 것은 'row'.
  field      text NOT NULL,
  before     jsonb,
  after      jsonb,
  actor      text NOT NULL DEFAULT 'admin' CHECK (actor IN ('admin')),
  changed_at timestamptz NOT NULL DEFAULT now(),
  CHECK (before IS DISTINCT FROM after)
);

CREATE INDEX review_change_match_idx ON review_change (match_id, changed_at) WHERE match_id IS NOT NULL;
CREATE INDEX review_change_lead_idx  ON review_change (lead_id, changed_at)  WHERE lead_id IS NOT NULL;

COMMENT ON TABLE review_change IS
  '관리자 수정 이력 — 무엇을 무엇에서 무엇으로 바꿨나. 변경과 같은 트랜잭션에서 기록한다. 공개하지 않는다.';

-- 0002 와 같은 이유 — public 스키마의 표는 PostgREST 로 노출되므로 RLS 를 켠다.
ALTER TABLE review_change ENABLE ROW LEVEL SECURITY;

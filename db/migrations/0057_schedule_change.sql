-- 0057 — 편성표 변경 이력. docs/SCHEDULE-PLAN.md §2단계 설계
--
-- 일정을 고치면 값만 바뀌어서 "10/5 → 10/6 연기" 같은 사실이 사라졌다. 보는 사람은 날짜가 바뀐 줄 모른다.
--
-- ★ saveScheduleEntry 가 **같은 트랜잭션에서** 이전 값과 비교해 쓴다. 값이 그대로면 쓰지 않는다(CHECK 로도 막는다).
-- ★ 공개 화면이 보여 주는 의미 있는 변화만 남긴다 — 제목·상태·방송 칸. 관리자 메모·공개 여부는 공개 이력이 아니다.
-- ★ 오타 수정은 관리자가 "이력에 남기지 않음" 으로 저장할 수 있다. 처음 입력을 고친 것까지 "일정 변경" 으로 보이면 거짓이다.
-- ★ 일정을 지우면 이력도 지운다(CASCADE) — 이 이력은 공개 화면용이고, 지운 일정은 공개 화면에 없다.

CREATE TABLE schedule_change (
  id          bigserial PRIMARY KEY,
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  field       text NOT NULL CHECK (field IN ('title', 'status', 'slots')),
  -- slots 는 [{on_date, start, end, label}] (KST "HH:MM", 모르면 null) — 화면이 그대로 문장으로 만든다.
  before      jsonb NOT NULL,
  after       jsonb NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (before IS DISTINCT FROM after)
);
CREATE INDEX schedule_change_entry_idx ON schedule_change (entry_id, changed_at);

ALTER TABLE schedule_change ENABLE ROW LEVEL SECURITY;

-- 부모 공개 조건을 상속한다 — 숨긴 일정의 이력은 나오지 않는다.
CREATE VIEW core_public.schedule_change AS
  SELECT c.entry_id AS schedule_id, c.field, c.before, c.after, c.changed_at
    FROM schedule_change c
    JOIN core_public.schedule_entry pe ON pe.schedule_id = c.entry_id;

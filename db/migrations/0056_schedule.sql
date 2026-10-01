-- 0056 — 편성표(스케줄). docs/SCHEDULE-PLAN.md
--
-- 스트리머가 공지한 대회·CK·이벤트전의 **예정**을 사람이 입력해 쌓는다.
--
-- ★ 왜 event 에 넣지 않나
--   event 는 **실제로 열린 것**의 기록이다(경기·조우가 매달린다). 예고만 하고 안 연 CK 를 넣으면
--   공개 화면에 거짓이 나간다 — event_lead(0012)를 따로 둔 것과 같은 이유다. 편성은 여기 두고,
--   실제로 열려 event 가 생기면 event_id 로 **연결만** 한다.
--
-- ★ 날짜와 시각을 따로 둔다
--   "10/3 저녁" 처럼 날짜만 아는 공지가 흔하다. 시각 칸에 자정을 지어내 넣으면 그 자정이 진행 판정과
--   표시로 새어 나간다. 날짜(on_date)는 언제나 알고, 시각(starts_at)은 모르면 NULL 이다.
--
-- ★ 쓰기는 core/lib/db/schedule.ts 의 saveScheduleEntry 하나다 — 본문·칸·참가자·출처를 한 트랜잭션으로
--   통째로 바꾸고, 표 사이 조건(공개면 출처 1개 이상 · 결과 event 와 게임 일치 · 동시 수정)을 거기서 검사한다.
--   표 하나 안에서 걸 수 있는 조건만 아래 CHECK 로 이중으로 건다.

CREATE TABLE schedule_entry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 경기 데이터의 게임 종류. 공간(로비)과는 다른 축이다 — 'platform' 은 여기 없다.
  game_code    text NOT NULL CHECK (game_code IN ('lol', 'fconline')),
  title        text NOT NULL CHECK (btrim(title) <> ''),
  -- 대형(여러 날·확정 편성) / 소형(하루·예고, 무산될 수 있음). 사람이 정한다.
  scale        text NOT NULL CHECK (scale IN ('major', 'minor')),
  -- 공지 기준 분류. 실제 분류는 연결된 event.kind 다 — 둘이 달라도 하나로 덮지 않는다.
  planned_kind text NOT NULL CHECK (planned_kind IN ('tournament', 'showmatch', 'ck', 'other')),
  sponsor      text,
  description  text,                       -- 공개 설명
  admin_note   text,                       -- 관리자 메모. 공개 뷰에 없다
  -- 예정 / 개최 확인 / 무산. "진행 중"·"지난 일정" 은 저장하지 않고 시각으로 계산한다(metrics/schedule.ts).
  status       text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'held', 'cancelled')),
  event_id     uuid REFERENCES event(id) ON DELETE SET NULL,
  -- 자동 수집이 붙으면 값을 늘린다. 화면은 이걸로 '수기' 뱃지를 단다(원칙 8).
  origin       text NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual')),
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'hidden')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 동시 수정 판정의 기준. 저장할 때마다 접근자가 now() 로 바꾼다.
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- 무산·미확인 일정에 결과를 달지 않는다.
  CONSTRAINT schedule_entry_result_needs_held CHECK (event_id IS NULL OR status = 'held')
);

CREATE TABLE schedule_slot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  label       text,                        -- '조별 1일차', '결승'
  on_date     date NOT NULL,               -- KST 날짜. 언제나 안다
  starts_at   timestamptz,                 -- 모르면 NULL — 자정을 지어내지 않는다
  ends_at     timestamptz,                 -- 모르면 NULL
  channel_id  text,                        -- 중계 SOOP 방송국 아이디(명시값). 없으면 화면이 규칙대로 고른다
  CONSTRAINT schedule_slot_start_on_date
    CHECK (starts_at IS NULL OR (starts_at AT TIME ZONE 'Asia/Seoul')::date = on_date),
  CONSTRAINT schedule_slot_end_after_start
    CHECK (ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at > starts_at))
);
CREATE INDEX schedule_slot_entry_idx ON schedule_slot (entry_id);
-- 편성표 조회는 기간(on_date)으로 자른다.
CREATE INDEX schedule_slot_date_idx ON schedule_slot (on_date);

-- 주최도 역할 하나다 — 주최 칸을 따로 두면 "주최가 선수로도 나온다" 를 두 곳에서 맞춰야 한다.
-- 등록 스트리머만 연결한다. 미등록 참가자는 설명에 글로 적는다(core_public 이 일반인을 거르는 원칙과 같다).
CREATE TABLE schedule_participant (
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  streamer_id uuid NOT NULL REFERENCES streamer(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('host', 'player', 'caster')),
  team        text,
  PRIMARY KEY (entry_id, streamer_id, role)
);
CREATE INDEX schedule_participant_streamer_idx ON schedule_participant (streamer_id);

-- 근거 공지. 대회 하나에 여러 개(개최 → 모집 → 조 편성 → 일정 변경).
CREATE TABLE schedule_source (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id    uuid NOT NULL REFERENCES schedule_entry(id) ON DELETE CASCADE,
  url         text NOT NULL CHECK (url ~ '^https?://'),
  title       text,
  posted_at   timestamptz,
  UNIQUE (entry_id, url)
);

ALTER TABLE schedule_entry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_slot        ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_source      ENABLE ROW LEVEL SECURITY;

-- ── 공개 경계 ────────────────────────────────────────────────────────
-- ★ 하위 뷰는 **부모 공개 뷰와 조인해서** 거른다. 하위 표만 따로 읽으면 숨긴 일정의 칸·참가자·출처가 샌다.
-- ★ 공개 일정은 출처가 1개 이상이어야 한다. 접근자가 저장 때 막지만, 뷰도 근거 없는 일정을 내보내지 않는다.

CREATE VIEW core_public.schedule_entry AS
  SELECT e.id AS schedule_id, e.game_code, e.title, e.scale, e.planned_kind, e.sponsor, e.description,
         e.status, e.event_id, e.origin, e.updated_at
    FROM schedule_entry e
   WHERE e.visibility = 'public'
     AND EXISTS (SELECT 1 FROM schedule_source s WHERE s.entry_id = e.id);

CREATE VIEW core_public.schedule_slot AS
  SELECT s.id AS slot_id, s.entry_id AS schedule_id, s.label, s.on_date, s.starts_at, s.ends_at, s.channel_id
    FROM schedule_slot s
    JOIN core_public.schedule_entry pe ON pe.schedule_id = s.entry_id;

CREATE VIEW core_public.schedule_source AS
  SELECT s.entry_id AS schedule_id, s.url, s.title, s.posted_at
    FROM schedule_source s
    JOIN core_public.schedule_entry pe ON pe.schedule_id = s.entry_id;

CREATE VIEW core_public.schedule_participant AS
  SELECT p.entry_id AS schedule_id, p.streamer_id, p.role, p.team
    FROM schedule_participant p
    JOIN core_public.schedule_entry pe ON pe.schedule_id = p.entry_id
    JOIN core_public.streamer st ON st.streamer_id = p.streamer_id;

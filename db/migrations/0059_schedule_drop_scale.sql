-- 0059 — 편성표: 대형/소형(scale)을 없앤다. docs/SCHEDULE-PLAN.md
--
-- ★ 왜 없애나
--   규모는 "확정 편성이냐 예고냐" 와 "여러 날이냐 하루냐" 를 한 칸에 섞어, 관리자에게 애매한 판단을 떠넘겼다
--   (하루짜리 큰 행사, 며칠 이어지는 CK). 예정이 흔들리는 일은 규모가 아니라 **상태**(0058 — 예정·진행중·취소·연기·완료)로 말한다.
--   화면이 규모로 하던 일(여러 날 행사를 따로 모으기)은 **칸 날짜가 여러 날인지**로 계산한다.

-- 공개 뷰가 scale 을 들고 있다. 하위 뷰가 부모 뷰에 기대므로 통째로 지웠다가 다시 만든다.
DROP VIEW core_public.schedule_change;
DROP VIEW core_public.schedule_participant;
DROP VIEW core_public.schedule_source;
DROP VIEW core_public.schedule_slot;
DROP VIEW core_public.schedule_entry;

ALTER TABLE schedule_entry DROP COLUMN scale;

CREATE VIEW core_public.schedule_entry AS
  SELECT e.id AS schedule_id, e.game_code, e.title, e.planned_kind, e.sponsor, e.description,
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

CREATE VIEW core_public.schedule_change AS
  SELECT c.entry_id AS schedule_id, c.field, c.before, c.after, c.changed_at
    FROM schedule_change c
    JOIN core_public.schedule_entry pe ON pe.schedule_id = c.entry_id;

/**
 * 편성표 — 관리자 쓰기·읽기. 공개 읽기는 schedule-public.ts(core_public 만 읽는다).
 * docs/SCHEDULE-PLAN.md §2 "저장 계약"
 *
 * ★ 쓰기는 saveScheduleEntry 하나다
 *   본문·칸·참가자·출처를 **한 트랜잭션에서 통째로** 바꾼다. 하나라도 실패하면 아무것도 안 바뀐다.
 *   폼 검증과 별개로 여기서 다시 검증한다 — 폼을 거치지 않은 호출(스크립트·나중의 자동 수집)도 같은 문을 쓴다.
 * ★ 동시 수정
 *   폼이 열 때 받은 version(updated_at 의 텍스트)을 같이 보낸다. 그 사이 다른 저장이 있었으면 거부한다 — 덮어쓰지 않는다.
 */

import { db } from "./client.ts";
import { kstDateString } from "../time.ts";
import {
  entryPeriod, entryState, validateScheduleInput,
  type EntryState, type ScheduleGame, type ScheduleInput, type SchedulePlannedKind, type ScheduleRole,
  type ScheduleScale, type ScheduleStatus,
} from "../metrics/schedule.ts";

/** 저장 거부. reasons 를 그대로 폼에 보여준다. */
export class ScheduleSaveError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join(" / "));
    this.name = "ScheduleSaveError";
    this.reasons = reasons;
  }
}

export const STALE_VERSION_MESSAGE = "다른 수정이 먼저 저장됐습니다. 새로 불러온 뒤 다시 저장하세요.";

export async function saveScheduleEntry(
  input: ScheduleInput,
  opts: { id?: string | null; version?: string | null } = {},
): Promise<{ id: string; version: string }> {
  const errors = validateScheduleInput(input);
  if (errors.length) throw new ScheduleSaveError(errors);

  return db().begin(async (tx) => {
    if (opts.id) {
      const [cur] = await tx<{ game_code: string; event_id: string | null; version: string }[]>`
        SELECT game_code, event_id, updated_at::text AS version FROM schedule_entry WHERE id = ${opts.id}::uuid FOR UPDATE
      `;
      if (!cur) throw new ScheduleSaveError(["없는 일정입니다. 지워졌을 수 있습니다."]);
      if (cur.version !== opts.version) throw new ScheduleSaveError([STALE_VERSION_MESSAGE]);
      if (cur.event_id && cur.game_code !== input.game_code) {
        throw new ScheduleSaveError(["결과 경기와 연결된 일정은 게임을 바꿀 수 없습니다. 연결을 먼저 끊고 저장하세요."]);
      }
    }
    if (input.event_id) {
      const [ev] = await tx<{ game_code: string }[]>`SELECT game_code FROM event WHERE id = ${input.event_id}::uuid`;
      if (!ev) throw new ScheduleSaveError(["연결하려는 결과 경기(event)가 없습니다."]);
      if (ev.game_code !== input.game_code) {
        throw new ScheduleSaveError([`결과 경기의 게임(${ev.game_code})이 일정의 게임(${input.game_code})과 다릅니다.`]);
      }
    }

    const body = {
      game_code: input.game_code, title: input.title.trim(), scale: input.scale, planned_kind: input.planned_kind,
      sponsor: input.sponsor, description: input.description, admin_note: input.admin_note,
      status: input.status, event_id: input.event_id, visibility: input.visibility,
    };
    const [row] = opts.id
      ? await tx<{ id: string; version: string }[]>`
          UPDATE schedule_entry SET ${tx(body)}, updated_at = now() WHERE id = ${opts.id}::uuid
          RETURNING id, updated_at::text AS version`
      : await tx<{ id: string; version: string }[]>`
          INSERT INTO schedule_entry ${tx(body)} RETURNING id, updated_at::text AS version`;

    await tx`DELETE FROM schedule_slot WHERE entry_id = ${row.id}::uuid`;
    await tx`DELETE FROM schedule_participant WHERE entry_id = ${row.id}::uuid`;
    await tx`DELETE FROM schedule_source WHERE entry_id = ${row.id}::uuid`;
    for (const s of input.slots) {
      await tx`INSERT INTO schedule_slot (entry_id, label, on_date, starts_at, ends_at, channel_id)
               VALUES (${row.id}::uuid, ${s.label}, ${s.on_date}::date, ${s.starts_at}, ${s.ends_at}, ${s.channel_id})`;
    }
    for (const p of input.participants) {
      await tx`INSERT INTO schedule_participant (entry_id, streamer_id, role, team)
               VALUES (${row.id}::uuid, ${p.streamer_id}::uuid, ${p.role}, ${p.team})`;
    }
    for (const s of input.sources) {
      await tx`INSERT INTO schedule_source (entry_id, url, title, posted_at)
               VALUES (${row.id}::uuid, ${s.url}, ${s.title}, ${s.posted_at})`;
    }
    return row;
  });
}

/** 일정 삭제. 저장과 같은 동시 수정 규칙을 쓴다. */
export async function deleteScheduleEntry(id: string, version: string): Promise<void> {
  await db().begin(async (tx) => {
    const [cur] = await tx<{ version: string }[]>`
      SELECT updated_at::text AS version FROM schedule_entry WHERE id = ${id}::uuid FOR UPDATE`;
    if (!cur) return;
    if (cur.version !== version) throw new ScheduleSaveError([STALE_VERSION_MESSAGE]);
    await tx`DELETE FROM schedule_entry WHERE id = ${id}::uuid`;
  });
}

// ── 관리자 읽기 ──────────────────────────────────────────────────────

export interface AdminScheduleRow {
  id: string;
  game_code: ScheduleGame;
  title: string;
  scale: ScheduleScale;
  planned_kind: SchedulePlannedKind;
  status: ScheduleStatus;
  visibility: "public" | "hidden";
  source_count: number;
  event_id: string | null;
  slots: { on_date: string; starts_at: Date | null; ends_at: Date | null }[];
  state: EntryState;
  period: { from: string; to: string } | null;
}

/**
 * 관리자 목록. **지난 일정인데 개최 미확인인 것을 맨 위에** — 그걸 held·cancelled 로 정리하는 게 일상 작업이다.
 * 그 다음 다가오는 일정(가까운 순), 마지막에 끝난 일정(최근 순).
 */
export async function listScheduleForAdmin(now = new Date()): Promise<AdminScheduleRow[]> {
  const rows = await db()<Omit<AdminScheduleRow, "state" | "period">[]>`
    SELECT e.id, e.game_code, e.title, e.scale, e.planned_kind, e.status, e.visibility, e.event_id,
           (SELECT count(*)::int FROM schedule_source s WHERE s.entry_id = e.id) AS source_count,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('on_date', sl.on_date, 'starts_at', sl.starts_at, 'ends_at', sl.ends_at)
                                      ORDER BY sl.on_date, sl.starts_at NULLS LAST)
                       FROM schedule_slot sl WHERE sl.entry_id = e.id), '[]'::jsonb) AS slots
      FROM schedule_entry e
  `;
  const out = rows.map((r) => {
    const slots = r.slots.map((s) => ({
      on_date: String(s.on_date).slice(0, 10),
      starts_at: s.starts_at ? new Date(s.starts_at) : null,
      ends_at: s.ends_at ? new Date(s.ends_at) : null,
    }));
    return { ...r, slots, state: entryState(r.status, slots, now), period: entryPeriod(slots) };
  });
  const rank = (r: AdminScheduleRow) => r.state === "past_unconfirmed" ? 0
    : r.state === "held" || r.state === "cancelled" ? (r.period && r.period.to < kstDateString(now) ? 2 : 1) : 1;
  return out.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 2 ? (b.period?.to ?? "").localeCompare(a.period?.to ?? "") : (a.period?.from ?? "").localeCompare(b.period?.from ?? "")));
}

export interface AdminScheduleDetail {
  id: string;
  version: string;
  input: ScheduleInput;
  participants: { streamer_id: string; slug: string; display_name: string; role: ScheduleRole; team: string | null }[];
}

export async function getScheduleForAdmin(id: string): Promise<AdminScheduleDetail | null> {
  const sql = db();
  const [e] = await sql<(Omit<ScheduleInput, "slots" | "participants" | "sources"> & { id: string; version: string })[]>`
    SELECT id, updated_at::text AS version, game_code, title, scale, planned_kind, sponsor, description, admin_note,
           status, event_id, visibility
      FROM schedule_entry WHERE id = ${id}::uuid`;
  if (!e) return null;
  // 작은 질의라 순서대로 보낸다 — 화면 하나의 동시 질의(팬아웃)를 늘리지 않는다(docs/PLAN.md §M4-1).
  const slots = await sql<ScheduleInput["slots"]>`
      SELECT label, on_date::text AS on_date, starts_at, ends_at, channel_id
        FROM schedule_slot WHERE entry_id = ${id}::uuid ORDER BY on_date, starts_at NULLS LAST`;
  const participants = await sql<AdminScheduleDetail["participants"]>`
      SELECT p.streamer_id, s.slug, s.display_name, p.role, p.team
        FROM schedule_participant p JOIN streamer s ON s.id = p.streamer_id
       WHERE p.entry_id = ${id}::uuid ORDER BY p.role, s.display_name`;
  const sources = await sql<ScheduleInput["sources"]>`
      SELECT url, title, posted_at FROM schedule_source WHERE entry_id = ${id}::uuid ORDER BY posted_at NULLS LAST, url`;
  const { id: _id, version, ...rest } = e;
  return {
    id, version, participants: [...participants],
    input: { ...rest, slots: [...slots], participants: participants.map(({ streamer_id, role, team }) => ({ streamer_id, role, team })), sources: [...sources] },
  };
}

/** 결과 연결 후보 — 같은 게임의 event 만(다른 게임은 저장이 거부하지만, 고를 수조차 없게 한다). */
export async function listEventsForScheduleLink(game: ScheduleGame): Promise<{ id: string; slug: string | null; name: string; kind: string; starts_at: Date | null }[]> {
  return db()`
    SELECT id, slug, name, kind, starts_at FROM event
     WHERE game_code = ${game}
     ORDER BY starts_at DESC NULLS LAST, created_at DESC
     LIMIT 300`;
}

/** slug → streamer id. 관리자 폼이 참가자를 slug 로 받는다. 없는 slug 는 빠진다. */
export async function streamerIdsBySlug(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const rows = await db()<{ slug: string; id: string }[]>`SELECT slug, id FROM streamer WHERE slug = ANY(${slugs}::text[])`;
  return new Map(rows.map((r) => [r.slug, r.id]));
}


/** 참가자 고르기용 전체 명부(관리자). 숨긴 사람도 고를 수 있다 — 공개 뷰가 거른다. */
export async function listStreamerChoices(): Promise<{ slug: string; display_name: string }[]> {
  return db()`SELECT slug, display_name FROM streamer ORDER BY display_name`;
}

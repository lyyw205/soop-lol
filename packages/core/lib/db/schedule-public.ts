/**
 * 편성표 공개 읽기. core_public 뷰만 읽는다 — 숨긴 일정·출처 없는 일정·숨긴 스트리머는 뷰가 이미 걸렀다.
 * 계약(core/lib/contract)으로 모듈에 나간다. docs/SCHEDULE-PLAN.md §2 "조회 계약"
 *
 * ★ 필터는 전부 인자로 받아 서버에서 거른다(화면은 URL 에 둔다 — 공유한 주소가 같은 화면을 연다).
 * ★ 기간은 **겹치면 포함**: 일정의 칸 날짜 범위가 [from, to] 와 겹치면 일정 전체(모든 칸)를 돌려준다.
 *   조회 시작 전에 시작한 대회도 나온다.
 * ★ 결과 링크는 **열리는 상세가 있을 때만** — 대회 목록 함수가 실제로 돌려주는 대회일 때만 result 를 채운다.
 *   상세 화면과 같은 조건을 따로 적지 않으려는 것이다(롤 대회 상세는 kind='tournament' 만 연다 — CK 로 링크하면 404).
 */

import { db } from "./client.ts";
import { listFcoEvents } from "./fconline.ts";
import { listPublicTournamentEvents } from "./public-tournaments.ts";
import {
  addDays, daysBetween, pickBroadcastChannel,
  type ScheduleGame, type SchedulePlannedKind, type ScheduleRole, type ScheduleScale, type ScheduleStatus,
} from "../metrics/schedule.ts";

/** 한 번에 볼 수 있는 최대 기간(일). 조회 범위 상한. */
export const SCHEDULE_MAX_DAYS = 31;

export interface PublicScheduleSlot {
  label: string | null;
  on_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
  /** 명시값 → 주최 한 명·채널 하나일 때만 자동 → 아니면 null(pickBroadcastChannel). */
  channel_id: string | null;
}

export interface PublicScheduleEntry {
  schedule_id: string;
  game_code: ScheduleGame;
  title: string;
  scale: ScheduleScale;
  planned_kind: SchedulePlannedKind;
  sponsor: string | null;
  description: string | null;
  status: ScheduleStatus;
  origin: "manual";
  slots: PublicScheduleSlot[];
  participants: { slug: string; display_name: string; role: ScheduleRole; team: string | null }[];
  sources: { url: string; title: string | null; posted_at: Date | null }[];
  /** 열리는 결과 상세가 있을 때만. 모듈은 이 page 에 맞는 역할의 모듈이 있을 때만 링크를 그린다. */
  result: { page: "lol_tournament" | "fc_event"; slug: string } | null;
}

export interface PublicScheduleQuery {
  from: string;
  to: string;
  game?: ScheduleGame | null;
  scale?: ScheduleScale | null;
  /** 스트리머 slug — 어떤 역할로든 참가한 일정. */
  streamer?: string | null;
}

export async function listPublicSchedule(q: PublicScheduleQuery): Promise<PublicScheduleEntry[]> {
  const to = daysBetween(q.from, q.to) > SCHEDULE_MAX_DAYS - 1 ? addDays(q.from, SCHEDULE_MAX_DAYS - 1) : q.to;
  const sql = db();
  const entries = await sql<(Omit<PublicScheduleEntry, "slots" | "participants" | "sources" | "result"> & { event_id: string | null })[]>`
    SELECT e.schedule_id, e.game_code, e.title, e.scale, e.planned_kind, e.sponsor, e.description, e.status, e.origin, e.event_id
      FROM core_public.schedule_entry e
      JOIN (SELECT schedule_id, min(on_date) AS first_day, max(on_date) AS last_day
              FROM core_public.schedule_slot GROUP BY schedule_id) r ON r.schedule_id = e.schedule_id
     WHERE r.first_day <= ${to}::date AND r.last_day >= ${q.from}::date
       AND (${q.game ?? null}::text IS NULL OR e.game_code = ${q.game ?? null})
       AND (${q.scale ?? null}::text IS NULL OR e.scale = ${q.scale ?? null})
       AND (${q.streamer ?? null}::text IS NULL OR EXISTS (
             SELECT 1 FROM core_public.schedule_participant p JOIN core_public.streamer s ON s.streamer_id = p.streamer_id
              WHERE p.schedule_id = e.schedule_id AND s.slug = ${q.streamer ?? null}))
     ORDER BY r.first_day, e.title
  `;
  if (entries.length === 0) return [];
  const ids = entries.map((e) => e.schedule_id);

  // 작은 질의라 순서대로 보낸다 — 화면 하나의 동시 질의(팬아웃)를 늘리지 않는다(docs/PLAN.md §M4-1).
  const slots = await sql<(Omit<PublicScheduleSlot, "channel_id"> & { schedule_id: string; channel_id: string | null })[]>`
      SELECT schedule_id, label, on_date::text AS on_date, starts_at, ends_at, channel_id
        FROM core_public.schedule_slot WHERE schedule_id = ANY(${ids}::uuid[])
       ORDER BY on_date, starts_at NULLS LAST`;
  const participants = await sql<(PublicScheduleEntry["participants"][number] & { schedule_id: string })[]>`
      SELECT p.schedule_id, s.slug, s.display_name, p.role, p.team
        FROM core_public.schedule_participant p JOIN core_public.streamer s ON s.streamer_id = p.streamer_id
       WHERE p.schedule_id = ANY(${ids}::uuid[])
       ORDER BY p.role, s.display_name`;
  const sources = await sql<(PublicScheduleEntry["sources"][number] & { schedule_id: string })[]>`
      SELECT schedule_id, url, title, posted_at FROM core_public.schedule_source
       WHERE schedule_id = ANY(${ids}::uuid[]) ORDER BY posted_at NULLS LAST, url`;
  const hostChannels = await sql<{ schedule_id: string; streamer_id: string; channel_id: string | null }[]>`
      SELECT p.schedule_id, p.streamer_id, c.channel_id
        FROM core_public.schedule_participant p
        LEFT JOIN core_public.streamer_channel c ON c.streamer_id = p.streamer_id AND c.platform = 'soop'
       WHERE p.role = 'host' AND p.schedule_id = ANY(${ids}::uuid[])`;

  const results = await resultPages(entries.filter((e) => e.status === "held" && e.event_id));

  return entries.map(({ event_id, ...e }) => {
    const hosts = new Map<string, string[]>();
    for (const h of hostChannels) {
      if (h.schedule_id !== e.schedule_id) continue;
      const list = hosts.get(h.streamer_id) ?? [];
      if (h.channel_id) list.push(h.channel_id);
      hosts.set(h.streamer_id, list);
    }
    const hostList = [...hosts.values()].map((channels) => ({ channels }));
    return {
      ...e,
      slots: slots.filter((s) => s.schedule_id === e.schedule_id)
        .map(({ schedule_id: _, channel_id, ...s }) => ({ ...s, channel_id: pickBroadcastChannel(channel_id, hostList) })),
      participants: participants.filter((p) => p.schedule_id === e.schedule_id).map(({ schedule_id: _, ...p }) => p),
      sources: sources.filter((s) => s.schedule_id === e.schedule_id).map(({ schedule_id: _, ...s }) => s),
      result: event_id && e.status === "held" ? results.get(event_id) ?? null : null,
    };
  });
}

/** 결과 상세가 실제로 열리는 event 만 — 각 게임의 대회 목록 함수가 돌려주는 것. */
async function resultPages(linked: { game_code: ScheduleGame; event_id: string | null }[]) {
  const out = new Map<string, NonNullable<PublicScheduleEntry["result"]>>();
  if (linked.some((e) => e.game_code === "lol")) {
    for (const t of await listPublicTournamentEvents()) if (t.slug) out.set(t.event_id, { page: "lol_tournament", slug: t.slug });
  }
  if (linked.some((e) => e.game_code === "fconline")) {
    for (const t of await listFcoEvents()) out.set(t.id, { page: "fc_event", slug: t.slug });
  }
  return out;
}

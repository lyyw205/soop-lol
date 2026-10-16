/**
 * **경기 분류의 쓰기 단일 출처** — 행사·시리즈·제외(docs/CLASSIFICATION-REDESIGN-PLAN.md §3, 0089).
 *
 * 뼈대: 행사(format) → 시리즈(event 필수) → 세트. 판이 어느 진행 방식인지 정하는 길은 "판을 어느 시리즈에, 그 시리즈를 어느
 * 행사에 두나" 하나뿐이다. 판을 행사·시리즈에 붙이거나 옮기는 쓰기는 **전부 이 파일을 거친다** — 수집·VOD 반영·검수 화면·
 * 시드·일괄 등록·FC 맥락이 각자 SQL 로 붙이면 제외 확인이나 게임 대조를 한쪽이 빠뜨린다(옛 구조에서 실제로 그랬다).
 *
 * ★ 미분류는 행사의 format='unclassified' 하나로만 표현한다. 행사 없이 들어오는 판은 **자동 미분류 묶음**에 담긴다 —
 *   묶음의 키는 판 자체에서 정해지므로(날짜·두 사람) 들어온 순서·재실행·동시 수집과 무관하게 같은 판은 같은 묶음에 간다.
 *   묶음은 자동 수집 전용 그릇이다. 사람은 묶음의 format 을 바꾸지 않고, 시리즈를 실제 행사로 옮겨 분류한다.
 * ★ "이 판은 이 행사가 아니다"는 소속으로 표현할 수 없다 — event_exclusion 이 **현재 제약**이다. 사람(admin)의 제외는
 *   자동 경로가 넘지 못한다. 사람이 그 행사에 다시 붙이면 제외를 지운다(이력은 review_change).
 */
import type postgres from "postgres";

import { allowedFormat, isFormat, type Format, type GameCode } from "../metrics/format.ts";
import { kstDateString } from "../time.ts";
import { validateBestOf } from "./series.ts";

type Tx = postgres.TransactionSql;
export type Actor = "auto" | "admin";

export interface EventInput {
  game_code: GameCode;
  slug: string;
  /** 새로 만들 때 필수. 기존 행사에 연결만 할 때는 비워도 된다. */
  name?: string;
  /** 새로 만들 때 필수(모르면 'unclassified' 를 명시). 기존 행사에 연결할 때 주면 기존 값과 대조한다. */
  format?: Format;
  organizer?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  source_url?: string | null;
}

function assertFormat(game: GameCode, format: string, where: string): asserts format is Format {
  if (!isFormat(format) || !allowedFormat(game, format)) {
    throw new Error(`${where}: ${game} 행사의 진행 방식으로 ${format} 은 쓸 수 없다`);
  }
}

/**
 * 행사를 **찾거나 새로 만든다.** 이미 있으면 절대 고치지 않는다(0035 사고 — 연결하는 쪽이 분류를 덮어 멸망전이 내전이 됐다).
 * format·game_code 를 주면 기존 값과 대조하고 다르면 멈춘다 — 입력이 틀렸거나 행사를 고쳐야 하거나, 어느 쪽인지는 사람이 정한다.
 * 자동 묶음 행사는 여기서 찾지 않는다(그 slug 는 ensureAutoBucketInTx 만 쓴다).
 */
export async function ensureEventInTx(tx: Tx, input: EventInput): Promise<string> {
  const slug = input.slug.trim();
  if (!slug) throw new Error("행사 slug 가 비어 있다.");
  if (input.format) assertFormat(input.game_code, input.format, `행사 ${slug}`);
  const [existing] = await tx<{ id: string }[]>`SELECT id FROM event WHERE slug = ${slug}`;
  if (!existing) {
    if (!input.name?.trim()) throw new Error(`새 행사 ${slug} 에는 이름이 필요하다 — slug 로 대신하지 않는다.`);
    if (!input.format) throw new Error(`새 행사 ${slug} 에는 진행 방식(format)이 필요하다 — 기본값이 없다(모르면 unclassified).`);
    await tx`
      INSERT INTO event (slug, name, format, game_code, organizer, starts_at, ends_at, source_url)
      VALUES (${slug}, ${input.name.trim()}, ${input.format}, ${input.game_code}, ${input.organizer ?? null},
              ${input.starts_at || null}, ${input.ends_at || null}, ${input.source_url ?? null})
      ON CONFLICT (slug) DO NOTHING`;
  }
  const [row] = await tx<{ id: string; format: Format; game_code: GameCode; auto_bucket: boolean }[]>`
    SELECT id, format, game_code, auto_bucket FROM event WHERE slug = ${slug} FOR UPDATE`;
  if (row.auto_bucket) throw new Error(`행사 ${slug} 는 자동 미분류 묶음이다 — 실제 행사로 쓸 수 없다.`);
  if (row.game_code !== input.game_code) throw new Error(`행사 ${slug} 는 ${row.game_code} 행사다 (입력: ${input.game_code}).`);
  if (input.format && row.format !== input.format) {
    throw new Error(`행사 ${slug} 의 진행 방식은 이미 ${row.format} 이다 (입력: ${input.format}). `
      + "연결하는 쪽은 행사를 고치지 않는다 — 틀렸으면 시드나 관리자 화면에서 고친다.");
  }
  return row.id;
}

/** 필드를 **생략하면 그대로**, 명시한 null 이면 비운다. 이름과 진행 방식은 비울 수 없다. */
export type EventPatch = Partial<Omit<EventInput, "slug" | "game_code">>;

/**
 * 이미 있는 행사를 고친다 — 행사의 주인(시드·관리자)만 부른다. 생략한 필드는 건드리지 않는다.
 * 진행 방식을 바꾸면 그 행사 모든 판의 분류가 함께 바뀐다 — 분류는 저장된 사본이 없으므로(파생 표 폐지) 따로 다시 만들 것이 없다.
 */
export async function updateEventInTx(tx: Tx, slug: string, patch: EventPatch): Promise<string> {
  const [before] = await tx<{ id: string; game_code: GameCode; auto_bucket: boolean }[]>`
    SELECT id, game_code, auto_bucket FROM event WHERE slug = ${slug} FOR UPDATE`;
  if (!before) throw new Error(`행사 ${slug} 가 없다 — 새로 만들 때는 ensureEventInTx 를 쓴다.`);
  if (before.auto_bucket) throw new Error(`행사 ${slug} 는 자동 미분류 묶음이다 — 고치지 않고 시리즈를 실제 행사로 옮긴다.`);
  if (patch.name === null || (patch.name !== undefined && !patch.name.trim())) throw new Error("행사 이름은 비울 수 없다.");
  if (patch.format === null) throw new Error("행사 진행 방식은 비울 수 없다(모르면 unclassified).");
  if (patch.format) assertFormat(before.game_code, patch.format, `행사 ${slug}`);
  const set: Record<string, unknown> = {};
  for (const key of ["name", "format", "organizer", "starts_at", "ends_at", "source_url"] as const) {
    if (patch[key] === undefined) continue;
    set[key] = key === "starts_at" || key === "ends_at" ? (patch[key] || null) : patch[key];
  }
  if (Object.keys(set).length) await tx`UPDATE event SET ${tx(set, ...Object.keys(set))} WHERE id = ${before.id}::uuid`;
  return before.id;
}

// ── 자동 미분류 묶음 ──────────────────────────────────────────────────────────

/** 토너먼트 코드 판의 묶음 — KST 날짜. 0089 이관과 같은 키다. */
export const lolCodeBucketSlug = (playedAt: Date) => `lol-code-auto-${kstDateString(playedAt)}`;
/** FC 스트리머끼리 판의 묶음 — (두 사람, KST 날짜). 사람 순서와 무관하다. */
export function fcPairBucketSlug(playedAt: Date, a: string, b: string): string {
  const [s1, s2] = [a, b].sort();
  return `fc-auto-${kstDateString(playedAt)}-${s1}-${s2}`;
}

/** 자동 묶음 행사를 찾거나 만든다. 동시에 두 번 불려도 하나다(slug 유일 + ON CONFLICT). */
export async function ensureAutoBucketInTx(tx: Tx, input: { game_code: GameCode; slug: string; name: string; day: Date }): Promise<string> {
  await tx`
    INSERT INTO event (slug, name, format, auto_bucket, game_code, starts_at)
    VALUES (${input.slug}, ${input.name}, 'unclassified', true, ${input.game_code},
            (${kstDateString(input.day)}::date)::timestamp AT TIME ZONE 'Asia/Seoul')
    ON CONFLICT (slug) DO NOTHING`;
  const [row] = await tx<{ id: string; auto_bucket: boolean; game_code: GameCode }[]>`
    SELECT id, auto_bucket, game_code FROM event WHERE slug = ${input.slug}`;
  if (!row.auto_bucket || row.game_code !== input.game_code) {
    throw new Error(`slug ${input.slug} 는 자동 묶음 자리인데 다른 행사가 쓰고 있다.`);
  }
  return row.id;
}

// ── 시리즈 ────────────────────────────────────────────────────────────────────

/** 행사 없이 들어온 판이나 묶이지 않은 판의 한 판짜리 시리즈 키. */
export const singleSetSeriesId = (matchId: string) => `set:${matchId}`;

export interface SeriesInput {
  id: string;
  game_code: GameCode;
  /** 시리즈는 행사 없이 존재할 수 없다(0089). */
  event_id: string;
  best_of?: number | null;
  best_of_evidence?: string | null;
  /** 대회 안의 위치("8강 2경기"). 세트 번호는 빼고 적는다. */
  round_label?: string | null;
  /** 세트 순서를 출처에서 확인했으면 true. 모르면 비운다(false 로 내려가지 않는다). */
  set_order_known?: boolean;
}

export interface SeriesRow {
  id: string; game_code: GameCode; event_id: string; best_of: number | null;
  best_of_evidence: string | null; round_label: string | null; set_order_known: boolean;
}
const SERIES_COLUMNS = "id, game_code, event_id, best_of, best_of_evidence, round_label, set_order_known";

/**
 * 시리즈를 만들거나 기존 정본과 일치하는지 확인한다. 기존 값을 다른 값으로 조용히 덮지 않는다 — 한 건의 잘못된 입력이 모든 세트를 바꾼다.
 * 시리즈의 행사를 옮기는 것은 여기가 아니라 moveSeriesInTx(영향 범위가 모든 세트라 별도 경로).
 */
export async function ensureSeriesInTx(tx: Tx, input: SeriesInput): Promise<SeriesRow> {
  const id = input.id.trim();
  if (!id) throw new Error("series_id 가 비어 있다.");
  validateBestOf(input.best_of, input.best_of_evidence);
  await tx`
    INSERT INTO match_series (id, game_code, event_id, best_of, best_of_evidence)
    VALUES (${id}, ${input.game_code}, ${input.event_id}::uuid, ${input.best_of ?? null}, ${input.best_of_evidence?.trim() || null})
    ON CONFLICT (id) DO NOTHING`;
  const [current] = await tx<SeriesRow[]>`SELECT ${tx.unsafe(SERIES_COLUMNS)} FROM match_series WHERE id = ${id} FOR UPDATE`;
  if (current.game_code !== input.game_code) throw new Error(`시리즈 ${id} 는 ${current.game_code} 경기다. ${input.game_code} 경기를 섞을 수 없다.`);
  if (current.event_id !== input.event_id) throw new Error(`시리즈 ${id} 의 행사가 기존 값과 다르다 — 옮기는 것은 moveSeriesInTx 로.`);
  if (input.best_of != null && current.best_of != null && current.best_of !== input.best_of) {
    throw new Error(`시리즈 ${id} 의 best_of 는 이미 ${current.best_of} 이다.`);
  }
  const roundLabel = input.round_label?.trim() || null;
  if (roundLabel && current.round_label && current.round_label !== roundLabel) {
    throw new Error(`시리즈 ${id} 의 라운드명은 이미 "${current.round_label}" 이다 (입력: "${roundLabel}").`);
  }
  const set: Record<string, unknown> = {};
  if (input.best_of != null && current.best_of == null) { set.best_of = input.best_of; set.best_of_evidence = input.best_of_evidence!.trim(); }
  if (roundLabel && !current.round_label) set.round_label = roundLabel;
  if (input.set_order_known && !current.set_order_known) set.set_order_known = true;
  if (!Object.keys(set).length) return current;
  const [updated] = await tx<SeriesRow[]>`
    UPDATE match_series SET ${tx(set, ...Object.keys(set))}, updated_at = now() WHERE id = ${id}
    RETURNING ${tx.unsafe(SERIES_COLUMNS)}`;
  return updated;
}

// ── 제외 ──────────────────────────────────────────────────────────────────────

/**
 * 판들을 이 행사에 붙여도 되나. 자동 경로는 사람의 제외를 넘지 못한다(거부). 사람이 붙이면 그 제외를 지운다 —
 * 사람의 새 판단이 옛 판단을 대신한다(이력은 review_change).
 */
export async function assertAttachAllowedInTx(tx: Tx, eventId: string, matchIds: readonly string[], actor: Actor): Promise<void> {
  if (!matchIds.length) return;
  const rows = await tx<{ match_id: string; decided_by: Actor; note: string | null }[]>`
    SELECT match_id, decided_by, note FROM event_exclusion WHERE event_id = ${eventId}::uuid AND match_id = ANY(${matchIds as string[]})`;
  if (!rows.length) return;
  const human = rows.filter((r) => r.decided_by === "admin");
  if (actor === "auto" && human.length) {
    throw new Error(`사람이 이 행사에서 뺀 판이다: ${human.map((r) => r.match_id).join(", ")} — 자동 경로는 되돌리지 않는다.`);
  }
  for (const r of rows) {
    await tx`DELETE FROM event_exclusion WHERE event_id = ${eventId}::uuid AND match_id = ${r.match_id}`;
    await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor)
             VALUES (${r.match_id}, 'classification', ${eventId}, 'event_exclusion',
                     ${tx.json({ decided_by: r.decided_by, note: r.note })}, NULL, ${actor})`;
  }
}

/**
 * "이 판은 이 행사가 아니다"를 남긴다. 사람의 제외는 자동 판단이 덮지 못한다(자동 제외는 사람이 덮는다).
 * 판을 그 행사에서 꺼내 어디에 둘지는 호출자가 정한다(보통 그 판의 자동 묶음으로 placeSingleSetInTx).
 */
export async function excludeFromEventInTx(tx: Tx, input: { event_id: string; match_id: string; actor: Actor; note?: string | null }): Promise<void> {
  const written = await tx`
    INSERT INTO event_exclusion (event_id, match_id, decided_by, note)
    VALUES (${input.event_id}::uuid, ${input.match_id}, ${input.actor}, ${input.note ?? null})
    ON CONFLICT (event_id, match_id) DO UPDATE SET decided_by = EXCLUDED.decided_by, note = EXCLUDED.note, decided_at = now()
      WHERE event_exclusion.decided_by = 'auto' OR EXCLUDED.decided_by = 'admin'
    RETURNING 1`;
  if (!written.length) return;  // 사람의 제외를 자동이 덮으려 했다 — 바뀐 것이 없으니 이력도 없다
  await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor)
           VALUES (${input.match_id}, 'classification', ${input.event_id}, 'event_exclusion', NULL,
                   ${tx.json({ decided_by: input.actor, note: input.note ?? null })}, ${input.actor})`;
}

// ── 판을 시리즈에 두기 ─────────────────────────────────────────────────────────

/**
 * 판을 (행사의) 시리즈의 몇 번째 세트로 둔다 — 판을 분류에 넣는 유일한 쓰기. 행사의 게임과 판의 게임을 대조하고,
 * 제외를 확인하고, 시리즈를 만들거나 대조한다. 판이 이미 다른 시리즈에 있으면 옮긴다(옛 시리즈가 비면 지운다).
 */
export async function placeSetInTx(tx: Tx, input: {
  match_id: string; series: SeriesInput; game_no: number; actor: Actor;
}): Promise<void> {
  const [m] = await tx<{ game_code: GameCode; series_id: string | null; scope: string }[]>`
    SELECT game_code, series_id, scope FROM match WHERE match_id = ${input.match_id} FOR UPDATE`;
  if (!m) throw new Error(`경기 ${input.match_id} 가 없다.`);
  if (m.game_code !== input.series.game_code) throw new Error(`경기 ${input.match_id} 는 ${m.game_code} 경기다.`);
  await assertAttachAllowedInTx(tx, input.series.event_id, [input.match_id], input.actor);
  await ensureSeriesInTx(tx, input.series);
  if (m.series_id === input.series.id) {
    await tx`UPDATE match SET series_game_no = ${input.game_no} WHERE match_id = ${input.match_id}`;
    return;
  }
  await tx`UPDATE match SET series_id = ${input.series.id}, series_game_no = ${input.game_no}, scope = 'versus'
            WHERE match_id = ${input.match_id}`;
  if (m.series_id) await dropEmptySeriesInTx(tx, m.series_id);
}

/** 행사에 한 판짜리 시리즈로 둔다(행사 없이 들어온 판·묶지 않은 판). */
export function placeSingleSetInTx(tx: Tx, input: { match_id: string; game_code: GameCode; event_id: string; actor: Actor }): Promise<void> {
  return placeSetInTx(tx, {
    match_id: input.match_id, game_no: 1, actor: input.actor,
    series: { id: singleSetSeriesId(input.match_id), game_code: input.game_code, event_id: input.event_id },
  });
}

/** 시리즈를 다른 행사로 옮긴다 — 그 시리즈의 모든 세트가 함께 간다. 제외를 세트마다 확인한다. */
export async function moveSeriesInTx(tx: Tx, input: { series_id: string; event_id: string; actor: Actor }): Promise<void> {
  const [s] = await tx<{ game_code: GameCode; event_id: string }[]>`
    SELECT game_code, event_id FROM match_series WHERE id = ${input.series_id} FOR UPDATE`;
  if (!s) throw new Error(`시리즈 ${input.series_id} 가 없다.`);
  if (s.event_id === input.event_id) return;
  const sets = await tx<{ match_id: string }[]>`SELECT match_id FROM match WHERE series_id = ${input.series_id}`;
  await assertAttachAllowedInTx(tx, input.event_id, sets.map((r) => r.match_id), input.actor);
  await tx`UPDATE match_series SET event_id = ${input.event_id}::uuid, updated_at = now() WHERE id = ${input.series_id}`;
  await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor)
           VALUES (NULL, 'series', ${input.series_id}, 'event_id', ${tx.json(s.event_id)}, ${tx.json(input.event_id)}, ${input.actor})`;
}

/** 판이 하나도 남지 않은 시리즈는 남기지 않는다. 비게 된 자동 묶음 행사도 지운다(실제 행사는 남긴다 — 팀·대진·일정이 매달려 있을 수 있다). */
export async function dropEmptySeriesInTx(tx: Tx, seriesId: string): Promise<void> {
  const [gone] = await tx<{ event_id: string }[]>`
    DELETE FROM match_series ms WHERE ms.id = ${seriesId}
       AND NOT EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id)
    RETURNING event_id`;
  if (!gone) return;
  await tx`DELETE FROM event e WHERE e.id = ${gone.event_id}::uuid AND e.auto_bucket
             AND NOT EXISTS (SELECT 1 FROM match_series ms WHERE ms.event_id = e.id)`;
}

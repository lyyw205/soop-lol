import type postgres from "postgres";

import {
  assertAttachAllowedInTx, ensureEventInTx, excludeFromEventInTx, moveSeriesInTx, placeSetInTx, placeSingleSetInTx,
  updateEventInTx, type Actor,
} from "../../db/classification.ts";
import { db } from "../../db/client.ts";
import { allowedFormat, isFormat, type Format } from "../../metrics/format.ts";
import {
  ensureFcoFriendlyEventInTx, ensureFcoPairBucketInTx, fcoContextStatus, fcoPairOf, FCO_CONTEXT_NOTE_FIELD,
  FCO_EVENT_CONCLUSION_FORMATS, FCO_LATEST_NOTE_LATERAL, FCO_PLACEMENT_JOIN, type FcoContextStatus,
} from "./classify.ts";

type Tx = postgres.TransactionSql;
export type { FcoContextStatus } from "./classify.ts";

/**
 * FC 경기 맥락의 단일 반영 경로 — 판단 = "이 판이 **어느 진행 방식의 행사** 소속인가"(사용자 결정 6, docs/CLASSIFICATION-REDESIGN-PLAN.md §3.7).
 *
 * 결론은 셋뿐이다.
 *   event       근거 URL 과 함께 실제 행사(ck·tournament·concept)를 찾거나 만들고 판(또는 시리즈)을 그 행사로 옮긴다.
 *   unresolved  행사를 못 정했다 — 판은 자동 묶음에 남고, 남은 질문 메모를 review_change(entity 'classification')에 남긴다.
 *   friendly    친선 — **사람(admin)만.** (두 사람, 날짜) 친선 행사로 옮긴다. 자동 조사는 친선을 낼 수 없다(거부, 사용자 결정 5-A·7).
 * 판을 행사·시리즈에 붙이는 쓰기는 전부 classification.ts 를 거친다(제외 확인·게임 대조가 거기 있다).
 * ★ 사람(admin)이 이 행사에서 뺀 판(event_exclusion)은 자동 경로가 다시 붙이지 못한다 — 어느 경로(단독·시리즈·포함 결정)든 같다.
 * ★ 자동 경로는 판을 실제 행사에서 꺼내지 못한다. 이미 다른 실제 행사에 있는 판을 옮기는 것은 사람이 화면에서 의도적으로(relink) 할 때뿐이다.
 */

export type FcoEvidenceRole = "pre" | "start" | "end" | "post" | "result";

export interface FcoEvidenceInput {
  /** 멱등 재전송 키. 예: 'vod:207643193@1479', 'notice:pick-182785'. */
  evidence_key: string;
  kind: "vod_frame" | "chat" | "audio" | "notice" | "url";
  vod_title_no?: number | null;
  channel_id?: string | null;
  /** VOD 전체 초 — ck:probe 와 같은 축. */
  at_sec?: number | null;
  end_sec?: number | null;
  url?: string | null;
  /** 조사가 실제로 연 프레임 파일 (out/ck/<vod>/g<전체초>.jpg). 검수 화면이 띄워 대조한다. */
  frame_path?: string | null;
  /** 경기 흐름의 어느 장면인가(0036). result 는 검수 화면이 먼저 띄운다. */
  role?: FcoEvidenceRole | null;
  /** 본 것. */
  observed: string;
  /** 그래서 어떻게 봤나. 관찰과 섞지 않는다. */
  why?: string | null;
}

export type FcoContextConclusion = "event" | "unresolved" | "friendly";
const CONCLUSIONS: readonly FcoContextConclusion[] = ["event", "unresolved", "friendly"];

export interface FcoContextInput {
  /**
   * 경기 참조 — 넥슨 경기 번호(provider_match_id) **또는 내부 match_id**(`fco:…`·`fcs:<VOD>@<초>`).
   * 화면 경기(VOD 결과 화면에서 읽은 경기)는 넥슨 번호가 없어 내부 id 로만 찾는다. 두 값은 겹치지 않는다.
   */
  provider_match_id: string;
  expectedVersion?: number;
  /** 없으면 근거만 쌓는다 — 결론 없이 중간 반영해도 된다. */
  conclusion?: FcoContextConclusion;
  /** unresolved 의 남은 질문(필수 — 빈 메모는 못 남긴다). event·friendly 에는 쓰지 않는다. */
  note?: string;
  event?: {
    slug: string;
    name: string;
    /** 진행 방식 — 새로 만들거나 자동 조사가 낼 수 있는 것은 ck·tournament·concept 뿐이다(친선은 friendly 결론, 모르면 unresolved). 사람은 이미 있는 행사의 값을 그대로 줄 수 있다. */
    format: Format;
    organizer?: string | null;
    /** 확인 근거 URL. 필수 — 근거 없는 행사 연결은 받지 않는다. */
    source_url: string;
  };
  /**
   * 다전제. 같은 두 사람이 연속 세트로 한 판의 승부를 가린 경우에만 쓴다 —
   * **상대가 바뀌면 시리즈가 아니라 대회(event)다.** 세트마다 이 블록을 준다.
   * 결론 없이 주면 그 판이 지금 있는 행사(보통 그날 두 사람 자동 묶음) 안에서 묶는다.
   * ⚠ best_of 는 근거 없이 못 넣는다. 「연속 3경기니까 Bo3」 는 추측이다.
   */
  series?: {
    /** 시리즈 정본 id. 예: `fc-sisik-cup-2026-09-20:kimmingyo-doochiwa`. */
    id: string;
    /** 이 경기가 그 시리즈의 몇 번째 세트인가 (1부터). */
    game_no: number;
    /** 3판2선승이면 3. 모르면 비운다 — 모른다와 단판은 다르다. */
    best_of?: number | null;
    /** best_of 를 확정한 화면·규정. best_of 를 줄 때만 필수(DB 도 막는다). */
    best_of_evidence?: string | null;
  };
  evidences?: FcoEvidenceInput[];
}

export interface FcoContextOutcome {
  provider_match_id: string;
  /** 실제로 한 일 (dry-run 이면 했을 일). */
  actions: string[];
  /** ⏭ 건너뛴 것과 사유. 성공으로 세지 않는다. */
  skipped: string[];
}

const ROLLBACK = Symbol("dry-run rollback");

/** 판 하나의 지금 자리 — 시리즈·행사(시리즈 경유 한 길). */
interface Game {
  match_id: string; played_at: Date; series_id: string | null; series_game_no: number | null; sets: number;
  event_id: string | null; auto_bucket: boolean | null;
}

async function lockGame(tx: Tx, ref: string): Promise<Game | null> {
  const [game] = await tx<Game[]>`
    SELECT m.match_id, m.game_creation AS played_at, m.series_id, m.series_game_no,
           (SELECT count(*)::int FROM match x WHERE x.series_id = m.series_id) AS sets,
           ms.event_id, e.auto_bucket
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = ms.event_id
     WHERE (d.provider_match_id = ${ref} OR m.match_id = ${ref}) AND m.game_code = 'fconline'
     FOR UPDATE OF m`;
  return game ?? null;
}

/** 사람이 이 행사에서 뺀 판이 이 중에 있나 — 자동 경로가 ⏭ 로 알리려고 먼저 본다(최종 거부는 classification.ts 가 한다). */
async function humanExcludedAmong(tx: Tx, eventId: string, matchIds: string[]): Promise<string | null> {
  if (!matchIds.length) return null;
  const [row] = await tx<{ match_id: string }[]>`
    SELECT match_id FROM event_exclusion
     WHERE event_id = ${eventId}::uuid AND match_id = ANY(${matchIds}) AND decided_by = 'admin'
     ORDER BY match_id LIMIT 1`;
  return row?.match_id ?? null;
}

/** 맥락 판단이 바뀌면 확인 도장이 풀린다(옛 판단 표 트리거가 하던 일 — 메모는 이제 review_change 에 남아 트리거가 없다). */
async function invalidateContextReview(tx: Tx, matchId: string): Promise<void> {
  await tx`UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
            WHERE match_id = ${matchId} AND game_code = 'fconline'`;
}

interface NoteRow { judgment: string; note: string; created_by: Actor; created_at: Date }
async function latestNote(tx: Tx | postgres.Sql, matchId: string): Promise<NoteRow | null> {
  const [row] = await tx<NoteRow[]>`
    SELECT after->>'judgment' AS judgment, after->>'note' AS note, actor AS created_by, changed_at AS created_at
      FROM review_change
     WHERE match_id = ${matchId} AND entity = 'classification' AND field = ${FCO_CONTEXT_NOTE_FIELD}
     ORDER BY changed_at DESC, id DESC LIMIT 1`;
  return row ?? null;
}

/** 판단 메모를 남긴다(이력 — 지우지 않는다). 같은 내용이면 멱등, 사람의 메모는 자동이 덮지 않는다. */
async function recordNote(tx: Tx, matchId: string, judgment: string, note: string, actor: Actor, out: FcoContextOutcome): Promise<void> {
  const latest = await latestNote(tx, matchId);
  if (latest && latest.judgment === judgment && latest.note === note && (latest.created_by === actor || latest.created_by === "admin")) {
    out.skipped.push("판단 — 이미 같은 내용 (멱등)");
    return;
  }
  if (latest?.created_by === "admin" && actor === "auto") {
    out.skipped.push("판단 — 검수(admin) 판단이 있어 자동 반영이 덮지 않는다");
    return;
  }
  await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after, actor)
           VALUES (${matchId}, 'classification', ${matchId}, ${FCO_CONTEXT_NOTE_FIELD},
                   ${latest ? tx.json({ judgment: latest.judgment, note: latest.note, by: latest.created_by }) : null},
                   ${tx.json({ judgment, note, by: actor })}, ${actor})`;
  await invalidateContextReview(tx, matchId);
  out.actions.push(`판단 기록 ${judgment}`);
}

/**
 * 결론 event 의 행사 — 찾거나 만든다. 이미 있으면 이름·진행 방식을 대조만 하고 고치지 않는다.
 * 새로 만들거나 자동 조사가 낼 수 있는 진행 방식은 ck·tournament·concept 뿐이다. 사람(admin)은 **이미 있는** 실제 행사라면
 * 진행 방식과 무관하게 고를 수 있다(친선 행사·옛 scrim 에서 넘어온 분류 전 행사 등 — 사람이 정한 자리다).
 */
async function resolveEventConclusion(tx: Tx, meta: FcoContextInput["event"], actor: Actor, out: FcoContextOutcome): Promise<{ id: string; slug: string }> {
  if (!meta?.slug || !meta.name) throw new Error("event 결론에는 event{slug,name,format,source_url}가 필수다");
  const format = (meta as { format?: string }).format;
  const [found] = await tx<{ format: string; auto_bucket: boolean }[]>`SELECT format, auto_bucket FROM event WHERE slug = ${meta.slug} AND game_code = 'fconline'`;
  const adminPicksExisting = actor === "admin" && found && !found.auto_bucket && format === found.format && allowedFormat("fconline", found.format as Format);
  if (!adminPicksExisting && (!format || !(FCO_EVENT_CONCLUSION_FORMATS as readonly string[]).includes(format))) {
    throw new Error(`event.format 은 ${FCO_EVENT_CONCLUSION_FORMATS.join("·")} 중 하나다 (입력: ${format ?? "없음"}) — `
      + "친선은 사람이 conclusion friendly 로, 형식을 모르면 unresolved 로 남긴다");
  }
  if (!meta.source_url?.trim()) throw new Error("행사 연결에는 확인 근거 URL(event.source_url)이 필수다");
  const [existing] = await tx<{ name: string; game_code: string; auto_bucket: boolean }[]>`SELECT name, game_code, auto_bucket FROM event WHERE slug = ${meta.slug}`;
  if (existing && existing.game_code !== "fconline") throw new Error(`slug '${meta.slug}' 는 ${existing.game_code} 행사가 쓰고 있다`);
  if (existing?.auto_bucket) throw new Error(`slug '${meta.slug}' 는 자동 미분류 묶음이다 — 실제 행사의 slug 를 새로 정한다`);
  if (existing && existing.name !== meta.name) {
    throw new Error(`slug 충돌 — 기존 행사 이름은 '${existing.name}' 이다. 덮어쓰지 않는다. 이름을 바꾸려면 admin 이 event 를 직접 고친다`);
  }
  const id = await ensureEventInTx(tx, {
    game_code: "fconline", slug: meta.slug, name: meta.name, format: format as Format,
    organizer: meta.organizer ?? null, source_url: meta.source_url,
  });
  if (!existing) out.actions.push(`행사 생성 ${meta.slug} (${format})`);
  return { id, slug: meta.slug };
}

/** best_of 형식 검사 — DB 도 근거 없는 best_of 를 막지만 메시지를 조사자 말로 먼저 준다. */
function checkSeriesMeta(meta: NonNullable<FcoContextInput["series"]>): void {
  if (!meta.id?.trim()) throw new Error("series.id 가 필요하다 — 시리즈의 정본 키다");
  if (!Number.isInteger(meta.game_no) || meta.game_no < 1) throw new Error("series.game_no 는 1 이상 정수다 (이 경기가 몇 번째 세트인가)");
  if (meta.best_of != null) {
    if (!Number.isInteger(meta.best_of) || meta.best_of < 1 || meta.best_of % 2 === 0) throw new Error("best_of 는 홀수 양수다 (Bo1·Bo3·Bo5…)");
    if (!meta.best_of_evidence?.trim()) throw new Error("best_of 에는 근거가 필수다 — 화면·공지에서 읽은 것을 적는다. 연속 경기 수로 추측하지 않는다");
  }
}

/**
 * 세트를 시리즈에 둔다(그 시리즈는 eventId 행사 아래). 같은 대진인지 먼저 본다 — 상대가 바뀌면 다전제가 아니다.
 * 시리즈가 이미 자동 묶음에 있으면 시리즈째 행사로 옮긴다(묶음은 그릇일 뿐이다). 다른 실제 행사에 있으면 사람의 relink 만 옮긴다.
 */
async function placeIntoSeries(tx: Tx, game: Game, eventId: string, meta: NonNullable<FcoContextInput["series"]>,
  actor: Actor, relink: boolean, out: FcoContextOutcome): Promise<void> {
  checkSeriesMeta(meta);
  // ★ 사람 비교는 fco_participant_key(스트리머 → 계정 → 화면 이름, 0054)로 한다. ouid 로 비교하면 화면 경기(ouid 없음)가
  //   같은 사람인데도 "다른 대진"이 되고, NULL 끼리는 array_agg 에서 같은 값처럼 합쳐진다.
  const [mine] = await tx<{ keys: string[] }[]>`
    SELECT array_agg(fco_participant_key(ouid, streamer_id, nickname) ORDER BY fco_participant_key(ouid, streamer_id, nickname)) AS keys
      FROM fco_match_participant WHERE match_id = ${game.match_id}`;
  const siblings = await tx<{ match_id: string; game_no: number | null; keys: string[] }[]>`
    SELECT m.match_id, m.series_game_no AS game_no,
           array_agg(fco_participant_key(p.ouid, p.streamer_id, p.nickname) ORDER BY fco_participant_key(p.ouid, p.streamer_id, p.nickname)) AS keys
      FROM match m JOIN fco_match_participant p ON p.match_id = m.match_id
     WHERE m.series_id = ${meta.id} AND m.game_code = 'fconline' AND m.match_id <> ${game.match_id}
     GROUP BY m.match_id, m.series_game_no`;
  for (const sibling of siblings) {
    if (sibling.keys.join("|") !== (mine?.keys ?? []).join("|")) {
      throw new Error(`시리즈 '${meta.id}' 에 다른 대진이 들어 있다 — 상대가 바뀌면 같은 다전제가 아니다. 대회라면 event 로 묶어라`);
    }
    if (sibling.game_no === meta.game_no) throw new Error(`시리즈 '${meta.id}' 의 ${meta.game_no}세트는 이미 ${sibling.match_id} 다`);
  }
  // ★ 사람의 제외는 시리즈를 통해서도 우회되지 않는다 — 이 판이든, 같은 시리즈의 다른 세트든.
  if (actor === "auto") {
    const blocked = await humanExcludedAmong(tx, eventId, [game.match_id, ...siblings.map((s) => s.match_id)]);
    if (blocked) {
      out.skipped.push(`시리즈 ${meta.id} ${meta.game_no}세트 — ${blocked === game.match_id ? "사람이 이 행사에서 제외한 경기다" : `같은 시리즈의 ${blocked} 를 사람이 이 행사에서 제외했다`}. 자동으로 연결하지 않는다`);
      return;
    }
  }
  const [known] = await tx<{ event_id: string; auto_bucket: boolean; best_of: number | null; best_of_evidence: string | null }[]>`
    SELECT ms.event_id, e.auto_bucket, ms.best_of, ms.best_of_evidence
      FROM match_series ms JOIN event e ON e.id = ms.event_id WHERE ms.id = ${meta.id} AND ms.game_code = 'fconline' FOR UPDATE OF ms`;
  if (known && meta.best_of != null && known.best_of != null && known.best_of !== meta.best_of) {
    throw new Error(`시리즈 '${meta.id}' 는 이미 Bo${known.best_of} 다 (근거: ${known.best_of_evidence}). 바꾸려면 확인이 먼저다`);
  }
  if (known && known.event_id !== eventId) {
    if (!known.auto_bucket && !(relink && actor === "admin")) throw new Error(`시리즈 '${meta.id}' 가 이미 다른 행사에 연결돼 있다`);
    await moveSeriesInTx(tx, { series_id: meta.id, event_id: eventId, actor });
    out.actions.push(`시리즈 ${meta.id} 를 행사로 옮김`);
  }
  if (game.series_id && game.series_id !== meta.id) {
    // 판이 옮길 수 있는 자리에 있나 — 한 판짜리이고, 자동 묶음이거나 같은 행사거나 사람의 relink.
    const movable = game.sets === 1 && (game.auto_bucket === true || game.event_id === eventId || (relink && actor === "admin"));
    if (!movable) throw new Error(`이 경기는 이미 시리즈 '${game.series_id}' 에 속해 있다`);
  }
  const fills = known && meta.best_of != null && known.best_of == null;
  if (game.series_id === meta.id && game.series_game_no === meta.game_no && !fills) {
    out.skipped.push(`시리즈 ${meta.id} ${meta.game_no}세트 — 이미 연결됨 (멱등)`);
    return;
  }
  await placeSetInTx(tx, {
    match_id: game.match_id, game_no: meta.game_no, actor,
    series: { id: meta.id, game_code: "fconline", event_id: eventId, best_of: meta.best_of ?? null, best_of_evidence: meta.best_of_evidence ?? null },
  });
  if (!known) out.actions.push(`시리즈 생성 ${meta.id}${meta.best_of ? ` (Bo${meta.best_of})` : ""}`);
  else if (fills) out.actions.push(`시리즈 보강 ${meta.id}`);
  if (game.series_id !== meta.id || game.series_game_no !== meta.game_no) out.actions.push(`시리즈 연결 ${meta.id} ${meta.game_no}세트`);
}

/** 판(한 판짜리)을 행사로 옮긴다. 여러 판 시리즈의 세트면 시리즈 블록과 함께 와야 한다. */
async function placeIntoEvent(tx: Tx, game: Game, event: { id: string; slug: string }, actor: Actor, relink: boolean,
  out: FcoContextOutcome): Promise<void> {
  if (actor === "auto" && await humanExcludedAmong(tx, event.id, [game.match_id])) {
    out.skipped.push("행사 연결 — 사람이 이 행사에서 제외한 경기다. 자동으로 다시 붙이지 않는다");
    return;
  }
  if (game.event_id === event.id) { out.skipped.push("행사 연결 — 이미 연결됨 (멱등)"); return; }
  if (game.series_id && game.sets > 1) throw new Error("시리즈에 속한 경기다 — 시리즈째 옮기려면 series 블록과 함께 보내라");
  if (game.event_id && game.auto_bucket === false && !(relink && actor === "admin")) {
    throw new Error("경기가 이미 다른 행사에 연결돼 있다 — 바꾸려면 먼저 기존 연결을 확인하라");
  }
  if (game.series_id) await moveSeriesInTx(tx, { series_id: game.series_id, event_id: event.id, actor });
  else await placeSingleSetInTx(tx, { match_id: game.match_id, game_code: "fconline", event_id: event.id, actor });
  out.actions.push(`행사 연결 ${event.slug}`);
}

export async function applyFcoMatchContext(
  input: FcoContextInput,
  /** relink: 이미 실제 행사에 있는 판을 **사람이 화면에서 의도적으로** 옮길 때만 (admin 전용). */
  opts: { createdBy?: Actor; dryRun?: boolean; relink?: boolean; transaction?: Tx } = {},
): Promise<FcoContextOutcome> {
  const createdBy = opts.createdBy ?? "auto";
  const relink = opts.relink === true && createdBy === "admin";
  const out: FcoContextOutcome = { provider_match_id: input.provider_match_id, actions: [], skipped: [] };
  if (input.conclusion !== undefined && !CONCLUSIONS.includes(input.conclusion)) {
    throw new Error(`결론은 ${CONCLUSIONS.join("·")} 중 하나다 (입력: ${String(input.conclusion)}) — `
      + "옛 casual 은 없어졌다: 친선은 사람이 확인해 friendly 로, 모르면 unresolved 에 남은 질문을 적는다");
  }
  // ★ 친선은 사람만 — 근거를 저장하기 전에 거부한다(자동 조사의 친선 결론은 통째로 받지 않는다).
  if (input.conclusion === "friendly" && createdBy !== "admin") {
    throw new Error("친선(friendly)은 사람이 확인해 정한다 — 자동 조사는 친선을 결론으로 낼 수 없다(unresolved 로 남긴다)");
  }
  const sql = db();
  try {
    const run = async (tx: Tx) => {
      const game = await lockGame(tx, input.provider_match_id);
      if (!game) throw new Error(`수집되지 않은 경기입니다: ${input.provider_match_id} — 먼저 FC 수집을 돌린다`);
      await assertFcoContextVersion(tx, game.match_id, input.expectedVersion);

      // ── 근거 — 결론과 무관하게 먼저 쌓는다. 판단이 바뀌어도 근거는 남는다.
      for (const ev of input.evidences ?? []) {
        if (!ev.evidence_key?.trim()) throw new Error("evidence_key 가 없다 — 멱등 재전송 키는 조사자가 정한다");
        if (!ev.observed?.trim()) throw new Error(`근거 '${ev.evidence_key}': observed(본 것)가 없다`);
        if (ev.kind === "vod_frame" && (ev.vod_title_no == null || ev.at_sec == null)) {
          throw new Error(`근거 '${ev.evidence_key}': vod_frame 은 vod_title_no 와 at_sec(전체 초)가 필요하다`);
        }
        if (ev.kind === "url" && !ev.url) throw new Error(`근거 '${ev.evidence_key}': url 종류는 url 이 필요하다`);
        const existing = await tx<{ created_by: string; observed: string; why: string | null; frame_path: string | null; role: string | null }[]>`
          SELECT created_by, observed, why, frame_path, role FROM fco_context_evidence
           WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}
        `;
        if (!existing[0]) {
          await tx`
            INSERT INTO fco_context_evidence
              (match_id, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, frame_path, role, observed, why, created_by)
            VALUES (${game.match_id}, ${ev.evidence_key}, ${ev.kind}, ${ev.vod_title_no ?? null},
                    ${ev.channel_id ?? null}, ${ev.at_sec ?? null}, ${ev.end_sec ?? null}, ${ev.url ?? null},
                    ${ev.frame_path ?? null}, ${ev.role ?? null}, ${ev.observed}, ${ev.why ?? null}, ${createdBy})
          `;
          out.actions.push(`근거 저장 ${ev.evidence_key}`);
        } else if (existing[0].observed === ev.observed && (existing[0].why ?? null) === (ev.why ?? null)
          && (existing[0].frame_path ?? null) === (ev.frame_path ?? null)) {
          // 내용이 같고 역할만 비어 있으면 채운다 — 0036 이전 근거에 역할을 다는 길이다(덮어쓰기 아님).
          if (ev.role && !existing[0].role) {
            await tx`UPDATE fco_context_evidence SET role = ${ev.role}
                      WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}`;
            out.actions.push(`근거 역할 채움 ${ev.evidence_key} → ${ev.role}`);
          } else {
            out.skipped.push(`근거 ${ev.evidence_key} — 이미 같은 내용`);
          }
        } else if (createdBy === "admin") {
          await tx`
            UPDATE fco_context_evidence
               SET observed = ${ev.observed}, why = ${ev.why ?? null},
                   vod_title_no = ${ev.vod_title_no ?? null}, channel_id = ${ev.channel_id ?? null},
                   at_sec = ${ev.at_sec ?? null}, end_sec = ${ev.end_sec ?? null}, url = ${ev.url ?? null},
                   frame_path = ${ev.frame_path ?? null}, role = ${ev.role ?? null},
                   created_by = 'admin'
             WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}
          `;
          out.actions.push(`근거 교정 ${ev.evidence_key} (admin)`);
        } else {
          out.skipped.push(`근거 ${ev.evidence_key} — 이미 있고 내용이 다르다. 교정은 admin 경로만`);
        }
      }

      // ── 결론
      if (input.conclusion === "unresolved") {
        const note = input.note?.trim();
        if (!note) throw new Error("'unresolved' 에는 note(남은 질문 — 무엇을 보면 풀리는가)가 필수다");
        await recordNote(tx, game.match_id, "unresolved", note, createdBy, out);
      }

      let target: { id: string; slug: string } | null = null;
      if (input.conclusion === "event") target = await resolveEventConclusion(tx, input.event, createdBy, out);
      if (input.conclusion === "friendly") {
        const pair = await fcoPairOf(tx, game.match_id);
        if (!pair) throw new Error("친선은 스트리머 두 사람의 판에만 정한다 — 한쪽이 스트리머가 아니면 개인 기록이다");
        target = await ensureFcoFriendlyEventInTx(tx, pair, createdBy);
      }

      if (target) {
        if (input.series) await placeIntoSeries(tx, game, target.id, input.series, createdBy, relink, out);
        else await placeIntoEvent(tx, game, target, createdBy, relink, out);
      } else if (input.series) {
        // 결론 없이 다전제만 — 판이 지금 있는 행사(보통 그날 두 사람 자동 묶음) 안에서 묶는다.
        if (!game.event_id) throw new Error("개인 기록 판(시리즈 밖)은 결론 없이 시리즈로 묶을 수 없다 — 행사 결론과 함께 보낸다");
        await placeIntoSeries(tx, game, game.event_id, input.series, createdBy, relink, out);
      }

      if (opts.dryRun) throw ROLLBACK;
    };
    if (opts.transaction) await run(opts.transaction); else await sql.begin(run);
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    out.actions = out.actions.map((a) => `(dry-run) ${a}`);
  }
  return out;
}

/** Check the exact context snapshot while holding the match lock. CLI callers may omit the token. */
async function assertFcoContextVersion(tx: Tx, matchId: string, expected?: number) {
  const [row] = await tx<{ context_review_version: number }[]>`
    SELECT context_review_version FROM match WHERE match_id = ${matchId} AND game_code = 'fconline' FOR UPDATE`;
  if (!row) throw new Error("경기를 찾지 못했습니다.");
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || row.context_review_version !== expected)) {
    throw new Error("대회·분류 정보가 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
  }
}

/** One transaction for the entire selection: a failure never leaves a partially classified session. */
export async function applyFcoMatchContexts(inputs: FcoContextInput[], opts: { relink?: boolean } = {}) {
  if (!inputs.length) throw new Error("선택한 경기가 없습니다.");
  return db().begin(async tx => {
    // Acquire and validate all rows first: updating one series may change sibling context versions.
    for (const input of [...inputs].sort((a, b) => a.provider_match_id.localeCompare(b.provider_match_id))) {
      const [m] = await tx<{ match_id: string }[]>`
        SELECT m.match_id FROM match m LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
         WHERE m.game_code = 'fconline' AND (m.match_id = ${input.provider_match_id} OR d.provider_match_id = ${input.provider_match_id}) FOR UPDATE OF m`;
      if (!m) throw new Error("선택한 경기를 찾지 못했습니다.");
      await assertFcoContextVersion(tx, m.match_id, input.expectedVersion);
    }
    const out: FcoContextOutcome = { provider_match_id: inputs[0].provider_match_id, actions: [], skipped: [] };
    for (const input of inputs) {
      const next = await applyFcoMatchContext({ ...input, expectedVersion: undefined }, { ...opts, createdBy: "admin", transaction: tx });
      out.actions.push(...next.actions); out.skipped.push(...next.skipped);
    }
    return out;
  });
}

// ── 조회 ─────────────────────────────────────────────────────────────

export interface FcoContextQueueRow {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  players: string;
  status: FcoContextStatus;
  /** 실제 행사에 있을 때만 — 자동 묶음은 행사가 아니다. */
  event_name: string | null;
  event_format: Format | null;
  judgment_note: string | null;
  /** 최신 메모의 주체. 'auto' 면 승인 대기 후보다. */
  judgment_by: string | null;
  /** 대회·분류 판단을 확인했나 (match.context_review_completed_at). 조사 완료와는 별개다. */
  confirmed: boolean;
  evidence_count: number;
}

/**
 * 공개 스트리머 간 1:1 경기의 맥락 큐. 미조사가 곧 조사 후보다.
 * ⚠ status 는 fcoContextStatus 하나로 정한다. 여기서 다른 우선순위를 만들지 않는다.
 */
export async function listFcoContextQueue(
  opts: { from?: string; to?: string; streamer?: string; status?: FcoContextStatus } = {},
): Promise<FcoContextQueueRow[]> {
  const sql = db();
  const rows = await sql<{
    provider_match_id: string; match_id: string; played_at: string; mode_key: string | null;
    players: string; event_id: string | null; auto_bucket: boolean | null; event_name: string | null; event_format: Format | null;
    note: string | null; note_by: string | null; confirmed: boolean; evidence_count: number;
  }[]>`
    SELECT d.provider_match_id, m.match_id, m.game_creation AS played_at, m.mode_key,
           string_agg(s.slug || '(' || p.outcome || ' ' || coalesce(coalesce(p.score_display, p.goals)::text, '?') || ')',
                      ' vs ' ORDER BY p.side_no) AS players,
           e.id AS event_id, e.auto_bucket, e.name AS event_name, e.format AS event_format,
           ctx.note, ctx.note_by,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           (SELECT count(*)::int FROM fco_context_evidence fe WHERE fe.match_id = m.match_id) AS evidence_count
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      JOIN fco_match_participant p ON p.match_id = m.match_id
      JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
      ${sql.unsafe(FCO_PLACEMENT_JOIN)}
      ${sql.unsafe(FCO_LATEST_NOTE_LATERAL)}
     WHERE m.game_code = 'fconline'
       AND (${opts.from ?? null}::text IS NULL OR m.game_creation >= (${opts.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Seoul'))
       AND (${opts.to ?? null}::text IS NULL OR m.game_creation < ((${opts.to ?? null}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Seoul'))
       AND (${opts.streamer ?? null}::text IS NULL OR EXISTS (
             SELECT 1 FROM fco_match_participant mine JOIN streamer ms2 ON ms2.id = mine.streamer_id
              WHERE mine.match_id = m.match_id AND ms2.slug = ${opts.streamer ?? null}))
     GROUP BY d.provider_match_id, m.match_id, e.id, ctx.note, ctx.note_by
    HAVING count(*) = 2
     ORDER BY m.game_creation DESC
  `;
  const mapped = rows.map((r): FcoContextQueueRow => {
    const status = fcoContextStatus(r, r.note);
    return {
      provider_match_id: r.provider_match_id, match_id: r.match_id, played_at: r.played_at, mode_key: r.mode_key,
      players: r.players, status,
      event_name: status === "event" ? r.event_name : null, event_format: status === "event" ? r.event_format : null,
      judgment_note: r.note, judgment_by: r.note_by, confirmed: r.confirmed, evidence_count: r.evidence_count,
    };
  });
  return opts.status ? mapped.filter((r) => r.status === opts.status) : mapped;
}

export interface FcoContextDetail {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  status: FcoContextStatus;
  /** 대회·분류 판단을 확인했나 (match.context_review_completed_at). */
  confirmed: boolean;
  /** 실제 행사에 있을 때만. 자동 묶음이면 null(분류 전). */
  event: { slug: string | null; name: string; format: Format; source_url: string | null } | null;
  participants: { slug: string | null; nickname: string; outcome: string; score: number | null }[];
  /** 판단 메모 이력(최신부터) — review_change. */
  history: { judgment: string; note: string; created_by: string; created_at: string }[];
  evidences: {
    evidence_key: string; kind: string; vod_title_no: number | null; channel_id: string | null;
    at_sec: number | null; end_sec: number | null; url: string | null; frame_path: string | null;
    role: FcoEvidenceRole | null;
    observed: string; why: string | null; created_by: string;
  }[];
}

export async function getFcoContextDetail(ref: string): Promise<FcoContextDetail | null> {
  const sql = db();
  const [game] = await sql<{
    match_id: string; provider_match_id: string | null; played_at: string; mode_key: string | null; confirmed: boolean;
    event_id: string | null; auto_bucket: boolean | null; slug: string | null; name: string | null; format: Format | null; source_url: string | null;
  }[]>`
    SELECT m.match_id, d.provider_match_id, m.game_creation AS played_at, m.mode_key,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           e.id AS event_id, e.auto_bucket, e.slug, e.name, e.format, e.source_url
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      ${sql.unsafe(FCO_PLACEMENT_JOIN)}
     WHERE (d.provider_match_id = ${ref} OR m.match_id = ${ref}) AND m.game_code = 'fconline'
  `;
  if (!game) return null;
  const participants = await sql<{ slug: string | null; nickname: string; outcome: string; score: number | null }[]>`
    SELECT s.slug, p.nickname, p.outcome, coalesce(p.score_display, p.goals) AS score
      FROM fco_match_participant p
      LEFT JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
     WHERE p.match_id = ${game.match_id} ORDER BY p.side_no
  `;
  const history = await sql<{ judgment: string; note: string; created_by: string; created_at: string }[]>`
    SELECT after->>'judgment' AS judgment, after->>'note' AS note, actor AS created_by, changed_at AS created_at
      FROM review_change
     WHERE match_id = ${game.match_id} AND entity = 'classification' AND field = ${FCO_CONTEXT_NOTE_FIELD}
     ORDER BY changed_at DESC, id DESC
  `;
  const evidences = await sql<FcoContextDetail["evidences"]>`
    SELECT evidence_key, kind, vod_title_no::int AS vod_title_no, channel_id, at_sec, end_sec, url,
           frame_path, role, observed, why, created_by
      FROM fco_context_evidence WHERE match_id = ${game.match_id} ORDER BY created_at
  `;
  const status = fcoContextStatus(game, history[0]?.note);
  return {
    provider_match_id: game.provider_match_id ?? game.match_id,
    match_id: game.match_id,
    played_at: game.played_at,
    mode_key: game.mode_key,
    status,
    confirmed: game.confirmed,
    event: status === "event" ? { slug: game.slug, name: game.name!, format: game.format!, source_url: game.source_url } : null,
    participants,
    history,
    evidences,
  };
}

/**
 * 검수 승인 — 조사(auto)의 현재 판단을 사람이 확인했다는 도장.
 *
 * 하는 일 두 가지뿐이다:
 *   1. 실제 행사 밖이고 최신 메모가 auto 면 같은 메모를 admin 으로 다시 남긴다 → 이후 자동 메모가 못 덮는다.
 *   2. 맥락 확인 도장(context_review_completed_at)을 찍는다 → 큐에서 「확인됨」이 된다.
 * 승인할 것이 없으면(미조사) 거부한다 — 도장은 조사를 대신하지 못한다.
 */
export async function approveFcoContext(ref: string, expectedVersion?: number): Promise<FcoContextOutcome> {
  const out: FcoContextOutcome = { provider_match_id: ref, actions: [], skipped: [] };
  await db().begin(async (tx) => {
    const game = await lockGame(tx, ref);
    if (!game) throw new Error(`수집되지 않은 경기입니다: ${ref}`);
    await assertFcoContextVersion(tx, game.match_id, expectedVersion);
    const latest = await latestNote(tx, game.match_id);
    const status = fcoContextStatus(game, latest?.note);
    if (status === "uninvestigated") {
      throw new Error("승인할 판단이 없다 — 미조사 경기다. 먼저 조사(fco-match-context)가 제안을 남겨야 한다");
    }
    if (status === "unresolved" && latest) {
      if (latest.created_by === "admin") out.skipped.push("판단 — 이미 admin 판단이다");
      else {
        await recordNote(tx, game.match_id, latest.judgment, latest.note, "admin", out);
        if (out.actions.at(-1)?.startsWith("판단 기록")) out.actions[out.actions.length - 1] = `판단 승인 ${latest.judgment} — 자동 반영이 못 덮는다`;
      }
    }
    if (await stampFcoContextReview(tx, game.match_id)) out.actions.push("대회·분류 판단 확정");
    else out.skipped.push("확인 도장 — 이미 찍혀 있다");
  });
  return out;
}

/**
 * 확인 도장 — 두 칸을 같이 찍는다. LoL 과 뜻이 같다(0043).
 *   reviewed_at          자동 조사가 덮지 못하게 하는 보호
 *   review_completed_at  사람이 확인해 끝냈다는 완료 (큐의 「확인됨」·화면 경기의 「완료」가 읽는 것)
 * FC 는 한동안 reviewed_at 하나에 두 뜻을 담았다. 한 곳에서만 찍어 다시 갈라지지 않게 한다.
 * @returns 완료가 새로 찍혔으면 true (이미 완료였으면 false)
 */
export async function stampFcoReview(tx: Tx, matchId: string): Promise<boolean> {
  const rows = await tx<{ match_id: string }[]>`
    UPDATE match
       SET reviewed_at = COALESCE(reviewed_at, now()),
           review_completed_at = COALESCE(review_completed_at, now())
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND review_completed_at IS NULL
    RETURNING match_id`;
  if (rows.length) return true;
  await tx`UPDATE match SET reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId} AND game_code = 'fconline'`;
  return false;
}

// ── 검수 작업대 — 행사 단위로 묶어서 본다 ────────────────────────────

/** Context confirmation is independent from match-value review and automatic value protection. */
export async function stampFcoContextReview(tx: Tx, matchId: string): Promise<boolean> {
  const rows = await tx<{ match_id: string }[]>`
    UPDATE match SET context_review_completed_at = now(), context_review_version = context_review_version + 1
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND context_review_completed_at IS NULL RETURNING match_id`;
  return rows.length > 0;
}

export interface FcoWorkspaceMatch {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  confirmed: boolean;
  context_version: number;
  value_completed: boolean;
  /** 판이 놓인 시리즈. 한 판짜리(`set:<id>`)도 시리즈다. 승패는 세트에서 파생한다(tally.ts). */
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  /** 대회 안의 위치("8강 2경기") — 시리즈 칸. */
  round_label: string | null;
  participants: { ouid: string; name: string; slug: string | null; outcome: string; score: number | null }[];
  /**
   * 이 단위(행사)에서의 포함/제외 — 소속이 곧 포함이고, 제외는 event_exclusion(현재 제약)이다.
   * 둘 다 없으면 null(행사 기간 안에 있어 후보로 올라온 미정 경기).
   */
  decision: "include" | "exclude" | null;
  /** 제외면 그 제외를 한 주체, 포함이면 사람이 확정했나(확정 = admin). 미정이면 null. */
  decision_by: Actor | null;
  decision_note: string | null;
}

export interface FcoWorkspaceEvidence {
  evidence_key: string;
  provider_match_id: string;
  kind: string;
  vod_title_no: number | null;
  channel_id: string | null;
  at_sec: number | null;
  end_sec: number | null;
  url: string | null;
  frame_path: string | null;
  role: FcoEvidenceRole | null;
  observed: string;
  why: string | null;
  created_by: string;
}

/**
 * 검수 단위 — 실제 행사로 결론난 경기는 **행사 하나가 한 단위**다. 검수자는 대회의
 * 시작부터 끝까지 프레임을 넘기며 전체 맥락을 보고 한 번에 승인한다.
 * 실제 행사에 안 붙은 경기(자동 묶음)는 경기 하나가 한 단위다.
 */
export interface FcoReviewUnit {
  /** 'event:<uuid>' | 'match:<providerMatchId>' */
  id: string;
  kind: "event" | "match";
  title: string;
  status: FcoContextStatus;
  /** 단위 전체가 확인됨 — 행사면 소속 경기 전부. */
  confirmed: boolean;
  /** 제안이 있는데 확인 도장이 없다 — 검수가 할 일. */
  pending: boolean;
  event: {
    id: string; slug: string | null; name: string; format: Format; organizer: string | null; source_url: string | null;
    starts_at: string | null; ends_at: string | null; admin_version: number;
  } | null;
  judgment: { judgment: string; note: string; created_by: string; created_at: string } | null;
  /** 행사면 포함 → 미정 → 제외 순. 제외한 경기도 사라지지 않고 남는다. */
  matches: FcoWorkspaceMatch[];
  /** 단위의 모든 근거 — VOD·초 순. 프레임을 순서로 넘기면 시간 흐름이 된다. */
  evidences: FcoWorkspaceEvidence[];
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getFcoReviewWorkspace(
  /** 하나만 열 때 좁힌다 — 작업대는 단위 하나만 읽는다(2층 구조). */
  opts: { eventId?: string; providerMatchId?: string; onlyEvents?: boolean } = {},
): Promise<FcoReviewUnit[]> {
  const sql = db();
  if (opts.eventId && !UUID.test(opts.eventId)) return [];
  let targetEvent = opts.eventId;
  let targetMatch: string | undefined;
  if (opts.providerMatchId) {
    // 경기로 열면 그 경기의 실제 행사, 없으면 가장 최근에 제외된 행사(뺀 판도 그 행사 단위에서 보인다).
    const [r] = await sql<{ match_id: string; event_id: string | null }[]>`
      SELECT m.match_id,
             COALESCE(CASE WHEN NOT e.auto_bucket THEN e.id END,
                      (SELECT x.event_id FROM event_exclusion x WHERE x.match_id = m.match_id ORDER BY x.decided_at DESC LIMIT 1)) AS event_id
        FROM match m LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
        ${sql.unsafe(FCO_PLACEMENT_JOIN)}
       WHERE m.game_code = 'fconline' AND (d.provider_match_id = ${opts.providerMatchId} OR m.match_id = ${opts.providerMatchId})`;
    if (!r) return [];
    targetMatch = r.match_id; targetEvent = r.event_id ?? undefined;
  }
  // ── 대회 후보. 소속 경기만이 아니다 — 뺀 경기도(제외 표), 행사 기간 안인데 아직 아무도
  //    안 정한 경기도(그 행사 참가자가 뛴 판) 후보로 남아야 「안 붙인 건지 뺀 건지」가 보인다.
  const exclusions = await sql<{ event_id: string; match_id: string; decided_by: Actor; note: string | null; decided_at: Date }[]>`
    SELECT x.event_id, x.match_id, x.decided_by, x.note, x.decided_at
      FROM event_exclusion x JOIN event e ON e.id = x.event_id AND e.game_code = 'fconline'
     WHERE ${targetEvent ? sql`x.event_id = ${targetEvent}::uuid` : sql`true`}`;
  const windowed = await sql<{ event_id: string; match_id: string }[]>`
    WITH linked AS (
      SELECT ms.event_id, m.match_id
        FROM match m JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
        JOIN event e ON e.id = ms.event_id AND NOT e.auto_bucket
       WHERE m.game_code = 'fconline'
    ), roster AS (
      SELECT DISTINCT l.event_id, p.streamer_id FROM linked l
        JOIN fco_match_participant p ON p.match_id = l.match_id
       WHERE p.streamer_id IS NOT NULL
    )
    SELECT ev.id AS event_id, m.match_id
      FROM event ev
      JOIN match m ON m.game_code = 'fconline' AND m.game_creation BETWEEN ev.starts_at AND ev.ends_at
      ${sql.unsafe(FCO_PLACEMENT_JOIN)}
     WHERE ev.game_code = 'fconline' AND NOT ev.auto_bucket AND ${targetEvent ? sql`ev.id = ${targetEvent}::uuid` : sql`true`}
       AND ev.starts_at IS NOT NULL AND ev.ends_at IS NOT NULL
       AND (e.id IS NULL OR e.auto_bucket)
       AND NOT EXISTS (SELECT 1 FROM event_exclusion x WHERE x.event_id = ev.id AND x.match_id = m.match_id)
       AND EXISTS (SELECT 1 FROM fco_match_participant p
                     JOIN roster r ON r.streamer_id = p.streamer_id AND r.event_id = ev.id
                    WHERE p.match_id = m.match_id)
  `;
  if (!targetEvent && targetMatch) targetEvent = windowed.find(w => w.match_id === targetMatch)?.event_id;
  const candidateIds = [...new Set([...exclusions.map((d) => d.match_id), ...windowed.map((w) => w.match_id)])];

  // 실제 행사에 붙은 경기는 매핑과 무관하게 전부 보여 준다 — 대회 흐름에 구멍을 내지 않는다.
  // 행사가 없는 경기는 공개 스트리머 간 1:1 만 검수 대상이다(큐와 같은 기준).
  const matches = await sql<{
    provider_match_id: string; match_id: string; played_at: Date; mode_key: string | null;
    confirmed: boolean; context_version: number; value_completed: boolean; event_id: string | null;
    series_id: string | null; series_game_no: number | null; best_of: number | null; round_label: string | null;
    note_judgment: string | null; note: string | null; note_by: string | null; note_at: Date | null;
    participants: FcoWorkspaceMatch["participants"];
    public_n: number;
  }[]>`
    SELECT COALESCE(d.provider_match_id, m.match_id) AS provider_match_id, m.match_id, m.game_creation AS played_at, m.mode_key,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           m.context_review_version AS context_version, (m.review_completed_at IS NOT NULL) AS value_completed,
           CASE WHEN NOT e.auto_bucket THEN e.id END AS event_id,
           m.series_id, m.series_game_no, ms.best_of, ms.round_label,
           ctx.note_judgment, ctx.note, ctx.note_by, ctx.note_at,
           parts.list AS participants, parts.public_n
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      ${sql.unsafe(FCO_PLACEMENT_JOIN)}
      ${sql.unsafe(FCO_LATEST_NOTE_LATERAL)}
      CROSS JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 -- 화면에 쓰는 이름은 display_name 이다. slug 는 링크·필터용으로 같이 준다.
                 'ouid', p.ouid,
                 'name', coalesce(s.display_name, p.nickname), 'slug', s.slug,
                 'outcome', p.outcome, 'score', coalesce(p.score_display, p.goals))
                 ORDER BY p.side_no) AS list,
               count(s.id)::int AS public_n
          FROM fco_match_participant p
          LEFT JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
         WHERE p.match_id = m.match_id
      ) parts
     WHERE m.game_code = 'fconline'
       AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
       AND ${targetEvent ? sql`((NOT e.auto_bucket AND e.id = ${targetEvent}::uuid) OR m.match_id = ANY(${candidateIds}))`
         : targetMatch ? sql`m.match_id = ${targetMatch}`
         : opts.onlyEvents ? sql`((e.id IS NOT NULL AND NOT e.auto_bucket) OR m.match_id = ANY(${candidateIds}))` : sql`true`}
       AND ((e.id IS NOT NULL AND NOT e.auto_bucket) OR parts.public_n = 2 OR m.match_id = ANY(${candidateIds}))
     ORDER BY m.game_creation
  `;

  // 경기 → 단위 행사. 소속이 우선이고, 없으면 가장 최근 제외의 행사, 그것도 없으면 기간이 겹친 행사.
  const exclusionsByMatch = new Map<string, (typeof exclusions)[number][]>();
  for (const d of exclusions) {
    if (!exclusionsByMatch.has(d.match_id)) exclusionsByMatch.set(d.match_id, []);
    exclusionsByMatch.get(d.match_id)!.push(d);
  }
  const windowByMatch = new Map(windowed.map((w) => [w.match_id, w.event_id]));
  const unitEventOf = (m: (typeof matches)[number]): string | null => {
    if (targetEvent && (m.event_id === targetEvent || exclusionsByMatch.get(m.match_id)?.some(d => d.event_id === targetEvent) || windowed.some(w => w.match_id === m.match_id && w.event_id === targetEvent))) return targetEvent;
    if (m.event_id) return m.event_id;
    const ds = exclusionsByMatch.get(m.match_id);
    if (ds?.length) return [...ds].sort((a, b) => b.decided_at.getTime() - a.decided_at.getTime())[0].event_id;
    return windowByMatch.get(m.match_id) ?? null;
  };

  const matchIds = matches.map((m) => m.match_id);
  const eventIds = [...new Set(matches.map(unitEventOf).filter((v): v is string => v != null))];
  const events = eventIds.length ? await sql<{
    id: string; slug: string | null; name: string; format: Format; organizer: string | null; source_url: string | null;
    starts_at: Date | null; ends_at: Date | null; admin_version: number;
  }[]>`SELECT id, slug, name, format, organizer, source_url, starts_at, ends_at, admin_version
         FROM event WHERE id = ANY(${eventIds}::uuid[])` : [];
  const evidences = matchIds.length ? await sql<(FcoWorkspaceEvidence & { match_id: string })[]>`
    SELECT fe.evidence_key, COALESCE(d.provider_match_id, fe.match_id) AS provider_match_id, fe.match_id, fe.kind,
           fe.vod_title_no::int AS vod_title_no, fe.channel_id, fe.at_sec, fe.end_sec,
           fe.url, fe.frame_path, fe.role, fe.observed, fe.why, fe.created_by
      FROM fco_context_evidence fe
      LEFT JOIN fco_match_detail d ON d.match_id = fe.match_id
     WHERE fe.match_id = ANY(${matchIds})
     ORDER BY fe.vod_title_no NULLS LAST, fe.at_sec NULLS LAST, fe.evidence_key
  ` : [];
  const evidenceByMatch = new Map<string, FcoWorkspaceEvidence[]>();
  for (const evidence of evidences) {
    if (!evidenceByMatch.has(evidence.match_id)) evidenceByMatch.set(evidence.match_id, []);
    evidenceByMatch.get(evidence.match_id)!.push(evidence);
  }

  const toMatch = (m: (typeof matches)[number], eventId: string | null): FcoWorkspaceMatch => {
    const ex = eventId ? exclusionsByMatch.get(m.match_id)?.find((x) => x.event_id === eventId) : undefined;
    const included = eventId != null && m.event_id === eventId;
    return {
      provider_match_id: m.provider_match_id, match_id: m.match_id, played_at: iso(m.played_at),
      mode_key: m.mode_key, confirmed: m.confirmed, context_version: m.context_version, value_completed: m.value_completed,
      series_id: m.series_id, series_game_no: m.series_game_no, best_of: m.best_of, round_label: m.round_label,
      participants: m.participants ?? [],
      decision: included ? "include" : ex ? "exclude" : null,
      decision_by: included ? (m.confirmed ? "admin" : "auto") : ex ? ex.decided_by : null,
      decision_note: included ? null : ex?.note ?? null,
    };
  };
  // 포함(세트 순 → 시각) → 미정 → 제외.
  const rank = (x: FcoWorkspaceMatch) => (x.decision === "include" ? 0 : x.decision === null ? 1 : 2);
  const order = (a: FcoWorkspaceMatch, b: FcoWorkspaceMatch) => rank(a) - rank(b) || a.played_at.localeCompare(b.played_at);

  const units: FcoReviewUnit[] = [];
  for (const event of events) {
    const mine = matches.filter((m) => unitEventOf(m) === event.id).map((m) => toMatch(m, event.id)).sort(order);
    const unitEvidences = mine.flatMap((m) => evidenceByMatch.get(m.match_id) ?? []);
    const confirmed = mine.length > 0 && mine.every((m) => m.decision != null && m.confirmed);
    units.push({
      id: `event:${event.id}`, kind: "event",
      title: event.name, status: "event",
      confirmed,
      pending: !confirmed,
      event: { ...event, starts_at: event.starts_at ? iso(event.starts_at) : null, ends_at: event.ends_at ? iso(event.ends_at) : null },
      judgment: null,
      matches: mine,
      evidences: unitEvidences,
    });
  }
  for (const m of matches.filter((m) => !unitEventOf(m) && m.public_n === 2)) {
    const status = fcoContextStatus({ event_id: m.event_id, auto_bucket: m.event_id ? false : true }, m.note);
    units.push({
      id: `match:${m.provider_match_id}`, kind: "match",
      title: (m.participants ?? []).map((p) => p.name).join(" vs "),
      status,
      confirmed: m.confirmed,
      pending: status !== "uninvestigated" && !m.confirmed,
      event: null,
      judgment: m.note ? {
        judgment: m.note_judgment ?? "unresolved", note: m.note, created_by: m.note_by ?? "auto", created_at: iso(m.note_at),
      } : null,
      matches: [toMatch(m, null)],
      evidences: evidenceByMatch.get(m.match_id) ?? [],
    });
  }
  // 최근 것이 위. 행사는 마지막 경기 기준.
  const lastPlayed = (u: FcoReviewUnit) => u.matches.map((m) => m.played_at).sort().at(-1) ?? "";
  const sorted = units.sort((a, b) => lastPlayed(b).localeCompare(lastPlayed(a)));
  // 좁히기 — 경기로 열면 그 경기가 속한 단위(행사면 행사 전체)를 준다.
  if (opts.eventId) return sorted.filter((u) => u.id === `event:${opts.eventId}`);
  if (opts.providerMatchId) return sorted.filter((u) => u.matches.some((m) => m.provider_match_id === opts.providerMatchId || m.match_id === opts.providerMatchId));
  return sorted;
}

// ── 대회 후보의 포함/제외 결정 ─────────────────────────────────────────

export interface FcoEventDecisionInput {
  eventId: string;
  providerMatchId: string;
  expectedVersion?: number;
  decision: "include" | "exclude";
  /** 제외에는 필수 — 왜 뺐는지가 남아야 되돌릴 수 있다. */
  note?: string | null;
}

/**
 * 경기 하나를 대회에 넣거나 뺀다.
 *   include  판을 그 행사로 옮긴다(한 판짜리 시리즈 — 여러 판 시리즈는 시리즈째, 자동 묶음에 있을 때만). 사람이 넣으면 그 행사의 제외가 풀린다.
 *   exclude  event_exclusion 에 남기고(현재 제약), 판이 그 행사에 있으면 그날 두 사람 자동 묶음으로 되돌린다.
 * 사람(admin)이 뺀 것은 자동 경로가 못 넣는다(⏭). 사람이 확정한 판(맥락 확인 도장)은 자동 경로가 빼지 않는다(⏭).
 * 사람이 정하면 그 경기에 맥락 확인 도장도 찍힌다.
 */
export async function decideFcoEventMatch(
  input: FcoEventDecisionInput,
  opts: { createdBy?: Actor } = {},
): Promise<FcoContextOutcome> {
  const actor = opts.createdBy ?? "auto";
  const out: FcoContextOutcome = { provider_match_id: input.providerMatchId, actions: [], skipped: [] };
  const note = input.note?.trim() || null;
  if (input.decision === "exclude" && !note) throw new Error("제외에는 이유가 필요하다 — 왜 대회 경기가 아닌지 적는다");
  await db().begin(async (tx) => {
    const game = await lockGame(tx, input.providerMatchId);
    if (!game) throw new Error(`수집되지 않은 경기입니다: ${input.providerMatchId}`);
    await assertFcoContextVersion(tx, game.match_id, input.expectedVersion);
    const [ev] = await tx<{ slug: string | null; game_code: string; auto_bucket: boolean }[]>`
      SELECT slug, game_code, auto_bucket FROM event WHERE id = ${input.eventId}::uuid`;
    if (!ev) throw new Error("행사를 찾을 수 없다");
    if (ev.game_code !== "fconline") throw new Error("FC 행사가 아니다");
    if (ev.auto_bucket) throw new Error("자동 미분류 묶음은 포함·제외의 대상이 아니다 — 실제 행사를 고른다");

    const here = game.event_id === input.eventId;
    if (input.decision === "include") {
      if (actor === "auto" && await humanExcludedAmong(tx, input.eventId, [game.match_id])) {
        out.skipped.push("결정 — 사람이 이 행사에서 제외한 경기다. 자동 반영이 되돌리지 않는다");
        return;
      }
      if (here) {
        // 사람이 포함을 다시 확인하면 남아 있던 자동 제외도 정리된다(같은 판단의 최신값).
        if (actor === "admin") await assertAttachAllowedInTx(tx, input.eventId, [game.match_id], "admin");
        out.skipped.push("결정 — 이미 이 행사 경기다 (멱등)");
      } else {
        if (game.event_id && game.auto_bucket === false && actor !== "admin") throw new Error("경기가 이미 다른 행사에 연결돼 있다 — 옮기는 것은 사람이 한다");
        if (game.series_id && game.sets > 1 && game.auto_bucket === false) throw new Error("이 경기의 다전제가 다른 행사에 붙어 있다 — 시리즈 단위로 옮겨라");
        if (game.series_id) await moveSeriesInTx(tx, { series_id: game.series_id, event_id: input.eventId, actor });
        else await placeSingleSetInTx(tx, { match_id: game.match_id, game_code: "fconline", event_id: input.eventId, actor });
        out.actions.push(`포함 결정 (${actor}) — ${game.event_id && game.auto_bucket === false ? "다른 행사에서 옮겨 연결" : "행사 연결"}`);
      }
    } else {
      if (actor === "auto") {
        const [ex] = await tx<{ decided_by: Actor }[]>`
          SELECT decided_by FROM event_exclusion WHERE event_id = ${input.eventId}::uuid AND match_id = ${game.match_id}`;
        const [m] = await tx<{ confirmed: boolean }[]>`SELECT context_review_completed_at IS NOT NULL AS confirmed FROM match WHERE match_id = ${game.match_id}`;
        if (ex?.decided_by === "admin" || (here && m.confirmed)) {
          out.skipped.push("결정 — 사람이 정한 경기라 자동 반영이 덮지 않는다");
          return;
        }
      }
      if (here) {
        if (game.series_id && game.sets > 1) throw new Error("다전제의 한 세트만 뺄 수 없다 — 시리즈 단위로 정한다");
        const pair = await fcoPairOf(tx, game.match_id);
        if (!pair) {
          throw new Error("스트리머 두 사람의 판이 아니라 돌아갈 자동 묶음이 없다 — 개인 기록으로 되돌리는 길이 아직 없다(관리자에게 알린다)");
        }
        const bucket = await ensureFcoPairBucketInTx(tx, pair);
        await excludeFromEventInTx(tx, { event_id: input.eventId, match_id: game.match_id, actor, note });
        await moveSeriesInTx(tx, { series_id: game.series_id!, event_id: bucket, actor });
        out.actions.push(`제외 결정 (${actor}) — 행사에서 빼 그날 두 사람 묶음(분류 전)으로 되돌림`);
      } else {
        await excludeFromEventInTx(tx, { event_id: input.eventId, match_id: game.match_id, actor, note });
        out.actions.push(`제외 결정 (${actor})`);
      }
      await invalidateContextReview(tx, game.match_id);
    }
    // 포함·제외 판단만 확정한다. 경기값 검수 상태는 변경하지 않는다.
    if (actor === "admin") await stampFcoContextReview(tx, game.match_id);
  });
  return out;
}

/** 행사 정보 수정 — 검수 화면 [대회] 탭. 사람이 명시적으로 고치는 경로다(자동 묶음은 고치지 않는다 — classification.ts 가 거부). */
export async function updateFcoEvent(eventId: string, patch: {
  name?: string; format?: string; organizer?: string | null; source_url?: string | null; expectedVersion?: number;
}): Promise<void> {
  if (patch.name != null && !patch.name.trim()) throw new Error("행사 이름은 비울 수 없다");
  if (patch.format != null && (!isFormat(patch.format) || !allowedFormat("fconline", patch.format))) {
    throw new Error(`FC 행사의 진행 방식으로 ${patch.format} 은 쓸 수 없다`);
  }
  if (!UUID.test(eventId)) throw new Error("행사 정보가 변경되었거나 삭제되었습니다. 새로고침 후 다시 확인해 주세요.");
  await db().begin(async (tx) => {
    const [row] = await tx<{ slug: string | null; admin_version: number }[]>`
      SELECT slug, admin_version FROM event WHERE id = ${eventId}::uuid AND game_code = 'fconline' FOR UPDATE`;
    if (!row || (patch.expectedVersion !== undefined && row.admin_version !== patch.expectedVersion)) {
      throw new Error("행사 정보가 변경되었거나 삭제되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
    if (!row.slug) throw new Error("slug 없는 행사는 고칠 수 없다");
    await updateEventInTx(tx, row.slug, {
      ...(patch.name != null ? { name: patch.name.trim() } : {}),
      ...(patch.format != null ? { format: patch.format as Format } : {}),
      ...(patch.organizer !== undefined ? { organizer: patch.organizer?.trim() || null } : {}),
      ...(patch.source_url !== undefined ? { source_url: patch.source_url?.trim() || null } : {}),
    });
  });
}

/**
 * 승인 해제(보류) — 확인 도장만 뗀다.
 * ⚠ 판단 메모 이력(review_change)은 지우지 않는다. 승인 때 admin 으로 다시 남긴 메모는 그대로 남는다 —
 *   「사람이 한 번 봤다」는 사실이 사라지면 안 되기 때문이다. 판단 자체를 되돌리려면 새 판단을 기록한다(그게 이력이다).
 */
export async function holdFcoContext(ref: string, expectedVersion?: number): Promise<FcoContextOutcome> {
  return db().begin(async tx => {
    const [m] = await tx<{ match_id: string }[]>`SELECT m.match_id FROM match m LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      WHERE m.game_code = 'fconline' AND (m.match_id = ${ref} OR d.provider_match_id = ${ref}) FOR UPDATE OF m`;
    if (!m) throw new Error("경기를 찾지 못했습니다.");
    await assertFcoContextVersion(tx, m.match_id, expectedVersion);
    const rows = await tx`UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
      WHERE match_id = ${m.match_id} AND context_review_completed_at IS NOT NULL RETURNING match_id`;
    return { provider_match_id: ref, actions: rows.length ? ["대회·분류 확정 해제"] : [], skipped: rows.length ? [] : ["이미 대기 상태입니다."] };
  });
}

export type FcoContextSnapshot = Record<string, number>;
/** 행사 단위의 판단 대상 — 그 행사 소속 판 + 그 행사에서 뺀 판(화면 기록 시점은 빼고 정본만). */
async function eventContextMatches(tx: Tx, eventId: string, expected?: FcoContextSnapshot) {
  const rows = await tx<{ match_id: string; included: boolean; context_review_version: number }[]>`
    SELECT m.match_id, COALESCE(ms.event_id = ${eventId}::uuid, false) AS included, m.context_review_version
    FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    WHERE m.game_code = 'fconline'
      AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
      AND (ms.event_id = ${eventId}::uuid
      OR EXISTS (SELECT 1 FROM event_exclusion x WHERE x.event_id = ${eventId}::uuid AND x.match_id = m.match_id))
    ORDER BY m.match_id FOR UPDATE OF m`;
  if (expected) {
    if (rows.some(r => expected[r.match_id] !== r.context_review_version)
        || Object.keys(expected).some(id => !rows.some(r => r.match_id === id))) {
      throw new Error("대회 후보나 판단이 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
  }
  return rows;
}

/** Holds only the context confirmation, including explicit exclusions. */
export async function holdFcoEvent(eventId: string, expected?: FcoContextSnapshot): Promise<{ cleared: number }> {
  if (!UUID.test(eventId)) throw new Error("행사를 찾을 수 없다");
  return db().begin(async tx => {
    const ids = await eventContextMatches(tx, eventId, expected);
    const rows = await tx`UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
      WHERE match_id = ANY(${ids.map(r => r.match_id)}) AND context_review_completed_at IS NOT NULL RETURNING match_id`;
    return { cleared: rows.length };
  });
}

export interface FcoEventOption {
  id: string;
  slug: string | null;
  name: string;
  format: Format;
  organizer: string | null;
  source_url: string | null;
  games: number;
}

/** 검수 화면의 행사 선택지 — 공개 여부와 무관하게 FC **실제** 행사를 전부 준다(자동 묶음은 고를 행사가 아니다). */
export async function listFcoEventOptions(): Promise<FcoEventOption[]> {
  return db()<FcoEventOption[]>`
    SELECT e.id, e.slug, e.name, e.format, e.organizer, e.source_url,
           (SELECT count(*)::int FROM match m JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
             WHERE ms.event_id = e.id AND m.game_code = 'fconline') AS games
      FROM event e
     WHERE e.game_code = 'fconline' AND NOT e.auto_bucket
     ORDER BY e.starts_at DESC NULLS LAST, e.name
  `;
}

/**
 * 행사 단위 승인 — 포함·제외 판단을 확정한다. 경기값 완료와 보호 시각은 유지한다.
 * ★ 조사(auto)의 제외 제안은 사람의 제외로 굳힌다 — 사람이 안 건드린 판은 「조사대로 맞다」는 뜻이다.
 *   굳히지 않으면 다음 자동 조사가 그 판을 다시 넣을 수 있다. 포함은 소속 자체가 판단이라 굳힐 행이 없다(확인 도장이 확정이다).
 */
export async function approveFcoEvent(eventId: string, expected?: FcoContextSnapshot): Promise<{
  stamped: number; already: number; included: number; excluded: number; promoted: number;
}> {
  if (!UUID.test(eventId)) throw new Error("확정할 대회 판단이 없습니다.");
  return db().begin(async (tx) => {
    const decided = await eventContextMatches(tx, eventId, expected);
    if (!decided.length) throw new Error("확정할 대회 판단이 없습니다.");
    const autoExclusions = await tx<{ match_id: string; note: string | null }[]>`
      SELECT match_id, note FROM event_exclusion WHERE event_id = ${eventId}::uuid AND decided_by = 'auto'
         AND match_id = ANY(${decided.map(m => m.match_id)})`;
    for (const x of autoExclusions) await excludeFromEventInTx(tx, { event_id: eventId, match_id: x.match_id, actor: "admin", note: x.note });
    const [{ n: excluded }] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM event_exclusion WHERE event_id = ${eventId}::uuid AND match_id = ANY(${decided.map(m => m.match_id)})`;
    const stamped = await tx<{ match_id: string }[]>`
      UPDATE match SET context_review_completed_at = now(), context_review_version = context_review_version + 1
       WHERE match_id = ANY(${decided.map((r) => r.match_id)}) AND context_review_completed_at IS NULL
       RETURNING match_id`;
    return {
      stamped: stamped.length, already: decided.length - stamped.length, promoted: autoExclusions.length,
      included: decided.filter(m => m.included).length, excluded,
    };
  });
}

/**
 * 계정을 새로 연결한 사람의 경기 중, **이미 있는 실제 행사의 기간 안인데 행사에 안 붙은 것.**
 *
 * ★ 왜 있나 (2026-09-24): 뿌챔스 조사에서 서도일 계정을 나중에 연결했는데 대회 연결 목록을
 *   다시 만들지 않아 그의 대회 경기 2건이 통째로 빠졌다. 계정 연결과 행사 연결이 따로 놀면
 *   한쪽만 하고 끝나도 아무도 모른다. 판단은 하지 않는다 — 후보를 보여 줄 뿐이다(개막 전
 *   연습처럼 기간 안이어도 대회 경기가 아닌 판이 있다).
 */
export async function listUnlinkedInEventWindows(streamerSlug: string): Promise<{
  provider_match_id: string; played_at: string; players: string; event_slug: string; event_name: string;
}[]> {
  const sql = db();
  return sql`
    SELECT d.provider_match_id, m.game_creation AS played_at, ev.slug AS event_slug, ev.name AS event_name,
           (SELECT string_agg(coalesce(s2.display_name, p2.nickname), ' vs ' ORDER BY p2.side_no)
              FROM fco_match_participant p2 LEFT JOIN streamer s2 ON s2.id = p2.streamer_id
             WHERE p2.match_id = m.match_id) AS players
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      JOIN fco_match_participant me ON me.match_id = m.match_id
      JOIN streamer s ON s.id = me.streamer_id AND s.slug = ${streamerSlug}
      ${sql.unsafe(FCO_PLACEMENT_JOIN)}
      JOIN event ev ON ev.game_code = 'fconline' AND NOT ev.auto_bucket AND ev.starts_at IS NOT NULL AND ev.ends_at IS NOT NULL
                   AND m.game_creation BETWEEN ev.starts_at AND ev.ends_at
     WHERE m.game_code = 'fconline' AND (e.id IS NULL OR e.auto_bucket)
       -- 이미 뺀 경기는 할 일이 아니다.
       AND NOT EXISTS (SELECT 1 FROM event_exclusion x WHERE x.event_id = ev.id AND x.match_id = m.match_id)
     ORDER BY m.game_creation
  `;
}

// ── 교차 단서 — LoL 조사가 실제로 연 화면에서 FC 가 보였을 때 ──────────

export interface FcoCrossClueInput {
  vod_title_no: number;
  channel_id: string;
  /** VOD 전체 초. */
  at_sec: number;
  /** 실제로 본 것. 추측이 아니라 화면 내용. */
  observed: string;
  title?: string;
  /** 그 단서가 가리키는 방송 시각(대략이라도). 수집 시각을 넣지 않는다 — VOD 목록의 시각에서 계산한다. */
  observed_at: string;
  url?: string | null;
}

export interface FcoCrossClueRow {
  vod_title_no: number;
  channel_id: string | null;
  at_sec: number | null;
  observed: string;
  title: string;
  observed_at: string;
  state: string;
}

/** LoL 조사가 남긴 FC 교차 단서. 기본은 미처리(state=new)만 — 조사 후보에 합류시키는 입구다. */
export async function listFcoCrossClues(opts: { all?: boolean; who?: string; vod?: string; q?: string } = {}): Promise<FcoCrossClueRow[]> {
  const sql = db();
  return sql<FcoCrossClueRow[]>`
    -- ::int — postgres.js 는 bigint 를 문자열로 돌려준다. title_no 는 int4 로 충분하다.
    SELECT (raw ->> 'vod_title_no')::int AS vod_title_no, channel_id,
           (raw ->> 'at_sec')::int AS at_sec, raw ->> 'observed' AS observed,
           title, observed_at, state
      FROM event_lead
     WHERE source = 'fc_screen'
       AND (${opts.all ?? false} OR state = 'new')
       AND ${opts.vod ? sql`raw ->> 'vod_title_no' = ${opts.vod}` : sql`true`}
       AND ${opts.q ? sql`concat_ws(' ', title, raw ->> 'observed') ILIKE ${`%${opts.q}%`}` : sql`true`}
       AND ${opts.who ? sql`EXISTS (SELECT 1 FROM streamer_channel sc JOIN streamer st ON st.id = sc.streamer_id WHERE st.slug = ${opts.who} AND sc.channel_id = event_lead.channel_id)` : sql`true`}
     ORDER BY observed_at DESC
  `;
}

/** 이미 있으면 조용히 두 번 쌓지 않는다. 반환값이 false 면 기존 단서가 있었던 것이다. */
export async function addFcoCrossClue(input: FcoCrossClueInput): Promise<boolean> {
  if (!input.observed?.trim()) throw new Error("observed(본 것) 없이 교차 단서를 남기지 않는다");
  if (!input.observed_at) throw new Error("observed_at(방송 시각)이 필요하다 — VOD 목록의 시각에서 계산해 넣는다");
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO event_lead (source, source_key, url, channel_id, title, observed_at, raw)
    VALUES ('fc_screen', ${`fc:${input.vod_title_no}:${input.at_sec}`},
            ${input.url ?? `https://vod.sooplive.com/player/${input.vod_title_no}`},
            ${input.channel_id},
            ${input.title ?? `FC 화면 단서 — VOD ${input.vod_title_no}`},
            ${input.observed_at},
            ${sql.json({ vod_title_no: input.vod_title_no, at_sec: input.at_sec, observed: input.observed })})
    ON CONFLICT (source, source_key) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}

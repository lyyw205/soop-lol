/**
 * CK(내전) 조사 — VOD 스캔 단서(`event_lead`), 그 판단에 쓰인 프레임
 * (`match_evidence_frame`), 그 결과로 확정된 경기(`match`/`match_participant`)의 단일 출처.
 *
 * 새 수집 스킬과 검수 어드민(`/admin/ck`)이 이 모듈을 같이 쓴다 — 계산식은
 * packages/core 가 단일 출처라는 원칙(CLAUDE.md 6번)을 그대로 따른다.
 *
 * ★ 이 파이프라인의 계약 (docs/CK-COLLECTION.md · 0019 · 0020)
 *   1. **초안 단계가 없다.** 스킬이 판단하면 곧 DB 이고 곧 공개다.
 *      대신 검수 어드민이 **사후에 고칠 수 있어야** 한다 — 그게 규칙을 느슨하게 한 대가다.
 *   2. **사람이 만진 것은 자동 수집이 덮지 않는다** (`match.reviewed_at`).
 *   3. **제외는 삭제가 아니다** (`match.visibility='hidden'`). 복구와 재생성 방지가 공짜다.
 *   4. **원본 수정과 파생 갱신은 한 트랜잭션이다.** 중간에 실패하면 승패가 어긋난 채 남는다.
 */

import type postgres from "postgres";

import { db } from "./client.ts";
import { recomputeChampionStatsInTx, rederiveEncountersInTx } from "./ingest.ts";
// 참가자 불변식(챔피언 이름↔ID · 계정↔사람)은 나무위키 시드 경로와 **같은 것**을 쓴다.
import { assertIdentityAgrees, resolveChampion } from "./participant.ts";
import { ensureMatchSeries, validateBestOf } from "./series.ts";
import type { MatchOutcome } from "./types.ts";
// 「어디까지 봤나」 는 조사 도구와 저장 경로가 같은 계산을 써야 한다.
import { mergeRanges, subtractRanges } from "../metrics/ranges.ts";

import { REVIEW_PROGRESS_JOIN, type ReviewProgress } from "./review-progress.ts";
import { checkedReviewChanges, ReviewConflictError } from "./review-patch.ts";
export { ReviewConflictError } from "./review-patch.ts";

type Tx = postgres.TransactionSql;

// ── event_lead — VOD 스캔 단서 ──────────────────────────────────────

export type EventLeadSource = "vod_title" | "board_post" | "chat_notice" | "live_title" | "official_hub" | "manual";
/**
 * 단서가 이어진 경기들의 분류 = 그 경기가 속한 **event.kind** (대회가 없는 경기는 other).
 * ★ 단서에는 분류 칸이 없다(0035). 예전 event_lead.kind 는 "시트가 경기 화면을 감지" ·
 *   "조사자의 추정" · "검수 탭 기준" 을 한 칸에 겹쳐 담아 event.kind 와 따로 놀았다.
 */
export type LeadEventKind = "ck" | "scrim" | "tournament" | "showmatch" | "other";
export type EventLeadState = "new" | "confirmed" | "rejected" | "ignored";

/** 시간 구간 [시작초, 끝초]. VOD **전체** 시간축이다 (분할 파일 로컬 시각이 아니다). */
export type TimeRange = [number, number];

/**
 * VOD 하나를 **어떻게 훑었나**. `event_lead.raw.scan` 에 들어간다.
 *
 * ★ 왜 필요한가: "event_lead 에 행이 있으니 건너뛴다"로 재처리를 막으면 두 가지가 깨진다 —
 *   ① 옛 수집기가 넣어둔 **미판독** VOD 가 조사 완료로 오인되고,
 *   ② 중간에 실패한 VOD 를 다시 처리할 길이 없다.
 *   이건 승인 게이트가 아니라 **재시도와 누락 방지를 위한 실행 기록**이다.
 *   그래서 `state`(단서 분류)와 따로 둔다 — `state` 는 공개 여부가 아니다.
 *
 * ★★ **네 가지를 서로 다른 칸에 적는다** (docs/CK-RESEARCH-PLAN.md §5).
 *   요청한 범위 · 대표 샘플을 배치한 범위 · **실제로 연 지점** · 못 본 범위.
 *   한 칸에 뭉치면 "대표 샘플 몇 장을 봤다"가 "영상 전체를 정밀 확인했다"로 읽힌다.
 *   실제로 그렇게 읽혀서 놓친 구간이 생긴 이력이 있다.
 *
 * ★ `done` 은 **실행 상태**다 — 계획한 탐색을 하고 후보들의 현재 결론을 적었다는 뜻이고,
 *   미해결 후보가 남아 있어도 `done` 일 수 있다. "경기를 다 찾았다"가 아니다.
 */
export interface LeadScanState {
  status: "running" | "done" | "failed";
  /** 이번 실행에서 조사하기로 한 범위. 부분 범위만 돌렸는지 여기서 드러난다. */
  requested?: TimeRange[];
  /** 대표 화면을 배치한 범위. ⚠ 전 프레임을 봤다는 뜻이 아니다. */
  sampled?: TimeRange[];
  /** 계획한 탐색 지점(초)과, 조사 중 LLM 이 더 본 지점. 간격은 도구 기본값일 뿐이다. */
  probes?: { planned?: number[]; extra?: number[] };
  /** **실제로 열어서 본** 프레임 시각(초). 뽑은 장수가 아니라 **연** 장수다. */
  opened?: number[];
  /** 실제로 본문을 읽은 전사 구간. 파일 생성·키워드 검색은 읽은 것이 아니다. */
  transcript_read?: TimeRange[];
  /** 못 본 구간 — 프레임을 못 받았거나(HLS 가 시트보다 짧다) 전사가 실패한 자리. */
  failed?: TimeRange[];
  /** 무엇으로 후보를 찾았나. 둘 중 하나만 돌았을 수 있다. */
  signals?: ("pixel" | "asr" | "chat" | "frame")[];
  /** 처리 로직 버전. 규칙을 고쳤을 때 "다시 볼 것"을 이걸로 고른다. */
  version?: string;
  finished_at?: string;
  note?: string;
}

/**
 * 후보 하나 — **"이 구간을 조사했고 지금 결론은 이것이다"**.
 *
 * ★ 왜 경기 테이블이 아니라 여기인가: 후보는 경기가 될 수도, 안 될 수도, 아직 모를 수도
 *   있다. 그걸 `match` 로 만들면 "승자를 모르는 경기" 같은 행을 만들어야 하고, 그러려면
 *   없는 값을 지어내게 된다. 반대로 아무 데도 안 적으면 **조사했다는 사실 자체가 사라져서**
 *   다음 사람이 같은 구간을 처음부터 다시 판다.
 *
 * ★ `unresolved` 는 실패가 아니다. 결과 화면을 못 찾았거나 사람을 못 붙인 것도
 *   **조사 결과**이고, 시도한 범위와 남은 질문이 다음 조사의 출발점이 된다.
 */
export interface LeadCandidate {
  /** 관리자가 고친 후보는 자동 병합이 덮지 않는다. */
  reviewed_at?: string | null;
  /** 재실행에도 같은 후보를 가리키는 안정적인 id. 중복 생성을 막는 키다. */
  id: string;
  /** 이 후보가 가리키는 구간. */
  at: TimeRange;
  /** 무엇이 보였나 — 관찰한 것. 해석과 섞지 않는다. */
  observed?: string;
  /**
   * 지금 결론.
   *   `match`      경기로 반영했다 (`match_id` 를 채운다)
   *   `linked`     이미 있는 경기의 근거로 붙였다 (다른 시점에서 같은 판을 본 경우)
   *   `not_target` 우리 경기가 아니다 (시청·중계·다른 게임 등 — 이유를 적는다)
   *   `unresolved` 더 봐야 한다. 시도한 것과 남은 질문을 적는다
   */
  conclusion: "match" | "linked" | "not_target" | "unresolved";
  /** 왜 그렇게 봤나. 자유 서술이다 — 정형 문구·점수를 요구하지 않는다. */
  why?: string;
  /** 이 결론에 쓴 근거 프레임 id (`match_evidence_frame.id`). */
  evidence_frame_ids?: string[];
  /** `match`·`linked` 일 때 그 경기. */
  match_id?: string | null;
  /** `unresolved` 일 때 남은 질문. 다음 조사가 여기서 시작한다. */
  open_questions?: string[];
  /** 이 새 후보가 대신하는 부모 후보 id. 부모는 수정하지 않고 조사 이력으로 남긴다. */
  supersedes?: string;
}

export interface EventLeadRow {
  id: string;
  source: EventLeadSource;
  source_key: string;
  url: string | null;
  channel_id: string | null;
  streamer_id: string | null;
  title: string;
  observed_at: Date;
  raw: Record<string, unknown> & { scan?: LeadScanState; candidates?: LeadCandidate[] };
  state: EventLeadState;
  note: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 검수 목록의 경기 수와 데이터 채움 현황. */
export interface EventLeadListRow extends EventLeadRow, ReviewProgress {
  completed_count: number;
  /** 근거가 붙은 경기 수. */
  match_count: number;
  /** 이어진 경기들이 속한 대회의 분류(중복 없음). 비었으면 아직 경기에 안 이어진 단서다. */
  event_kinds: LeadEventKind[];
}

export interface EventLeadInput {
  source: EventLeadSource;
  source_key: string;
  url?: string | null;
  channel_id?: string | null;
  streamer_id?: string | null;
  title: string;
  observed_at: Date;
  raw?: Record<string, unknown>;
  state?: EventLeadState;
  note?: string | null;
}

/**
 * VOD 하나의 스캔 단서를 쌓거나 갱신한다. `(source, source_key)` 가 중복 방지 키다(0012)
 * — **같은 VOD 재처리 방지**가 이 키의 일이다.
 *
 * ⚠ **같은 경기 중복 생성 방지는 이 키가 못 한다.** 한 경기를 6명이 방송하면 lead 는 6개고
 *   match 는 1개여야 한다 — 그건 `upsertMatchFromScan` 이 같은 `match_id` 를 쓰는 것으로
 *   맞춘다. 반대로 VOD 하나에 경기가 여럿이므로 `event_lead.event_id` 를 그 VOD 전체의
 *   유일한 관계로 삼아서도 안 된다.
 */
export async function upsertEventLead(input: EventLeadInput): Promise<string> {
  return db().begin((tx) => upsertEventLeadInTx(tx, input)) as Promise<string>;
}

export async function upsertEventLeadInTx(tx: Tx, input: EventLeadInput): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    INSERT INTO event_lead
      (source, source_key, url, channel_id, streamer_id, title, observed_at, raw, state, note)
    VALUES
      (${input.source}, ${input.source_key}, ${input.url ?? null}, ${input.channel_id ?? null},
       ${input.streamer_id ?? null}, ${input.title}, ${input.observed_at},
       ${tx.json((input.raw ?? {}) as never)}, ${input.state ?? "new"}, ${input.note ?? null})
    ON CONFLICT (source, source_key) DO UPDATE SET
      url          = EXCLUDED.url,
      channel_id   = EXCLUDED.channel_id,
      streamer_id  = EXCLUDED.streamer_id,
      title        = EXCLUDED.title,
      observed_at  = EXCLUDED.observed_at,
      -- ★ 덮지 않고 **병합한다.** 통째로 덮으면 markLeadScan 이 적어 둔 실행 기록
      --   (raw.scan — 어디까지 훑었나)이 다음 단서 갱신 한 번에 사라지고, 그러면
      --   "다시 처리해야 하나" 를 판단할 근거가 없어진다. 새 값이 이긴다.
      raw          = event_lead.raw || EXCLUDED.raw,
      state        = EXCLUDED.state,
      note         = EXCLUDED.note
    RETURNING id
  `;
  return rows[0].id;
}

/**
 * 탐색 실행 기록을 갱신한다 — 단서 내용(제목·참가자)은 건드리지 않는다.
 *
 * ★★ 기본은 **누적**이다(`mode: "merge"`). 조사는 한 번에 안 끝난다 — 전 범위를 훑고,
 *    며칠 뒤 한 구간만 다시 파는 게 정상 흐름이다. 그런데 jsonb 의 `||` 는 최상위 키를
 *    **통째로 교체**하므로, 부분 재조사 한 번이 `requested`·`failed`·`opened` 를 전부
 *    날렸다(재현됨). "어디까지 봤나" 는 이 사이트에서 결론만큼 중요한 기록이다 —
 *    그게 사라지면 다음 조사가 같은 구간을 처음부터 다시 판다.
 *
 * ★ 실패는 명시적인 resolved_failed 로만 해소한다. 대표 샘플 범위는 해소 근거가 아니다.
 *
 * ★ `mode: "replace"` 는 기록이 틀렸을 때 사람이 명시적으로 쓰는 길이다.
 */
export async function markLeadScan(
  leadId: string,
  scan: LeadScanState,
  opts: { mode?: "merge" | "replace"; resolved_failed?: TimeRange[] } = {},
): Promise<LeadScanState> {
  return db().begin((tx) => markLeadScanInTx(tx, leadId, scan, opts)) as Promise<LeadScanState>;
}

export async function markLeadScanInTx(
  tx: Tx,
  leadId: string,
  scan: LeadScanState,
  opts: { mode?: "merge" | "replace"; resolved_failed?: TimeRange[] } = {},
): Promise<LeadScanState> {
  const resolved = (opts.resolved_failed ?? []).map((r): TimeRange => {
    if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isFinite) || r[0] < 0 || r[1] < r[0]) {
      throw new Error("resolved_failed 는 VOD 전체 초 [시작, 끝] 배열이어야 합니다.");
    }
    return [Math.ceil(r[0]), Math.floor(r[1])];
  }).filter(([a, b]) => b >= a);
  // 해소는 입력 명령이다. raw.scan 에 남겨 다음 실행에서 재적용하지 않는다.
  const { resolved_failed: _ignored, ...state } = scan as LeadScanState & { resolved_failed?: unknown };
  const rows = await tx<{ raw: { scan?: LeadScanState } }[]>`
    SELECT raw FROM event_lead WHERE id = ${leadId}::uuid FOR UPDATE
  `;
  if (rows.length === 0) throw new Error(`event_lead 를 찾지 못했다: ${leadId}`);

  const prev = rows[0].raw.scan;
  const next = opts.mode === "replace" || !prev ? state : mergeScan(prev, state, resolved);

  await tx`
    UPDATE event_lead SET raw = raw || ${tx.json({ scan: next } as never)}
     WHERE id = ${leadId}::uuid
  `;
  return next;
}

/** 숫자 목록 합치기 — 중복 없이 정렬. `opened` 처럼 "실제로 연 시각" 에 쓴다. */
const mergeNums = (a?: number[], b?: number[]): number[] | undefined =>
  a || b ? [...new Set([...(a ?? []), ...(b ?? [])])].sort((x, y) => x - y) : undefined;

/**
 * 두 실행 기록을 합친다.
 *
 * ⚠ `status`·`version`·`note`·`finished_at` 은 **이번 실행 것이 이긴다** — 그건 누적할
 *   성질이 아니라 "지금 상태" 다. 범위·지점만 쌓인다.
 */
function mergeScan(prev: LeadScanState, next: LeadScanState, resolvedFailed: TimeRange[]): LeadScanState {
  const requested = mergeRanges([...(prev.requested ?? []), ...(next.requested ?? [])]) as TimeRange[];
  const sampled = mergeRanges([...(prev.sampled ?? []), ...(next.sampled ?? [])]) as TimeRange[];
  // sampled 는 대표 샘플 배치 범위일 뿐이다. 확인해 전달한 해소만 반영한다.
  const resolved = subtractRanges(prev.failed ?? [], resolvedFailed) as TimeRange[];
  const failed = mergeRanges([...resolved, ...(next.failed ?? [])]) as TimeRange[];

  return {
    ...prev,
    ...next,
    ...(requested.length ? { requested } : {}),
    ...(sampled.length ? { sampled } : {}),
    failed,
    probes: {
      planned: mergeNums(prev.probes?.planned, next.probes?.planned),
      extra: mergeNums(prev.probes?.extra, next.probes?.extra),
    },
    opened: mergeNums(prev.opened, next.opened) ?? [],
    transcript_read: mergeRanges([
      ...(prev.transcript_read ?? []), ...(next.transcript_read ?? []),
    ]) as TimeRange[],
    signals: [...new Set([...(prev.signals ?? []), ...(next.signals ?? [])])],
  };
}

/**
 * 후보 결론을 **id 로 병합한다.** 같은 후보를 다시 보내면 갱신되고, 처음이면 추가된다.
 *
 * ★ 왜 통째로 덮지 않나: 조사는 한 번에 끝나지 않는다. 후보 하나를 읽자마자 반영하고
 *   다음 후보로 가는 흐름이라(계획 §3 — "다른 후보가 끝날 때까지 기다리지 않는다"),
 *   덮어쓰기면 나중 호출이 앞서 적은 후보를 지운다.
 * ★ 순서는 시각 순으로 정렬해 둔다 — 어드민 타임라인이 그대로 쓴다.
 */
const CANDIDATE_FIELDS = ["id", "at", "observed", "conclusion", "why", "evidence_frame_ids", "match_id", "open_questions", "supersedes"] as const;
export interface CandidateMergeResult { candidates: LeadCandidate[]; updated: string[]; skipped: string[] }

/**
 * 후보 JSON(`raw.candidates`)에는 **구조만** 둔다 — 구간·결론·연결·대체 관계.
 * 관찰·해석·질문(서술)은 `review_record` 가 정본이다(0040). 입력으로는 받되 JSON 에는 남기지 않는다.
 */
function candidateStructure<T extends Partial<LeadCandidate>>(c: T): Omit<T, "observed" | "why" | "open_questions"> {
  const { observed: _observed, why: _why, open_questions: _questions, ...structure } = c;
  return structure;
}

/** 남은 질문은 문자열 배열이다. 문자열 하나를 받으면 글자마다 질문 하나가 된다(실제로 121건 생겼다). */
function assertQuestions(candidateId: string, questions: unknown): asserts questions is string[] | undefined {
  if (questions === undefined) return;
  if (!Array.isArray(questions) || questions.some((q) => typeof q !== "string")) {
    throw new Error(`후보 ${candidateId}의 open_questions 는 문자열 배열이어야 합니다 — 질문이 하나여도 ["…"] 로 적는다.`);
  }
}

/** 질문은 적은 순서대로 읽혀야 한다 — 한 트랜잭션의 now() 는 같으므로 clock_timestamp() 로 순서를 남긴다. */
async function replaceCandidateQuestions(tx: Tx, leadId: string, candidateId: string, questions: string[], by: "auto" | "admin") {
  await tx`DELETE FROM review_record WHERE lead_id=${leadId}::uuid AND candidate_id=${candidateId} AND type='question'`;
  for (const question of questions) if (question.trim()) await tx`
    INSERT INTO review_record (lead_id, candidate_id, type, body, created_by, created_at)
    VALUES (${leadId}::uuid, ${candidateId}, 'question', ${question.trim()}, ${by}, clock_timestamp())
  `;
}

function assertCandidateSupersession(candidates: readonly LeadCandidate[]): void {
  const ids = new Set(candidates.map((candidate) => candidate.id));
  for (const candidate of candidates) {
    const parent = candidate.supersedes;
    if (parent === undefined) continue;
    if (typeof parent !== "string" || !parent.trim()) {
      throw new Error(`후보 ${candidate.id}의 supersedes는 부모 후보 id 문자열이어야 합니다.`);
    }
    if (parent === candidate.id) throw new Error(`후보 ${candidate.id}는 자기 자신을 대체할 수 없습니다.`);
    if (!ids.has(parent)) throw new Error(`후보 ${candidate.id}가 존재하지 않는 부모 후보를 가리킵니다: ${parent}`);
  }

  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`후보 대체 관계가 순환합니다: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const parent = byId.get(id)?.supersedes;
    if (parent) visit(parent);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

/**
 * 후보가 가리키는 경기가 **실제로 있는지** 확인한다. 끊어진 참조가 있으면 멈춘다.
 *
 * ★ 후보는 raw.candidates(JSON)에 있어 FK 를 걸 수 없다. 그래서 쓰는 쪽이 여기를 지난다.
 *   실측: 'meljang-2022-s2-g25s1' 처럼 ':' 대신 '-' 로 적힌 12건이 조용히 들어가 있었다.
 * ★ 한 결과 파일 안에서 scan(후보 → 경기 X)이 match(경기 X 생성)보다 **앞에** 올 수 있다.
 *   그래서 ck-merge 는 쓸 때마다가 아니라 **파일 트랜잭션 끝에서** 부른다.
 * ★ 정의는 뷰 lead_candidate_dangling 하나다(0035). 사후에 경기가 지워져 생긴 끊김도 같은 뷰에 드러난다.
 */
export async function assertCandidateMatchesExistInTx(tx: Tx, leadIds: string[]): Promise<void> {
  if (leadIds.length === 0) return;
  const dangling = await tx<{ lead_id: string; candidate_id: string; match_id: string }[]>`
    SELECT lead_id, candidate_id, match_id FROM lead_candidate_dangling
     WHERE lead_id = ANY(${leadIds}::uuid[])
  `;
  if (dangling.length > 0) {
    throw new Error("없는 경기를 가리키는 후보가 있습니다 — "
      + dangling.map((d) => `${d.candidate_id} → ${d.match_id}`).join(", ")
      + ". 경기 ID 오기이거나, 그 경기를 같은 결과 파일에 넣지 않았습니다.");
  }
}

/**
 * 혼자 커밋하는 길이므로 **커밋 전에** 후보가 가리키는 경기를 확인한다.
 * `…InTx` 는 검사를 호출한 쪽에 맡긴다 — ck-merge 는 같은 파일의 경기를 다 넣은 뒤 파일 끝에서 본다.
 */
export async function mergeLeadCandidates(
  leadId: string, incoming: Omit<LeadCandidate, "reviewed_at">[],
): Promise<CandidateMergeResult> {
  return db().begin(async (tx) => {
    const merged = await mergeLeadCandidatesInTx(tx, leadId, incoming);
    await assertCandidateMatchesExistInTx(tx, [leadId]);
    return merged;
  }) as Promise<CandidateMergeResult>;
}

export async function mergeLeadCandidatesInTx(
  tx: Tx,
  leadId: string, incoming: Omit<LeadCandidate, "reviewed_at">[],
): Promise<CandidateMergeResult> {
  for (const c of incoming) {
    for (const key of Object.keys(c)) {
      if (!(CANDIDATE_FIELDS as readonly string[]).includes(key)) throw new Error(`자동 후보 입력에 허용되지 않은 필드: ${key}`);
    }
    assertQuestions(c.id, c.open_questions);
  }
  const rows = await tx<{ raw: { candidates?: LeadCandidate[] } }[]>`
    SELECT raw FROM event_lead WHERE id = ${leadId}::uuid FOR UPDATE
  `;
  if (!rows.length) throw new Error(`event_lead 를 찾지 못했다: ${leadId}`);
  const byId = new Map((rows[0].raw.candidates ?? []).map(c => [c.id, c]));
  const updated: string[] = [], skipped: string[] = [];
  for (const c of incoming) {
    const old = byId.get(c.id);
    if (old?.reviewed_at) { skipped.push(c.id); continue; }
    const next = { ...candidateStructure(old ?? {}), ...candidateStructure(c) } as LeadCandidate;
    // "경기 반영·연결" 이라고 적으려면 **어느 경기인지** 있어야 한다. 없이 적힌 옛 후보가 49건 남아
    // 검수 큐에 할 일로 떴다. 새로 쓰는 것은 여기서 막는다(어드민 수정 경로와 같은 규칙).
    if ((next.conclusion === "match" || next.conclusion === "linked") && !next.match_id) {
      throw new Error(`후보 ${c.id}: 결론이 ${next.conclusion} 이면 match_id 가 있어야 한다 — 모르면 unresolved 로 남긴다.`);
    }
    byId.set(c.id, next);
    for (const [type, body] of [["observation", c.observed], ["assessment", c.why]] as const) {
      if (body === undefined) continue;
      await tx`DELETE FROM review_record WHERE lead_id=${leadId}::uuid AND candidate_id=${c.id} AND type=${type}`;
      if (body?.trim()) await tx`
        INSERT INTO review_record (lead_id, candidate_id, type, body, created_by)
        VALUES (${leadId}::uuid, ${c.id}, ${type}, ${body.trim()}, 'auto')
      `;
    }
    if (c.open_questions !== undefined) await replaceCandidateQuestions(tx, leadId, c.id, c.open_questions, "auto");
    updated.push(c.id);
  }
  const candidates = [...byId.values()].sort((a, b) => a.at[0] - b.at[0]);
  assertCandidateSupersession(candidates);
  if (updated.length) await tx`
    UPDATE event_lead SET raw = raw || ${tx.json({ candidates } as never)} WHERE id = ${leadId}::uuid
  `;
  return { candidates, updated, skipped };
}

export async function getEventLead(id: string): Promise<EventLeadRow | null> {
  const sql = db();
  const rows = await sql<EventLeadRow[]>`SELECT * FROM event_lead WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
}

/**
 * `/admin/ck` 목록 — 경기로 이어진 VOD 와 그 검수 진척.
 *
 * ★ 후보·미해결·못 본 구간 같은 **조사 상태**는 사람 화면에서 뺐다(읽은 프레임 수도).
 *   "이어서 할 일" 은 `npm run ck:record -- --todo` 가 본다 — 같은 집계를 두 곳에 두지 않는다.
 */
export async function listEventLeads(opts: {
  from?: Date;
  to?: Date;
  state?: EventLeadState;
  /** 이어진 경기의 대회 분류로 거른다. "unlinked" 는 경기에 아직 안 이어진 단서. */
  event_kind?: LeadEventKind | "unlinked";
  channel_id?: string;
  limit?: number;
  with_matches?: boolean;
  unreviewed?: boolean;
} = {}): Promise<EventLeadListRow[]> {
  const sql = db();
  return sql<EventLeadListRow[]>`
    SELECT el.*,
           linked.n::int                                             AS match_count,
           linked.completed::int AS completed_count,
           linked.participant_count, linked.position_count, linked.linked_count, linked.champion_count, linked.kda_count,
           linked.kinds                                              AS event_kinds
      FROM event_lead el
      -- ★ 이 VOD 에서 나온 경기는 lead_match 뷰 하나가 정한다(0035). 예전엔 세 갈래
      --   (근거 프레임·후보·출처 URL) 규칙이 여기 두 벌, 상세 화면에 한 벌 복사돼 있었다.
      --   경기 수·검수 수·분류가 같은 경기 집합에서 나와야 분모와 분자가 어긋나지 않는다.
      CROSS JOIN LATERAL (
        SELECT count(*) AS n,
               count(*) FILTER (WHERE m.review_completed_at IS NOT NULL) AS completed,
               COALESCE(sum(rp.participant_count), 0)::int AS participant_count,
               COALESCE(sum(rp.position_count), 0)::int AS position_count,
               COALESCE(sum(rp.linked_count), 0)::int AS linked_count,
               COALESCE(sum(rp.champion_count), 0)::int AS champion_count,
               COALESCE(sum(rp.kda_count), 0)::int AS kda_count,
               COALESCE(array_agg(DISTINCT COALESCE(e.kind, 'other')), '{}') AS kinds
          FROM lead_match lm
          JOIN match m ON m.match_id = lm.match_id AND m.game_code = 'lol'
          ${sql.unsafe(REVIEW_PROGRESS_JOIN)}
          LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
          LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
         WHERE lm.lead_id = el.id
      ) linked
     WHERE (${opts.from ?? null}::timestamptz IS NULL OR el.observed_at >= ${opts.from ?? null})
       AND (${opts.to ?? null}::timestamptz IS NULL OR el.observed_at < ${opts.to ?? null})
       AND (${opts.state ?? null}::text IS NULL OR el.state = ${opts.state ?? null})
       AND (${opts.event_kind ?? null}::text IS NULL
            OR (${opts.event_kind ?? null} = 'unlinked' AND linked.n = 0)
            OR ${opts.event_kind ?? null} = ANY(linked.kinds))
       AND (${opts.channel_id ?? null}::text IS NULL OR el.channel_id = ${opts.channel_id ?? null})
       AND (${opts.with_matches ?? false} = false OR linked.n > 0)
       AND (${opts.unreviewed ?? false} = false OR linked.completed < linked.n)
     ORDER BY el.observed_at DESC
     LIMIT ${opts.limit ?? 200}
  `;
}

// ── match_evidence_frame — 판단 근거 프레임 ─────────────────────────

export type EvidenceFrameKind = "result" | "roster" | "other";
export type ReviewRecordType = "observation" | "assessment" | "question" | "final_evidence";
export interface ReviewRecordRow {
  id: string;
  lead_id: string | null;
  match_id: string | null;
  candidate_id: string | null;
  frame_id: string | null;
  type: ReviewRecordType;
  body: string;
  created_by: "auto" | "admin" | "migration";
  created_at: Date;
}

export interface EvidenceFrameRow {
  id: string;
  lead_id: string;
  match_id: string | null;
  frame_path: string;
  at_sec: number | null;
  kind: EvidenceFrameKind;
  /** 실제로 열어 읽은 시각. NULL = 뽑았지만 아직 안 본 프레임 (0019). 읽은 **내용**은 review_record 에 있다. */
  read_at: Date | null;
  /**
   * 사람이 메모·연결을 고친 시각 (0021). 채워져 있으면 **재수집이 덮지 않는다.**
   * `read_at` 과 다르다 — 그건 "열어 봤다"(스킬도 찍는다), 이건 "사람이 고쳤다".
   */
  reviewed_at: Date | null;
  created_at: Date;
}

export interface EvidenceFrameInput {
  frame_path: string;
  at_sec?: number | null;
  kind?: EvidenceFrameKind;
  /**
   * 이 프레임에서 읽은 내용(조사 기록). `review_record(observation)` 에만 저장된다(0040).
   * ★ 메모는 **읽음을 켜지 않는다.** 열어 봤는지는 `read` 가 따로 말한다 — 둘을 묶었더니
   *   읽음을 켜려고 쓸모없는 메모를 지어내게 됐다.
   */
  note?: string | null;
  /** 실제로 열어 봤나. `ck:merge` 는 결과 파일의 `scan.opened`(열어 본 시각) 로 채운다. */
  read?: boolean;
  match_id?: string | null;
}

/**
 * 한 lead(VOD)에서 뽑은 프레임을 기록한다. 만든 행을 돌려주므로 그 id 로 매치에 잇는다.
 *
 * ★ 같은 `(lead_id, frame_path)` 를 다시 보내면 **새 행을 만들지 않고 갱신한다** —
 *   재실행이 근거 프레임을 중복 생성하면 어드민 타임라인에 같은 지점이 여러 개 쌓인다.
 * ★ `read: true` 여야 **읽은 것으로** 표시한다(`read_at`). 없으면 "뽑았지만 안 본" 채로 남는다.
 *   메모(`note`)는 읽음과 무관하다 — 조사 기록일 뿐이다.
 * ★ **사람이 고친 프레임(`reviewed_at`)은 메모도 연결도 안 건드린다**(0021). 경기의
 *   `reviewed_at` 과 같은 계약이다 — 여기만 없어서, 어드민에서 "실은 리플레이였다" 로
 *   고쳐 둔 메모를 재수집이 원래 문구로 되돌리고 끊어 둔 연결까지 되살렸다.
 */
export async function recordEvidenceFrames(
  leadId: string,
  frames: EvidenceFrameInput[],
): Promise<EvidenceFrameRow[]> {
  return db().begin((tx) => recordEvidenceFramesInTx(tx, leadId, frames)) as Promise<EvidenceFrameRow[]>;
}

export async function recordEvidenceFramesInTx(
  tx: Tx,
  leadId: string,
  frames: EvidenceFrameInput[],
): Promise<EvidenceFrameRow[]> {
  if (frames.length === 0) return [];
  const out: EvidenceFrameRow[] = [];
  for (const f of frames) {
    const read = f.read === true;
    const rows = await tx<EvidenceFrameRow[]>`
      INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind, read_at)
      VALUES (${leadId}::uuid, ${f.match_id ?? null}, ${f.frame_path}, ${f.at_sec ?? null},
              ${f.kind ?? "other"}, ${read ? new Date() : null})
      ON CONFLICT (lead_id, frame_path) DO UPDATE SET
        -- ★ 사람이 고친 행(reviewed_at)은 **메모도 연결도 그대로 둔다**(0021).
        --   at_sec·kind 는 파일에서 나오는 사실이라 그대로 갱신해도 된다.
        match_id = CASE WHEN match_evidence_frame.reviewed_at IS NOT NULL
                        THEN match_evidence_frame.match_id
                        ELSE COALESCE(EXCLUDED.match_id, match_evidence_frame.match_id) END,
        at_sec   = COALESCE(EXCLUDED.at_sec, match_evidence_frame.at_sec),
        kind     = EXCLUDED.kind,
        -- 한 번 읽었으면 읽은 것이다. 나중에 추출만 다시 돌려도 안 지운다.
        read_at  = COALESCE(match_evidence_frame.read_at, EXCLUDED.read_at)
      RETURNING *
    `;
    if (f.note?.trim() && rows[0].reviewed_at == null) await tx`
      INSERT INTO review_record (lead_id, frame_id, type, body, created_by)
      VALUES (${leadId}::uuid, ${rows[0].id}::uuid, 'observation', ${f.note.trim()}, 'auto')
      ON CONFLICT (frame_id) WHERE type = 'observation' DO UPDATE SET
        body = EXCLUDED.body, created_at = now()
    `;
    out.push(rows[0]);
  }
  return out;
}

/**
 * 프레임 **경로**로 id 를 찾는다.
 *
 * ★ 왜 필요한가: 조사자는 결과 파일을 쓸 때 프레임의 uuid 를 알 수 없다 — id 는 넣어 봐야
 *   생긴다. 반면 경로는 알고 있다(파일 이름이 곧 시각이다). 그래서 근거를 **경로로** 걸고,
 *   창구가 id 로 바꾼다. 안 그러면 "넣고 → id 확인하고 → 다시 넣는" 왕복이 생기고,
 *   그 왕복을 귀찮아하면 근거가 안 붙은 경기가 쌓인다.
 */
export async function evidenceFrameIdsByPath(paths: string[]): Promise<Map<string, string>> {
  return db().begin((tx) => evidenceFrameIdsByPathInTx(tx, paths)) as Promise<Map<string, string>>;
}

/** 같은 트랜잭션에서 방금 기록한 프레임도 찾아야 하므로(ck-merge) tx 를 받는다. */
export async function evidenceFrameIdsByPathInTx(tx: Tx, paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const rows = await tx<{ id: string; frame_path: string }[]>`
    SELECT id, frame_path FROM match_evidence_frame WHERE frame_path = ANY(${paths}::text[])
  `;
  return new Map(rows.map((r) => [r.frame_path, r.id]));
}

export async function listEvidenceFrames(leadId: string): Promise<EvidenceFrameRow[]> {
  return db().begin((tx) => listEvidenceFramesInTx(tx, leadId)) as Promise<EvidenceFrameRow[]>;
}

export async function listEvidenceFramesInTx(tx: Tx, leadId: string): Promise<EvidenceFrameRow[]> {
  return tx<EvidenceFrameRow[]>`
    SELECT * FROM match_evidence_frame
     WHERE lead_id = ${leadId}::uuid
     ORDER BY at_sec NULLS LAST, created_at
  `;
}

/**
 * 프레임을 다른 경기로 옮기거나(잘못 붙였을 때) 연결을 끊는다(`null`).
 *
 * 프레임 연결은 **근거 기록**이라 조우·통계에 영향이 없다 — 그래서 파생 재계산이 없다.
 * 옮기는 것만으로 승패가 바뀌지는 않는다는 뜻이기도 하다: 판독을 고치려면 경기를 고쳐야 한다.
 *
 * ★ 이건 **사람만 부르는 길**이라 `reviewed_at` 을 찍는다(0021). 특히 연결을 **끊은**
 *   경우가 중요하다 — 표시가 없으면 다음 재수집이 `evidence_frame_ids` 로 그대로 되살린다.
 */
export async function relinkEvidenceFrame(frameId: string, matchId: string | null): Promise<EvidenceFrameRow | null> {
  return db().begin(async (tx) => {
    const [current] = await tx<{ lead_id: string; match_id: string | null }[]>`
      SELECT lead_id, match_id FROM match_evidence_frame WHERE id = ${frameId}::uuid FOR UPDATE`;
    if (!current) return null;
    const rows = await tx<EvidenceFrameRow[]>`
      UPDATE match_evidence_frame SET match_id = ${matchId}, reviewed_at = now()
       WHERE id = ${frameId}::uuid
      RETURNING *
    `;
    // 경기 쪽에서 모아 볼 수 있게, 옮긴 뒤의 경기(없으면 옮기기 전 경기)에 묶는다.
    await recordReviewChanges(tx, [{ match_id: matchId ?? current.match_id, lead_id: current.lead_id, entity: "frame", entity_key: frameId, field: "match_id", before: current.match_id, after: matchId }]);
    return rows[0] ?? null;
  }) as Promise<EvidenceFrameRow | null>;
}

// ── match / match_participant ───────────────────────────────────────

export type MatchOrigin = "wiki_seed" | "vod_scan" | "admin";
export type MatchVisibility = "public" | "hidden";

export interface CkMatchParticipantInput {
  /** 1..10. 한 경기 안에서 자리를 정하는 값이라 계정·사람을 몰라도 늘 있다(0017). */
  participant_id: number;
  puuid?: string | null;
  streamer_id?: string | null;
  /**
   * 결과 화면에서 읽은 인게임명. **사람을 못 붙였어도 자리를 남기려고** 쓴다(0020) —
   * 세 값이 다 비면 CHECK 가 거부한다. "못 읽은 자리"와 "없던 자리"는 다르다.
   */
  observed_name?: string | null;
  team_id: 100 | 200;
  team_position?: string | null;
  individual_position?: string | null;
  champion_id?: number | null;
  champion_name?: string | null;
  /** ★ 못 읽었으면 비운다. 0 으로 채우면 "딜 안 하고 안 죽은 사람"이 남는다(0020). */
  kills?: number | null;
  deaths?: number | null;
  assists?: number | null;
}

export interface CkMatchInput {
  match_id: string;
  event_id?: string | null;
  played_at: Date;
  /**
   * `played_at` 의 **시각까지** 확인했나. 기본값이 없다(0035) — VOD 에서 찾았다고 시각이
   * 정확한 게 아니다. VOD 시작 시각을 확인 못 하고 오프셋으로 어림했으면 "date" 다.
   */
  played_at_precision: "datetime" | "date";
  /**
   * 이 세트가 속한 시리즈의 **세트 순서**를 확인했나. true 만 반영된다 — "모름" 은 기존의
   * 확인된 값을 내리지 않는다(ensureMatchSeries).
   */
  set_order_known?: boolean;
  duration?: number | null;
  source_url?: string | null;
  result_evidence?: string | null;
  series_id?: string | null;
  series_game_no?: number | null;
  best_of?: number | null;
  best_of_evidence?: string | null;
  blue_team_id?: string | null;
  red_team_id?: string | null;
  winning_team: 100 | 200;
  participants: CkMatchParticipantInput[];
  /** 기본 `vod_scan`. 어드민이 미연결 프레임에서 직접 만들면 `admin`. */
  origin?: MatchOrigin;
  /**
   * 이 판단의 근거가 된 프레임 id. **명시한 것만** 잇는다.
   * ⚠ 예전엔 "그 lead 의 미배정 프레임 전부"를 붙였는데, VOD 하나에 경기가 여럿이라
   *   **첫 경기가 뒤 경기의 프레임까지 통째로 삼켰다.** 5시간 방송에 5경기면 4경기가 근거를 잃는다.
   */
  evidence_frame_ids?: string[];
}

export interface MatchRow extends ReviewProgress {
  game_code: string;
  review_completed_at: Date | null;
  review_version: number;
  match_id: string;
  queue_id: number;
  game_mode: string | null;
  game_creation: Date;
  game_duration: number | null;
  winning_team: 100 | 200 | null;
  source: string;
  origin: MatchOrigin | null;
  visibility: MatchVisibility;
  reviewed_at: Date | null;
  event_id: string | null;
  source_url: string | null;
  result_evidence: string | null;
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  best_of_evidence: string | null;
  blue_team_id: string | null;
  red_team_id: string | null;
  /** 'date' 면 game_creation 의 시각은 의미가 없다(0035). 화면은 날짜만 보여준다. */
  game_creation_precision: "datetime" | "date";
  /** 세트 순서를 출처에서 확인했나. false 면 "N세트" 로 단정하지 않는다. 시리즈 없으면 false. */
  set_order_known: boolean;
}

export interface MatchParticipantRow {
  /** 검수 화면의 연결 표시용. 저장된 직접 연결과 분리한다. */
  account_streamer_id?: string | null;
  match_id: string;
  puuid: string | null;
  streamer_id: string | null;
  observed_name: string | null;
  participant_id: number;
  team_id: 100 | 200;
  team_position: string | null;
  individual_position: string | null;
  champion_id: number;
  champion_name: string | null;
  outcome: MatchOutcome;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface MatchDetail {
  match: MatchRow;
  participants: MatchParticipantRow[];
  evidence_frames: EvidenceFrameRow[];
}

const MATCH_COLUMNS = `m.match_id, m.game_code, m.queue_id, m.game_mode, m.game_creation, m.game_duration, m.winning_team,
  m.source, m.origin, m.visibility, m.reviewed_at, m.review_completed_at, m.review_version,
  rp.participant_count, rp.position_count, rp.linked_count, rp.champion_count, rp.kda_count, COALESCE(ms.event_id, m.event_id) AS event_id,
  m.source_url,
  -- 최종 결과 근거의 정본은 review_record 하나다(0040 에서 match.result_evidence 제거).
  (SELECT rr.body FROM review_record rr WHERE rr.match_id = m.match_id AND rr.type = 'final_evidence') AS result_evidence,
  m.series_id, m.series_game_no, ms.best_of, ms.best_of_evidence,
  m.blue_team_id, m.red_team_id, m.game_creation_precision, COALESCE(ms.set_order_known, false) AS set_order_known`;
const MATCH_SERIES_JOIN = `LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code ${REVIEW_PROGRESS_JOIN}`;

const PARTICIPANT_COLUMNS = `match_id, puuid, streamer_id, observed_name, participant_id, team_id,
  team_position, individual_position, champion_id, champion_name, outcome, kills, deaths, assists`;

/**
 * 스킬이 판단을 마친 직후 쓰는 경로. `tournaments.saveTournamentGame` 과 모양이 같지만
 * 시드 파일이 아니라 스킬이 직접 인자를 넘긴다.
 *
 * `riot_game_id`/`platform_id` 는 비운다(0006) — Riot 이 준 값이 아닌 걸 지어내지 않는다.
 *
 * ★ **사람이 검수한 경기는 건드리지 않고 `false` 를 돌려준다**(0020). 여러 POV 를 돌다가
 *   이미 고쳐 둔 경기를 다시 만나는 것이 정상 흐름이고, 그때 판독값이 자동 산출물보다 정확하다.
 */
export async function upsertMatchFromScan(g: CkMatchInput): Promise<boolean> {
  return db().begin((tx) => upsertMatchFromScanInTx(tx, g)) as Promise<boolean>;
}

export async function upsertMatchFromScanInTx(tx: Tx, g: CkMatchInput): Promise<boolean> {
  // ★ `FOR UPDATE` 로 그 행을 잠근다. 없으면 검수 저장과 자동 수집이 **동시에** 돌 때
  //   READ COMMITTED 에서 둘 다 `reviewed_at IS NULL` 을 보고 통과해, 사람이 고친 값이
  //   덮인다. 잠그면 자동 수집이 검수 커밋을 기다렸다가 보고 물러난다.
  const reviewed = await tx<{ reviewed_at: Date | null }[]>`
    SELECT reviewed_at FROM match WHERE match_id = ${g.match_id} FOR UPDATE
  `;
  if (reviewed[0]?.reviewed_at != null) return false;

  // ★ **지우기 전에** 옛 명단을 잡는다. 아래에서 참가자를 DELETE 후 재INSERT 하므로,
  //   이 줄이 없으면 `affectedStreamers` 가 새 명단만 본다. 재판독으로 A 자리를 B 로
  //   바꾸면 A 에게서 빼야 하는데 A 가 범위에 없어 **A 의 챔피언 통계에 유령 경기가
  //   남는다**(재현: A 의 143 통계가 교체 뒤에도 그대로 남았다).
  //   `applyMatchReview` 는 같은 이유로 `before` 를 잡고 있었고, 이 경로만 빠져 있었다.
  const before = await affectedStreamers(tx, g.match_id);

  if (g.series_id) await ensureMatchSeries(tx, {
    id: g.series_id,
    game_code: "lol",
    event_id: g.event_id,
    best_of: g.best_of,
    best_of_evidence: g.best_of_evidence,
    set_order_known: g.set_order_known,
  });
  const matchEventId = g.series_id ? null : (g.event_id ?? null);

  await tx`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, game_duration,
                       winning_team, source, origin, event_id, source_url,
                       series_id, series_game_no, blue_team_id, red_team_id, game_creation_precision)
    VALUES (${g.match_id}, 'lol', 0, '0', 'CUSTOM', ${g.played_at}, ${g.duration ?? null},
            ${g.winning_team}, 'manual', ${g.origin ?? "vod_scan"}, ${matchEventId},
            ${g.source_url ?? null},
            ${g.series_id ?? null}, ${g.series_game_no ?? null},
            ${g.blue_team_id ?? null}, ${g.red_team_id ?? null}, ${g.played_at_precision})
    ON CONFLICT (match_id) DO UPDATE SET
      game_creation   = EXCLUDED.game_creation,
      -- 시각과 그 정확도는 한 쌍이다. 시각을 VOD 로 보정하면 정확도도 입력값으로 바뀐다.
      game_creation_precision = EXCLUDED.game_creation_precision,
      game_duration   = EXCLUDED.game_duration,
      winning_team    = EXCLUDED.winning_team,
      event_id        = EXCLUDED.event_id,
      source_url      = EXCLUDED.source_url,
      series_id       = EXCLUDED.series_id,
      series_game_no  = EXCLUDED.series_game_no,
      blue_team_id    = EXCLUDED.blue_team_id,
      red_team_id     = EXCLUDED.red_team_id
  `;
  if (g.result_evidence?.trim()) await tx`
    INSERT INTO review_record (match_id, type, body, created_by)
    VALUES (${g.match_id}, 'final_evidence', ${g.result_evidence.trim()}, 'auto')
    ON CONFLICT (match_id) WHERE type='final_evidence' DO UPDATE SET
      body=EXCLUDED.body, created_at=now()
  `;

  await tx`DELETE FROM match_participant WHERE match_id = ${g.match_id}`;
  for (const p of g.participants) {
    await assertIdentityAgrees(tx, p);
    const champ = resolveChampion(p.champion_id, p.champion_name);
    await tx`
      INSERT INTO match_participant
        (match_id, puuid, streamer_id, observed_name, participant_id, team_id, side_no,
         team_position, individual_position, champion_id, champion_name, outcome,
         kills, deaths, assists)
      VALUES (${g.match_id}, ${p.puuid ?? null}, ${p.streamer_id ?? null}, ${p.observed_name ?? null},
              ${p.participant_id}, ${p.team_id}, ${p.team_id === 100 ? 1 : 2},
              ${p.team_position ?? null}, ${p.individual_position ?? p.team_position ?? null},
              ${champ.champion_id}, ${champ.champion_name},
              ${p.team_id === g.winning_team ? "win" : "loss"},
              ${p.kills ?? null}, ${p.deaths ?? null}, ${p.assists ?? null})
    `;
  }

  // ★ 명시한 프레임만 잇는다. lead 의 미배정 프레임을 싹 가져오지 않는다 (위 주석 참고).
  // ★ 그리고 **사람이 만진 프레임은 건드리지 않는다**(0021) — 어드민에서 끊어 둔 연결을
  //   재수집이 되살리면, 끊은 사람은 끊었다고 믿고 화면은 그대로다.
  if (g.evidence_frame_ids?.length) {
    await tx`
      UPDATE match_evidence_frame SET match_id = ${g.match_id}
       WHERE id = ANY(${g.evidence_frame_ids}::uuid[]) AND reviewed_at IS NULL
    `;
  }

  // 원본과 파생을 **한 트랜잭션**으로 묶는다. 갈라지면 승패가 어긋난 채 남는다.
  await rederiveEncountersInTx(tx, g.match_id);
  const after = await affectedStreamers(tx, g.match_id);
  await recomputeChampionStatsInTx(tx, [...new Set([...before, ...after])]);
  return true;
}


/** 어드민 타임라인 화면 하나(경기 상세)를 구성하는 데 필요한 전부. */
export async function getMatchDetail(matchId: string): Promise<MatchDetail | null> {
  const sql = db();
  const matches = await sql<MatchRow[]>`
    SELECT ${sql.unsafe(MATCH_COLUMNS)} FROM match m
    ${sql.unsafe(MATCH_SERIES_JOIN)} WHERE m.match_id = ${matchId}
  `;
  if (matches.length === 0) return null;
  const [participants, evidence_frames] = await Promise.all([
    sql<MatchParticipantRow[]>`
      SELECT ${sql.unsafe(PARTICIPANT_COLUMNS)},
             (SELECT sa.streamer_id FROM streamer_account sa
               WHERE sa.puuid = match_participant.puuid AND sa.active_to IS NULL LIMIT 1) AS account_streamer_id
        FROM match_participant
       WHERE match_id = ${matchId} ORDER BY participant_id
    `,
    sql<EvidenceFrameRow[]>`
      SELECT * FROM match_evidence_frame WHERE match_id = ${matchId}
       ORDER BY at_sec NULLS LAST, created_at
    `,
  ]);
  return { match: matches[0], participants, evidence_frames };
}

/**
 * 이 경기가 통계에 영향을 주는 스트리머들.
 *
 * ★ **고치기 전과 후를 모두 모아야 한다.** 참가자의 사람을 A → B 로 바꾸면 A 에게서
 *   빼고 B 에게 넣어야 하는데, 나중 것만 보면 A 의 통계에 유령 경기가 남는다.
 * ★ puuid 매핑이 `streamer_id` 보다 **먼저** 온다 — `transform.ts` 의 식별 순서와 같아야
 *   하고, `champion_stat` 재계산 SQL 의 COALESCE 순서와도 같아야 한다.
 */
export async function affectedStreamers(tx: Tx, matchId: string): Promise<string[]> {
  const rows = await tx<{ streamer_id: string }[]>`
    SELECT DISTINCT COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id
      FROM match_participant mp
      LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
     WHERE mp.match_id = ${matchId}
       AND COALESCE(sa.streamer_id, mp.streamer_id) IS NOT NULL
  `;
  return rows.map((r) => r.streamer_id);
}

export interface MatchMetaValues {
  winning_team: 100 | 200;
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  best_of_evidence: string | null;
  blue_team_id: string | null;
  red_team_id: string | null;
  event_id: string | null;
  game_creation: Date;
  game_duration: number | null;
}
// 최종 결과 근거는 여기 없다 — 전용 saveFinalEvidenceReview 한 곳으로만 고친다.
const META_FIELDS = ["winning_team", "series_id", "series_game_no", "best_of", "best_of_evidence", "blue_team_id", "red_team_id", "event_id", "game_creation", "game_duration", "game_creation_precision", "set_order_known"] as const;
const PARTICIPANT_EDIT_FIELDS = ["puuid", "streamer_id", "observed_name", "team_id", "team_position", "individual_position", "champion_id", "champion_name", "kills", "deaths", "assists"] as const;

export interface MatchReviewPatch {
  match?: { changes: Partial<MatchMetaValues>; expect: Record<string, unknown> };
  visibility?: MatchVisibility;
  participants?: {
    /** 신규 생성 전용. 이미 있으면 덮지 않는다. */
    add?: CkMatchParticipantInput[];
    patch?: ParticipantPatch[];
    remove?: number[];
  };
}
export interface ParticipantPatch {
  participant_id: number;
  changes: Partial<Omit<CkMatchParticipantInput, "participant_id">>;
  expect: Record<string, unknown>;
}

// ── 관리자 수정 이력 (0042) ─────────────────────────────────────────

export type ReviewChangeEntity = "match" | "series" | "participant" | "frame";
export interface ReviewChangeInput {
  match_id?: string | null;
  lead_id?: string | null;
  entity: ReviewChangeEntity;
  entity_key: string;
  field: string;
  before: unknown;
  after: unknown;
}

const changeValue = (value: unknown): unknown =>
  value instanceof Date ? value.toISOString() : value === undefined ? null : value;

/**
 * 관리자 수정 이력을 **같은 트랜잭션에서** 남긴다. 값이 그대로인 칸은 건너뛴다.
 * 이유 문장은 받지 않는다 — 전후 값이면 충분하고, 사람에게 설명문을 쓰게 하지 않는다.
 */
async function recordReviewChanges(tx: Tx, changes: readonly ReviewChangeInput[]): Promise<void> {
  for (const c of changes) {
    const before = changeValue(c.before), after = changeValue(c.after);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    await tx`
      INSERT INTO review_change (match_id, lead_id, entity, entity_key, field, before, after)
      VALUES (${c.match_id ?? null}, ${c.lead_id ?? null}, ${c.entity}, ${c.entity_key}, ${c.field},
              ${before == null ? null : tx.json(before as never)}, ${after == null ? null : tx.json(after as never)})
    `;
  }
}

export interface ReviewChangeRow {
  id: string;
  match_id: string | null;
  lead_id: string | null;
  entity: ReviewChangeEntity;
  entity_key: string;
  field: string;
  before: unknown;
  after: unknown;
  actor: string;
  changed_at: Date;
}

/** 경기 하나(또는 VOD 하나)의 수정 이력. 오래된 것부터. */
export async function listReviewChanges(scope: { match_id?: string; lead_id?: string }): Promise<ReviewChangeRow[]> {
  const sql = db();
  if (scope.match_id) return sql<ReviewChangeRow[]>`
    SELECT * FROM review_change
     WHERE match_id = ${scope.match_id}
        OR (entity = 'frame' AND before = to_jsonb(${scope.match_id}::text))
        OR (entity = 'series' AND entity_key = (SELECT series_id FROM match WHERE match_id = ${scope.match_id}))
     ORDER BY changed_at, id`;
  if (scope.lead_id) return sql<ReviewChangeRow[]>`
    SELECT * FROM review_change
     WHERE lead_id = ${scope.lead_id}::uuid
        OR match_id IN (SELECT match_id FROM lead_match WHERE lead_id = ${scope.lead_id}::uuid)
     ORDER BY changed_at, id`;
  return [];
}

/**
 * 검수 어드민의 **유일한 저장 경로**.
 *
 * 왜 함수를 하나로 두나 — 고칠 때마다 **같이 손봐야 하는 것**이 정해져 있는데,
 * 컬럼별 패치 함수를 따로 두면 그중 하나를 빼먹는다. 실제로 빼먹었다:
 * `winning_team` 만 바꾸고 `match_participant.outcome` 을 안 뒤집으면, 조우가 참가자
 * 행에서 승패를 읽으므로(`transform.ts` 의 `a_outcome: a.outcome`) **승자가 반대로
 * 들어간다** — 마이그레이션 0015 가 막으려던 바로 그 사고다.
 *
 * 한 트랜잭션에서 이 순서로 한다:
 *   ① 매치 메타 · 공개 여부  ② 참가자 추가·수정·삭제  ③ `outcome` 을 승리 팀에 맞춰 재계산
 *   ④ `reviewed_at` 기록 (이후 자동 수집이 이 행을 덮지 않는다)
 *   ⑤ 조우 재파생  ⑥ 영향받은 스트리머의 챔피언 통계 재계산
 */
export async function applyMatchReview(matchId: string, patch: MatchReviewPatch): Promise<MatchDetail | null> {
  return db().begin(tx => applyMatchReviewInTx(tx, matchId, patch)) as Promise<MatchDetail | null>;
}

/** 단일 경기와 일괄 검수가 같은 저장·파생 계약을 쓰되 트랜잭션을 중첩하지 않는다. */
async function applyMatchReviewInTx(tx: Tx, matchId: string, patch: MatchReviewPatch): Promise<MatchDetail | null> {
  // ★ `FOR UPDATE` — 잠그고 나서 읽는다. 잠금 전에 읽으면 그 사이 다른 트랜잭션이
  //   커밋해, 아래에서 쓰는 "고치기 전" 스냅샷이 이미 낡은 것일 수 있다.
  const exists = await tx<MatchRow[]>`
    SELECT ${tx.unsafe(MATCH_COLUMNS)} FROM match m
    ${tx.unsafe(MATCH_SERIES_JOIN)} WHERE m.match_id = ${matchId} FOR UPDATE OF m
  `;
  if (exists.length === 0) return null;

  const meta = checkedReviewChanges(exists[0] as unknown as Record<string, unknown>, patch.match?.changes ?? {}, patch.match?.expect ?? {}, META_FIELDS);
  // 이력에는 **사람이 고친 칸**만 남긴다 — 아래에서 파생으로 바뀌는 칸(event_id 소유 이전 등)은 빼고.
  const intended: Record<string, unknown> = { ...meta };
  const history: ReviewChangeInput[] = [];
  const finalMeta = { ...exists[0], ...meta };
  if ((finalMeta.series_id == null) !== (finalMeta.series_game_no == null)) throw new Error("시리즈 키와 세트 번호는 둘 다 채우거나 둘 다 비워야 합니다.");
  if (Object.hasOwn(meta, "game_creation_precision") && !["datetime", "date"].includes(String(meta.game_creation_precision))) {
    throw new Error("시각 정확도는 datetime(시각까지 확인) 또는 date(날짜만) 입니다.");
  }
  const orderChanged = Object.hasOwn(meta, "set_order_known");
  if (orderChanged && finalMeta.series_id == null) throw new Error("세트 순서 확인은 시리즈가 있는 경기에만 적을 수 있습니다.");
  const seriesFormatChanged = Object.hasOwn(meta, "best_of") || Object.hasOwn(meta, "best_of_evidence");
  if (finalMeta.series_id == null && seriesFormatChanged
      && (meta.best_of != null || meta.best_of_evidence != null)) {
    throw new Error("best_of와 그 근거는 시리즈가 있는 경기에만 적을 수 있습니다.");
  }
  if (finalMeta.series_id != null
      && (Object.hasOwn(meta, "series_id") || Object.hasOwn(meta, "event_id") || seriesFormatChanged)) {
    const sameSeries = finalMeta.series_id === exists[0].series_id;
    validateBestOf(finalMeta.best_of, finalMeta.best_of_evidence);
    await ensureMatchSeries(tx, {
      id: finalMeta.series_id,
      game_code: "lol",
      event_id: finalMeta.event_id,
      best_of: sameSeries ? undefined : finalMeta.best_of,
      best_of_evidence: sameSeries ? undefined : finalMeta.best_of_evidence,
    });
    if (sameSeries && seriesFormatChanged) {
      await tx`
        UPDATE match_series
           SET best_of = ${finalMeta.best_of},
               best_of_evidence = ${finalMeta.best_of == null ? null : finalMeta.best_of_evidence?.trim() || null},
               updated_at = now()
         WHERE id = ${finalMeta.series_id} AND game_code = 'lol'
      `;
    }
    if (Object.hasOwn(meta, "series_id") || Object.hasOwn(meta, "event_id")) {
      // 시리즈의 event는 match_series 한 곳만 소유한다. 세트 행에는 복제하지 않는다.
      meta.event_id = null;
    }
  } else if (finalMeta.series_id == null && exists[0].series_id != null && !Object.hasOwn(meta, "event_id")) {
    // 시리즈에서 단판으로 풀 때 기존 유효 event를 잃지 않는다.
    meta.event_id = exists[0].event_id;
  }
  // ★ 사람이 고치는 길이라 "확인됨 → 모름" 으로 내리는 것도 받는다(ensureMatchSeries 는 자동 경로라 안 내린다).
  if (orderChanged) {
    await tx`
      UPDATE match_series SET set_order_known = ${Boolean(meta.set_order_known)}, updated_at = now()
       WHERE id = ${finalMeta.series_id} AND game_code = 'lol'
    `;
  }
  // 이 셋은 match 컬럼이 아니라 match_series에 위에서 반영한다.
  delete meta.best_of;
  delete meta.best_of_evidence;
  delete meta.set_order_known;
  if (patch.visibility && patch.visibility !== exists[0].visibility) meta.visibility = patch.visibility;
  const SERIES_FIELDS = new Set(["best_of", "best_of_evidence", "set_order_known"]);
  for (const [field, after] of Object.entries(intended)) {
    const series = SERIES_FIELDS.has(field);
    history.push({
      match_id: matchId, entity: series ? "series" : "match",
      entity_key: series ? String(finalMeta.series_id) : matchId,
      field, before: (exists[0] as unknown as Record<string, unknown>)[field], after,
    });
  }
  if (meta.visibility) history.push({ match_id: matchId, entity: "match", entity_key: matchId, field: "visibility", before: exists[0].visibility, after: meta.visibility });
  let changed = Object.keys(meta).length > 0 || seriesFormatChanged || orderChanged;
  // 고치기 전과 후 명단을 합쳐 파생 통계를 정리한다.
  const before = await affectedStreamers(tx, matchId);

  // ── 부분 수정: 바뀐 칸만, 그리고 그 칸이 아직 내가 본 값일 때만 ──
  for (const p of patch.participants?.patch ?? []) {
    const cur = await tx<Record<string, unknown>[]>`
      SELECT ${tx.unsafe(PARTICIPANT_COLUMNS)} FROM match_participant
       WHERE match_id = ${matchId} AND participant_id = ${p.participant_id}
    `;
    if (cur.length === 0) {
      throw new Error(`${p.participant_id}번 자리가 없습니다. 그 사이 지워졌을 수 있습니다.`);
    }
    if (Object.hasOwn(p.changes, "champion_name") || Object.hasOwn(p.changes, "champion_id")) {
      for (const key of ["champion_name", "champion_id"]) {
        if (!Object.hasOwn(p.expect, key)) throw new Error(`${key} 기대값이 없습니다.`);
      }
    }
    const next = checkedReviewChanges(cur[0], p.changes, p.expect, PARTICIPANT_EDIT_FIELDS);
    if (!Object.keys(next).length) continue;
    if ("champion_name" in next || "champion_id" in next) {
      const champ = "champion_name" in next
        ? resolveChampion(null, next.champion_name as string | null)
        : resolveChampion(next.champion_id as number | null, null);
      next.champion_id = champ.champion_id;
      next.champion_name = champ.champion_name;
    }
    changed = true;

    await assertIdentityAgrees(tx, {
      participant_id: p.participant_id,
      puuid: ("puuid" in next ? next.puuid : cur[0].puuid) as string | null,
      streamer_id: ("streamer_id" in next ? next.streamer_id : cur[0].streamer_id) as string | null,
    });
    await tx`
      UPDATE match_participant SET ${tx(next, ...Object.keys(next))}
       WHERE match_id = ${matchId} AND participant_id = ${p.participant_id}
    `;
    for (const [field, after] of Object.entries(next)) history.push({
      match_id: matchId, entity: "participant", entity_key: String(p.participant_id), field, before: cur[0][field], after,
    });
  }

  for (const pid of patch.participants?.remove ?? []) {
    const removed = await tx<Record<string, unknown>[]>`
      DELETE FROM match_participant WHERE match_id = ${matchId} AND participant_id = ${pid}
      RETURNING ${tx.unsafe(PARTICIPANT_COLUMNS)}`;
    changed ||= removed.length > 0;
    if (removed.length) history.push({ match_id: matchId, entity: "participant", entity_key: String(pid), field: "row", before: removed[0], after: null });
  }

  for (const p of patch.participants?.add ?? []) {
    await assertIdentityAgrees(tx, p);
    const champ = resolveChampion(p.champion_id, p.champion_name);
    const added = await tx`
      INSERT INTO match_participant
        (match_id, puuid, streamer_id, observed_name, participant_id, team_id, side_no,
         team_position, individual_position, champion_id, champion_name, outcome,
         kills, deaths, assists)
      VALUES (${matchId}, ${p.puuid ?? null}, ${p.streamer_id ?? null}, ${p.observed_name ?? null},
              ${p.participant_id}, ${p.team_id}, ${p.team_id === 100 ? 1 : 2},
              ${p.team_position ?? null}, ${p.individual_position ?? p.team_position ?? null},
              ${champ.champion_id}, ${champ.champion_name}, 'loss',
              ${p.kills ?? null}, ${p.deaths ?? null}, ${p.assists ?? null})
      ON CONFLICT (match_id, participant_id) DO NOTHING
      RETURNING participant_id
    `;
    if (!added.length) {
      const [current] = await tx<Record<string, unknown>[]>`SELECT ${tx.unsafe(PARTICIPANT_COLUMNS)} FROM match_participant WHERE match_id=${matchId} AND participant_id=${p.participant_id}`;
      throw new ReviewConflictError(`${p.participant_id}번 자리(이미 추가됨)`, null, current);
    }
    history.push({ match_id: matchId, entity: "participant", entity_key: String(p.participant_id), field: "row", before: null, after: { ...p, champion_id: champ.champion_id, champion_name: champ.champion_name } });
    changed = true;
  }

  if (changed) {
    meta.reviewed_at = new Date();
    await tx`UPDATE match SET ${tx(meta, ...Object.keys(meta))} WHERE match_id = ${matchId}`;
    await recordReviewChanges(tx, history);
    // ★ `outcome` 은 사람이 적는 값이 아니라 **팀과 승리 팀에서 나오는 값**이다.
    //   승자를 바꿨든 참가자를 옮겼든, 여기서 한 번에 맞춘다. 위 INSERT 가 'loss' 를
    //   넣어 두는 것도 이 줄이 반드시 뒤에 오기 때문이다.
    //   ⚠ `game_code = 'lol'` — 이 공식엔 무승부가 없다. FC 경기가 언젠가 이 검수
    //   경로를 타더라도 draw 를 loss 로 덮으면 안 된다.
    await tx`
      UPDATE match_participant mp
         SET outcome = CASE WHEN mp.team_id = m.winning_team THEN 'win' ELSE 'loss' END,
             side_no = CASE mp.team_id WHEN 100 THEN 1 WHEN 200 THEN 2 ELSE side_no END
        FROM match m
       WHERE m.match_id = mp.match_id AND mp.match_id = ${matchId}
         AND m.game_code = 'lol'
    `;

    await rederiveEncountersInTx(tx, matchId);

    const after = await affectedStreamers(tx, matchId);
    await recomputeChampionStatsInTx(tx, [...new Set([...before, ...after])]);
  }

  const matches = await tx<MatchRow[]>`
    SELECT ${tx.unsafe(MATCH_COLUMNS)} FROM match m
    ${tx.unsafe(MATCH_SERIES_JOIN)} WHERE m.match_id = ${matchId}
  `;
  const participants = await tx<MatchParticipantRow[]>`
    SELECT ${tx.unsafe(PARTICIPANT_COLUMNS)} FROM match_participant
     WHERE match_id = ${matchId} ORDER BY participant_id
  `;
  const frames = await tx<EvidenceFrameRow[]>`
    SELECT * FROM match_evidence_frame WHERE match_id = ${matchId}
     ORDER BY at_sec NULLS LAST, created_at
  `;
  return { match: matches[0], participants, evidence_frames: frames };
}

/**
 * 경기를 공개에서 빼거나 되살린다 — 「기본 공개, 뺄 것만 제외」의 '제외'.
 *
 * `applyMatchReview` 를 거치므로 **챔피언 통계까지 같이 갱신된다.** 그게 중요한 이유는
 * `champion_stat` 이 뷰가 아니라 테이블이라, 뷰 필터만으로는 숨긴 경기가 통계에 남는다.
 */
export async function setMatchVisibility(matchId: string, visibility: MatchVisibility): Promise<MatchDetail | null> {
  return applyMatchReview(matchId, { visibility });
}

/**
 * 아무 칸도 안 고치고 **"검수했다"는 도장만** 찍거나 뗀다.
 *
 * ★ 왜 따로 두나 — `applyMatchReview`는 실제로 바뀐 칸이 있을 때만 `reviewed_at`을
 *   찍는다(그래야 "저장" 버튼을 눌러도 안 바뀐 폼이 매번 도장을 새로 찍지 않는다).
 *   그런데 검수자가 프레임을 보고 "이미 맞다, 더 볼 것 없다"고 판단했을 때는 **고칠 칸이
 *   없다** — 그 판단을 남길 자리가 없으면 자동 재수집이 계속 이 경기를 건드릴 수 있다.
 *   이 함수가 그 빈자리를 메운다: 값은 그대로 두고 잠금만 걸거나 푼다.
 */
export async function markMatchReviewed(matchId: string, reviewed: boolean): Promise<boolean> {
  return db().begin(async (tx) => {
    const [current] = await tx<{ reviewed_at: Date | null }[]>`
      SELECT reviewed_at FROM match WHERE match_id = ${matchId} FOR UPDATE`;
    if (!current) return false;
    await tx`UPDATE match SET reviewed_at = ${reviewed ? new Date() : null} WHERE match_id = ${matchId}`;
    // 이력에는 켜고 끈 사실만 남긴다(시각은 changed_at 이 이미 안다).
    await recordReviewChanges(tx, [{ match_id: matchId, entity: "match", entity_key: matchId, field: "admin_protected", before: current.reviewed_at != null, after: reviewed }]);
    return true;
  }) as Promise<boolean>;
}

/** 빈칸 여부와 무관하게 사람이 현재 값을 확인했다. 완료 해제는 자동 갱신 보호를 풀지 않는다. */
export async function setMatchReviewCompleted(matchId: string, completed: boolean, expectedVersion: number): Promise<void> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  await db().begin(async tx => {
    const [current] = await tx<{ review_completed_at: Date | null; review_version: number; reviewed_at: Date | null }[]>`
      SELECT review_completed_at, review_version, reviewed_at FROM match
       WHERE match_id = ${matchId} AND game_code = 'lol' FOR UPDATE`;
    if (!current) throw new Error("경기를 찾지 못했습니다.");
    if (current.review_version !== expectedVersion) throw new Error("경기 값이 바뀌었습니다. 새로고침 후 다시 확인해 주세요.");
    if ((current.review_completed_at != null) === completed) return;
    await tx`UPDATE match SET review_completed_at = ${completed ? new Date() : null},
      reviewed_at = CASE WHEN ${completed} THEN COALESCE(reviewed_at, now()) ELSE reviewed_at END
      WHERE match_id = ${matchId}`;
    await recordReviewChanges(tx, [
      { match_id: matchId, entity: "match", entity_key: matchId, field: "review_completed", before: current.review_completed_at != null, after: completed },
      ...(completed && !current.reviewed_at ? [{ match_id: matchId, entity: "match" as const, entity_key: matchId, field: "admin_protected", before: false, after: true }] : []),
    ]);
  });
}

/** 이미 있는 자리에 **사람·계정만** 붙인다. 판독값(챔피언·KDA·포지션)은 건드리지 않는다. */
export interface ParticipantLink {
  participant_id: number;
  /** 준 것만 바뀐다. `undefined` 는 "그대로 두라", `null` 은 "비워라". */
  streamer_id?: string | null;
  puuid?: string | null;
  observed_name?: string | null;
}

export type LinkParticipantsResult =
  | { status: "ok"; linked: number; missing: number[] }
  | { status: "reviewed" }
  | { status: "no_match" };

/**
 * 참가자에 **사람을 붙이기만** 한다 (`ck:merge --result` 의 `identify`).
 *
 * ★ 자동 식별은 판독값을 바꾸지 않는다. 과거 검수용 전 행 upsert 를 재사용했을 때
 *   생략한 챔피언·KDA 가 지워진 사고가 있어 이 계약을 분리했다.
 *
 * ★ 그리고 `reviewed_at` 을 찍지 않는다. 그건 "사람이 만졌다" 는 표시인데 식별은
 *   조사 파이프라인이 돌리는 자동 단계다. 찍어 버리면 사람 연결 하나 때문에 그 경기의
 *   챔피언·KDA 보강이 통째로 잠긴다(`upsertMatchFromScan` 은 매치 단위 전부/전무다).
 *
 * ★ 반대로 **사람이 검수한 경기는 건드리지 않는다.** 사람이 정한 매핑이 자동 식별보다 낫다.
 *
 * ⚠ 없는 자리는 만들지 않는다. 식별은 "이 자리의 사람은 누구" 이지 "자리를 추가" 가 아니다 —
 *   자리를 새로 만드는 것은 판독(`upsertMatchFromScan`)이나 검수 화면의 일이다.
 */
export async function linkParticipants(
  matchId: string,
  links: ParticipantLink[],
): Promise<LinkParticipantsResult> {
  return db().begin((tx) => linkParticipantsInTx(tx, matchId, links)) as Promise<LinkParticipantsResult>;
}

export async function linkParticipantsInTx(
  tx: Tx,
  matchId: string,
  links: ParticipantLink[],
): Promise<LinkParticipantsResult> {
  const m = await tx<{ reviewed_at: Date | null }[]>`
    SELECT reviewed_at FROM match WHERE match_id = ${matchId} FOR UPDATE
  `;
  if (m.length === 0) return { status: "no_match" };
  if (m[0].reviewed_at != null) return { status: "reviewed" };

  const before = await affectedStreamers(tx, matchId);
  const missing: number[] = [];
  let linked = 0;

  for (const l of links) {
    const cur = await tx<{ puuid: string | null; streamer_id: string | null; observed_name: string | null }[]>`
      SELECT puuid, streamer_id, observed_name FROM match_participant
       WHERE match_id = ${matchId} AND participant_id = ${l.participant_id}
    `;
    if (cur.length === 0) { missing.push(l.participant_id); continue; }

    // `undefined` 인 키를 버린다 — 준 것만 바뀐다.
    const patch: Record<string, unknown> = Object.fromEntries(
      Object.entries({
        streamer_id: l.streamer_id,
        puuid: l.puuid,
        observed_name: l.observed_name,
      }).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(patch).length === 0) continue;

    // 합쳐진 **최종 값**으로 검사한다. 안 준 쪽은 기존 값이 남으므로, 새 값만 보면
    // "기존 puuid + 새 streamer_id" 조합의 어긋남을 놓친다.
    const next = {
      participant_id: l.participant_id,
      puuid: (patch.puuid !== undefined ? patch.puuid : cur[0].puuid) as string | null,
      streamer_id: (patch.streamer_id !== undefined ? patch.streamer_id : cur[0].streamer_id) as string | null,
    };
    await assertIdentityAgrees(tx, next);

    // 셋 다 비면 CHECK 가 거부한다(0017·0020). 먼저 막아 이유를 말해준다.
    const observed = patch.observed_name !== undefined ? patch.observed_name : cur[0].observed_name;
    if (!next.puuid && !next.streamer_id && !observed) {
      throw new Error(
        `참가자 ${l.participant_id}: 사람·계정·화면 이름이 모두 비어 자리가 사라진다. `
        + `자리를 없애려면 식별이 아니라 검수에서 지울 것.`,
      );
    }

    await tx`
      UPDATE match_participant SET ${tx(patch, ...Object.keys(patch))}
       WHERE match_id = ${matchId} AND participant_id = ${l.participant_id}
    `;
    linked++;
  }

  if (linked > 0) {
    // 사람이 바뀌면 조우의 주인도 바뀐다. 옛 사람과 새 사람 **둘 다** 다시 계산한다.
    await rederiveEncountersInTx(tx, matchId);
    const after = await affectedStreamers(tx, matchId);
    await recomputeChampionStatsInTx(tx, [...new Set([...before, ...after])]);
  }
  return { status: "ok", linked, missing };
}

// ── 검수 화면이 한 번에 받는 것 ──────────────────────────────────────

export interface LeadWorkspace {
  lead: EventLeadRow;
  /** 그 VOD 에서 뽑은 프레임 전부 (시각 순). 매치에 안 붙은 것도 포함한다. */
  frames: EvidenceFrameRow[];
  /** 이 VOD 가 근거가 된 경기들. 한 VOD 에 경기가 여럿인 게 정상이다. */
  matches: MatchDetail[];
  /**
   * 조사자가 남긴 후보와 결론. **경기가 안 된 후보도 여기 있다** —
   * 미해결·대상 아님이 곧 조사 결과이고, 어드민이 그걸 봐야 "경기 0개"를
   * "경기 없음"으로 잘못 읽지 않는다 (계획 §5).
   */
  candidates: LeadCandidate[];
  /** 프레임·후보·경기의 모든 서술 기록. review_record가 단일 원천이다. */
  reviews: ReviewRecordRow[];
  /** 참가자에 사람을 붙일 때 고를 목록. 표시용 이름과 slug 만 준다. */
  streamers: { id: string; slug: string; display_name: string }[];
  /**
   * 경기를 붙일 대회 목록.
   * ★ 분류(`ck`/`tournament`)는 **대회에서 나온다**(`lol_match_category`). 검수에서 만든
   *   경기에 대회를 못 붙이면 내전인데 '기타' 로 들어가고, 상대전적 필터에서 사라진다.
   */
  events: { id: string; slug: string | null; name: string; kind: string }[];
}

/**
 * 검수 화면(`/admin/ck/[leadId]`) 한 장을 그리는 데 필요한 전부.
 *
 * ★ 화면이 질의를 여러 번 조립하지 않게 여기서 묶는다. 프레임이 어느 경기에 붙었는지가
 *   이 화면의 골자이므로(요구사항 1 — 지점별 체크), 프레임은 **매치별로 나누지 않고
 *   통째로** 준다 — 화면이 트랙으로 나누고, 안 붙은 것도 한 트랙으로 보여야 한다.
 */
export async function getLeadWorkspace(leadId: string): Promise<LeadWorkspace | null> {
  const lead = await getEventLead(leadId);
  if (!lead) return null;

  const sql = db();
  const frames = await listEvidenceFrames(leadId);

  // ★ 경기를 찾는 길(근거 프레임·후보·출처 URL)은 lead_match 뷰 하나가 정한다(0035).
  //   프레임 하나에만 기대면 근거를 안 붙인 경기가 통째로 안 보인다 — 검수자는 그걸
  //   "경기 없음" 으로 읽는다. 목록의 경기 수와 같은 정의를 써야 둘이 어긋나지 않는다.
  const matchIds = (await sql<{ match_id: string }[]>`
    SELECT lm.match_id FROM lead_match lm JOIN match m ON m.match_id = lm.match_id
     WHERE lead_id = ${lead.id}::uuid AND m.game_code = 'lol'
  `).map((r) => r.match_id);

  // ★ 경기마다 질의를 따로 내지 않는다. 예전엔 `Promise.all(ids.map(getMatchDetail))` 이라
  //   경기 수 × 2 만큼 질의가 동시에 나갔다(N+1). 실제 Postgres 에서도 낭비고, 개발
  //   하네스(PGlite 소켓)는 동시 연결을 못 받아 **ECONNRESET 으로 화면이 죽었다.**
  //   묶어서 세 번만 읽고 조립한다.
  const [matchRows, participantRows, streamers] = matchIds.length === 0
    ? [[], [], await sql<{ id: string; slug: string; display_name: string }[]>`
        SELECT id, slug, display_name FROM streamer ORDER BY display_name
      `]
    : [
      await sql<MatchRow[]>`
        SELECT ${sql.unsafe(MATCH_COLUMNS)} FROM match m
        ${sql.unsafe(MATCH_SERIES_JOIN)}
         WHERE m.match_id = ANY(${matchIds}) ORDER BY m.game_creation, m.match_id
      `,
      await sql<MatchParticipantRow[]>`
        SELECT ${sql.unsafe(PARTICIPANT_COLUMNS)},
               (SELECT sa.streamer_id FROM streamer_account sa
                 WHERE sa.puuid = match_participant.puuid AND sa.active_to IS NULL LIMIT 1) AS account_streamer_id
          FROM match_participant
         WHERE match_id = ANY(${matchIds}) ORDER BY match_id, participant_id
      `,
      await sql<{ id: string; slug: string; display_name: string }[]>`
        SELECT id, slug, display_name FROM streamer ORDER BY display_name
      `,
    ];

  const events = await sql<{ id: string; slug: string | null; name: string; kind: string }[]>`
    SELECT id, slug, name, kind FROM event
     ORDER BY starts_at DESC NULLS LAST, created_at DESC
     LIMIT 200
  `;

  const framesByMatch = new Map<string, EvidenceFrameRow[]>();
  for (const f of frames) {
    if (!f.match_id) continue;
    framesByMatch.set(f.match_id, [...(framesByMatch.get(f.match_id) ?? []), f]);
  }
  const partsByMatch = new Map<string, MatchParticipantRow[]>();
  for (const p of participantRows) {
    partsByMatch.set(p.match_id, [...(partsByMatch.get(p.match_id) ?? []), p]);
  }

  const reviews = matchIds.length
    ? await sql<ReviewRecordRow[]>`
        SELECT * FROM review_record
         WHERE lead_id = ${leadId}::uuid
            OR match_id = ANY(${matchIds}::text[])
         ORDER BY created_at, id
      `
    : await sql<ReviewRecordRow[]>`
        SELECT * FROM review_record
         WHERE lead_id = ${leadId}::uuid
         ORDER BY created_at, id
      `;

  const matches: MatchDetail[] = matchRows.map((match) => ({
    match,
    participants: partsByMatch.get(match.match_id) ?? [],
    evidence_frames: framesByMatch.get(match.match_id) ?? [],
  }));

  return { lead, frames, matches, candidates: lead.raw.candidates ?? [], reviews, streamers, events };
}

// ── 미확인 참가자 — 「조사해서 채울 목록」 ───────────────────────────

/**
 * 화면에서 이름은 읽었는데 **사람을 못 붙인 자리**.
 *
 * ★ 새 표를 만들지 않는다 — `match_participant` 에서 그대로 파생된다(원칙 5).
 *   별도 큐를 두면 원본과 큐가 어긋나고, 어긋난 걸 아무도 모른다.
 *
 * ★ 이름으로 묶어서 센다. 같은 사람이 한 내전의 네 세트에 다 나오므로, **등장 횟수가
 *   곧 조사 가치**다 — 한 번 알아내면 네 경기가 한꺼번에 채워진다.
 */
/** 화면에서 확인한 자리와 검수 기준값. 이름은 검색 단서이며 저장 키가 아니다. */
export interface UnidentifiedSelection {
  match_id: string;
  participant_id: number;
  observed_name: string;
  reviewed_at: string | null;
}
export interface UnidentifiedSeat extends UnidentifiedSelection {
  series_id: string | null;
  played_at: string;
  team_id: number;
  champion_name: string | null;
}
export interface UnidentifiedParticipant {
  targets: UnidentifiedSeat[];
  observed_name: string;
  /** 이 이름으로 남은 자리 수. 조사 우선순위다. */
  seats: number;
  /** 그 자리들이 속한 경기. 검수 화면으로 바로 갈 수 있게 준다. */
  match_ids: string[];
  /** 쓴 챔피언들 — 같은 사람인지 가늠하는 단서가 된다. */
  champions: string[];
  /** 같은 편이었던 **등록된** 사람들. 누구 팀이었나가 사람 찾는 가장 센 단서다. */
  teammates: string[];
  first_seen: Date;
  last_seen: Date;
}

/**
 * 미확인 이름 수. 목록은 페이지로 끊어 보여 주므로 전체가 몇인지 따로 센다.
 * ★ 예전엔 100명에서 조용히 잘렸다 — 3판에 나온 '붕어에몽' 이 102번째라 화면에 없었다.
 */
export async function countUnidentifiedNames(): Promise<number> {
  const [r] = await db()<{ n: number }[]>`
    SELECT count(DISTINCT mp.observed_name)::int AS n
      FROM match_participant mp
      JOIN match m ON m.match_id = mp.match_id AND m.visibility = 'public'
     WHERE mp.streamer_id IS NULL AND mp.puuid IS NULL AND mp.observed_name IS NOT NULL`;
  return r.n;
}

export async function listUnidentifiedParticipants(limit = 100, offset = 0): Promise<UnidentifiedParticipant[]> {
  const sql = db();
  return sql<UnidentifiedParticipant[]>`
    WITH seat AS (
      SELECT mp.match_id, mp.participant_id, mp.observed_name, mp.team_id,
             mp.champion_name, m.game_creation, m.series_id, m.reviewed_at
        FROM match_participant mp
        JOIN match m ON m.match_id = mp.match_id AND m.visibility = 'public'
       WHERE mp.streamer_id IS NULL AND mp.puuid IS NULL AND mp.observed_name IS NOT NULL
    )
    SELECT seat.observed_name,
           count(*)::int                                          AS seats,
           jsonb_agg(jsonb_build_object(
             'match_id', seat.match_id, 'participant_id', seat.participant_id,
             'observed_name', seat.observed_name, 'reviewed_at', seat.reviewed_at,
             'series_id', seat.series_id, 'played_at', seat.game_creation,
             'team_id', seat.team_id, 'champion_name', seat.champion_name
           ) ORDER BY seat.game_creation, seat.match_id, seat.participant_id) AS targets,
           array_agg(DISTINCT seat.match_id)                      AS match_ids,
           array_remove(array_agg(DISTINCT seat.champion_name), NULL) AS champions,
           min(seat.game_creation)                                AS first_seen,
           max(seat.game_creation)                                AS last_seen,
           -- 같은 경기·같은 팀의 등록된 사람들. 사람을 찾을 때 이게 제일 센 단서다.
           -- ⚠ 사람을 고르는 순서는 **여기서도 같아야 한다** — ownerOf.get(puuid) 다음 streamer_id
           --   (transform.ts). 팀원이 계정으로만 붙어 있으면 streamer_id 는 비어 있으므로,
           --   그것만 보면 "같은 팀에 아무도 없다" 가 되어 단서가 통째로 사라진다.
           COALESCE((
             SELECT array_agg(DISTINCT s2.display_name)
               FROM seat s0
               JOIN match_participant mate ON mate.match_id = s0.match_id
                                          AND mate.team_id = s0.team_id
                                          AND mate.participant_id <> s0.participant_id
               LEFT JOIN streamer_account sa2 ON sa2.puuid = mate.puuid AND sa2.active_to IS NULL
               JOIN streamer s2 ON s2.id = COALESCE(sa2.streamer_id, mate.streamer_id)
              WHERE s0.observed_name = seat.observed_name
           ), '{}') AS teammates
      FROM seat
     GROUP BY seat.observed_name
     ORDER BY count(*) DESC, max(seat.game_creation) DESC, seat.observed_name
     LIMIT ${limit} OFFSET ${offset}
  `;
}

/**
 * 관리자 일괄 검수. 화면에서 선택한 자리만 한 트랜잭션에 저장한다.
 * 자동 identify(linkParticipants)의 검수 표시 없는 계약과 분리한다.
 */
export async function reviewUnidentifiedParticipants(
  targets: UnidentifiedSelection[],
  streamerId: string,
): Promise<{ linked: number; matches: string[]; skipped: string[] }> {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("연결할 자리를 선택해 주세요.");
  const byMatch = new Map<string, UnidentifiedSelection[]>();
  const seen = new Set<string>();
  for (const t of targets) {
    if (!t || typeof t.match_id !== "string" || !t.match_id || !Number.isInteger(t.participant_id)
      || t.participant_id < 1 || typeof t.observed_name !== "string" || !t.observed_name
      || !(t.reviewed_at === null || (typeof t.reviewed_at === "string" && Number.isFinite(Date.parse(t.reviewed_at))))) {
      throw new Error("자리 ID와 편집 기준값이 올바르지 않습니다. 목록을 새로 불러오세요.");
    }
    const key = JSON.stringify([t.match_id, t.participant_id]);
    if (seen.has(key)) throw new Error("같은 자리가 두 번 선택됐습니다.");
    seen.add(key);
    byMatch.set(t.match_id, [...(byMatch.get(t.match_id) ?? []), t]);
  }
  try {
    return await db().begin(async tx => {
      // 경기 잠금 순서를 통일한다. 배치 전체가 같은 트랜잭션이므로 반쪽 커밋은 없다.
      const ids = [...byMatch.keys()].sort();
      const rows = await tx<MatchRow[]>`
        SELECT ${tx.unsafe(MATCH_COLUMNS)} FROM match m
        ${tx.unsafe(MATCH_SERIES_JOIN)}
         WHERE m.match_id = ANY(${ids}::text[]) ORDER BY m.match_id FOR UPDATE OF m
      `;
      const matches: string[] = [], skipped: string[] = [];
      let linked = 0;
      for (const id of ids) {
        const match = rows.find(row => row.match_id === id);
        if (!match) throw new Error(`${id}: 경기가 없어졌습니다. 목록을 새로 불러오세요.`);
        const seats = byMatch.get(id)!;
        for (const t of seats) checkedReviewChanges(match as unknown as Record<string, unknown>, {},
          {visibility: "public", reviewed_at: t.reviewed_at}, ["visibility", "reviewed_at"]);
        if (match.reviewed_at !== null) { skipped.push(id); continue; }
        await applyMatchReviewInTx(tx, id, {participants: {patch: seats.map(t => ({
          participant_id: t.participant_id,
          changes: {streamer_id: streamerId},
          expect: {streamer_id: null, puuid: null, observed_name: t.observed_name},
        }))}});
        matches.push(id); linked += seats.length;
      }
      return {linked, matches, skipped};
    }) as { linked: number; matches: string[]; skipped: string[] };
  } catch (error) {
    if ((error as {constraint_name?: string}).constraint_name === "match_participant_streamer_uq") {
      throw new Error("선택한 경기 안에 이 사람이 이미 있거나 같은 사람에게 두 자리를 지정했습니다. 이번 연결은 모두 취소됐습니다.");
    }
    throw error;
  }
}

/** slug → streamer_id. 화면이 사람을 slug 로 받으므로(목록에서 고른다) 해석이 필요하다. */
export async function streamerIdBySlug(slug: string): Promise<string | null> {
  return db().begin((tx) => streamerIdBySlugInTx(tx, slug)) as Promise<string | null>;
}

export async function streamerIdBySlugInTx(tx: Tx, slug: string): Promise<string | null> {
  const rows = await tx<{ id: string }[]>`SELECT id FROM streamer WHERE slug = ${slug}`;
  return rows[0]?.id ?? null;
}

/**
 * **이미 들어와 있는 경기 중 이 판일 수 있는 것**을 찾는다.
 *
 * ★ 왜 필요한가 (계획 §6): 한 내전을 평균 여섯 명이 방송한다. 다른 사람 시점에서 같은 판을
 *   또 만나면 **기존 경기에 근거만 붙여야** 하는데, VOD 번호로 `match_id` 를 만들면
 *   같은 판이 시점마다 다른 경기로 갈라진다 — 상대전적이 통째로 부풀어 이 사이트의
 *   존재 이유가 무너진다. 그래서 조사자가 "이 판 이미 있나?" 를 물을 창구를 둔다.
 *
 * ★ 판정하지 않는다. 시각이 가까운 후보를 **참가자 겹침과 함께** 돌려주고,
 *   같은 판인지는 조사자가 정한다(계획 §4 — 자동 결론을 만들지 않는다).
 */
export async function findMatchesAround(opts: {
  at: Date;
  /** 앞뒤 허용 폭(분). 기본 90분 — 다전제 한 시리즈가 들어갈 만큼. */
  window_minutes?: number;
  /**
   * 한 시각 ± 폭 대신 **구간 전체**를 본다 — VOD 하나의 방송 시작~끝(`ck:merge --find-match --vod`).
   * 주면 `at`·`window_minutes` 는 무시한다.
   */
  range?: { from: Date; to: Date };
  /** 이 사람들이 낀 경기를 위로 올린다. slug 가 아니라 streamer_id 다. */
  streamer_ids?: string[];
  /** 방송 주인. 주면 그 사람의 팀·챔피언을 같이 돌려준다 — 같은 판인지 화면과 대조할 값이다. */
  owner_streamer_id?: string;
}): Promise<{
  match_id: string;
  game_creation: Date;
  /** 'date' 면 시각이 어림이라 VOD 구간으로 옮기면 안 된다. */
  game_creation_precision: "datetime" | "date" | null;
  /** 초. 없으면 끝 경계를 모른다. */
  game_duration: number | null;
  winning_team: 100 | 200 | null;
  visibility: MatchVisibility;
  origin: MatchOrigin | null;
  reviewed_at: Date | null;
  event_name: string | null;
  series_id: string | null;
  series_game_no: number | null;
  /** 세트 순서를 VOD 에서 직접 확인했나. 번호가 있어도 false 일 수 있다(추정 번호). */
  set_order_known: boolean;
  /** 넘긴 사람 중 이 경기에 있는 수. 많으면 같은 판일 가능성이 높다 — 판정은 사람이 한다. */
  overlap: number;
  participant_names: string[];
  participant_count: number;
  unidentified_count: number;
  champion_missing_count: number;
  kda_missing_count: number;
  evidence_frame_count: number;
  result_frame_count: number;
  /** 최종 판정 근거의 정본은 match.result_evidence가 아니라 review_record다. */
  has_final_evidence: boolean;
  open_questions: string[];
  owner_team_id: number | null;
  owner_champion: string | null;
}[]> {
  const sql = db();
  const ids = opts.streamer_ids ?? [];
  const owner = opts.owner_streamer_id ?? null;
  const w = opts.window_minutes ?? 90;
  const from = opts.range ? opts.range.from : new Date(opts.at.getTime() - w * 60_000);
  const to = opts.range ? opts.range.to : new Date(opts.at.getTime() + w * 60_000);
  return sql`
    SELECT m.match_id, m.game_creation, m.game_creation_precision, m.game_duration,
           m.winning_team, m.visibility, m.origin, m.reviewed_at,
           ev.name AS event_name, m.series_id, m.series_game_no,
           COALESCE(ms.set_order_known, false) AS set_order_known,
           COUNT(*) FILTER (
             WHERE ${ids.length > 0} AND COALESCE(sa.streamer_id, mp.streamer_id) = ANY(${ids}::uuid[])
           )::int AS overlap,
           COALESCE(
             array_agg(DISTINCT COALESCE(s.display_name, mp.observed_name))
               FILTER (WHERE COALESCE(s.display_name, mp.observed_name) IS NOT NULL),
             '{}'
           ) AS participant_names,
           COUNT(mp.participant_id)::int AS participant_count,
           COUNT(mp.participant_id) FILTER (
             WHERE mp.streamer_id IS NULL AND mp.puuid IS NULL
           )::int AS unidentified_count,
           COUNT(mp.participant_id) FILTER (WHERE mp.champion_id = 0)::int AS champion_missing_count,
           COUNT(mp.participant_id) FILTER (
             WHERE mp.kills IS NULL OR mp.deaths IS NULL OR mp.assists IS NULL
           )::int AS kda_missing_count,
           evidence.frame_count::int AS evidence_frame_count,
           evidence.result_count::int AS result_frame_count,
           EXISTS (
             SELECT 1 FROM review_record rr
              WHERE rr.match_id = m.match_id AND rr.type = 'final_evidence'
           ) AS has_final_evidence,
           COALESCE(questions.items, '{}') AS open_questions,
           (array_agg(mp.team_id) FILTER (
             WHERE ${owner}::uuid IS NOT NULL AND COALESCE(sa.streamer_id, mp.streamer_id) = ${owner}::uuid
           ))[1] AS owner_team_id,
           (array_agg(mp.champion_name) FILTER (
             WHERE ${owner}::uuid IS NOT NULL AND COALESCE(sa.streamer_id, mp.streamer_id) = ${owner}::uuid
           ))[1] AS owner_champion
      FROM match m
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
      LEFT JOIN match_participant mp ON mp.match_id = m.match_id
      LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
      LEFT JOIN streamer s ON s.id = COALESCE(sa.streamer_id, mp.streamer_id)
      LEFT JOIN LATERAL (
        SELECT count(*) AS frame_count,
               count(*) FILTER (WHERE mef.kind = 'result') AS result_count
          FROM match_evidence_frame mef
         WHERE mef.match_id = m.match_id
      ) evidence ON true
      LEFT JOIN LATERAL (
        SELECT array_agg(DISTINCT rr.body) AS items
          FROM event_lead el
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(el.raw -> 'candidates', '[]'::jsonb)) c
          JOIN review_record rr ON rr.lead_id = el.id
                               AND rr.candidate_id = c ->> 'id'
                               AND rr.type = 'question'
         WHERE c ->> 'match_id' = m.match_id
      ) questions ON true
     WHERE m.source = 'manual'
       AND m.game_creation BETWEEN ${from}::timestamptz AND ${to}::timestamptz
     GROUP BY m.match_id, m.game_creation, m.game_creation_precision, m.game_duration,
              m.winning_team, m.visibility, m.origin, m.reviewed_at,
              ev.name, m.series_id, m.series_game_no, ms.set_order_known, evidence.frame_count, evidence.result_count,
              questions.items
     ORDER BY overlap DESC, m.game_creation
     LIMIT ${opts.range ? 200 : 25}
  `;
}

/** 대회 시드처럼 VOD가 없는 경기도 같은 값 편집 화면으로 연다. */
export async function getMatchReviewWorkspace(matchId: string) {
  const detail = await getMatchDetail(matchId);
  if (!detail || detail.match.game_code !== "lol") return null;
  const sql = db();
  const [lead] = await sql<{ id: string }[]>`
    SELECT lead_id AS id FROM lead_match WHERE match_id = ${matchId} ORDER BY lead_id LIMIT 1`;
  const streamers = await sql<{ id: string; slug: string; display_name: string }[]>`
    SELECT id, slug, display_name FROM streamer ORDER BY display_name`;
  const events = await sql<{ id: string; slug: string | null; name: string; kind: string }[]>`
    SELECT id, slug, name, kind FROM event WHERE game_code = 'lol' ORDER BY starts_at DESC NULLS LAST`;
  return { detail, leadId: lead?.id, streamers, events };
}

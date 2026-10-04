/**
 * FC 검수의 경기 모양 — **경기 하나 = 키 하나**, 그 경기를 본 것들은 **시점**이다 (CK 의 경기·시점 구조와 같다).
 *
 *   정본 경기  넥슨 기록(provider_api)이 있으면 그것, 없으면 처음 찾은 화면 기록(fcs:…).
 *              화면 기록이 다른 기록에 이어져 있으면(fco_screen_link) 그 대상이 정본이다.
 *   시점       넥슨 기록(공식 값) · VOD 마다 하나(그 방송 화면 사진 + 화면 기록이 읽은 값).
 *              맥락·검수 완료·공개 여부는 시점이 아니라 **정본 경기에 하나**다.
 *
 * 목록 단위(어느 경기를 한 화면에서 같이 보나)는 여기가 아니라 sessions.ts(대전)와 대회 단위다.
 * ★ 데이터 구조는 바꾸지 않는다(마이그레이션 없음). 이미 있는 화면 기록·연결·근거를 읽는 쪽에서 묶는다.
 */

import type postgres from "postgres";

import { db } from "../../db/client.ts";
import { stampFcoReview, type FcoContextStatus } from "./context.ts";
import { compareMatches, type MatchSig } from "./screen.ts";
import { updateScreenSides } from "./screen-review.ts";

// ── 본 방송 (단일 출처) ─────────────────────────────────────────────

/**
 * obs : (정본 경기, 그 경기를 본 VOD) — 화면 기록의 VOD, 근거 사진의 VOD 를 정본 경기로 올려 모은다.
 * 대전 묶음(sessions.ts)이 "VOD 로 본 경기인가"·"누구 방송에 나왔나"를 이것으로 안다.
 */
export const OBS_CTE = `
  obs AS (
    SELECT COALESCE(l.api_match_id, m.match_id) AS canon, split_part(split_part(m.match_id, ':', 2), '@', 1)::bigint AS vod
      FROM match m LEFT JOIN fco_screen_link l ON l.screen_match_id = m.match_id
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan' AND m.match_id LIKE 'fcs:%'
    UNION
    SELECT COALESCE(l.api_match_id, e.match_id) AS canon, e.vod_title_no AS vod
      FROM fco_context_evidence e LEFT JOIN fco_screen_link l ON l.screen_match_id = e.match_id
     WHERE e.vod_title_no IS NOT NULL
  )`;

// ── 작업대 ───────────────────────────────────────────────────────────

export interface FcoSide { name: string; nickname: string; score: number | null; outcome: string | null; streamer_id: string | null; streamer_slug: string | null; identity_basis: string | null }
export interface FcoViewFrame { key: string; path: string; sec: number | null; vod: string | null; label: string | null; result: boolean; observed: string; why: string | null }
export interface FcoMismatch { field: string; match: string; view: string }
export interface FcoMatchView {
  /** 'api' 또는 'vod:<번호>' */
  key: string;
  kind: "api" | "vod";
  vod: string | null;
  /** 그 VOD 방송 주인 */
  streamer: string | null;
  /** 이 시점이 읽은 값을 가진 화면 기록. 넥슨 기록 시점·사진만 있는 시점은 null */
  screen: { match_id: string; review_version: number; linked: { decided_by: string } | null } | null;
  /** 이 시점이 읽은 값 — 넥슨 기록이면 공식 값. 사진만 있는 시점이면 null */
  sides: FcoSide[] | null;
  frames: FcoViewFrame[];
  /** 경기 값과 다른 곳 */
  mismatches: FcoMismatch[];
}
export interface FcoContextView {
  status: FcoContextStatus;
  event: { id: string; slug: string | null; name: string; kind: string; organizer: string | null; source_url: string | null } | null;
  judgment: { judgment: string; note: string; created_by: string } | null;
}
export interface FcoCandidate { match_id: string; source: string; at: string; gap_sec: number; verdict: "same" | "maybe" | "none"; sides: { nickname: string; score: number | null; streamer_name: string | null }[] }
export interface FcoMatchUnit {
  match_id: string;
  provider_match_id: string | null;
  source: string;
  played_at: string;
  mode_key: string | null;
  /** 경기 값을 사람이 고칠 수 있나 — 화면 기록이 정본일 때만(넥슨 기록은 정본이라 고치지 않는다) */
  editable: boolean;
  sides: FcoSide[];
  context: FcoContextView;
  context_completed_at: string | null;
  context_version: number;
  review_completed_at: string | null;
  review_version: number;
  views: FcoMatchView[];
  /** 정본이 화면 기록이고 아무 데도 안 이어졌을 때만 — 같은 경기일 수 있는 다른 기록 */
  candidates: FcoCandidate[];
  /** 사진 없는 근거 — 채팅·공지·링크·메모(조사 기록) */
  notes: { key: string; kind: string; vod: string | null; sec: number | null; url: string | null; observed: string; why: string | null }[];
}

const norm = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
const sideKey = (s: { streamer_id: string | null; nickname: string }) => s.streamer_id ?? `name:${norm(s.nickname)}`;
const NEARBY_SEC = 30 * 60;
const ROLE_LABEL: Record<string, string> = { pre: "경기 전", start: "시작", end: "종료", post: "종료 후", result: "결과" };

/** 시점이 읽은 값과 경기 값을 비교한다. 같은 사람끼리 맞춘다(사람 키가 엇갈리면 순서를 바꿔 본다). */
export function viewMismatches(match: FcoSide[], view: FcoSide[]): FcoMismatch[] {
  if (match.length !== 2 || view.length !== 2) return [];
  const direct = Number(sideKey(match[0]) === sideKey(view[0])) + Number(sideKey(match[1]) === sideKey(view[1]));
  const swapped = Number(sideKey(match[0]) === sideKey(view[1])) + Number(sideKey(match[1]) === sideKey(view[0]));
  const v = swapped > direct ? [view[1], view[0]] : [view[0], view[1]];
  const out: FcoMismatch[] = [];
  for (const i of [0, 1]) {
    const m = match[i], o = v[i], who = m.name;
    if (norm(m.nickname) !== norm(o.nickname)) out.push({ field: `${who} 닉네임`, match: m.nickname, view: o.nickname });
    if (m.score != null && o.score != null && m.score !== o.score) out.push({ field: `${who} 점수`, match: String(m.score), view: String(o.score) });
    const known = (x: string | null) => x === "win" || x === "loss" || x === "draw";
    if (known(m.outcome) && known(o.outcome) && m.outcome !== o.outcome) out.push({ field: `${who} 승패`, match: m.outcome!, view: o.outcome! });
  }
  return out;
}

type SideRow = FcoSide & { match_id: string; side_no: number };

/**
 * 정본 경기들 → 작업대가 보는 모양(경기 값·시점·후보·맥락·완료). 방송·대회·단독 경기 단위가 **같이 쓴다**.
 * 순서는 넘긴 순서가 아니라 경기 시각 순이다(대회는 부르는 쪽이 브래킷 순으로 다시 놓는다).
 */
export async function buildMatchUnits(canon: string[]): Promise<FcoMatchUnit[]> {
  if (!canon.length) return [];
  const sql = db();
  const matches = await sql<{
    match_id: string; provider_match_id: string | null; source: string; game_creation: Date; mode_key: string | null;
    context_completed_at: Date | null; context_version: number;
    review_completed_at: Date | null; review_version: number;
    event_id: string | null; event_slug: string | null; event_name: string | null; event_kind: string | null; event_organizer: string | null; event_source_url: string | null;
    judgment: string | null; judgment_note: string | null; judgment_by: string | null;
  }[]>`
    SELECT m.match_id, d.provider_match_id, m.source, m.game_creation, m.mode_key, m.review_completed_at, m.review_version, m.context_review_completed_at AS context_completed_at, m.context_review_version AS context_version,
           e.id AS event_id, e.slug AS event_slug, e.name AS event_name, e.kind AS event_kind, e.organizer AS event_organizer, e.source_url AS event_source_url,
           ctx.judgment, ctx.note AS judgment_note, ctx.created_by AS judgment_by
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
      LEFT JOIN LATERAL (SELECT judgment, note, created_by FROM fco_match_context c WHERE c.match_id = m.match_id ORDER BY c.created_at DESC LIMIT 1) ctx ON true
     WHERE m.match_id = ANY(${canon})
     ORDER BY m.game_creation, m.match_id`;

  // 시점 재료: 정본에 이어진 화면 기록(+ 정본 자신이 화면 기록이면 그것)
  const screens = await sql<{ match_id: string; canon: string; review_version: number; decided_by: string | null }[]>`
    SELECT m.match_id, COALESCE(l.api_match_id, m.match_id) AS canon, m.review_version, l.decided_by
      FROM match m LEFT JOIN fco_screen_link l ON l.screen_match_id = m.match_id
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan' AND m.match_id LIKE 'fcs:%'
       AND COALESCE(l.api_match_id, m.match_id) = ANY(${canon})`;
  const ids = [...new Set([...canon, ...screens.map((s) => s.match_id)])];
  const sides = await sql<SideRow[]>`
    SELECT p.match_id, p.side_no, coalesce(s.display_name, p.nickname) AS name, p.nickname, coalesce(p.score_display, p.goals) AS score, p.outcome,
           p.streamer_id, s.slug AS streamer_slug, p.identity_basis
      FROM fco_match_participant p LEFT JOIN streamer s ON s.id = p.streamer_id
     WHERE p.match_id = ANY(${ids}) ORDER BY p.match_id, p.side_no`;
  // 사진: 정본에 걸린 근거(이어질 때 복사된 화면 사진 포함) + 화면 기록 자신의 근거. 같은 사진은 한 번.
  const evidence = await sql<{ match_id: string; evidence_key: string; frame_path: string; at_sec: number | null; vod_title_no: string | null; role: string | null; observed: string; why: string | null }[]>`
    SELECT match_id, evidence_key, frame_path, at_sec, vod_title_no::text AS vod_title_no, role, observed, why
      FROM fco_context_evidence WHERE match_id = ANY(${ids}) AND frame_path IS NOT NULL
     ORDER BY at_sec NULLS LAST, evidence_key`;
  const notes = await sql<{ match_id: string; evidence_key: string; kind: string; vod_title_no: string | null; at_sec: number | null; url: string | null; observed: string; why: string | null }[]>`
    SELECT match_id, evidence_key, kind, vod_title_no::text AS vod_title_no, at_sec, url, observed, why
      FROM fco_context_evidence WHERE match_id = ANY(${ids}) AND frame_path IS NULL ORDER BY at_sec NULLS LAST, evidence_key`;
  const vodsSeen = [...new Set([...evidence.map((e) => e.vod_title_no), ...screens.map((s) => s.match_id.split(":")[1].split("@")[0])].filter((x): x is string => !!x))];
  const owners = vodsSeen.length ? await sql<{ vod: string; streamer: string | null }[]>`
    SELECT DISTINCT ON (v.vod) v.vod, st.display_name AS streamer
      FROM unnest(${vodsSeen}::text[]) AS v(vod)
      LEFT JOIN event_lead el ON el.url LIKE '%/player/' || v.vod
      LEFT JOIN streamer st ON st.id = el.streamer_id
     ORDER BY v.vod, st.display_name NULLS LAST` : [];
  const ownerOf = (v: string | null) => (v ? owners.find((o) => o.vod === v)?.streamer ?? null : null);
  const sidesOf = (id: string): FcoSide[] => sides.filter((s) => s.match_id === id).map(({ match_id: _m, side_no: _n, ...x }) => x);
  const frameOf = (e: (typeof evidence)[number]): FcoViewFrame => ({
    key: `${e.match_id}:${e.evidence_key}`, path: e.frame_path, sec: e.at_sec, vod: e.vod_title_no,
    label: e.role ? ROLE_LABEL[e.role] ?? e.role : null, result: e.role === "result", observed: e.observed, why: e.why,
  });

  // 같은 경기일 수 있는 다른 기록 — 정본이 화면 기록이고 이어지지 않은 경기만. 시각 범위 하나로 한 번에 읽는다.
  const lonely = matches.filter((m) => m.source === "manual");
  const pool = lonely.length ? await sql<{ match_id: string; source: string; game_creation: Date; parts: { nickname: string; score: number | null; streamer_id: string | null; streamer_name: string | null }[] | null }[]>`
    SELECT m.match_id, m.source, m.game_creation,
           (SELECT json_agg(json_build_object('nickname', p.nickname, 'score', coalesce(p.score_display, p.goals), 'streamer_id', p.streamer_id, 'streamer_name', s.display_name) ORDER BY p.side_no)
              FROM fco_match_participant p LEFT JOIN streamer s ON s.id = p.streamer_id WHERE p.match_id = m.match_id) AS parts
      FROM match m
     WHERE m.game_code = 'fconline' AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
       AND m.game_creation BETWEEN ${new Date(Math.min(...lonely.map((m) => m.game_creation.getTime())) - NEARBY_SEC * 1000)}
                               AND ${new Date(Math.max(...lonely.map((m) => m.game_creation.getTime())) + NEARBY_SEC * 1000)}` : [];

  return matches.map((m): FcoMatchUnit => {
    const mine = sidesOf(m.match_id);
    const views: FcoMatchView[] = [];
    if (m.source === "provider_api") {
      views.push({ key: "api", kind: "api", vod: null, streamer: null, screen: null, sides: mine, frames: [], mismatches: [] });
    }
    // VOD 마다 하나 — 화면 기록이 있으면 그 기록이 읽은 값, 사진은 그 VOD 의 근거 전부
    const myScreens = screens.filter((s) => s.canon === m.match_id);
    const myEvidence = evidence.filter((e) => e.match_id === m.match_id || myScreens.some((s) => s.match_id === e.match_id));
    const vods = [...new Set([
      ...myScreens.map((s) => s.match_id.split(":")[1].split("@")[0]),
      ...myEvidence.map((e) => e.vod_title_no).filter((x): x is string => !!x),
    ])].sort((a, b) => Number(a) - Number(b));
    for (const v of vods) {
      const scr = myScreens.find((s) => s.match_id.startsWith(`fcs:${v}@`)) ?? null;
      const seen = new Set<string>();
      const frames = myEvidence.filter((e) => e.vod_title_no === v || (scr && e.match_id === scr.match_id))
        .filter((e) => (seen.has(e.frame_path) ? false : (seen.add(e.frame_path), true))).map(frameOf);
      const read = scr ? sidesOf(scr.match_id) : null;
      views.push({
        key: `vod:${v}`, kind: "vod", vod: v, streamer: ownerOf(v),
        screen: scr ? { match_id: scr.match_id, review_version: scr.review_version, linked: scr.decided_by ? { decided_by: scr.decided_by } : null } : null,
        sides: read, frames,
        mismatches: read && scr && scr.match_id !== m.match_id ? viewMismatches(mine, read) : [],
      });
    }

    let candidates: FcoCandidate[] = [];
    if (m.source === "manual" && mine.length === 2) {
      const atMs = m.game_creation.getTime();
      const sig: MatchSig = { at: atMs, sides: [{ key: sideKey(mine[0]), score: mine[0].score, name: mine[0].nickname }, { key: sideKey(mine[1]), score: mine[1].score, name: mine[1].nickname }] };
      for (const n of pool.filter((x) => x.match_id !== m.match_id && Math.abs(x.game_creation.getTime() - atMs) <= NEARBY_SEC * 1000)
        .sort((a, b) => Math.abs(a.game_creation.getTime() - atMs) - Math.abs(b.game_creation.getTime() - atMs)).slice(0, 12)) {
        const parts = n.parts ?? [];
        if (parts.length !== 2) continue;
        const verdict = compareMatches(sig, { at: n.game_creation.getTime(), sides: [{ key: sideKey(parts[0]), score: parts[0].score, name: parts[0].nickname }, { key: sideKey(parts[1]), score: parts[1].score, name: parts[1].nickname }] });
        const sharesPerson = parts.some((p) => p.streamer_id && mine.some((x) => x.streamer_id === p.streamer_id));
        if (verdict === "no" && !sharesPerson) continue;
        candidates.push({ match_id: n.match_id, source: n.source, at: n.game_creation.toISOString(), gap_sec: Math.round((n.game_creation.getTime() - atMs) / 1000), verdict: verdict === "no" ? "none" : verdict, sides: parts.map((p) => ({ nickname: p.nickname, score: p.score, streamer_name: p.streamer_name })) });
      }
      const rank = { same: 0, maybe: 1, none: 2 } as const;
      candidates = candidates.sort((a, b) => rank[a.verdict] - rank[b.verdict] || Math.abs(a.gap_sec) - Math.abs(b.gap_sec));
    }

    return {
      match_id: m.match_id, provider_match_id: m.provider_match_id, source: m.source, played_at: m.game_creation.toISOString(), mode_key: m.mode_key,
      editable: m.source === "manual", sides: mine,
      context: {
        // 맥락 파생 규칙은 기존과 같다: 행사 연결이 있으면 그 행사, 없으면 최신 판단, 그것도 없으면 미조사.
        status: m.event_id ? "event" : m.judgment === "casual" || m.judgment === "unresolved" ? m.judgment : "uninvestigated",
        event: m.event_id ? { id: m.event_id, slug: m.event_slug, name: m.event_name ?? "", kind: m.event_kind ?? "other", organizer: m.event_organizer, source_url: m.event_source_url } : null,
        judgment: m.judgment ? { judgment: m.judgment, note: m.judgment_note ?? "", created_by: m.judgment_by ?? "auto" } : null,
      },
      context_completed_at: m.context_completed_at?.toISOString() ?? null, context_version: m.context_version,
      review_completed_at: m.review_completed_at?.toISOString() ?? null, review_version: m.review_version,
      views, candidates,
      notes: notes.filter((n) => n.match_id === m.match_id || myScreens.some((x) => x.match_id === n.match_id))
        .map((n) => ({ key: `${n.match_id}:${n.evidence_key}`, kind: n.kind, vod: n.vod_title_no, sec: n.at_sec, url: n.url, observed: n.observed, why: n.why })),
    };
  });

}

/** 사람 선택 목록 — 공개 스트리머 전부, FC 계정이 있는 사람 먼저(화면 경기의 상대는 계정이 없는 경우가 흔하다). */
export async function listPickableStreamers(): Promise<{ slug: string; display_name: string; has_fc: boolean }[]> {
  return db()<{ slug: string; display_name: string; has_fc: boolean }[]>`
    SELECT s.slug, s.display_name, EXISTS (SELECT 1 FROM streamer_fco_account a WHERE a.streamer_id = s.id AND a.visibility = 'public') AS has_fc
      FROM streamer s WHERE s.visibility = 'public' ORDER BY has_fc DESC, s.display_name`;
}

/**
 * 대회 단위의 정본 경기 — 대회 결정·후보 목록(getFcoReviewWorkspace, 넥슨 기록만)에 더해 **대회에 붙은 화면 기록 정본**도.
 * 화면 기록만 있는 경기가 대회에 붙으면 그 대회 단위에서 봐야 하는데(대전 묶음은 대회 경기를 뺀다), 대회 목록이 넥슨 기록만 보면 어디에도 안 나온다.
 */
export async function eventScreenMatchIds(eventId: string): Promise<string[]> {
  return (await db()<{ match_id: string }[]>`
    SELECT m.match_id FROM match m
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN fco_screen_link l ON l.screen_match_id = m.match_id
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND l.screen_match_id IS NULL
       AND COALESCE(ms.event_id, m.event_id) = ${eventId}::uuid
     ORDER BY m.game_creation`).map((r) => r.match_id);
}

// ── 완료 (아무 FC 정본 경기) ────────────────────────────────────────────

/**
 * 검수 완료 — 넥슨 기록이든 화면 기록이든 정본 경기 하나에 찍는다. 찍는 함수는 FC 승인과 같은 stampFcoReview 하나다.
 * 경기값만 완료한다. 대회·분류 판단과 그 판단의 자동 갱신 보호는 별도 경로가 맡는다.
 * 취소는 완료만 뗀다(보호 reviewed_at 은 남는다 — LoL 과 같다).
 */
export async function setFcoMatchCompleted(matchId: string, completed: boolean, expectedVersion: number, tx?: postgres.TransactionSql): Promise<void> {
  const run = async (t: postgres.TransactionSql) => {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
    const [cur] = await t<{ review_completed_at: Date | null; review_version: number; has_event: boolean }[]>`
      SELECT m.review_completed_at, m.review_version, (COALESCE(ms.event_id, m.event_id) IS NOT NULL) AS has_event
        FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE m.match_id = ${matchId} AND m.game_code = 'fconline' FOR UPDATE OF m`;
    if (!cur) throw new Error("경기를 찾지 못했습니다.");
    if (cur.review_version !== expectedVersion) throw new Error("경기 값이 바뀌었습니다. 새로고침 후 다시 확인해 주세요.");
    if ((cur.review_completed_at != null) === completed) return;
    if (completed) {
      await stampFcoReview(t, matchId);
    } else {
      await t`UPDATE match SET review_completed_at = NULL WHERE match_id = ${matchId}`;
    }
    await t`INSERT INTO review_change (match_id, entity, entity_key, field, before, after)
            VALUES (${matchId}, 'match', ${matchId}, 'review_completed', ${t.json(cur.review_completed_at != null)}, ${t.json(completed)})`;
  };
  if (tx) await run(tx); else await db().begin(run);
}

/**
 * 「저장하고 완료」 — 고친 값 저장과 완료를 **한 트랜잭션**으로. 따로 누르게 하면 고친 값을 저장하지 않고 완료해
 * DB 의 옛 값에 완료 도장이 붙는다(외부 검토 2026-10-02). 화면 기록이 정본인 경기만 값을 고칠 수 있다.
 */
export async function saveAndCompleteScreenMatch(
  matchId: string, expectedVersion: number,
  edits: Parameters<typeof updateScreenSides>[2], outcome: Parameters<typeof updateScreenSides>[3],
): Promise<number> {
  return db().begin(async (tx) => {
    const next = await updateScreenSides(matchId, expectedVersion, edits, outcome, tx);
    await setFcoMatchCompleted(matchId, true, next, tx);
    return next;
  });
}

/**
 * FC 검수의 단위 — **경기 하나 = 키 하나**, 그 경기를 본 것들은 **시점**이다 (CK 의 경기·시점 구조와 같다).
 *
 *   정본 경기  넥슨 기록(provider_api)이 있으면 그것, 없으면 처음 찾은 화면 기록(fcs:…).
 *              화면 기록이 다른 기록에 이어져 있으면(fco_screen_link) 그 대상이 정본이다.
 *   시점       넥슨 기록(공식 값) · VOD 마다 하나(그 방송 화면 사진 + 화면 기록이 읽은 값).
 *              맥락·검수 완료·공개 여부는 시점이 아니라 **정본 경기에 하나**다.
 *   집 단위    경기가 목록에 나오는 단 한 곳. 대회(행사)에 붙었으면 그 대회 → 아니면 그 경기를 처음 본 방송(VOD 번호가 가장 작은 것)
 *              → VOD 로 본 적이 없으면 경기 단위(기존 맥락 검수). 상대가 일반 유저여도 VOD 로 봤으면 방송 단위에 들어간다.
 *
 * ★ 정본·집을 정하는 규칙은 아래 SQL 조각(HOME_CTE) **하나**다. 목록과 작업대가 같은 조각을 쓴다 — 두 곳에서 따로 정하면
 *   같은 경기가 두 줄로 뜨거나 아무 데도 안 뜬다(2026-10-02 실제로 27경기가 두 줄이었다).
 * ★ 데이터 구조는 바꾸지 않는다(마이그레이션 없음). 이미 있는 화면 기록·연결·근거를 읽는 쪽에서 묶는다.
 */

import type postgres from "postgres";

import { db } from "../../db/client.ts";
import { stampFcoReview, type FcoContextStatus } from "./context.ts";
import { compareMatches, type MatchSig } from "./screen.ts";
import { updateScreenSides } from "./screen-review.ts";

// ── 정본·집 규칙 (단일 출처) ───────────────────────────────────────────

/**
 * obs  : (정본 경기, 그 경기를 본 VOD) — 화면 기록의 VOD, 근거 사진의 VOD 를 정본 경기로 올려 모은다
 * home : 정본 경기마다 집 방송(가장 작은 VOD 번호). 대회에 붙은 경기는 뺀다(대회 단위가 집이다).
 */
const HOME_CTE = `
  obs AS (
    SELECT COALESCE(l.api_match_id, m.match_id) AS canon, split_part(split_part(m.match_id, ':', 2), '@', 1)::bigint AS vod
      FROM match m LEFT JOIN fco_screen_link l ON l.screen_match_id = m.match_id
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan' AND m.match_id LIKE 'fcs:%'
    UNION
    SELECT COALESCE(l.api_match_id, e.match_id) AS canon, e.vod_title_no AS vod
      FROM fco_context_evidence e LEFT JOIN fco_screen_link l ON l.screen_match_id = e.match_id
     WHERE e.vod_title_no IS NOT NULL
  ),
  home AS (
    SELECT o.canon, min(o.vod) AS home_vod
      FROM obs o JOIN match c ON c.match_id = o.canon AND c.game_code = 'fconline'
      LEFT JOIN match_series ms ON ms.id = c.series_id AND ms.game_code = c.game_code
     WHERE COALESCE(ms.event_id, c.event_id) IS NULL
     GROUP BY o.canon
  )`;

// ── 목록 ─────────────────────────────────────────────────────────────

export interface FcoBroadcastUnit {
  vod: string;
  title: string | null;
  streamer: string | null;
  channel_id: string | null;
  total: number;
  completed: number;
  /** 넥슨 기록이 정본인 경기 수 */
  api: number;
  first_at: string;
  /** 이 방송이 집인 정본 경기들 — 목록이 경기 단위에서 빼는 데 쓴다 */
  match_ids: string[];
}

export async function listFcoBroadcastUnits(): Promise<FcoBroadcastUnit[]> {
  const rows = await db().unsafe<(Omit<FcoBroadcastUnit, "first_at" | "vod"> & { vod: string; first_at: Date })[]>(`
    WITH ${HOME_CTE}
    SELECT h.home_vod::text AS vod, el.title, st.display_name AS streamer, el.channel_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE c.review_completed_at IS NOT NULL)::int AS completed,
           count(*) FILTER (WHERE c.source = 'provider_api')::int AS api,
           min(c.game_creation) AS first_at,
           array_agg(c.match_id ORDER BY c.game_creation) AS match_ids
      FROM home h JOIN match c ON c.match_id = h.canon
      LEFT JOIN LATERAL (SELECT title, channel_id, streamer_id FROM event_lead e WHERE e.url LIKE '%/player/' || h.home_vod::text LIMIT 1) el ON true
      LEFT JOIN streamer st ON st.id = el.streamer_id
     GROUP BY h.home_vod, el.title, st.display_name, el.channel_id
     ORDER BY min(c.game_creation) DESC`);
  return rows.map((r) => ({ ...r, first_at: r.first_at.toISOString() }));
}

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
  review_completed_at: string | null;
  review_version: number;
  views: FcoMatchView[];
  /** 정본이 화면 기록이고 아무 데도 안 이어졌을 때만 — 같은 경기일 수 있는 다른 기록 */
  candidates: FcoCandidate[];
}
export interface FcoBroadcastWorkspace {
  vod: string;
  url: string;
  title: string | null;
  streamer: string | null;
  channel_id: string | null;
  matches: FcoMatchUnit[];
  streamers: { slug: string; display_name: string; has_fc: boolean }[];
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

/** 방송 하나의 작업대 — 이 방송이 **집**인 정본 경기들과 그 시점들. */
export async function getFcoBroadcastWorkspace(vod: string): Promise<FcoBroadcastWorkspace | null> {
  if (!/^\d{1,12}$/.test(vod)) return null;
  const sql = db();
  const canon = (await sql.unsafe<{ canon: string }[]>(`WITH ${HOME_CTE} SELECT canon FROM home WHERE home_vod = $1`, [vod])).map((r) => r.canon);
  if (!canon.length) return null;

  const matches = await sql<{
    match_id: string; provider_match_id: string | null; source: string; game_creation: Date; mode_key: string | null;
    review_completed_at: Date | null; review_version: number;
    event_id: string | null; event_slug: string | null; event_name: string | null; event_kind: string | null; event_organizer: string | null; event_source_url: string | null;
    judgment: string | null; judgment_note: string | null; judgment_by: string | null;
  }[]>`
    SELECT m.match_id, d.provider_match_id, m.source, m.game_creation, m.mode_key, m.review_completed_at, m.review_version,
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

  const units: FcoMatchUnit[] = matches.map((m) => {
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
      review_completed_at: m.review_completed_at?.toISOString() ?? null, review_version: m.review_version,
      views, candidates,
    };
  });

  const lead = await sql<{ title: string | null; channel_id: string | null; streamer: string | null }[]>`
    SELECT e.title, e.channel_id, st.display_name AS streamer FROM event_lead e LEFT JOIN streamer st ON st.id = e.streamer_id
     WHERE e.url LIKE ${`%/player/${vod}`} LIMIT 1`;
  // 사람 선택 목록 — 공개 스트리머 전부, FC 계정이 있는 사람 먼저(화면 경기의 상대는 계정이 없는 경우가 흔하다).
  const streamers = await sql<{ slug: string; display_name: string; has_fc: boolean }[]>`
    SELECT s.slug, s.display_name, EXISTS (SELECT 1 FROM streamer_fco_account a WHERE a.streamer_id = s.id AND a.visibility = 'public') AS has_fc
      FROM streamer s WHERE s.visibility = 'public' ORDER BY has_fc DESC, s.display_name`;
  return {
    vod, url: `https://vod.sooplive.com/player/${vod}`, title: lead[0]?.title ?? null, channel_id: lead[0]?.channel_id ?? null,
    streamer: lead[0]?.streamer ?? null, matches: units, streamers,
  };
}

// ── 완료 (아무 FC 정본 경기) ────────────────────────────────────────────

/**
 * 검수 완료 — 넥슨 기록이든 화면 기록이든 정본 경기 하나에 찍는다. 찍는 함수는 FC 승인과 같은 stampFcoReview 하나다.
 * 완료할 때 맥락의 최신 판단이 자동 조사(auto) 것이면 사람(admin) 판단으로 굳힌다 — 기존 「승인」과 같다(다음 자동 조사가 못 덮게).
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
      if (!cur.has_event) {
        const [latest] = await t<{ judgment: string; note: string; created_by: string }[]>`
          SELECT judgment, note, created_by FROM fco_match_context WHERE match_id = ${matchId} ORDER BY created_at DESC LIMIT 1`;
        if (latest && latest.created_by !== "admin") {
          await t`INSERT INTO fco_match_context (match_id, judgment, note, created_by) VALUES (${matchId}, ${latest.judgment}, ${latest.note}, 'admin')`;
        }
      }
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
): Promise<void> {
  await db().begin(async (tx) => {
    const next = await updateScreenSides(matchId, expectedVersion, edits, outcome, tx);
    await setFcoMatchCompleted(matchId, true, next, tx);
  });
}

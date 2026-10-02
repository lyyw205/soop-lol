/**
 * FC 화면 경기 검수 — 사람이 근거 프레임을 보며 값을 고치고, 같은 경기의 API 기록에 잇고, 완료한다.
 * (docs/FCO-SCREEN-MATCH-DESIGN.md §4 단계 3·7단계)
 *
 * ★ 이 모듈은 **공개 여부를 바꾸지 않는다.** 화면 경기는 계속 숨김(`visibility='hidden'`)이다.
 *   공개 표시(단계 4)는 별도 설계가 끝나기 전까지 하지 않는다 — 검수 완료는 "사람이 봤다"는 도장일 뿐이다.
 * ★ 완료·보호는 LoL 검수와 같은 칸을 쓴다 — `match.review_completed_at`·`review_version`·`reviewed_at`.
 *   LoL 은 참가자 트리거(0043)가 값이 바뀌면 완료를 풀지만 `fco_match_participant` 에는 그 트리거가 없다.
 *   그래서 여기서는 **값을 저장하는 같은 트랜잭션에서 직접** 완료를 풀고 변경 번호를 올린다.
 * ★ 사람이 고친 경기는 `reviewed_at` 이 찍혀 자동 조사(`saveFcoScreenMatch`)가 덮지 않는다.
 * ★ 모든 변경은 `review_change` 에 남긴다 — 완료가 왜 풀렸는지 나중에 알 수 있어야 한다(2026-10-02 의 교훈).
 */

import type postgres from "postgres";

import { db } from "../../db/client.ts";
import { stampFcoReview, type FcoContextStatus } from "./context.ts";
import { compareMatches, linkScreenTo, resolveSide, screenOutcomes, type MatchSig, type ResolvedSide } from "./screen.ts";

type ResolvedSideBasis = ResolvedSide["basis"];

// ── 읽기 ────────────────────────────────────────────────────────────

export interface ScreenVodRow {
  vod: string;
  title: string | null;
  channel_id: string | null;
  streamer: string | null;
  total: number;
  completed: number;
  linked: number;
  first_at: string;
  last_at: string;
}

/** VOD 마다 화면 경기가 몇 건이고 몇 건을 봤는지. */
export async function listScreenReviewVods(): Promise<ScreenVodRow[]> {
  const sql = db();
  const rows = await sql<(Omit<ScreenVodRow, "first_at" | "last_at"> & { first_at: Date; last_at: Date })[]>`
    WITH s AS (
      SELECT m.match_id, split_part(split_part(m.match_id, ':', 2), '@', 1) AS vod, m.review_completed_at, m.game_creation,
             EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id) AS linked
        FROM match m
       WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan' AND m.match_id LIKE 'fcs:%')
    SELECT s.vod, el.title, el.channel_id, st.display_name AS streamer,
           count(*)::int AS total,
           count(*) FILTER (WHERE s.review_completed_at IS NOT NULL)::int AS completed,
           count(*) FILTER (WHERE s.linked)::int AS linked,
           min(s.game_creation) AS first_at, max(s.game_creation) AS last_at
      FROM s
      LEFT JOIN LATERAL (SELECT title, channel_id, streamer_id FROM event_lead e WHERE e.url LIKE '%/player/' || s.vod LIMIT 1) el ON true
      LEFT JOIN streamer st ON st.id = el.streamer_id
     GROUP BY s.vod, el.title, el.channel_id, st.display_name
     ORDER BY min(s.game_creation) DESC`;
  return rows.map((r) => ({ ...r, first_at: r.first_at.toISOString(), last_at: r.last_at.toISOString() }));
}

export interface ScreenSide {
  side_no: number;
  nickname: string;
  score: number | null;
  outcome: string | null;
  streamer_id: string | null;
  streamer_slug: string | null;
  streamer_name: string | null;
  identity_basis: string | null;
}
export interface ScreenFrame { evidence_key: string; frame_path: string; at_sec: number | null; observed: string; role: string | null }
export interface ScreenCandidate {
  match_id: string;
  source: string;
  at: string;
  gap_sec: number;
  verdict: "same" | "maybe" | "none";
  sides: { nickname: string; score: number | null; streamer_name: string | null }[];
}
/** 이 경기의 맥락(무슨 판이었나) — 기존 FC 맥락 검수와 같은 저장(fco_match_context·event 연결)을 읽는다. */
export interface ScreenContext {
  status: FcoContextStatus;
  event: { id: string; slug: string | null; name: string; kind: string; organizer: string | null; source_url: string | null } | null;
  judgment: { judgment: string; note: string; created_by: string } | null;
}
export interface ScreenMatchView {
  match_id: string;
  context: ScreenContext;
  at_sec: number;
  ended_at: string;
  mode_key: string | null;
  review_completed_at: string | null;
  review_version: number;
  reviewed_at: string | null;
  /** 같은 경기로 이은 기록. 맥락(무슨 판이었나)은 그쪽에 저장된다 — 화면에서 그쪽 맥락을 바로 고친다. */
  link: {
    api_match_id: string; decided_by: string;
    target: { provider_match_id: string | null; source: string; played_at: string; sides: { name: string; score: number | null }[]; context: ScreenContext } | null;
  } | null;
  sides: ScreenSide[];
  frames: ScreenFrame[];
  /** 같은 경기일 수 있는 다른 기록 — 이미 연결됐으면 비어 있다. */
  candidates: ScreenCandidate[];
}
export interface ScreenWorkspace {
  vod: string;
  title: string | null;
  channel_id: string | null;
  streamer: string | null;
  url: string;
  matches: ScreenMatchView[];
  streamers: { slug: string; display_name: string; has_fc: boolean }[];
}

const NEARBY_SEC = 30 * 60;

export async function getScreenReviewWorkspace(vod: string): Promise<ScreenWorkspace | null> {
  if (!/^\d{1,12}$/.test(vod)) return null;
  const sql = db();
  const rows = await sql<{
    match_id: string; game_creation: Date; mode_key: string | null; review_completed_at: Date | null; review_version: number; reviewed_at: Date | null;
    api_match_id: string | null; decided_by: string | null;
    event_id: string | null; event_slug: string | null; event_name: string | null; event_kind: string | null;
    event_organizer: string | null; event_source_url: string | null;
    judgment: string | null; judgment_note: string | null; judgment_by: string | null;
  }[]>`
    SELECT m.match_id, m.game_creation, m.mode_key, m.review_completed_at, m.review_version, m.reviewed_at,
           l.api_match_id, l.decided_by,
           e.id AS event_id, e.slug AS event_slug, e.name AS event_name, e.kind AS event_kind,
           e.organizer AS event_organizer, e.source_url AS event_source_url,
           ctx.judgment, ctx.note AS judgment_note, ctx.created_by AS judgment_by
      FROM match m LEFT JOIN fco_screen_link l ON l.screen_match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
      LEFT JOIN LATERAL (SELECT judgment, note, created_by FROM fco_match_context c
                          WHERE c.match_id = m.match_id ORDER BY c.created_at DESC LIMIT 1) ctx ON true
     WHERE m.game_code = 'fconline' AND m.source = 'manual' AND m.origin = 'vod_scan' AND m.match_id LIKE ${`fcs:${vod}@%`}
     ORDER BY m.game_creation, m.match_id`;
  if (!rows.length) return null;
  const ids = rows.map((r) => r.match_id);

  const sides = await sql<(Omit<ScreenSide, "score"> & { match_id: string; score: number | null })[]>`
    SELECT p.match_id, p.side_no, p.nickname, coalesce(p.score_display, p.goals) AS score, p.outcome,
           p.streamer_id, s.slug AS streamer_slug, s.display_name AS streamer_name, p.identity_basis
      FROM fco_match_participant p LEFT JOIN streamer s ON s.id = p.streamer_id
     WHERE p.match_id = ANY(${ids}) ORDER BY p.match_id, p.side_no`;
  const frames = await sql<(ScreenFrame & { match_id: string })[]>`
    SELECT match_id, evidence_key, frame_path, at_sec, observed, role
      FROM fco_context_evidence WHERE match_id = ANY(${ids}) AND frame_path IS NOT NULL ORDER BY match_id, at_sec NULLS LAST, evidence_key`;

  const lead = await sql<{ title: string | null; channel_id: string | null; streamer: string | null }[]>`
    SELECT e.title, e.channel_id, st.display_name AS streamer
      FROM event_lead e LEFT JOIN streamer st ON st.id = e.streamer_id WHERE e.url LIKE ${`%/player/${vod}`} LIMIT 1`;

  // 후보 재료 — 이 VOD 경기들의 시각 범위(±30분) 안 FC 경기를 참가자와 함께 **한 번에** 읽는다.
  // (경기마다 따로 물으면 17경기 VOD 에서 200번 넘게 왕복해 화면이 3초씩 걸렸다.)
  const times = rows.map((r) => r.game_creation.getTime());
  const pool = await sql<{ match_id: string; source: string; game_creation: Date; parts: { nickname: string; score: number | null; streamer_id: string | null; streamer_name: string | null }[] | null }[]>`
    SELECT m.match_id, m.source, m.game_creation,
           (SELECT json_agg(json_build_object('nickname', p.nickname, 'score', coalesce(p.score_display, p.goals),
                                              'streamer_id', p.streamer_id, 'streamer_name', s.display_name) ORDER BY p.side_no)
              FROM fco_match_participant p LEFT JOIN streamer s ON s.id = p.streamer_id WHERE p.match_id = m.match_id) AS parts
      FROM match m
     WHERE m.game_code = 'fconline'
       AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
       AND m.game_creation BETWEEN ${new Date(Math.min(...times) - NEARBY_SEC * 1000)} AND ${new Date(Math.max(...times) + NEARBY_SEC * 1000)}`;

  // 이어진 대상(API·다른 화면 경기) — 맥락은 그쪽에 있으므로 그쪽 맥락과 대진을 같이 읽는다.
  const targetIds = [...new Set(rows.map((r) => r.api_match_id).filter((x): x is string => !!x))];
  const targets = targetIds.length ? await sql<{
    match_id: string; provider_match_id: string | null; source: string; game_creation: Date;
    parts: { name: string; score: number | null }[] | null;
    event_id: string | null; event_slug: string | null; event_name: string | null; event_kind: string | null; event_organizer: string | null; event_source_url: string | null;
    judgment: string | null; judgment_note: string | null; judgment_by: string | null;
  }[]>`
    SELECT m.match_id, d.provider_match_id, m.source, m.game_creation,
           (SELECT json_agg(json_build_object('name', coalesce(s.display_name, p.nickname), 'score', coalesce(p.score_display, p.goals)) ORDER BY p.side_no)
              FROM fco_match_participant p LEFT JOIN streamer s ON s.id = p.streamer_id WHERE p.match_id = m.match_id) AS parts,
           e.id AS event_id, e.slug AS event_slug, e.name AS event_name, e.kind AS event_kind, e.organizer AS event_organizer, e.source_url AS event_source_url,
           ctx.judgment, ctx.note AS judgment_note, ctx.created_by AS judgment_by
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
      LEFT JOIN LATERAL (SELECT judgment, note, created_by FROM fco_match_context c WHERE c.match_id = m.match_id ORDER BY c.created_at DESC LIMIT 1) ctx ON true
     WHERE m.match_id = ANY(${targetIds})` : [];
  const contextOf = (r: { event_id: string | null; event_slug: string | null; event_name: string | null; event_kind: string | null; event_organizer: string | null; event_source_url: string | null; judgment: string | null; judgment_note: string | null; judgment_by: string | null }): ScreenContext => ({
    // 맥락 파생 규칙은 기존과 같다: 행사 연결이 있으면 그 행사, 없으면 최신 판단, 그것도 없으면 미조사.
    status: r.event_id ? "event" : r.judgment === "casual" || r.judgment === "unresolved" ? r.judgment : "uninvestigated",
    event: r.event_id ? { id: r.event_id, slug: r.event_slug, name: r.event_name ?? "", kind: r.event_kind ?? "other", organizer: r.event_organizer, source_url: r.event_source_url } : null,
    judgment: r.judgment ? { judgment: r.judgment, note: r.judgment_note ?? "", created_by: r.judgment_by ?? "auto" } : null,
  });

  const out: ScreenMatchView[] = [];
  for (const r of rows) {
    const mySides = sides.filter((x) => x.match_id === r.match_id);
    const mine: [MatchSig["sides"][0], MatchSig["sides"][1]] | null = mySides.length === 2
      ? [sigSide(mySides[0]), sigSide(mySides[1])] : null;
    const atMs = r.game_creation.getTime();
    let candidates: ScreenCandidate[] = [];
    if (!r.api_match_id && mine) {
      // 같은 경기일 수 있는 것 + 같은 사람이 낀 가까운 경기. 판정은 자동 연결과 같은 함수를 쓴다.
      const near = pool
        .filter((n) => n.match_id !== r.match_id && Math.abs(n.game_creation.getTime() - atMs) <= NEARBY_SEC * 1000)
        .sort((a, b) => Math.abs(a.game_creation.getTime() - atMs) - Math.abs(b.game_creation.getTime() - atMs))
        .slice(0, 12);
      for (const n of near) {
        const parts = n.parts ?? [];
        if (parts.length !== 2) continue;
        const sig: MatchSig = { at: n.game_creation.getTime(), sides: [candSide(parts[0]), candSide(parts[1])] };
        const verdict = compareMatches({ at: atMs, sides: mine }, sig);
        const sharesPerson = parts.some((p) => p.streamer_id && mySides.some((m) => m.streamer_id === p.streamer_id));
        if (verdict === "no" && !sharesPerson) continue;
        candidates.push({
          match_id: n.match_id, source: n.source, at: n.game_creation.toISOString(),
          gap_sec: Math.round((n.game_creation.getTime() - atMs) / 1000),
          verdict: verdict === "no" ? "none" : verdict,
          sides: parts.map((p) => ({ nickname: p.nickname, score: p.score, streamer_name: p.streamer_name })),
        });
      }
      // 판정이 맞는 것부터, 같은 판정이면 시각이 가까운 순.
      const rank = { same: 0, maybe: 1, none: 2 } as const;
      candidates = candidates.sort((a, b) => rank[a.verdict] - rank[b.verdict] || Math.abs(a.gap_sec) - Math.abs(b.gap_sec));
    }
    const context = contextOf(r);
    const t = r.api_match_id ? targets.find((x) => x.match_id === r.api_match_id) : undefined;
    out.push({
      match_id: r.match_id,
      context,
      at_sec: Number(r.match_id.split("@")[1] ?? 0),
      ended_at: r.game_creation.toISOString(),
      mode_key: r.mode_key,
      review_completed_at: r.review_completed_at?.toISOString() ?? null,
      review_version: r.review_version,
      reviewed_at: r.reviewed_at?.toISOString() ?? null,
      link: r.api_match_id ? {
        api_match_id: r.api_match_id, decided_by: r.decided_by ?? "auto",
        target: t ? { provider_match_id: t.provider_match_id, source: t.source, played_at: t.game_creation.toISOString(), sides: t.parts ?? [], context: contextOf(t) } : null,
      } : null,
      sides: mySides.map(({ match_id: _m, ...s }) => s),
      frames: frames.filter((f) => f.match_id === r.match_id).map(({ match_id: _m, ...f }) => f),
      candidates,
    });
  }

  // 사람 선택 목록 — 공개 스트리머 전부. FC 계정이 등록된 사람이 먼저 온다.
  // ★ FC 계정이 있는 사람만 고를 수 있게 했더니 820명 중 16명만 나왔다 — 화면 경기의 상대는 계정이 없는 경우가 흔하다
  //   (그래서 API 에 없는 경기다). 사람을 붙이는 근거는 'manual'(사람이 지정)로 남는다.
  const streamers = await sql<{ slug: string; display_name: string; has_fc: boolean }[]>`
    SELECT s.slug, s.display_name,
           EXISTS (SELECT 1 FROM streamer_fco_account a WHERE a.streamer_id = s.id AND a.visibility = 'public') AS has_fc
      FROM streamer s WHERE s.visibility = 'public'
     ORDER BY has_fc DESC, s.display_name`;

  return {
    vod, title: lead[0]?.title ?? null, channel_id: lead[0]?.channel_id ?? null, streamer: lead[0]?.streamer ?? null,
    url: `https://vod.sooplive.com/player/${vod}`, matches: out, streamers,
  };
}

const norm = (name: string) => name.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();
const sigSide = (s: ScreenSide) => ({ key: s.streamer_id ?? `name:${norm(s.nickname)}`, score: s.score, name: s.nickname });
const candSide = (p: { nickname: string; score: number | null; streamer_id: string | null }) =>
  ({ key: p.streamer_id ?? `name:${norm(p.nickname)}`, score: p.score, name: p.nickname });

// ── 쓰기 ────────────────────────────────────────────────────────────

type Sql = postgres.TransactionSql;

/** 화면 경기 한 건을 잠그고 변경 번호를 확인한다. 화면 경기가 아니면 거부한다. */
async function lockScreen(tx: Sql, matchId: string, expectedVersion: number) {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("검수 기준값이 없습니다. 새로고침해 주세요.");
  const [cur] = await tx<{ review_version: number; review_completed_at: Date | null; reviewed_at: Date | null }[]>`
    SELECT review_version, review_completed_at, reviewed_at FROM match
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND source = 'manual' AND origin = 'vod_scan' FOR UPDATE`;
  if (!cur) throw new Error("화면 경기를 찾지 못했습니다.");
  if (cur.review_version !== expectedVersion) throw new Error("경기 값이 바뀌었습니다. 새로고침 후 다시 확인해 주세요.");
  return cur;
}

async function log(tx: Sql, matchId: string, entity: "match" | "participant", key: string, field: string, before: unknown, after: unknown) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await tx`INSERT INTO review_change (match_id, entity, entity_key, field, before, after)
           VALUES (${matchId}, ${entity}, ${key}, ${field}, ${before == null ? null : tx.json(before as postgres.JSONValue)}, ${after == null ? null : tx.json(after as postgres.JSONValue)})`;
}

/**
 * 이 칸의 사람을 어떻게 할지.
 *   keep  지금 붙은 사람·근거를 그대로 둔다 (기본). ★ 방송 주인(vod_owner) 근거는 닉네임으로 다시 판정하면 사라진다 —
 *         화면 경기 169칸 중 56칸이 그랬다. 그래서 "건드리지 않으면 그대로"가 기본이어야 한다.
 *   auto  닉네임으로 다시 판정한다 (등록 계정과 정확히 하나만 일치할 때만 붙는다)
 *   none  사람을 뗀다
 *   { slug }  사람이 직접 지정한다 (근거 manual)
 */
export type ScreenPersonEdit = "keep" | "auto" | "none" | { slug: string };
export interface ScreenSideEdit {
  nickname: string;
  score: number | null;
  person: ScreenPersonEdit;
}
export type ScreenOutcomeEdit = "auto" | "first_win" | "second_win" | "draw";

/** 닉네임·점수·사람·결과를 고친다. 연결된 경기는 고치지 않는다(원본이 그쪽에 있다). */
export async function updateScreenSides(matchId: string, expectedVersion: number, edits: [ScreenSideEdit, ScreenSideEdit], outcome: ScreenOutcomeEdit): Promise<void> {
  for (const e of edits) {
    if (!e.nickname.trim()) throw new Error("닉네임이 비었습니다.");
    if (e.score != null && (!Number.isInteger(e.score) || e.score < 0 || e.score > 99)) throw new Error("점수는 0~99 의 정수여야 합니다.");
  }
  await db().begin(async (tx) => {
    const cur = await lockScreen(tx, matchId, expectedVersion);
    const linked = await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    if (linked.length) throw new Error("다른 경기에 연결된 화면 경기입니다. 연결을 풀고 고치세요.");

    const before = await tx<{ side_no: number; nickname: string; score_display: number | null; streamer_id: string | null; identity_basis: string | null }[]>`
      SELECT side_no, nickname, score_display, streamer_id, identity_basis FROM fco_match_participant WHERE match_id = ${matchId} ORDER BY side_no`;
    if (before.length !== 2) throw new Error("참가자 두 칸이 없는 경기입니다.");

    const resolveEdit = async (e: ScreenSideEdit, b: (typeof before)[number]) => {
      const nickname = e.nickname.trim();
      if (e.person === "keep") return { nickname, streamerId: b.streamer_id, basis: b.identity_basis as ResolvedSideBasis, key: b.streamer_id ?? `name:${norm(nickname)}`, score: e.score };
      if (e.person === "none") return { nickname, streamerId: null, basis: null, key: `name:${norm(nickname)}`, score: e.score };
      if (e.person === "auto") return resolveSide(tx, { nickname, score: e.score });
      return resolveSide(tx, { nickname, score: e.score, streamerSlug: e.person.slug, basis: "manual" });
    };
    const resolved = [await resolveEdit(edits[0], before[0]), await resolveEdit(edits[1], before[1])] as const;
    if (resolved[0].key === resolved[1].key) throw new Error("두 칸이 같은 사람입니다. 닉네임·사람을 확인하세요.");

    const direct = outcome === "first_win" ? ["win", "loss"] as const : outcome === "second_win" ? ["loss", "win"] as const : outcome === "draw" ? ["draw", "draw"] as const : null;
    const outs = screenOutcomes([
      { nickname: edits[0].nickname, score: edits[0].score, ...(direct ? { outcome: direct[0] } : {}) },
      { nickname: edits[1].nickname, score: edits[1].score, ...(direct ? { outcome: direct[1] } : {}) },
    ]);

    for (const [i, r] of resolved.entries()) {
      await tx`UPDATE fco_match_participant
                  SET nickname = ${r.nickname}, score_display = ${r.score}, streamer_id = ${r.streamerId}, identity_basis = ${r.basis}, outcome = ${outs[i]}
                WHERE match_id = ${matchId} AND side_no = ${i + 1}`;
      const b = before[i];
      const key = `${matchId}#${i + 1}`;
      await log(tx, matchId, "participant", key, "nickname", b.nickname, r.nickname);
      await log(tx, matchId, "participant", key, "score", b.score_display, r.score);
      await log(tx, matchId, "participant", key, "streamer_id", b.streamer_id, r.streamerId);
      await log(tx, matchId, "participant", key, "identity_basis", b.identity_basis, r.basis);
    }
    // 값이 달라졌으니 완료를 푼다(참가자 트리거가 없는 FC 표라 여기서 직접). 사람이 고친 경기는 자동 조사가 덮지 못하게 보호한다.
    await tx`UPDATE match SET review_completed_at = NULL, review_version = review_version + 1, reviewed_at = COALESCE(reviewed_at, now())
              WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "review_completed", cur.review_completed_at != null, false);
  });
}

/** 같은 경기라고 사람이 판단해 다른 기록(API 또는 다른 화면 경기)에 잇는다. */
export async function linkScreenByAdmin(matchId: string, expectedVersion: number, targetId: string): Promise<void> {
  await db().begin(async (tx) => {
    await lockScreen(tx, matchId, expectedVersion);
    if (matchId === targetId) throw new Error("자기 자신에게는 연결할 수 없습니다.");
    const [target] = await tx<{ match_id: string }[]>`SELECT match_id FROM match WHERE match_id = ${targetId} AND game_code = 'fconline' FOR UPDATE`;
    if (!target) throw new Error("연결할 경기를 찾지 못했습니다.");
    if ((await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${targetId}`).length) throw new Error("그 경기는 이미 다른 경기에 연결돼 있습니다.");
    if ((await tx`SELECT 1 FROM fco_screen_link WHERE screen_match_id = ${matchId}`).length) throw new Error("이미 연결된 경기입니다.");
    await linkScreenTo(tx, matchId, targetId, { participants: "admin", score: "admin" }, "admin");
    await tx`UPDATE match SET review_version = review_version + 1, reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "screen_link", null, targetId);
  });
}

/** 연결을 푼다. 연결할 때 대상으로 복사한 근거 프레임도 거두어 온다(그 키는 이 화면 경기의 것뿐이다). */
export async function unlinkScreenByAdmin(matchId: string, expectedVersion: number): Promise<void> {
  await db().begin(async (tx) => {
    await lockScreen(tx, matchId, expectedVersion);
    const [link] = await tx<{ api_match_id: string }[]>`SELECT api_match_id FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    if (!link) throw new Error("연결돼 있지 않은 경기입니다.");
    await tx`DELETE FROM fco_context_evidence
              WHERE match_id = ${link.api_match_id}
                AND evidence_key IN (SELECT evidence_key FROM fco_context_evidence WHERE match_id = ${matchId})`;
    await tx`DELETE FROM fco_screen_link WHERE screen_match_id = ${matchId}`;
    await tx`UPDATE match SET review_completed_at = NULL, review_version = review_version + 1, reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "screen_link", link.api_match_id, null);
  });
}

/**
 * 검수 완료 도장. 공개 여부는 건드리지 않는다.
 * 찍는 일은 기존 FC 승인과 같은 함수(`stampFcoReview`) 하나다 — 도장이 두 가지로 갈라지지 않게.
 * 취소는 완료만 뗀다(보호 도장 reviewed_at 은 남긴다 — 사람이 본 경기를 자동 조사가 덮지 못하게. LoL 과 같다).
 */
export async function setScreenReviewCompleted(matchId: string, completed: boolean, expectedVersion: number): Promise<void> {
  await db().begin(async (tx) => {
    const cur = await lockScreen(tx, matchId, expectedVersion);
    if ((cur.review_completed_at != null) === completed) return;
    if (completed) await stampFcoReview(tx, matchId);
    else await tx`UPDATE match SET review_completed_at = NULL WHERE match_id = ${matchId}`;
    await log(tx, matchId, "match", matchId, "review_completed", cur.review_completed_at != null, completed);
  });
}

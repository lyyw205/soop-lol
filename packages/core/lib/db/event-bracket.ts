/**
 * 대진(칸·화살표·결정) 읽기와 저장. 계산은 tournament/bracket.ts 가 한다 — 여기는 DB 와 그 입력 모양 사이의 통로다.
 * docs/TOURNAMENT-FORMAT-PLAN.md · db/migrations/0061_event_bracket.sql
 *
 * ★ 실제 경기를 참가 단위(event_team)로 바꾸는 곳이 여기 하나다. 롤은 경기의 청/홍 팀(blue_team_id/red_team_id),
 *   FC 는 참가자 스트리머가 속한 참가 단위(event_team_member)로 바꾼다. 세트마다 진영이 바뀌어도 같은 id 가 된다.
 */
import type postgres from "postgres";
import { db } from "./client.ts";
import {
  resolveBracket, validateStructure,
  type BracketInput, type BracketResult, type BracketRoute, type BracketSlot, type DecisionBasis, type DecisionStatus,
  type FinalRank, type SlotDecision, type SlotGame,
} from "../tournament/bracket.ts";
import { parseBracketSpec, type BracketSpec } from "../tournament/spec.ts";

type Sql = postgres.Sql | postgres.TransactionSql;

export interface EventBracketMember {
  streamerId: string;
  slug: string;
  name: string;
  image: string | null;
  channelId: string | null;
}
export interface EventBracketEntrant {
  id: string;
  name: string;
  members: EventBracketMember[];
  finalRankEvidence: string | null;
}
export interface EventBracketStage { id: string; no: number; name: string; template: string | null; evidence: string }
export interface EventBracket {
  eventId: string;
  stages: EventBracketStage[];
  input: BracketInput;
  entrants: EventBracketEntrant[];
  /** 칸 id → 근거 */
  slotEvidence: Record<string, string>;
  /** 칸 id → 채택 결정의 근거(결정이 있을 때) */
  decisionEvidence: Record<string, string>;
  /** match_id → 넥슨 경기 id(FC 상세 화면 주소). 롤은 없다 */
  providerIds: Record<string, string>;
}

/** 대회의 대진. 단계가 하나도 없으면 null — 화면은 대진 없이 경기 목록만 보인다. */
export async function getEventBracket(eventId: string, sql: Sql = db()): Promise<EventBracket | null> {
  const stages = await sql<{ stage_id: string; stage_no: number; name: string; template: string | null; evidence: string }[]>`
    SELECT stage_id, stage_no, name, template, evidence FROM core_public.event_stage WHERE event_id = ${eventId} ORDER BY stage_no`;
  if (!stages.length) return null;
  const stageNo = new Map(stages.map((s) => [s.stage_id, s.stage_no]));

  // ★ 순서대로 묻는다 — 검증용 PGlite 소켓은 연결 하나만 받아 병렬 질의가 끊긴다(작은 질의 7개라 운영에도 차이가 없다).
  const slotRows = await sql<{ slot_id: string; stage_id: string; slot_no: number; label: string | null; lane: string | null; kind: "match" | "selection";
      best_of: number | null; picks: number | null; seed_a: string | null; seed_b: string | null; evidence: string }[]>`
      SELECT slot_id, stage_id, slot_no, label, lane, kind, best_of, picks, seed_a, seed_b, evidence
        FROM core_public.event_slot WHERE event_id = ${eventId}`;
  const routeRows = await sql<{ from_slot: string; outcome: "winner" | "loser"; to_kind: "slot" | "placement" | "eliminated"; to_slot: string | null;
      to_side: "a" | "b" | null; placement_min: number | null; placement_max: number | null }[]>`
      SELECT from_slot, outcome, to_kind, to_slot, to_side, placement_min, placement_max
        FROM core_public.event_route WHERE event_id = ${eventId}`;
  const decisionRows = await sql<{ slot_id: string; status: DecisionStatus; winners: string[]; score_a: number | null; score_b: number | null; basis: DecisionBasis; evidence: string }[]>`
      SELECT slot_id, status, winners, score_a, score_b, basis, evidence FROM core_public.event_slot_decision WHERE event_id = ${eventId}`;
  const teamRows = await sql<{ event_team_id: string; name: string; final_rank_min: number | null; final_rank_max: number | null;
      final_rank_basis: FinalRank["basis"] | null; final_rank_evidence: string | null }[]>`
      SELECT event_team_id, name, final_rank_min, final_rank_max, final_rank_basis, final_rank_evidence
        FROM core_public.event_team WHERE event_id = ${eventId}`;
  const memberRows = await sql<{ event_team_id: string; streamer_id: string; slug: string; name: string; image: string | null; channel_id: string | null }[]>`
      SELECT m.event_team_id, m.streamer_id, s.slug, s.display_name AS name, s.profile_image_url AS image,
             (SELECT c.channel_id FROM core_public.streamer_channel c
               WHERE c.streamer_id = s.id AND c.platform = 'soop' ORDER BY c.is_primary DESC LIMIT 1) AS channel_id
        FROM core_public.event_team_member m JOIN streamer s ON s.id = m.streamer_id
       WHERE m.event_id = ${eventId}`;
  // 롤: 경기의 청/홍 팀이 곧 참가 단위
  const lolRows = await sql<{ slot_id: string; match_id: string; played_at: Date; blue: string | null; red: string | null; winning_team: number | null }[]>`
      SELECT l.slot_id, l.match_id, m.game_creation AS played_at, m.blue_team_id AS blue, m.red_team_id AS red, m.winning_team
        FROM core_public.event_slot_match l JOIN match m ON m.match_id = l.match_id
       WHERE l.event_id = ${eventId} AND m.game_code = 'lol'`;
  // FC: 참가자 스트리머 → 그 사람이 속한 참가 단위
  const fcoRows = await sql<{ slot_id: string; match_id: string; played_at: Date; provider_id: string; entrant: string | null;
      outcome: SlotGame["entrants"][number]["outcome"]; score: number | null; shootout: number | null; side_no: number }[]>`
      SELECT l.slot_id, l.match_id, m.game_creation AS played_at, d.provider_match_id AS provider_id,
             tm.event_team_id AS entrant, p.outcome, COALESCE(p.score_display, p.goals) AS score,
             (p.match_info -> 'shoot' ->> 'shootOutScore')::int AS shootout, p.side_no
        FROM core_public.event_slot_match l
        JOIN match m ON m.match_id = l.match_id AND m.game_code = 'fconline'
        JOIN fco_match_detail d ON d.match_id = m.match_id
        JOIN fco_match_participant p ON p.match_id = m.match_id
        LEFT JOIN event_team_member tm ON tm.event_id = l.event_id AND tm.streamer_id = p.streamer_id
       WHERE l.event_id = ${eventId}
       ORDER BY l.match_id, p.side_no`;

  const slots: BracketSlot[] = slotRows.map((r) => ({
    id: r.slot_id, stageNo: stageNo.get(r.stage_id) ?? 1, no: r.slot_no, label: r.label, lane: r.lane, kind: r.kind,
    bestOf: r.best_of, picks: r.picks, seedA: r.seed_a, seedB: r.seed_b,
  }));
  const routes: BracketRoute[] = routeRows.map((r) => ({
    fromSlot: r.from_slot, outcome: r.outcome,
    to: r.to_kind === "slot" ? { kind: "slot", slot: r.to_slot!, side: r.to_side }
      : r.to_kind === "placement" ? { kind: "placement", min: r.placement_min!, max: r.placement_max! }
      : { kind: "eliminated" },
  }));
  const decisions: SlotDecision[] = decisionRows.map((r) => ({
    slotId: r.slot_id, status: r.status, winners: r.winners, scoreA: r.score_a, scoreB: r.score_b, basis: r.basis, evidence: r.evidence,
  }));
  const games: SlotGame[] = lolRows.map((r) => ({
    slotId: r.slot_id, matchId: r.match_id, playedAt: new Date(r.played_at).toISOString(),
    entrants: [
      { entrant: r.blue, outcome: r.winning_team == null ? "unknown" : r.winning_team === 100 ? "win" : "loss", score: null },
      { entrant: r.red, outcome: r.winning_team == null ? "unknown" : r.winning_team === 200 ? "win" : "loss", score: null },
    ],
  }));
  const providerIds: Record<string, string> = {};
  const fco = new Map<string, SlotGame>();
  for (const r of fcoRows) {
    providerIds[r.match_id] = r.provider_id;
    const g = fco.get(r.match_id) ?? { slotId: r.slot_id, matchId: r.match_id, playedAt: new Date(r.played_at).toISOString(), entrants: [] };
    g.entrants.push({ entrant: r.entrant, outcome: r.outcome, score: r.score, shootout: r.shootout });
    fco.set(r.match_id, g);
  }
  games.push(...fco.values());

  const finalRanks: FinalRank[] = teamRows.filter((t) => t.final_rank_min != null).map((t) => ({
    entrant: t.event_team_id, min: t.final_rank_min!, max: t.final_rank_max!, basis: t.final_rank_basis!,
  }));
  const entrants: EventBracketEntrant[] = teamRows.map((t) => ({
    id: t.event_team_id, name: t.name, finalRankEvidence: t.final_rank_evidence,
    members: memberRows.filter((m) => m.event_team_id === t.event_team_id).map((m) => ({
      streamerId: m.streamer_id, slug: m.slug, name: m.name, image: m.image, channelId: m.channel_id,
    })),
  }));
  return {
    eventId,
    stages: stages.map((s) => ({ id: s.stage_id, no: s.stage_no, name: s.name, template: s.template, evidence: s.evidence })),
    input: { slots, routes, games, decisions, finalRanks },
    entrants,
    slotEvidence: Object.fromEntries(slotRows.map((r) => [r.slot_id, r.evidence])),
    decisionEvidence: Object.fromEntries(decisionRows.map((r) => [r.slot_id, r.evidence])),
    providerIds,
  };
}

/* ── 저장 ─────────────────────────────────────────────────────────── */

export interface ApplyBracketReport {
  eventId: string;
  entrants: number;
  slots: number;
  routes: number;
  links: number;
  decisionsAdded: number;
  /** 사람(admin)이 내린 최신 결정이 있어 시드가 덮지 않은 칸 */
  decisionsKeptByAdmin: number[];
  result: BracketResult;
  /** 참가 단위 id → 이름 */
  names: Record<string, string>;
}

class DryRun extends Error {
  readonly report: ApplyBracketReport;
  constructor(report: ApplyBracketReport) { super("dry run"); this.report = report; }
}

/**
 * 시드 파일 하나를 대회에 반영한다. 같은 파일을 다시 돌려도 안전하다(칸은 번호로 찾아 갱신하고, 결정은 바뀐 것만 쌓는다).
 * ★ 구조 오류(validateStructure)가 있으면 아무것도 쓰지 않는다.
 * ★ 사람(admin)이 내린 최신 결정은 시드가 덮지 않는다 — 검수 화면의 판단이 시드보다 나중이다.
 * dryRun 이면 같은 트랜잭션에서 계산까지 해 보고 되돌린다.
 */
export async function applyBracketSpec(spec: BracketSpec, opts: { dryRun?: boolean } = {}): Promise<ApplyBracketReport> {
  try {
    return await db().begin(async (tx) => {
      const report = await apply(tx, spec);
      if (opts.dryRun) throw new DryRun(report);
      return report;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.report;
    throw error;
  }
}

async function apply(tx: postgres.TransactionSql, spec: BracketSpec): Promise<ApplyBracketReport> {
  const [event] = await tx<{ id: string }[]>`SELECT id FROM event WHERE slug = ${spec.event} AND game_code = ${spec.game}`;
  if (!event) throw new Error(`대회가 없다: ${spec.game}/${spec.event}`);
  const eventId = event.id;
  const parsed = parseBracketSpec(spec);

  // 1. 참가 단위(event_team). FC 개인전은 1인 팀이다. 이름이 키다(같은 대회 안에서 유일 — 0008).
  const teamId = new Map<string, string>();
  for (const e of spec.entrants) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO event_team (event_id, name) VALUES (${eventId}, ${e.name})
      ON CONFLICT (event_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
    teamId.set(e.key, row.id);
    for (const slug of e.streamers) {
      const [s] = await tx<{ id: string }[]>`SELECT id FROM streamer WHERE slug = ${slug}`;
      if (!s) throw new Error(`스트리머가 없다: ${slug} (참가 단위 ${e.key})`);
      await tx`
        INSERT INTO event_team_member (event_id, event_team_id, streamer_id) VALUES (${eventId}, ${row.id}, ${s.id})
        ON CONFLICT (event_id, streamer_id) DO UPDATE SET event_team_id = EXCLUDED.event_team_id`;
    }
  }
  const team = (key: string | null) => (key == null ? null : teamId.get(key)!);

  // 2. 구조 검사 — 오류가 하나라도 있으면 쓰지 않는다
  const structural = validateStructure(parsed.slots, parsed.routes);
  if (structural.length) throw new Error(`대진 구조 오류:\n${structural.map((i) => `  - ${i.message}`).join("\n")}`);

  // 3. 단계와 칸(번호로 찾아 갱신 — 칸 id 가 유지돼야 결정 이력이 남는다)
  const stageIds = new Map<number, string>();
  for (const st of spec.stages) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO event_stage (event_id, stage_no, name, template, evidence)
      VALUES (${eventId}, ${st.no}, ${st.name}, ${st.template ?? null}, ${st.evidence ?? spec.evidence})
      ON CONFLICT (event_id, stage_no) DO UPDATE SET name = EXCLUDED.name, template = EXCLUDED.template, evidence = EXCLUDED.evidence
      RETURNING id`;
    stageIds.set(st.no, row.id);
  }
  await tx`DELETE FROM event_stage WHERE event_id = ${eventId} AND NOT (id = ANY(${[...stageIds.values()]}::uuid[]))`;
  const slotIds = new Map<string, string>();
  for (const s of parsed.slots) {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO event_slot (event_id, stage_id, slot_no, label, lane, kind, best_of, picks, seed_a, seed_b, evidence)
      VALUES (${eventId}, ${stageIds.get(s.stageNo)!}, ${s.no}, ${s.label}, ${s.lane}, ${s.kind}, ${s.bestOf}, ${s.picks},
              ${team(s.seedA)}, ${team(s.seedB)}, ${parsed.evidence.get(s.id)!})
      ON CONFLICT (stage_id, slot_no) DO UPDATE SET label = EXCLUDED.label, lane = EXCLUDED.lane, kind = EXCLUDED.kind,
        best_of = EXCLUDED.best_of, picks = EXCLUDED.picks, seed_a = EXCLUDED.seed_a, seed_b = EXCLUDED.seed_b, evidence = EXCLUDED.evidence
      RETURNING id`;
    slotIds.set(s.id, row.id);
  }
  await tx`DELETE FROM event_slot WHERE event_id = ${eventId} AND NOT (id = ANY(${[...slotIds.values()]}::uuid[]))`;

  // 4. 화살표·경기 연결은 통째로 다시 쓴다(이력이 필요한 것은 결정뿐이다)
  await tx`DELETE FROM event_route WHERE event_id = ${eventId}`;
  for (const r of parsed.routes) {
    await tx`
      INSERT INTO event_route (event_id, from_slot, outcome, to_kind, to_slot, to_side, placement_min, placement_max)
      VALUES (${eventId}, ${slotIds.get(r.fromSlot)!}, ${r.outcome}, ${r.to.kind},
              ${r.to.kind === "slot" ? slotIds.get(r.to.slot)! : null}, ${r.to.kind === "slot" ? r.to.side : null},
              ${r.to.kind === "placement" ? r.to.min : null}, ${r.to.kind === "placement" ? r.to.max : null})`;
  }
  await tx`DELETE FROM event_slot_match WHERE event_id = ${eventId}`;
  let links = 0;
  for (const [slot, matchIds] of parsed.links) for (const matchId of matchIds) {
    await tx`INSERT INTO event_slot_match (match_id, slot_id, event_id) VALUES (${matchId}, ${slotIds.get(slot)!}, ${eventId})`;
    links++;
  }

  // 5. 칸 규칙의 세트 수가 정본이다. 칸의 경기가 시리즈 하나에 모여 있으면 시리즈 값도 맞춘다 — 두 값이 따로 놀지 않게.
  for (const s of parsed.slots) {
    if (s.bestOf == null) continue;
    await tx`
      UPDATE match_series ms SET best_of = ${s.bestOf}, best_of_evidence = ${`대진 칸 규칙 — ${parsed.evidence.get(s.id)}`}, updated_at = now()
       WHERE ms.id = (SELECT min(m.series_id) FROM event_slot_match l JOIN match m ON m.match_id = l.match_id
                       WHERE l.slot_id = ${slotIds.get(s.id)!} HAVING count(DISTINCT m.series_id) = 1 AND count(*) = count(m.series_id))
         AND ms.best_of IS DISTINCT FROM ${s.bestOf}`;
  }

  // 6. 결정: 바뀐 것만 쌓는다. 사람의 최신 결정은 덮지 않는다. 파일에서 빠진 시드 결정은 철회(auto)한다.
  let decisionsAdded = 0;
  const keptByAdmin: number[] = [];
  const specDecisions = new Map(parsed.decisions.map((d) => [slotIds.get(d.slotId)!, d]));
  const latest = await tx<{ slot_id: string; status: string; winners: string[]; score_a: number | null; score_b: number | null; basis: string; evidence: string; created_by: string }[]>`
    SELECT DISTINCT ON (slot_id) slot_id, status, winners, score_a, score_b, basis, evidence, created_by
      FROM event_slot_decision WHERE event_id = ${eventId} ORDER BY slot_id, created_at DESC, id DESC`;
  const latestBy = new Map(latest.map((d) => [d.slot_id, d]));
  const slotNoOf = new Map(parsed.slots.map((s) => [slotIds.get(s.id)!, s.no]));
  for (const slotId of new Set([...specDecisions.keys(), ...latestBy.keys()])) {
    const want = specDecisions.get(slotId);
    const have = latestBy.get(slotId);
    if (have?.created_by === "admin") { if (want) keptByAdmin.push(slotNoOf.get(slotId)!); continue; }
    const row = want
      ? { status: want.status, winners: want.winners.map((w) => team(w)!), score_a: want.scoreA, score_b: want.scoreB, basis: want.basis, evidence: want.evidence }
      : have && have.status !== "auto"
        ? { status: "auto", winners: [] as string[], score_a: null, score_b: null, basis: have.basis, evidence: "시드 파일에서 이 결정이 빠졌다 — 경기 기록대로" }
        : null;
    if (!row) continue;
    const same = have && have.status === row.status && [...have.winners].sort().join() === [...row.winners].sort().join()
      && have.score_a === row.score_a && have.score_b === row.score_b && have.basis === row.basis && have.evidence === row.evidence;
    if (same) continue;
    await tx`
      INSERT INTO event_slot_decision (slot_id, event_id, status, winners, score_a, score_b, basis, evidence, created_by)
      VALUES (${slotId}, ${eventId}, ${row.status}, ${row.winners}::uuid[], ${row.score_a}, ${row.score_b}, ${row.basis}, ${row.evidence}, 'seed')`;
    decisionsAdded++;
  }

  // 7. 공식 최종 순위 — 파일에 있는 참가 단위만 다룬다(파일에 순위가 없으면 비운다)
  const ranks = new Map((spec.finalRanks ?? []).map((f) => [f.entrant, f]));
  for (const e of spec.entrants) {
    const f = ranks.get(e.key);
    await tx`
      UPDATE event_team SET final_rank_min = ${f?.min ?? null}, final_rank_max = ${f?.max ?? null},
             final_rank_basis = ${f?.basis ?? null}, final_rank_evidence = ${f?.evidence ?? null}
       WHERE id = ${teamId.get(e.key)!}`;
  }

  const bracket = (await getEventBracket(eventId, tx))!;
  return {
    eventId, entrants: spec.entrants.length, slots: parsed.slots.length, routes: parsed.routes.length, links,
    decisionsAdded, decisionsKeptByAdmin: keptByAdmin, result: resolveBracket(bracket.input),
    names: Object.fromEntries(bracket.entrants.map((e) => [e.id, e.name])),
  };
}

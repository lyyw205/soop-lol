/**
 * CK 조사 기록 조회 — **읽기만 한다.**
 *
 *   npm run ck:record -- --match <match_id>          # 경기 하나: 공개 값·참가자·근거 프레임·조사 기록·수정 이력
 *   npm run ck:record -- --lead <lead uuid | vod:NNN> # VOD 하나: 탐색 기록·프레임 읽음·후보와 서술·수정 이력
 *   npm run ck:record -- --event <slug>              # 대회 하나: 근거 연결·로스터 점검
 *   npm run ck:record -- --todo                      # LLM 조사 목록: 연결 없는 반영 후보·미해결 후보·못 본 구간·같은 판 의심
 *   … --json                                          # 같은 내용을 JSON 으로
 *
 * ★ 왜 CLI 인가 — 사람 검수 화면은 **공개될 값과 비교할 프레임**만 보여준다. 탐색 상태·관찰문·
 *   후보 판단·남은 질문은 LLM 이 조사할 때 필요한 것이라 화면에 올리면 정보 과부하가 된다.
 *   그 기록은 여기서 경기 값과 묶어 읽는다. 설명문에 경기 값을 복사해 두지 않아도 된다.
 * ★ 옛 `ck:gate` 를 대신한다. "시점 N개 이상"·"사유 문장이 있으면 통과" 같은 합격선은 없다 —
 *   문장을 적었는가가 아니라 **근거가 실제 대상과 연결돼 있는가**를 본다.
 */
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { getLeadWorkspace, getMatchDetail, listReviewChanges, type ReviewChangeRow } from "@soop-lol/core/lib/db/ck";
import { listDuplicateSuspects } from "@soop-lol/core/lib/db/ck-duplicates";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const MATCH = opt("--match", "");
const LEAD = opt("--lead", "");
const EVENT = opt("--event", "");
const TODO = argv.includes("--todo");
const JSON_OUT = argv.includes("--json");

if (!MATCH && !LEAD && !EVENT && !TODO) {
  console.error("무엇을 볼까: --match <id> | --lead <uuid|vod:NNN> | --event <slug> | --todo  [--json]");
  process.exit(1);
}

const sql = db();
const hms = (sec: number | null | undefined) => {
  if (sec == null) return "--:--:--";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const range = ([a, b]: [number, number]) => `${hms(a)}–${hms(b)}`;
const out: string[] = [];
const say = (line = "") => out.push(line);

type Narrative = { observed: string | null; why: string | null; questions: string[] };
async function candidateNarrative(leadId: string, candidateId: string): Promise<Narrative> {
  const rows = await sql<{ type: string; body: string }[]>`
    SELECT type, body FROM review_record WHERE lead_id = ${leadId}::uuid AND candidate_id = ${candidateId}
     ORDER BY created_at, id`;
  return {
    observed: rows.find((r) => r.type === "observation")?.body ?? null,
    why: rows.find((r) => r.type === "assessment")?.body ?? null,
    questions: rows.filter((r) => r.type === "question").map((r) => r.body),
  };
}
function sayNarrative(n: Narrative, indent = "      ") {
  if (n.observed) say(`${indent}본 것  ${n.observed}`);
  if (n.why) say(`${indent}판단  ${n.why}`);
  for (const q of n.questions) say(`${indent}남은 질문  ${q}`);
}
function sayHistory(rows: ReviewChangeRow[]) {
  say(`수정 이력 ${rows.length}건`);
  for (const r of rows) {
    say(`  ${r.changed_at.toISOString()}  ${r.entity}:${r.entity_key}  ${r.field}  `
      + `${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}  (${r.actor})`);
  }
}

async function resolveLeadId(arg: string): Promise<string | null> {
  if (/^[0-9a-f-]{36}$/i.test(arg)) return arg;
  const [row] = await sql<{ id: string }[]>`SELECT id FROM event_lead WHERE source_key = ${arg} LIMIT 1`;
  return row?.id ?? null;
}

try {
  let json: unknown = null;

  if (MATCH) {
    const detail = await getMatchDetail(MATCH);
    if (!detail) { console.error(`경기 '${MATCH}' 가 없다.`); process.exit(1); }
    const m = detail.match;
    const [event] = m.event_id
      ? await sql<{ slug: string; name: string; kind: string }[]>`SELECT slug, name, kind FROM event WHERE id = ${m.event_id}::uuid`
      : [];
    const people = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM streamer WHERE id = ANY(${detail.participants.map((p) => p.streamer_id).filter(Boolean) as string[]}::uuid[])`;
    const nameOf = new Map(people.map((p) => [p.id, p.display_name]));
    const frames = await sql<{ id: string; lead_id: string; at_sec: number | null; kind: string; frame_path: string;
      read_at: Date | null; url: string | null; source_key: string; observed: string | null }[]>`
      SELECT f.id, f.lead_id, f.at_sec, f.kind, f.frame_path, f.read_at, l.url, l.source_key, r.body AS observed
        FROM match_evidence_frame f JOIN event_lead l ON l.id = f.lead_id
        LEFT JOIN review_record r ON r.frame_id = f.id AND r.type = 'observation'
       WHERE f.match_id = ${MATCH} ORDER BY f.at_sec NULLS LAST`;
    const candidates = await sql<{ lead_id: string; c: { id: string; at: [number, number]; conclusion: string } }[]>`
      SELECT l.id AS lead_id, c FROM event_lead l, jsonb_array_elements(
        CASE WHEN jsonb_typeof(l.raw->'candidates') = 'array' THEN l.raw->'candidates' ELSE '[]'::jsonb END) c
       WHERE c->>'match_id' = ${MATCH}`;
    const history = await listReviewChanges({ match_id: MATCH });

    say(`경기 ${m.match_id}`);
    say(`  시각    ${kstPlayedAt(m.game_creation, m.game_creation_precision)} (${m.game_creation_precision === "date" ? "날짜만 확실" : "시각까지 확실"})`);
    say(`  대회    ${event ? `${event.name} (${event.slug}, ${event.kind})` : "연결 없음"}`);
    say(`  세트    ${m.series_id ? `${m.series_id} #${m.series_game_no ?? "?"}` : "단판"} · BO ${m.best_of ?? "미확정"}${m.best_of_evidence ? ` (근거: ${m.best_of_evidence})` : ""} · 세트 순서 ${m.set_order_known ? "확인" : "모름"}`);
    say(`  승자    ${m.winning_team === 100 ? "1팀(블루)" : m.winning_team === 200 ? "2팀(레드)" : "미상"} · 경기 시간 ${m.game_duration != null ? hms(m.game_duration) : "미수집"}`);
    say(`  출처    ${m.source}/${m.origin ?? "-"} · ${m.visibility === "hidden" ? "공개에서 뺌" : "공개"} · ${m.reviewed_at ? `관리자 확인 ${m.reviewed_at.toISOString()}` : "관리자 확인 없음"}`);
    if (m.source_url) say(`  출처 링크 ${m.source_url}`);
    say(`참가자 ${detail.participants.length}/10`);
    for (const p of detail.participants) {
      const who = p.streamer_id ? nameOf.get(p.streamer_id) ?? p.streamer_id : p.observed_name ? `미확인 "${p.observed_name}"` : "미확인";
      const kda = p.kills != null && p.deaths != null && p.assists != null ? `${p.kills}/${p.deaths}/${p.assists}` : "—";
      say(`  ${p.team_id === 100 ? "1팀" : "2팀"} #${p.participant_id} ${p.team_position ?? "-"}  ${who}  ${p.champion_name ?? p.champion_id}  ${kda}`);
    }
    say(`검수 완료  ${m.review_completed_at?.toISOString() ?? "미완료"}`);
    say(`최종 근거  ${m.result_evidence ?? "(문장 없음)"}`);
    say(`근거 프레임 ${frames.length}장`);
    for (const f of frames) {
      say(`  ${f.kind.padEnd(6)} ${hms(f.at_sec)}  ${f.read_at ? "열어 봄" : "안 열어 봄"}  frame=${f.id}`);
      say(`         VOD ${f.url ?? f.source_key} @ ${hms(f.at_sec)}  ${f.frame_path}`);
      if (f.observed) say(`         본 것  ${f.observed}`);
    }
    say(`이 경기를 가리키는 조사 후보 ${candidates.length}건`);
    const cands = [];
    for (const { lead_id, c } of candidates) {
      const n = await candidateNarrative(lead_id, c.id);
      say(`  ${c.id} (${c.conclusion}) ${range(c.at)}  lead=${lead_id}`);
      sayNarrative(n, "    ");
      cands.push({ lead_id, ...c, ...n });
    }
    sayHistory(history);
    json = { match: m, event: event ?? null, participants: detail.participants, frames, candidates: cands, history };
  }

  if (LEAD) {
    const leadId = await resolveLeadId(LEAD);
    const ws = leadId ? await getLeadWorkspace(leadId) : null;
    if (!ws) { console.error(`VOD '${LEAD}' 가 없다.`); process.exit(1); }
    const scan = ws.lead.raw.scan as Record<string, unknown> | undefined;
    const matchIds = new Set(ws.matches.map((d) => d.match.match_id));
    const superseded = new Set(ws.candidates.flatMap((c) => c.supersedes ? [c.supersedes] : []));
    const history = await listReviewChanges({ lead_id: ws.lead.id });
    const read = ws.frames.filter((f) => f.read_at).length;

    say(`VOD ${ws.lead.source_key}  ${ws.lead.title}`);
    say(`  ${ws.lead.url ?? "(주소 없음)"} · 채널 ${ws.lead.channel_id ?? "-"} · 방송 ${ws.lead.observed_at.toISOString()}`);
    say(`탐색 ${scan?.status ?? "미탐색"}`);
    for (const key of ["requested", "sampled", "failed", "transcript_read"] as const) {
      const ranges = (scan?.[key] ?? []) as [number, number][];
      if (ranges.length) say(`  ${key.padEnd(15)} ${ranges.map(range).join(", ")}`);
    }
    const opened = (scan?.opened ?? []) as number[];
    if (opened.length) say(`  opened          ${opened.map(hms).join(", ")}`);
    say(`프레임 ${ws.frames.length}장 (열어 봄 ${read} · 안 열어 봄 ${ws.frames.length - read})`);
    say(`경기 ${ws.matches.length}`);
    for (const d of ws.matches) {
      say(`  ${d.match.match_id}  ${d.match.reviewed_at ? "관리자 확인" : "-"}  근거 ${d.evidence_frames.length}장`);
    }
    say(`후보 ${ws.candidates.length}`);
    const cands = [];
    for (const c of ws.candidates) {
      const n = await candidateNarrative(ws.lead.id, c.id);
      const link = c.match_id ? (matchIds.has(c.match_id) ? `→ ${c.match_id}` : `→ ${c.match_id} (없는 경기)`)
        : c.conclusion === "match" || c.conclusion === "linked" ? "→ (경기 연결 없음)" : "";
      say(`  ${c.id} (${c.conclusion}) ${range(c.at)} ${link}${superseded.has(c.id) ? "  [대체됨]" : ""}${c.reviewed_at ? "  [관리자 수정]" : ""}`);
      sayNarrative(n, "    ");
      cands.push({ ...c, ...n });
    }
    sayHistory(history);
    json = { lead: ws.lead, frames: { total: ws.frames.length, read }, matches: ws.matches.map((d) => d.match.match_id), candidates: cands, history };
  }

  if (EVENT) {
    const [event] = await sql<{ id: string; name: string; kind: string }[]>`SELECT id, name, kind FROM event WHERE slug = ${EVENT}`;
    if (!event) { console.error(`대회 '${EVENT}' 가 없다.`); process.exit(1); }
    const rows = await sql<{ match_id: string; origin: string | null; source_url: string | null; visibility: string;
      reviewed: boolean; participants: number; frames: number; has_text: boolean }[]>`
      SELECT m.match_id, m.origin, m.source_url, m.visibility, m.reviewed_at IS NOT NULL AS reviewed,
             (SELECT count(*) FROM match_participant mp WHERE mp.match_id = m.match_id)::int AS participants,
             (SELECT count(*) FROM match_evidence_frame f WHERE f.match_id = m.match_id)::int AS frames,
             EXISTS (SELECT 1 FROM review_record r WHERE r.match_id = m.match_id AND r.type = 'final_evidence') AS has_text
        FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE COALESCE(ms.event_id, m.event_id) = ${event.id}::uuid
       ORDER BY m.game_creation, m.match_id`;
    // 근거의 실체는 연결이다 — VOD 판독·검수 생성 경기는 프레임, 시드 경기는 출처 링크.
    const unlinked = rows.filter((r) => r.origin === "wiki_seed" ? !r.source_url : r.frames === 0);
    const short = rows.filter((r) => r.participants < 10);
    say(`대회 ${event.name} (${EVENT}, ${event.kind}) — 경기 ${rows.length}`);
    say(`  관리자 확인 ${rows.filter((r) => r.reviewed).length} · 공개에서 뺌 ${rows.filter((r) => r.visibility === "hidden").length}`);
    say(`근거 연결이 없는 경기 ${unlinked.length}`);
    for (const r of unlinked) say(`  ${r.match_id} (${r.origin ?? "-"}) — ${r.origin === "wiki_seed" ? "출처 링크 없음" : "근거 프레임 없음"}${r.has_text ? " · 근거 문장만 있음" : ""}`);
    say(`참가자 10명 미만 ${short.length}`);
    for (const r of short) say(`  ${r.match_id} — ${r.participants}명`);
    json = { event: { slug: EVENT, ...event }, matches: rows, unlinked, short };
    process.exitCode = unlinked.length > 0 ? 1 : 0;
  }

  if (TODO) {
    const dangling = await sql<{ lead_id: string; source_key: string; candidate_id: string; conclusion: string; match_id: string | null; at: [number, number] }[]>`
      SELECT l.id AS lead_id, l.source_key, c->>'id' AS candidate_id, c->>'conclusion' AS conclusion,
             c->>'match_id' AS match_id, c->'at' AS at
        FROM event_lead l, jsonb_array_elements(
          CASE WHEN jsonb_typeof(l.raw->'candidates') = 'array' THEN l.raw->'candidates' ELSE '[]'::jsonb END) c
       WHERE c->>'conclusion' IN ('match', 'linked')
         AND (c->>'match_id' IS NULL OR NOT EXISTS (SELECT 1 FROM match m WHERE m.match_id = c->>'match_id'))
       ORDER BY l.observed_at, c->>'id'`;
    const unresolved = await sql<{ source_key: string; n: number }[]>`
      SELECT l.source_key, count(*)::int AS n
        FROM event_lead l, jsonb_array_elements(
          CASE WHEN jsonb_typeof(l.raw->'candidates') = 'array' THEN l.raw->'candidates' ELSE '[]'::jsonb END) c
       WHERE c->>'conclusion' = 'unresolved'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.raw->'candidates') k WHERE k->>'supersedes' = c->>'id')
       GROUP BY l.source_key ORDER BY n DESC, l.source_key`;
    const failed = await sql<{ source_key: string; n: number }[]>`
      SELECT source_key, jsonb_array_length(raw->'scan'->'failed')::int AS n FROM event_lead
       WHERE jsonb_typeof(raw->'scan'->'failed') = 'array' AND jsonb_array_length(raw->'scan'->'failed') > 0
       ORDER BY n DESC, source_key`;
    say(`경기 연결이 없는 반영·연결 후보 ${dangling.length} — 근거로 경기를 찾아 잇거나, 대체 관계를 적거나, unresolved 로 되돌린다`);
    for (const d of dangling) say(`  ${d.source_key}  ${d.candidate_id} (${d.conclusion}) ${range(d.at)}${d.match_id ? `  → ${d.match_id} (없는 경기)` : ""}`);
    say(`미해결 후보가 남은 VOD ${unresolved.length}`);
    for (const u of unresolved) say(`  ${u.source_key}  ${u.n}건`);
    say(`못 본 구간이 남은 VOD ${failed.length}`);
    for (const f of failed) say(`  ${f.source_key}  ${f.n}곳`);
    // 저장 뒤 값이 채워져서야 드러나는 같은 판 — 두 경기 화면을 대조해 같은 판이면 정리하고, 다르면 distinct_from 을 남긴다.
    const duplicates = await listDuplicateSuspects();
    say(`같은 판으로 보이는 공개 경기 ${duplicates.length}쌍 — 두 경기 결과창을 대조한다`);
    for (const d of duplicates) say(`  ${d.a}  ↔  ${d.b}  (이름 무관 ${d.blind}·사람별 KDA ${d.kda}·챔피언 ${d.champ}명 일치)`);
    json = { dangling, unresolved, failed, duplicates };
  }

  console.log(JSON_OUT ? JSON.stringify(json, null, 2) : out.join("\n"));
} finally {
  await closeDb();
}

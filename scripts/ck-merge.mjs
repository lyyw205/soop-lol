/**
 * 조사 결과가 DB 로 들어가는 **유일한 창구**.
 *
 *   npm run ck:merge -- --result out/ck/<vod>/result.json
 *   npm run ck:merge -- --result <파일> --dry-run     # 무엇이 바뀔지만 본다
 *
 * ★ 왜 창구를 하나로 모으나 (docs/CK-RESEARCH-PLAN.md §5·§6)
 *   프레임 추출·전사는 **로컬 산출물만** 만들고, 조사 기록과 경기 변경은 전부 여기로 온다.
 *   경로가 여럿이면 어떤 경로가 무엇을 썼는지 추적이 안 되고, 재실행 보호(검수 보존·중복
 *   방지)를 한 군데에만 넣게 된다. 쓰기는 전부 `core/lib/db/ck.ts` 가 한다.
 *
 * ★ **파일 하나가 한 트랜잭션이다.** 중간에 하나라도 실패하면 아무것도 남지 않는다.
 *   예전엔 대회 수정이 먼저 커밋되고 경기 저장이 뒤에서 실패해도 대회 변경은 남았다.
 *   안쪽 함수도 전부 같은 트랜잭션을 받는다(`…InTx`) — 바깥에만 begin 을 두고 안에서
 *   각자 연결을 열면 원자성이 없다.
 *
 * ★ **승인 대기 초안이 아니다.** 입력 파일은 운반·재시도용 산출물이다.
 *   반영하면 곧 DB 이고 곧 공개다. 사람의 검수는 사후에 `/admin/ck` 가 한다.
 *
 * ★ 검증기가 **결론을 정하지 않는다** (§5)
 *   타입·키·참조·파일 존재·처리 응답은 기계적으로 본다. 그러나 근거 메모가 충분한지,
 *   어떤 결론을 내려야 하는지는 보지 않는다 — 정형 문구나 점수를 요구하면 조사자가
 *   그 문구를 채우는 일을 하게 되고, 그게 판단을 대신하지 못한다는 것은 이미 겪었다.
 * ★ scan.resolved_failed 는 실제 재시도로 해소했다고 확인한 [시작초, 끝초]다.
 *   sampled 만으로는 실패를 지우지 않는다. 이 명령은 raw.scan 에 누적하지 않는다.
 *
 * 입력 형식 (한 파일에 여러 결과를 배열로 넣어도 된다):
 *
 * {
 *   "resultType": "scan",
 *   "lead": { "source_key": "vod:207602969", "title": "…", "observed_at": "…",
 *             "vod_started_at": "…", // 실제 방송 시작을 확인한 경우에만
 *             "channel_id": "…", "url": "…" },
 *   "scan": { "status": "done", "requested": [[0, 18000]], "sampled": [[0, 18000]],
 *             "probes": { "planned": [0, 600] }, "opened": [600],
 *             "transcript_read": [[590, 700]], "failed": [], "resolved_failed": [], "signals": ["frame"] },
 *   "frames": [{ "frame_path": "out/ck/207602969/f_000600.jpg", "at_sec": 600,
 *                "kind": "result", "note": "결과창 점수판 — 읽은 내용" }],
 *   ★ 읽음은 scan.opened(열어 본 at_sec) 또는 frames[].read:true 로 정한다. 메모는 읽음을 켜지 않는다.
 *   "candidates": [{ "id": "c1", "at": [400, 900], "conclusion": "unresolved",
 *                    "observed": "…", "why": "…", "open_questions": ["…"] }]
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  assertCandidateMatchesExistInTx, evidenceFrameIdsByPathInTx, findMatchesAround, getLeadWorkspace,
  linkParticipantsInTx, listEvidenceFramesInTx, markLeadScanInTx, mergeLeadCandidatesInTx,
  recordEvidenceFramesInTx, streamerIdBySlug, streamerIdBySlugInTx, upsertEventLeadInTx,
  upsertMatchFromScanInTx, lockCkMatchWritesInTx,
} from "@soop-lol/core/lib/db/ck";
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { submitMatchPovInTx } from "@soop-lol/core/lib/db/ck-pov";
import { resolveChampion } from "@soop-lol/core/lib/db/participant";
import { ensureEventInTx } from "@soop-lol/core/lib/db/tournaments";
import { vodWork } from "@soop-lol/core/lib/metrics/ck-vod-status";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const resultPath = flag("--result");
const findVod = args.includes("--find-match") ? flag("--vod") : null;
const findAt = findVod ? null : flag("--find-match");

/**
 * **「이 VOD 의 어느 시간대가 이미 기록돼 있나?」** — VOD 를 훑기 **전에** 묻는다.
 *
 * ★ 왜: 한 내전을 여러 명이 방송한다. 첫 시점에서 결과창까지 확보한 판을 다음 시점에서
 *   처음부터 다시 좁히면 같은 일을 참가자 수만큼 한다(2026-09-27 CK 하나를 여섯 번 팠다).
 *   방송 시작~끝 안에 **방송 주인이 참가자로 들어간** 경기를 VOD 초로 옮겨 보여 준다.
 *
 * ★ 같은 판이라고 판정하지 않는다. VOD 초는 "경기 시작 절대시각 − 방송 시작 절대시각" 으로 옮긴 **어림**이다 —
 *   VOD 가 중간에 끊겼으면 어긋난다. 연결은 조사자가 그 초의 화면(챔피언·시계·스코어)을 보고 한다.
 *   시각이 'date'(날짜만)인 경기는 VOD 초로 옮기지 않는다 — 옮기면 거짓 구간이 된다.
 */
if (findVod) {
  const { vodDetail, vodBroadcastTimes, hms } = await import("./lib/soop-vod.mjs");
  const detail = await vodDetail(findVod);
  if (!detail) { console.error(`VOD ${findVod} 상세를 못 받았다`); process.exit(1); }
  const { start, end } = vodBroadcastTimes(detail);
  const channel = detail.bj_id ?? detail.user_id ?? null;
  if (!start || !end) { console.error(`VOD ${findVod} 의 방송 시작·끝을 못 읽었다 — 구간 조회를 할 수 없다`); process.exit(1); }
  const [owner] = channel ? await db()`
    SELECT s.id, s.display_name FROM streamer s
      JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     WHERE c.channel_id = ${channel} LIMIT 1` : [];
  if (!owner) { console.error(`채널 ${channel ?? "?"} 이 등록된 스트리머가 아니다`); process.exit(1); }
  const startMs = Date.parse(start);
  const found = (await findMatchesAround({
    at: new Date(start),
    // 방송 시작 직전에 시작한 판도 VOD 첫머리에 걸린다. 한 판 길이만큼 앞을 더 본다.
    range: { from: new Date(startMs - 60 * 60_000), to: new Date(end) },
    streamer_ids: [owner.id], owner_streamer_id: owner.id,
  })).filter((m) => m.overlap > 0).sort((a, b) => a.game_creation - b.game_creation);

  console.log(`VOD ${findVod} · ${owner.display_name}(${channel}) · 방송 ${start} ~ ${end}`);
  if (found.length === 0) {
    console.log("\n이 방송 시간대에 이 사람이 참가자로 기록된 경기가 없다. 전 범위를 평소대로 본다.");
  } else {
    console.log(`\n이 사람이 참가자로 기록된 경기 ${found.length}건 — VOD 초는 어림이다. 그 초의 화면으로 같은 판인지 확인할 것:\n`);
    for (const m of found) {
      const gaps = [
        m.result_frame_count === 0 && "결과 화면 없음",
        m.champion_missing_count > 0 && `챔피언 공백 ${m.champion_missing_count}`,
        m.kda_missing_count > 0 && `KDA 공백 ${m.kda_missing_count}`,
        m.participant_count < 10 && `로스터 ${m.participant_count}/10`,
        // 번호가 있어도 순서를 확인한 게 아닐 수 있다 — 2026-09-27 2세트가 그랬다.
        m.series_id && (!m.series_game_no || !m.set_order_known) && "세트 순서 미확인",
        !m.has_final_evidence && "최종 판정 근거 없음",
        m.open_questions.length > 0 && `남은 질문 ${m.open_questions.length}: ${m.open_questions.join(" / ")}`,
      ].filter(Boolean);
      let span;
      /**
       * ★ 예측 위치 — 결과창은 경기 끝 **뒤** 에 뜬다. 추석 CK 시점 29개 실측(2026-09-28): 예측한 끝과 실제
       *   결과창 차이 27개가 +5~+60초, 최대 +183초(경기를 만든 시점의 시작 오차). 그래서 끝−30초 ~ 끝+240초부터 좁힌다.
       *   예측은 **어디부터 볼지** 일 뿐이다 — 화면으로 확인하고, 못 찾으면 넓힌다(스킬 "예측 위치로 바로 가기").
       */
      let jump = null;
      if (m.game_creation_precision !== "datetime") span = "VOD 초 모름 — 시각이 날짜 단위 어림이다";
      else {
        const a = Math.round((m.game_creation.getTime() - startMs) / 1000);
        span = m.game_duration ? `VOD 약 ${hms(Math.max(0, a))} ~ ${hms(a + m.game_duration)}` : `VOD 약 ${hms(Math.max(0, a))} 시작 · 끝 모름`;
        if (m.game_duration && a >= 0) {
          const end = a + m.game_duration;
          jump = `예측 위치 — 결과창: --between ${Math.max(0, end - 30)}:${end + 240} --divide 5 · 밴픽·시작: --at ${Math.max(0, a - 300)},${a + 300}`;
        }
      }
      console.log(`  ${m.match_id}${m.series_game_no ? ` (${m.series_game_no}세트${m.set_order_known ? "" : "·추정"})` : ""}${m.event_name ? ` · ${m.event_name}` : ""}`);
      console.log(`    ${span}`);
      if (jump) console.log(`    ${jump}`);
      console.log(`    이 사람: ${m.owner_team_id === 100 ? "1팀" : m.owner_team_id === 200 ? "2팀" : "?"} · 챔피언 ${m.owner_champion ?? "기록 없음"}`
        + ` · ${m.winning_team === m.owner_team_id ? "승" : m.winning_team ? "패" : "승자 미정"}`);
      // ★ "공백 없음" 은 DB 조회 항목 기준이다. 화면끼리의 모순이나 VOD 경계 오류까지 확인한 게 아니다.
      console.log(`    ${gaps.length ? `조회 항목상 공백: ${gaps.join(" · ")}` : "조회 항목상 공백 없음 — 그래도 이 VOD 에서 처음부터 읽고, 직접 읽은 칸만 이 match_id 로 제출한다"}`);
    }
  }
  await closeDb();
  process.exit(0);
}

/**
 * **「이 판 이미 있나?」** — 한 내전을 여러 명이 방송하므로, 다른 시점에서 같은 판을 만나면
 * 새 경기를 만들지 말고 기존 경기에 근거만 붙여야 한다 (계획 §6).
 * ★ 같은 판인지 **판정하지 않는다.** 가까운 것을 보여주고 고르는 것은 조사자다.
 */
if (findAt) {
  const at = new Date(findAt);
  if (Number.isNaN(at.getTime())) {
    console.error(`--find-match 는 시각이어야 한다 (예: 2026-09-20T20:15:00Z). 받은 값: ${findAt}`);
    process.exit(1);
  }
  const slugs = (flag("--with") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ids = [];
  for (const s of slugs) {
    const id = await streamerIdBySlug(s);
    if (id) ids.push(id);
    else console.error(`  ⚠ 등록 안 된 slug: ${s}`);
  }
  const found = await findMatchesAround({
    at, window_minutes: Number(flag("--window") ?? 90), streamer_ids: ids,
  });
  if (found.length === 0) {
    console.log("\n가까운 시각에 이미 들어온 경기가 없다. 새로 넣으면 된다.");
  } else {
    console.log(`\n이 시각 근처의 기존 경기 ${found.length}건 — 같은 판인지는 직접 판단할 것:\n`);
    for (const m of found) {
      const when = m.game_creation.toISOString().replace("T", " ").slice(0, 16);
      console.log(`  ${m.match_id}`);
      console.log(`    ${when} · ${m.winning_team === 100 ? "1팀" : m.winning_team === 200 ? "2팀" : "승자미정"} 승`
        + `${m.event_name ? ` · ${m.event_name}` : ""}`
        + `${m.series_id ? ` · ${m.series_game_no}세트` : ""}`
        + `${m.visibility === "hidden" ? " · ⚠ 공개에서 빠짐" : ""}`
        + `${m.reviewed_at ? " · 관리자 확인(자동 수집이 못 덮는다)" : ""}`);
      console.log(`    겹친 사람 ${m.overlap}명 · 참가자: ${m.participant_names.join(", ") || "—"}`);
      console.log(`    로스터 ${m.participant_count}/10 · 미확인 ${m.unidentified_count}`
        + ` · 챔피언 공백 ${m.champion_missing_count} · KDA 공백 ${m.kda_missing_count}`);
      console.log(`    근거 프레임 ${m.evidence_frame_count}장 (결과 화면 ${m.result_frame_count})`
        + ` · 최종 판정 근거 ${m.has_final_evidence ? "있음" : "없음"}`);
      if (m.open_questions.length > 0) console.log(`    남은 질문: ${m.open_questions.join(" / ")}`);
    }
  }
  await closeDb();
  process.exit(0);
}

if (!resultPath) {
  console.error(`
사용법:
  npm run ck:merge -- --result <파일.json> [--dry-run]
  npm run ck:merge -- --find-match <시각> [--with slug,slug] [--window 90]
  npm run ck:merge -- --find-match --vod <VOD번호>

결과 파일 하나(또는 배열)를 받아 DB 에 반영한다. resultType 으로 갈린다:
  scan      실행 기록 · 후보 결론 · 근거 프레임      → event_lead(raw) · match_evidence_frame
  match     경기와 참가자                            → match · match_participant
  identify  기존 참가자에 사람을 붙인다              → match_participant.streamer_id

--find-match 는 "다른 시점에서 본 그 판이 이미 들어와 있나" 를 묻는다. 새 경기를 만들기 전에 본다.
--find-match --vod 는 VOD 를 훑기 전에 "이 방송의 어느 시간대가 이미 기록돼 있나" 를 묻는다.
`.trim());
  process.exit(1);
}

const raw = JSON.parse(readFileSync(isAbsolute(resultPath) ? resultPath : join(ROOT, resultPath), "utf8"));
const results = Array.isArray(raw) ? raw : [raw];

// ── 기계적 검증만 한다 ──────────────────────────────────────────────
//
// ⚠ 여기서 "근거가 충분한가" 를 보지 않는다. 그건 조사자의 판단이고, 검증기가 정하면
//   조사자는 검증기를 통과시키는 일을 하게 된다(§5).

const problems = [];

/**
 * ★ 단서 시각(observed_at)은 **SOOP 메타데이터가 정본**이다 — probe.json 의 broadcast.
 *   조사 결과 파일에 적힌 값은 probe 가 없을 때만 쓴다. 예전엔 조사 초안이 "지금" 을 넣거나
 *   조사자가 날짜를 손으로 적어, 2020년 VOD 가 2026년으로 저장돼 검수 목록 정렬이 틀렸다.
 */
function broadcastOf(sourceKey) {
  const vod = /^vod:(\d+)$/.exec(sourceKey ?? "")?.[1];
  const p = vod ? join(ROOT, "out", "ck", vod, "probe.json") : null;
  if (!p || !existsSync(p)) return null;
  try {
    const b = JSON.parse(readFileSync(p, "utf8")).broadcast;
    return b?.end ?? b?.start ?? null;
  } catch { return null; }
}
// 전체 길이는 실제 probe 시간축에서 가져온다. API 길이와 다를 수 있다.
function measuredVodLength(sourceKey) {
  const vod = /^vod:(\d+)$/.exec(sourceKey ?? "")?.[1];
  if (!vod) return {};
  try {
    const probe = JSON.parse(readFileSync(join(ROOT, "out", "ck", vod, "probe.json"), "utf8"));
    return probe.vod_id === Number(vod) && Number.isFinite(probe.total_sec) && probe.total_sec > 0
      && probe.parts?.length && probe.parts.every(p => p.length_measured)
      ? { vod_total_sec: probe.total_sec } : {};
  } catch { return {}; }
}
const fail = (i, msg) => problems.push(`결과 #${i + 1}: ${msg}`);
/** 자식의 supersedes 역참조로 기본 큐에서 숨길 부모를 계산한다. 원본 부모는 고치지 않는다. */
const supersededIds = (candidates) => new Set(
  candidates.map((candidate) => candidate.supersedes).filter((id) => typeof id === "string" && id),
);

/**
 * **새 경기**를 만들 때만 요구하는 것. 기존 경기에 시점을 더할 때는 요구하지 않는다 —
 * 그 화면에서 읽은 칸만 낸다(§4.2). 경기를 만든 시점이 혼자일 때 값을 고치는 재제출도 이 조건을 채워야 한다.
 */
function creationProblems(r) {
  const out = [];
  if (![100, 200].includes(r.winning_team)) {
    // ★ 승자를 모르면 경기가 아니라 **후보**로 남긴다 (§6). 없는 값을 만들지 않는다.
    out.push("match 는 winning_team 이 100 또는 200 이어야 한다 — "
      + "승자가 미해결이면 경기로 넣지 말고 scan 의 candidates 에 unresolved 로 남길 것");
  }
  // ★ **무엇을 보고 승패를 정했는지 없이는 받지 않는다** (마이그레이션 0015).
  //   ⚠ 내용이 충분한지는 **보지 않는다** — 정형 문구를 요구하면 그 문구를 채우게 된다(§5).
  if (!r.result_evidence || String(r.result_evidence).trim() === "") {
    out.push("match 는 result_evidence 가 필요하다 — 무엇을 보고 승패를 정했는지 그대로 적을 것 "
      + "(결과 화면을 못 찾았으면 그 사실과 대신 무엇을 봤는지를 적는다)");
  }
  if (!r.played_at) out.push("match 는 played_at 이 필요하다");
  // ★ 기본값이 없다(0035). VOD 시작 시각을 확인하지 않고 오프셋으로 어림했으면 "date" 다.
  if (!["datetime", "date"].includes(r.played_at_precision)) {
    out.push("match 는 played_at_precision 이 필요하다 — \"datetime\"(시각까지 확인) 또는 \"date\"(날짜만 확실)");
  }
  if (r.set_order_known !== undefined && typeof r.set_order_known !== "boolean") {
    out.push("set_order_known 은 true/false 다 — 세트 순서를 VOD 에서 확인했으면 true");
  }
  if (r.best_of !== undefined && r.best_of !== null) {
    if (!r.series_id) out.push("best_of를 적으려면 series_id가 필요하다");
    if (!Number.isInteger(r.best_of) || r.best_of <= 0 || r.best_of % 2 === 0) {
      out.push("best_of는 양의 홀수여야 한다 — 고정 2세트제나 모르는 포맷은 비울 것");
    }
    if (!r.best_of_evidence || !String(r.best_of_evidence).trim()) {
      out.push("best_of에는 대회 규정이나 VOD 시각 근거(best_of_evidence)가 필요하다");
    }
  } else if (r.best_of_evidence !== undefined && r.best_of_evidence !== null) {
    out.push("best_of_evidence만 적을 수 없다");
  }
  if (!Array.isArray(r.participants) || r.participants.length === 0) out.push("match 는 participants 가 필요하다");
  for (const [j, p] of (r.participants ?? []).entries()) {
    if (!Number.isInteger(p.participant_id)) out.push(`participants[${j}] 에 participant_id 가 없다`);
    if (![100, 200].includes(p.team_id)) out.push(`participants[${j}] 의 team_id 가 100·200 이 아니다`);
  }
  return out;
}

/** 이 파일의 경기 중 DB 에 이미 있는 것. 있으면 시점 추가, 없으면 새 경기다. */
const existingMatchIds = new Set();
{
  const ids = results.filter((r) => r.resultType === "match" && r.match_id).map((r) => r.match_id);
  if (ids.length) for (const row of await db()`SELECT match_id FROM match WHERE match_id = ANY(${ids})`) existingMatchIds.add(row.match_id);
}
/** 경기 제출이 어느 VOD 의 시점인가 — 명시(pov.source_key) → 파일에 scan 이 하나면 그것. */
const scanKeys = results.filter((r) => r.resultType === "scan" && r.lead?.source_key).map((r) => r.lead.source_key);
const povKeyOf = (r) => r.pov?.source_key ?? (scanKeys.length === 1 ? scanKeys[0] : null);

for (const [i, r] of results.entries()) {
  if (!["scan", "match", "identify"].includes(r.resultType)) {
    fail(i, `resultType 이 scan·match·identify 중 하나여야 한다 (받은 값: ${r.resultType})`);
    continue;
  }
  if (r.resultType === "scan") {
    if (r.scan?.resolved_failed !== undefined && (!Array.isArray(r.scan.resolved_failed)
      || r.scan.resolved_failed.some(x => !Array.isArray(x) || x.length !== 2 || !x.every(Number.isFinite) || x[0] < 0 || x[1] < x[0]))) {
      fail(i, "scan.resolved_failed 는 VOD 전체 초 [시작, 끝] 배열이어야 한다");
    }
    if (!r.lead?.source_key) fail(i, "scan 은 lead.source_key 가 필요하다 (VOD 번호를 정규화한 키)");
    if (!r.lead?.title) fail(i, "scan 은 lead.title 이 필요하다");
    if (!r.lead?.observed_at && !broadcastOf(r.lead?.source_key)) {
      fail(i, "scan 은 lead.observed_at 이 필요하다 (probe.json 에 방송 시각이 있으면 그걸 쓴다 — npm run ck:probe)");
    }
    if (r.lead?.vod_started_at !== undefined && Number.isNaN(new Date(r.lead.vod_started_at).getTime())) {
      fail(i, "lead.vod_started_at 은 확인된 VOD 시작 절대시각이어야 한다");
    }
    for (const [j, f] of (r.frames ?? []).entries()) {
      if (!f.frame_path) { fail(i, `frames[${j}] 에 frame_path 가 없다`); continue; }
      // 이름 칸 확대본(names/)은 원본의 일부를 키운 보조물이다 — 근거 프레임은 원본을 적는다.
      if (/(^|\/)names\/[^/]+$/.test(f.frame_path)) {
        fail(i, `frames[${j}] 는 이름 칸 확대본이다: ${f.frame_path} — 근거 프레임은 원본(${f.frame_path.replace(/names\//, "")})을 적는다`);
        continue;
      }
      // ★ 파일이 실제로 있는지는 본다. 없는 근거를 DB 에 적으면 어드민이 못 연다.
      const p = isAbsolute(f.frame_path) ? f.frame_path : join(ROOT, f.frame_path);
      if (!existsSync(p)) fail(i, `frames[${j}] 의 파일이 없다: ${f.frame_path}`);
    }
    const ids = new Set();
    for (const [j, c] of (r.candidates ?? []).entries()) {
      if ("reviewed_at" in c) fail(i, "자동 후보 입력에 reviewed_at 을 지정할 수 없다");
      if (!c.id) fail(i, `candidates[${j}] 에 id 가 없다 (재실행에 같은 후보를 가리킬 키)`);
      if (ids.has(c.id)) fail(i, `candidates[${j}] 의 id 가 중복이다: ${c.id}`);
      ids.add(c.id);
      if (!Array.isArray(c.at) || c.at.length !== 2) fail(i, `candidates[${j}] 의 at 은 [시작초, 끝초] 여야 한다`);
      if (!["match", "linked", "not_target", "unresolved"].includes(c.conclusion)) {
        fail(i, `candidates[${j}] 의 conclusion 이 match·linked·not_target·unresolved 중 하나여야 한다`);
      }
      if (c.supersedes !== undefined && (typeof c.supersedes !== "string"
        || !c.supersedes.trim() || c.supersedes === c.id)) {
        fail(i, `candidates[${j}] 의 supersedes 는 자기 자신이 아닌 부모 후보 id 문자열이어야 한다`);
      }
      // ★ "같은 판이다" 만 적고 끝내지 않는다. 그 경기에 이 VOD 의 시점을 같이 내야 한다 — 메모만 남고
      //   사진·비교가 빠지는 일(임아니 VOD 41장)을 막는다. docs/CK-MULTI-POV-PLAN.md §4.8
      if (c.conclusion === "linked" && c.match_id && !results.some((m) =>
        m.resultType === "match" && m.match_id === c.match_id && povKeyOf(m) === r.lead?.source_key)) {
        fail(i, `candidates[${j}] 이 ${c.match_id} 에 linked 인데 같은 파일에 이 VOD(${r.lead?.source_key}) 시점의 `
          + "match 제출이 없다 — 이 화면에서 직접 읽은 값과 근거 사진으로 그 경기를 match 로 낼 것");
      }
    }
  }
  if (r.resultType === "match") {
    if (r.game_mode !== undefined && !['CLASSIC', 'ARAM'].includes(r.game_mode)) fail(i, 'game_mode 는 CLASSIC 또는 ARAM');
    if (!r.match_id) { fail(i, "match 는 match_id 가 필요하다"); continue; }
    if (r.pov !== undefined) {
      if (typeof r.pov !== "object" || r.pov === null) fail(i, "pov 는 객체여야 한다");
      else {
        if (r.pov.source !== undefined && !["own", "rebroadcast"].includes(r.pov.source)) {
          fail(i, "pov.source 는 own(본인 화면) 또는 rebroadcast(남의 방송을 띄운 화면 — 방송 주인이 같은 시리즈·대회 참가자일 때만)다");
        }
        if (r.pov.time_reliable !== undefined && typeof r.pov.time_reliable !== "boolean") {
          fail(i, "pov.time_reliable 은 true/false 다 — VOD 가 끊겨 시각을 믿을 수 없으면 false");
        }
        if (r.pov.source_key !== undefined && !/^vod:\d+$/.test(r.pov.source_key)) {
          fail(i, "pov.source_key 는 vod:<번호> 다");
        }
      }
    }
    if (r.participants !== undefined && !Array.isArray(r.participants)) fail(i, "participants 는 배열이다");
    for (const [j, p] of (r.participants ?? []).entries()) {
      // null 은 "잘못 읽은 팀 관측 철회" 다. 새 경기 생성은 creationProblems 가 100·200 을 따로 요구한다.
      if (p.team_id !== undefined && p.team_id !== null && ![100, 200].includes(p.team_id)) {
        fail(i, `participants[${j}] 의 team_id 가 100·200 이 아니다 — 철회하려면 null`);
      }
      if (!p.streamer_slug && !p.puuid && !p.observed_name) {
        fail(i, `participants[${j}] 에 사람·계정·화면이름이 하나도 없다 — `
          + "이름도 못 읽었으면 그 자리는 후보 기록에 남길 것");
      }
    }
    if (r.winning_team !== undefined && r.winning_team !== null && ![100, 200].includes(r.winning_team)) {
      fail(i, "winning_team 은 100 또는 200 이다 — 모르면 적지 않고, 잘못 읽은 관측을 철회하려면 null");
    }
    if (existingMatchIds.has(r.match_id)) {
      // ★ 이미 있는 경기에는 **시점을 더한다**(docs/CK-MULTI-POV-PLAN.md §3). 이 화면에서 직접 읽은
      //   칸만 낸다 — 못 읽은 값을 기존 기록에서 옮겨 적으면 확인 안 한 값이 "일치" 로 보인다.
      if (!r.pov?.link_basis || !String(r.pov.link_basis).trim()) {
        fail(i, `${r.match_id} 는 이미 있는 경기다 — 시점을 더하려면 pov.link_basis(같은 경기라고 본 근거)가 필요하다`);
      }
    } else {
      if (!r.game_mode) fail(i, '새 경기는 game_mode(CLASSIC 또는 ARAM)가 필요하다 — 모드를 못 확인했으면 unresolved 후보로 남길 것');
      for (const msg of creationProblems(r)) fail(i, msg);
    }
  }
  if (r.resultType === "identify") {
    if (!r.match_id) fail(i, "identify 는 match_id 가 필요하다");
    for (const [j, p] of (r.participants ?? []).entries()) {
      if (!Number.isInteger(p.participant_id)) fail(i, `participants[${j}] 에 participant_id 가 없다`);
      if (!p.streamer_slug) fail(i, `participants[${j}] 에 streamer_slug 가 없다`);
      // ★ identify 는 **사람만** 붙인다. 판독값을 같이 보내면 그건 재판독이므로 match 로 가야 한다 —
      //   여기서 받으면 "일부만 보냈는데 나머지가 지워졌다" 는 사고가 다시 열린다.
      const reading = ["champion_id", "champion_name", "kills", "deaths", "assists", "team_position", "team_id"]
        .filter((k) => p[k] !== undefined);
      if (reading.length > 0) {
        fail(i, `participants[${j}] 에 판독값이 섞였다(${reading.join(", ")}). `
          + "identify 는 사람·계정만 바꾼다 — 값을 고치려면 resultType 을 match 로 보낼 것");
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`\n입력을 받지 못했다 — ${problems.length}건:`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error("\n⚠ 아무것도 쓰지 않았다. 고쳐서 다시 넣으면 된다(재전송은 중복을 만들지 않는다).");
  process.exit(1);
}

if (dryRun) {
  console.log(`\n입력 ${results.length}건 · 형식 이상 없음 (dry-run — 쓰지 않았다)`);
  for (const [i, r] of results.entries()) {
    const extra = r.resultType === "scan"
      ? `프레임 ${r.frames?.length ?? 0} · 후보 ${r.candidates?.length ?? 0}`
      : r.resultType === "match"
        ? `${r.match_id} · ${existingMatchIds.has(r.match_id) ? "시점 추가" : "새 경기"} · 참가자 ${r.participants?.length ?? 0}`
        : `${r.match_id} · ${r.participants?.length ?? 0}명`;
    console.log(`  #${i + 1} ${r.resultType}  ${extra}`);
  }
  await closeDb();
  process.exit(0);
}

/**
 * 제출을 "이 화면에서 직접 읽은 칸" 으로 바꾼다. **키가 있는 칸만** 싣는다 — 없는 칸은 안 읽음,
 * null 은 철회, 0 은 읽은 값(§4.2·4.7). 사람은 slug 를 사람 id 로, 챔피언은 이름을 id 로 바꾼다.
 */
async function povSubmissionOf(tx, r) {
  const sub = { match: {}, participants: [] };
  if ("winning_team" in r) sub.match.winning_team = r.winning_team;
  if ("duration" in r) sub.match.duration = r.duration;
  if ("series_game_no" in r) sub.match.series_game_no = r.series_game_no;
  for (const p of r.participants ?? []) {
    const ident = {
      streamer_id: p.streamer_slug ? await streamerIdBySlugInTx(tx, p.streamer_slug) : null,
      puuid: p.puuid ?? null,
      observed_name: p.observed_name ?? null,
    };
    if (p.streamer_slug && !ident.streamer_id && !p.observed_name && !p.puuid) {
      console.log(`      ⚠ 등록 안 된 slug ${p.streamer_slug} — 이름도 없어 이 자리는 비교하지 않는다`);
    }
    const e = { ident };
    if ("team_id" in p) e.team = p.team_id;
    if ("team_position" in p) e.position = p.team_position;
    if ("champion_name" in p || "champion_id" in p) {
      if (p.champion_name == null && p.champion_id == null) e.champion_id = null;
      else {
        const c = resolveChampion(p.champion_id ?? null, p.champion_name ?? null);
        if (c.champion_id) e.champion_id = c.champion_id;
        else console.log(`      ⚠ 챔피언을 표에서 못 찾았다: ${p.champion_name ?? p.champion_id} — 이 칸은 비교하지 않는다`);
      }
    }
    for (const f of ["kills", "deaths", "assists"]) if (f in p) e[f] = p[f];
    sub.participants.push(e);
  }
  return sub;
}

/**
 * 사진의 절대시각 — **실제 경기와 방송 시각을 직접 대응할 수 있을 때만** 낸다(§4.5).
 * 본인 화면 · VOD 시작 시각을 앎 · 분할 파일 길이를 모두 잰 연속 시간축 · 조사자가 끊김을 보고하지 않음.
 * 하나라도 아니면 undefined — 시각 모순 검사를 하지 않고 조사자 근거로 판단한다.
 */
async function frameTimesOf(tx, r, povKey, povLead, frameIds) {
  if ((r.pov?.source ?? "own") !== "own" || r.pov?.time_reliable === false || !frameIds.length) return undefined;
  const probeStart = (() => {
    const vod = /^vod:(\d+)$/.exec(povKey ?? "")?.[1];
    const p = vod ? join(ROOT, "out", "ck", vod, "probe.json") : null;
    try { return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).broadcast?.start ?? null : null; } catch { return null; }
  })();
  const started = povLead.raw?.vod_started_at ?? probeStart;
  if (!started || !povLead.raw?.vod_total_sec) return undefined;
  const rows = await tx`SELECT at_sec FROM match_evidence_frame WHERE id = ANY(${frameIds}::uuid[]) AND at_sec IS NOT NULL`;
  const base = new Date(started).getTime();
  return rows.map((f) => new Date(base + Number(f.at_sec) * 1000));
}

// ── 반영 ────────────────────────────────────────────────────────────

let leads = 0, framesIn = 0, cands = 0, matches = 0, skipped = 0, identified = 0, povAdded = 0;
/** 이번에 건드린 단서. 끝에 되읽어 반영 결과와 남은 일을 보여준다. */
const touchedLeads = new Set();
/** 이번 파일이 롤 scan 을 done 으로 저장한 단서 — 끝에서 범위가 영상 끝까지 덮였는지 본다. */
const doneLeads = new Set();

let committed = false;
/** 이번 파일이 넣은 VOD 판독 경기. 파일 끝에서 VOD 에 이어졌는지 본다. */
const vodMatchIds = [];
try {
  await db().begin(async (tx) => {
    // 단서·대회 행보다 먼저 잠근다. 다른 VOD의 신규 경기 저장과도 중복 검사를 직렬화한다.
    if (results.some((r) => r.resultType === "match")) await lockCkMatchWritesInTx(tx);
    for (const r of results) {
      if (r.resultType === "scan") {
        // ★ 단서에는 분류가 없다(0035) — 분류는 이어진 경기의 대회가 정한다.
        //   옛 결과 파일을 다시 넣는 것은 정상이므로 멈추지 않고 버린다는 사실만 알린다.
        if (r.lead.kind !== undefined) {
          console.log(`      ℹ lead.kind(${r.lead.kind}) 는 저장하지 않는다 — 분류는 경기의 대회(event.kind)에서 나온다`);
        }
        const leadId = await upsertEventLeadInTx(tx, {
          source: "vod_title",
          source_key: r.lead.source_key,
          url: r.lead.url ?? null,
          channel_id: r.lead.channel_id ?? null,
          title: r.lead.title,
          observed_at: new Date(broadcastOf(r.lead.source_key) ?? r.lead.observed_at),
          // 경기 절대시각을 VOD 상대 초로 바꾸는 기준은 추측하지 않는다. 조사 결과가
          // 명시적으로 확인해 준 경우에만 raw에 보존해 검수 타임라인 fallback으로 쓴다.
          raw: { ...measuredVodLength(r.lead.source_key),
            ...(r.lead.vod_started_at ? { vod_started_at: r.lead.vod_started_at } : {}) },
          // ★ state 는 단서 분류이지 공개 승인이 아니다. 조사했으면 confirmed 로 둔다.
          state: r.lead.state ?? "confirmed",
        });
        leads++;
        touchedLeads.add(leadId);
        if (r.scan?.status === "done") doneLeads.add(leadId);
        console.log(`단서  ${r.lead.source_key}  ${r.lead.title}`);

        if (r.frames?.length) {
          // ★ 열어 봤는지는 **메모가 아니라** scan.opened(열어 본 시각) 또는 frames[].read 로 정한다.
          //   메모만 있고 opened 에 없으면 읽음으로 세지 않는다 — 열어 봤다면 opened 에 적을 것.
          const opened = new Set((r.scan?.opened ?? []).map(Number));
          const frames = r.frames.map((f) => ({ ...f, read: f.read === true || (f.at_sec != null && opened.has(Number(f.at_sec))) }));
          const noteOnly = frames.filter((f) => !f.read && f.note?.trim()).length;
          if (noteOnly > 0) console.log(`      ⚠ 메모는 있는데 scan.opened 에 없는 프레임 ${noteOnly}장 — 읽음으로 세지 않았다`);
          const saved = await recordEvidenceFramesInTx(tx, leadId, frames);
          framesIn += saved.length;
          const read = saved.filter((f) => f.read_at).length;
          // ★ 뽑은 장수가 아니라 **읽은 장수**를 따로 말한다. 합치면 "다 봤다" 로 읽힌다.
          console.log(`      근거 프레임 ${saved.length}장 (읽음 ${read} · 미열람 ${saved.length - read})`);
        }
        if (r.candidates?.length) {
          const merged = await mergeLeadCandidatesInTx(tx, leadId, r.candidates);
          cands += merged.updated.length;
          if (merged.skipped.length) console.log(`      ⏭ 검수한 후보 보존: ${merged.skipped.join(", ")}`);
          const hidden = supersededIds(merged.candidates);
          const open = merged.candidates.filter((c) => c.conclusion === "unresolved" && !hidden.has(c.id)).length;
          console.log(`      후보 ${merged.candidates.length}건${open > 0 ? `  ⚠ 미해결 ${open}` : ""}`);
        }
        if (r.scan) {
          const { resolved_failed, ...scan } = r.scan;
          const savedScan = await markLeadScanInTx(tx, leadId, scan, { resolved_failed });
          const miss = savedScan.failed?.length ?? 0;
          console.log(`      실행 ${r.scan.status}`
            + `${miss > 0 ? `  ⚠ 못 본 구간 ${miss}곳 — 이 VOD 의 결론을 완결로 읽으면 안 된다` : ""}`);
          /**
           * ★★ **뽑고 안 읽은 프레임도 DB 에 남긴다** (`read_at = NULL`).
           *
           * 예전엔 여기서 CLI 경고만 찍고 지나갔다. 그러면 검수 화면에는 **조사자가 읽은
           * 프레임만** 올라가서, 안 연 구간이 "볼 게 없는 구간" 과 구분되지 않는다 —
           * 화면상으로는 오히려 "이 구간은 다 봤다" 로 읽힌다.
           *
           * 실측(207602969): 313장을 뽑아 48장만 열었는데, 검수 화면에는 그 48장만 떴다.
           * 결과 화면을 세 번(s1g2·s2g1·단판) 놓쳤고 셋 다 **이미 뽑혀 있던 프레임 안에**
           * 있었다. 세 번 다 사람이 화면을 보고 "결과창이 없는데?" 라고 해서 찾아냈다.
           *
           * 등록해 두면 어드민의 경기·후보 행이 "메모 없음 N장" 으로 구멍을 직접 보여 준다.
           * 이건 '읽음' 을 올리는 게 아니다 — 오히려 안 읽었다는 사실을 화면에 박는 것이다.
           */
          const vod = /^vod:(\d+)$/.exec(r.lead.source_key)?.[1];
          const probePath = vod ? join(ROOT, "out", "ck", vod, "probe.json") : null;
          if (probePath && existsSync(probePath)) {
            try {
              const probe = JSON.parse(readFileSync(probePath, "utf8"));
              // 이번 입력이 메모와 함께 낸 프레임은 위에서 이미 저장했다. 여기서 다시 보내면
              // kind 가 'other' 로 덮인다(결과창이 '그 밖' 으로 강등된다). 경로로 제외한다.
              const listed = new Set((r.frames ?? []).map((f) => f.frame_path));
              // 이미 DB 에 있는 프레임도 건드리지 않는다 — 지난 실행에서 읽어 둔 메모·종류를
              // 지금의 빈 입력으로 덮을 이유가 없다.
              for (const row of await listEvidenceFramesInTx(tx, leadId)) listed.add(row.frame_path);
              const fresh = (probe.frames ?? [])
                .filter((f) => f.path && !listed.has(f.path))
                .map((f) => ({ frame_path: f.path, at_sec: f.at_sec ?? null }));
              if (fresh.length > 0) {
                await recordEvidenceFramesInTx(tx, leadId, fresh);
                console.log(`      뽑았지만 아직 안 읽은 프레임 ${fresh.length}장도 등록했다`
                  + " — npm run ck:record -- --lead 로 보인다");
              }
            } catch (error) {
              console.log(`      ⚠ probe.json을 읽지 못해 안 읽은 프레임을 등록하지 못했다: ${error.message}`);
            }
          } else {
            console.log("      ℹ probe.json이 없어 뽑아 둔 프레임 목록을 확인하지 않았다"
              + " — 수동 작성 결과는 그대로 저장한다");
          }
        }
      }

      if (r.resultType === "match") {
        /**
         * 근거 프레임을 **경로로** 받아 id 로 바꾼다. 조사자는 id 를 모르고 경로는 안다.
         * 못 찾은 경로는 조용히 넘기지 않는다 — 근거가 빠진 채 성공으로 보이면 안 된다.
         */
        const frameIds = [...(r.evidence_frame_ids ?? [])];
        if (r.evidence_frames?.length) {
          const found = await evidenceFrameIdsByPathInTx(tx, r.evidence_frames);
          for (const path of r.evidence_frames) {
            const id = found.get(path);
            if (id) frameIds.push(id);
            // ★ 경고만 찍고 넘기면 "근거 없는 VOD 판독 경기" 가 성공처럼 들어간다 — 실제로 6세트가
            //   그렇게 들어가 어느 VOD 에서 봤는지 연결이 끊겼다(2026-09-25). 파일 전체를 되돌린다.
            else throw new Error(`${r.match_id}: 근거 프레임을 못 찾았다 — 같은 파일의 scan 으로 먼저 기록해야 한다: ${path}`);
          }
        }

        // ★ 이 제출이 어느 VOD 의 시점인가. 명시 → 파일에 scan 이 하나면 그것 → 출처 URL 이 같은 VOD 단서 하나.
        let povKey = povKeyOf(r);
        if (!povKey && r.source_url) {
          const hits = await tx`SELECT source_key FROM event_lead WHERE source = 'vod_title' AND url = ${r.source_url}`;
          if (hits.length === 1) povKey = hits[0].source_key;
        }
        const [povLead] = povKey ? await tx`
          SELECT id, raw FROM event_lead WHERE source = 'vod_title' AND source_key = ${povKey}` : [];
        // ★ 행을 잠그고 읽는다 — 아래 soleCreator 판단("덮어써도 되나")과 실제 저장 사이에 다른 조사가 시점·증거를 더하면
        //   낡은 판단으로 덮어쓴다. 시점을 더하는 쪽(submitMatchPovInTx)도 같은 행을 먼저 잠그므로 여기서 직렬화된다.
        //   잠근 뒤의 다음 문장이 최신 커밋을 본다(READ COMMITTED) — match_pov 조회가 그 뒤에 온다.
        const [current] = await tx`SELECT reviewed_at, game_mode FROM match WHERE match_id = ${r.match_id} FOR UPDATE`;
        const exists = current != null;
        if (!exists && !r.game_mode) throw new Error(`${r.match_id}: 새 경기의 game_mode가 필요하다`);
        const povs = exists ? await tx`SELECT lead_id::text AS lead_id, role FROM match_pov WHERE match_id = ${r.match_id}` : [];
        // ★ 경기를 만든 시점만 붙어 있을 때만 그 시점이 값을 고칠 수 있다(§4.4). 다른 시점이 한 번이라도
        //   붙었으면 그 뒤로는 덮어쓰지 않고 빈 칸 채우기·비교만 한다.
        //   ★ "붙은 시점이 하나" 만으로는 안 된다 — **그 시점이 경기를 만든(created) 시점**이어야 한다.
        //     예전 경기(시점 기록 없음)에 처음 붙은 추가 시점이 필수 정보를 다 채워 다시 내면, 혼자라는 이유로
        //     원본 전체를 덮어쓸 수 있었다(외부 검토 2026-09-28).
        const soleCreator = exists && povLead && povs.length > 0
          && povs.every((p) => p.lead_id === povLead.id) && povs.some((p) => p.role === "created");
        const complete = creationProblems(r).length === 0;
        const povSource = r.pov?.source ?? "own";
        const submission = await povSubmissionOf(tx, r);

        // 검수된 경기는 통째로 덮지 않는다 — 만든 시점이라도 시점으로 더한다(§4.6). 빈 칸 채우기는
        // 칸 단위 보호(core/lib/db/review-lock.ts)를 따른다: 사람이 바꾼 칸만 빼고 채운다.
        if (exists && !(soleCreator && complete && current.reviewed_at == null)) {
          if (r.game_mode && r.game_mode !== current.game_mode
            && (r.game_mode === 'ARAM' || current.game_mode === 'ARAM')) {
            throw new Error(`${r.match_id}: 기존 모드 ${current.game_mode}와 제출 ${r.game_mode}가 다르다. 다른 경기인지 확인하고 기존 모드는 근거로 검수할 것`);
          }
          if (!povLead) {
            throw new Error(`${r.match_id}: 이미 있는 경기인데 어느 VOD 의 시점인지 모른다 — pov.source_key 를 적거나 같은 파일에 그 VOD 의 scan 을 넣을 것`);
          }
          const res = await submitMatchPovInTx(tx, {
            match_id: r.match_id,
            lead_id: povLead.id,
            source: povSource,
            link_basis: r.pov?.link_basis ?? null,
            submission,
            frame_ids: frameIds,
            frame_times: await frameTimesOf(tx, r, povKey, povLead, frameIds),
          });
          povAdded++;
          const s = res.summary;
          console.log(`시점  ${r.match_id}  ← ${povKey} (${povSource})  사진 ${res.attached}`
            + ` · 비교 ${s.compared}(일치 ${s.agree}${s.mismatch_open ? ` · ⚠ 불일치 ${s.mismatch_open}` : ""})`
            + `${res.filled.length ? ` · 빈 칸 채움 ${res.filled.length}` : ""}`
            + `${s.pending ? ` · 대응 보류 ${s.pending}` : ""}`
            + `${res.locked ? ` · 검수된 경기라 값은 잠김(${res.lock_reason})` : ""}`
            + `${res.kept ? ` · 사람이 고친 칸이라 안 채움 ${res.kept}` : ""}`
            + `${res.reopened ? " · ⚠ 새 불일치로 검수 완료를 풀었다(미검수 목록에 다시 뜬다)" : ""}`);
          if (res.unmatched.length) console.log(`      ⚠ 경기에서 찾지 못한 사람: ${res.unmatched.join(", ")} — 비교·채우기 안 함`);
          continue;
        }
        /**
         * 대회에 **붙이기만** 한다. 분류는 그 대회의 kind 가 정한다
         * (`lol_match_category(source, queue_id, event.kind)`).
         *
         * ★ 이미 있는 대회는 읽기만 한다 — 분류·이름·주최·기간·출처를 고치지 않는다.
         *   예전엔 여기서 upsertEvent 가 멸망전 4개를 'ck' 로 덮어 153경기가 내전이 됐다(0035).
         *   `event.kind` 를 적으면 기존 값과 대조하고, 다르면 파일 전체를 되돌린다.
         * ★ 새 대회는 이름과 분류가 있어야 만든다. 기본값을 두지 않는다.
         */
        let eventId = r.event_id ?? null;
        if (!eventId && r.event?.slug) {
          eventId = await ensureEventInTx(tx, {
            slug: r.event.slug,
            name: r.event.name,
            kind: r.event.kind,
            organizer: r.event.organizer ?? null,
            starts_at: r.event.starts_at ?? null,
            ends_at: r.event.ends_at ?? null,
            source_url: r.event.source_url ?? r.source_url ?? null,
          });
          console.log(`대회  ${r.event.slug}`);
        }

        // slug → streamer_id. 화면 이름만 있는 자리는 그대로 둔다(0020).
        const participants = [];
        for (const p of r.participants) {
          let streamerId = null;
          if (p.streamer_slug) {
            streamerId = await streamerIdBySlugInTx(tx, p.streamer_slug);
            if (!streamerId) {
              console.log(`      ⚠ 등록 안 된 slug: ${p.streamer_slug} — 화면 이름만 남긴다`);
            }
          }
          participants.push({
            participant_id: p.participant_id,
            team_id: p.team_id,
            puuid: p.puuid ?? null,
            streamer_id: streamerId,
            observed_name: p.observed_name ?? null,
            team_position: p.team_position ?? null,
            champion_name: p.champion_name ?? null,
            champion_id: p.champion_id ?? null,
            kills: p.kills ?? null,
            deaths: p.deaths ?? null,
            assists: p.assists ?? null,
          });
        }

        const wrote = await upsertMatchFromScanInTx(tx, {
          match_id: r.match_id,
          game_mode: r.game_mode,
          event_id: eventId,
          played_at: new Date(r.played_at),
          played_at_precision: r.played_at_precision,
          set_order_known: r.set_order_known === true,
          duration: r.duration ?? null,
          source_url: r.source_url ?? null,
          result_evidence: r.result_evidence ?? null,
          series_id: r.series_id ?? null,
          series_game_no: r.series_game_no ?? null,
          set_role: r.set_role ?? "main",
          set_label: r.set_label ?? null,
          best_of: r.best_of ?? null,
          best_of_evidence: r.best_of_evidence ?? null,
          blue_team_id: r.blue_team_id ?? null,
          red_team_id: r.red_team_id ?? null,
          winning_team: r.winning_team,
          origin: r.origin ?? "vod_scan",
          evidence_frame_ids: frameIds,
          participants,
          distinct_from: r.distinct_from ?? [],
        });

        if ((r.origin ?? "vod_scan") === "vod_scan") vodMatchIds.push(r.match_id);
        if (wrote) {
          matches++;
          console.log(`경기  ${r.match_id}  ${r.winning_team === 100 ? "1팀" : "2팀"} 승 · 참가자 ${participants.length}`);
          if (povLead) {
            await submitMatchPovInTx(tx, {
              match_id: r.match_id, lead_id: povLead.id, source: povSource, role: "created",
              link_basis: r.pov?.link_basis ?? null, submission, frame_ids: frameIds,
            });
          } else if ((r.origin ?? "vod_scan") === "vod_scan") {
            console.log(`      ⚠ 어느 VOD 시점인지 몰라 시점 기록 없이 만들었다 — pov.source_key 를 적으면 남는다`);
          }
        } else {
          // ★ 성공으로 세지 않는다 (§3-D). 검수 보호로 막힌 것도 결과다.
          skipped++;
          console.log(`경기  ${r.match_id}  ⏭ 사람이 검수한 경기라 건드리지 않았다`);
        }
      }

      if (r.resultType === "identify") {
        /**
         * ★ **사람·계정만** 보낸다. 챔피언·KDA·포지션은 넣지 않는다.
         *   예전엔 생략한 필드를 `?? null` 로 채워 전부 넘겼고, 그게 그대로 덮여서
         *   **사람만 붙이려다 판독한 챔피언·KDA 가 지워졌다.** 식별은 부분 수정이다.
         */
        const links = [];
        for (const p of r.participants) {
          const streamerId = await streamerIdBySlugInTx(tx, p.streamer_slug);
          if (!streamerId) {
            console.log(`      ⚠ 등록 안 된 slug: ${p.streamer_slug} — 건너뛴다`);
            continue;
          }
          const link = { participant_id: p.participant_id, streamer_id: streamerId };
          // 준 것만 싣는다. 없는 키는 아예 넣지 않아야 "그대로 두라"가 된다.
          if (p.puuid !== undefined) link.puuid = p.puuid;
          if (p.observed_name !== undefined) link.observed_name = p.observed_name;
          links.push(link);
        }
        if (links.length > 0) {
          const res = await linkParticipantsInTx(tx, r.match_id, links);
          if (res.status === "no_match") {
            console.log(`식별  ${r.match_id}  ⚠ 그런 경기가 없다 — 먼저 match 로 넣어야 한다`);
          } else if (res.status === "reviewed") {
            // 성공으로 세지 않는다. 사람이 정한 매핑이 자동 식별보다 낫다.
            skipped++;
            console.log(`식별  ${r.match_id}  ⏭ 경기 전체가 보호된 검수 경기라 건드리지 않았다`);
          } else {
            identified += res.linked;
            console.log(`식별  ${r.match_id}  ${res.linked}명`
              + (res.kept.length > 0 ? `  · 사람이 정한 자리라 안 바꿈 ${res.kept.join(",")}번` : "")
              + (res.missing.length > 0 ? `  ⚠ 없는 자리 ${res.missing.join(",")}번 — 판독으로 먼저 만들 것` : ""));
          }
        }
      }
    }

    // ★ 후보가 가리키는 경기가 있는지는 **파일 끝에서** 본다 — scan 이 match 보다 앞에 와도 된다.
    await assertCandidateMatchesExistInTx(tx, [...touchedLeads]);
    // ★ VOD 판독 경기는 **어느 VOD 에서 봤는지** 이어져 있어야 한다(lead_match). match 만 넣고
    //   scan 을 빠뜨리면 경기는 공개되는데 검수 화면에서 그 VOD 로 갈 길이 없다 — 6세트가 그랬다.
    const orphan = vodMatchIds.length === 0 ? [] : await tx`
      SELECT m.match_id FROM match m
       WHERE m.match_id = ANY(${vodMatchIds})
         AND NOT EXISTS (SELECT 1 FROM lead_match lm WHERE lm.match_id = m.match_id)`;
    if (orphan.length > 0) {
      throw new Error(`VOD 에 이어지지 않은 판독 경기: ${orphan.map((o) => o.match_id).join(", ")} — `
        + "그 VOD 의 scan 결과를 같은 파일에 넣거나, 이미 조사한 VOD 를 source_url 로 적을 것");
    }
  });
  committed = true;

  console.log(`\n단서 ${leads} · 프레임 ${framesIn} · 후보 ${cands} · 경기 ${matches}`
    + `${povAdded > 0 ? ` · 기존 경기에 시점 추가 ${povAdded}` : ""}`
    + `${skipped > 0 ? ` · 검수돼 건드리지 않음 ${skipped}` : ""}`
    + `${identified > 0 ? ` · 식별 ${identified}` : ""}`);

  // ★ 반영 결과를 **되읽어** 확인한다 (§3-D — 처리 응답을 확인하고, 실패를 성공으로 적지 않는다).
  //   그리고 미해결 후보를 끝에 다시 보여준다. 이게 다음 조사의 출발점이다.
  for (const leadId of touchedLeads) {
    const ws = await getLeadWorkspace(leadId);
    if (!ws) { console.log(`⚠ 반영 뒤 단서를 되읽지 못했다: ${leadId}`); continue; }
    const hidden = supersededIds(ws.candidates);
    const open = ws.candidates.filter((c) => c.conclusion === "unresolved" && !hidden.has(c.id));
    const unread = ws.frames.filter((f) => !f.read_at).length;
    console.log(`\n${ws.lead.title}`);
    console.log(`  프레임 ${ws.frames.length}장 (안 읽음 ${unread}) · 후보 ${ws.candidates.length} · 경기 ${ws.matches.length}`);

    // ★ done 으로 저장했는데 요청 범위가 영상 끝까지 안 닿으면 셸은 이 VOD 를 partial 로 읽어 다시 연다.
    //   요청 범위는 실행기(준비 단계)가 정한다 — 세션이 못 고친다. 조용히 두지 않고 비 0 으로 끝낸다.
    //   저장은 이미 끝났다(후보·경기·프레임 보존) — 되돌리면 읽은 근거만 잃는다. 같은 입력을 다시 넣어도 결과는 같다.
    if (doneLeads.has(leadId)) {
      const w = vodWork(ws.lead.raw, null);
      if (w.reason === "partial" && w.uncovered == null) {
        console.log("  ℹ done 이지만 저장된 영상 길이가 없어 요청 범위가 끝까지 닿았는지 판정하지 못했다 (ck:probe 로 길이를 재면 기록된다).");
      } else if (w.reason === "partial" && w.uncovered > 0) {
        console.log(`  ⚠ done 으로 저장했지만 요청 범위가 영상 끝까지 덮이지 않았다 (못 본 ${w.uncovered}초) — 셸은 partial 로 읽어 다시 연다.`
          + " 요청 범위는 준비 단계(ck:local 준비 / ck:probe 기본 실행)가 영상 전체로 정한다. 그 준비를 다시 돌려 저장하거나, 끝나지 않았으면 status 를 running 으로 남긴다.");
        process.exitCode = 3;
      }
    }

    if (open.length > 0) {
      console.log(`  남은 일 — 미해결 후보 ${open.length}건:`);
      for (const c of open) {
        console.log(`    · ${c.id} (${c.at[0]}~${c.at[1]}초)`
          + `${c.open_questions?.length ? `  ${c.open_questions.join(" / ")}` : ""}`);
      }
    }
  }

  if (matches > 0) {
    console.log(`\n검수: /admin/ck  — 들어간 경기는 이미 공개다. 틀린 것만 고치거나 빼면 된다.`);
  }
} catch (error) {
  // 위에 찍힌 "단서 · 경기" 줄은 시도한 기록일 뿐이다. 커밋 전에 실패했으면 전부 되돌려졌다.
  if (!committed) {
    console.error(`\n✖ 반영하지 않았다 — 파일 전체를 되돌렸다. ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDb();
}

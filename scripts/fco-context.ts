/**
 * FC 경기 맥락 조사의 CLI 창구 (FCO-MATCH-CONTEXT-SKILL-PLAN 구현 순서 3).
 *
 *   list   맥락 큐 — 미조사가 곧 조사 후보다. --vods 면 후보 VOD 시간창까지 제안한다
 *   locate 경기마다 VOD 몇 초인가 — 4종 지점(경기 전·시작·종료·종료 후)과 결과 화면 5분할 명령
 *   draft  뽑은 프레임을 **전부 열거한** 반영 초안. 읽은 것만 채우고 나머지는 지운다
 *   show   경기 하나의 맥락 상세 (판단 이력·근거·행사)
 *   apply  반영 (유일한 쓰기 창구) — casual/unresolved/event + 근거. --dry-run 지원
 *   clue   LoL 조사 중 실제로 연 FC 화면의 교차 단서
 *   screen VOD 결과 화면에서 읽은 경기를 저장 — API 에 없는 경기(30일 이전 등). 관측을 먼저 숨겨 저장하고,
 *          같은 경기의 API·화면 기록이 유일하게 맞으면 연결, 애매하면 검수 대기(docs/FCO-SCREEN-MATCH-DESIGN.md). --dry-run 지원
 *   scan   VOD 하나의 FC 조사 도장(raw.fco_scan) — 롤 도장(scan)과 따로다. done 은 VOD 전 범위를 본 뒤에만
 *
 * 시간창 제안은 실측(docs/FCO-TIME-SAMPLES.md)의 초기값이다 — matchDate 는 경기 종료 시각,
 * 경기 구간 ≈ [matchDate−12분, matchDate]. 판정 규칙이 아니라 탐색 시작점이다.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { closeDb } from "@soop-lol/core/lib/db/client";
import {
  addFcoCrossClue, applyFcoMatchContext, getFcoContextDetail, getFcoReviewWorkspace,
  listFcoContextQueue, listFcoCrossClues, listFcoEventOptions,
  type FcoContextInput, type FcoContextStatus,
} from "@soop-lol/core/lib/games/fconline/context";
import { db } from "@soop-lol/core/lib/db/client";
import { fcoProbePlan, fcoVodOffsets, type FcoVodSpan } from "@soop-lol/core/lib/games/fconline/timeline";

const args = process.argv.slice(2);
const command = args[0];
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}
const flag = (name: string) => args.includes(`--${name}`);

const STATUS_LABEL: Record<FcoContextStatus, string> = {
  uninvestigated: "미조사",
  unresolved: "미해결",
  casual: "단순 친선",
  event: "행사",
};

/** 경기 구간 초기값 — FCO-TIME-SAMPLES 실측. matchDate 는 종료 시각이다. */
const WINDOW_BEFORE_SEC = 12 * 60;

async function listCommand() {
  const queue = await listFcoContextQueue({
    from: option("from"), to: option("to"), streamer: option("streamer"),
    status: option("status") as FcoContextStatus | undefined,
  });
  if (!queue.length) { console.log("해당 조건의 공개 스트리머 간 FC 경기가 없다."); return; }
  const counts = new Map<string, number>();
  for (const row of queue) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  for (const row of queue) {
    const played = new Date(row.played_at);
    const kst = new Date(played.getTime() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
    const tail = row.status === "event" ? `${row.event_name} (${row.event_kind})`
      : row.judgment_note ? row.judgment_note.slice(0, 40) : "";
    console.log(`${kst} KST | ${STATUS_LABEL[row.status].padEnd(5)} | ${row.players} | 근거 ${row.evidence_count} | ${row.provider_match_id}${tail ? ` | ${tail}` : ""}`);
  }
  console.log(`\n${queue.length}건 — ` + [...counts].map(([s, n]) => `${STATUS_LABEL[s as FcoContextStatus]} ${n}`).join(" · "));

  // LoL 조사가 남긴 교차 단서도 후보 입력이다 (계획 최소 흐름의 「합류」). API 경기와의
  // 대조 전이므로 특정 경기에 붙이지 않고 따로 보여 준다.
  const clues = await listFcoCrossClues();
  if (clues.length) {
    console.log(`\n▸ LoL 조사가 남긴 FC 교차 단서 ${clues.length}건 (미처리) — 시각대의 API 경기와 대조하라`);
    for (const clue of clues) {
      const at = new Date(clue.observed_at).toISOString().slice(0, 10);
      console.log(`  VOD ${clue.vod_title_no}@${clue.at_sec}s (${clue.channel_id ?? "?"}, ${at}) — ${clue.observed}`);
    }
  }

  if (flag("vods")) await suggestVods(queue.filter((r) => r.status === "uninvestigated" || r.status === "unresolved"));
  else console.log("VOD 후보 시간창까지 보려면 --vods (미조사·미해결 대상, SOOP 목록 조회 발생)");
}

/** 후보 VOD 시간창 제안. 채널·날짜당 목록 1회만 조회한다. */
async function suggestVods(rows: Awaited<ReturnType<typeof listFcoContextQueue>>) {
  const { listBroadcasts } = await import("./lib/soop-vod.mjs");
  const sql = db();
  const channels = await sql<{ match_id: string; slug: string; channel_id: string | null }[]>`
    SELECT p.match_id, s.slug, sc.channel_id
      FROM fco_match_participant p
      JOIN streamer s ON s.id = p.streamer_id
      LEFT JOIN streamer_channel sc ON sc.streamer_id = s.id
     WHERE p.match_id = ANY(${rows.map((r) => r.match_id)})
  `;
  const byMatch = new Map<string, { slug: string; channel_id: string | null }[]>();
  for (const c of channels) {
    if (!byMatch.has(c.match_id)) byMatch.set(c.match_id, []);
    byMatch.get(c.match_id)!.push(c);
  }
  const vodCache = new Map<string, Awaited<ReturnType<typeof listBroadcasts>>>();
  console.log("\n▸ 후보 VOD 시간창 (시작 추정 = 등록시각−길이 — 분할·중단이면 어긋난다, FCO-TIME-SAMPLES)");
  for (const row of rows) {
    const endUtc = new Date(row.played_at).getTime();
    const startUtc = endUtc - WINDOW_BEFORE_SEC * 1000;
    const dayKst = new Date(endUtc + 9 * 3600_000).toISOString().slice(0, 10);
    const lines: string[] = [];
    for (const part of byMatch.get(row.match_id) ?? []) {
      if (!part.channel_id) { lines.push(`  ${part.slug}: 채널 미등록 — VOD 조사 불가 (VOD 없음과 다르다)`); continue; }
      const cacheKey = `${part.channel_id}:${dayKst}`;
      if (!vodCache.has(cacheKey)) {
        vodCache.set(cacheKey, await listBroadcasts(part.channel_id, { from: dayKst, to: dayKst }));
      }
      const vods = vodCache.get(cacheKey)!;
      // listBroadcasts(.mjs) 는 배열에 truncated 를 덧붙인다 — 추론 타입엔 없다.
      if ((vods as typeof vods & { truncated?: boolean }).truncated) lines.push(`  ${part.slug}(${part.channel_id}): ⚠ 목록 조회가 잘렸다 — 아래는 불완전하다`);
      let hit = false;
      for (const v of vods) {
        const vodEndUtc = new Date(`${v.ended_at.replace(" ", "T")}+09:00`).getTime();
        const vodStartUtc = vodEndUtc - v.hours * 3600_000;
        if (vodEndUtc < startUtc || vodStartUtc > endUtc) continue;
        hit = true;
        const a = Math.max(0, Math.round((startUtc - vodStartUtc) / 1000));
        const b = Math.min(Math.round(v.hours * 3600), Math.round((endUtc - vodStartUtc) / 1000));
        lines.push(`  ${part.slug}(${part.channel_id}): VOD ${v.title_no} [cat ${v.category}] ${v.title.slice(0, 30)}`);
        lines.push(`      npm run ck:probe -- --vod ${v.title_no} --between ${a}:${b} --divide 4`);
      }
      if (!hit) lines.push(`  ${part.slug}(${part.channel_id}): 해당 시각을 덮는 VOD 없음 (그날 목록 ${vods.length}건)`);
    }
    console.log(`\n${row.provider_match_id} — ${row.players}`);
    for (const line of lines) console.log(line);
  }
}

/** `out/ck/<vod>/g0001479.jpg` → 1479. ck:probe 가 뽑아 둔 프레임 전량을 읽는다. */
async function framesOnDisk(vod: number): Promise<number[]> {
  const dir = `out/ck/${vod}`;
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => /^g\d+\.jpg$/.test(n))
    .map((n) => Number(n.slice(1, -4)))
    .sort((a, b) => a - b);
}

/**
 * 반영 초안 — **뽑은 프레임을 전부 열거한다.**
 *
 * ★ 왜 이 명령이 있나 (2026-09-24 실패에서 나왔다)
 *   손으로 쓰는 JSON 은 빈 배열에서 시작한다. 그러면 기록이 기억에 의존하고, 실제로
 *   26장을 읽고 2장만 걸었다. ck-research 는 `ck:probe` 가 만든 초안에 **전량이 이미
 *   열거돼** 있어서 그 실수가 안 난다. 같은 구조를 FC 에도 둔다.
 *   `observed` 는 빈 문자열로 나오고 apply 가 빈 값을 거부하므로,
 *   **읽은 것은 채우고 안 읽은 것은 지워야만** 반영된다.
 */
interface FcoTarget { provider_match_id: string; played_at: string; who: string; label?: string | null }

/** --event slug | --match-id a,b | --from/--to — draft·locate 가 같은 대상을 본다. */
async function resolveTargets(): Promise<FcoTarget[]> {
  const eventSlug = option("event");
  const ids = option("match-id")?.split(",").map((v) => v.trim()).filter(Boolean);
  let targets: FcoTarget[];
  if (eventSlug) {
    const found = (await listFcoEventOptions()).find((o) => o.slug === eventSlug);
    if (!found) throw new Error(`행사를 찾을 수 없다: ${eventSlug}`);
    const unit = (await getFcoReviewWorkspace({ eventId: found.id }))[0];
    if (!unit) throw new Error("그 행사에 연결된 경기가 없다");
    targets = unit.matches
      .filter((m) => m.decision !== "exclude")
      .map((m) => ({
        provider_match_id: m.provider_match_id, played_at: m.played_at,
        who: m.participants.map((p) => p.name).join(" vs "), label: m.bracket_label,
      }));
  } else {
    const queue = await listFcoContextQueue({ from: option("from"), to: option("to"), streamer: option("streamer") });
    if (!queue.length) throw new Error("대상 경기가 없다 — --event 나 --from/--to 를 확인하라");
    // ★ 큐는 DB 의 timestamptz 를 Date 로 돌려준다 — 행사 경로(문자열)와 맞춰 ISO 문자열로. Date 그대로면 locate 정렬이 깨졌다.
    targets = queue.map((r) => ({ provider_match_id: r.provider_match_id, played_at: new Date(r.played_at).toISOString(), who: r.players }));
  }

  if (ids?.length) targets = targets.filter((t) => ids.includes(t.provider_match_id));
  if (!targets.length) throw new Error("대상 경기가 없다 — --match-id 가 그 범위 안에 있나?");
  return targets;
}

/** VOD 의 시간축 — broad_start 그대로(등록시각−길이로 추정하지 않는다). */
async function vodSpan(vod: number): Promise<FcoVodSpan & { channel: string | null }> {
  const { vodDetail } = await import("./lib/soop-vod.mjs");
  const detail = await vodDetail(vod);
  if (!detail?.broad_start) throw new Error(`VOD ${vod}: broad_start 를 못 읽었다 — 시간축을 세울 수 없다`);
  const startMs = Date.parse(`${String(detail.broad_start).replace(" ", "T")}+09:00`);
  // duration 은 **밀리초**다(soop-vod.mjs). 여러 조각이면 합이 방송 전체 길이다.
  const ms = Number(detail.total_file_duration ?? 0)
    || (detail.files ?? []).reduce((sum: number, f: { duration?: number }) => sum + Number(f.duration ?? 0), 0);
  if (!ms) throw new Error(`VOD ${vod}: 길이를 못 읽었다`);
  return { vod, startMs, lengthSec: Math.round(ms / 1000), channel: detail.writer_id ?? null };
}

/**
 * 경기마다 **어느 VOD 몇 초인가**를 계산해 뽑을 명령을 낸다. 프레임은 뽑지 않는다.
 *   4종: 경기 전·시작·종료 직전 화면·종료 후 — 경기가 있었다는 것.
 *   결과 화면: [종료−20, 종료+60] 을 --divide 5 로 시작해 좁힌다 — API 와 같은 스코어인가.
 * 결과 화면은 모든 포함 경기에 필수다(검수자가 가장 먼저 보는 프레임).
 */
async function locateCommand() {
  const vods = (option("vods") ?? "").split(",").map((v) => Number(v.trim())).filter(Boolean);
  if (!vods.length) throw new Error("사용법: npm run fco:context -- locate --vods 297349995 (--event slug | --match-id id | --from/--to)");
  const targets = await resolveTargets();
  const spans = [];
  for (const vod of vods) spans.push(await vodSpan(vod));
  // 롤·FC 공유 준비(ck-local)의 구간 지도가 있으면 FC 결과 화면 칸을 함께 보여준다 — 위치 안내일 뿐(docs/CK-LOCAL-FC-PLAN.md §4-5)
  // null = 쓸 지도 없음(없거나 FC 를 모르는 옛 지도) — "결과 화면 없음"과 다르다. 그때는 기존 5분할.
  const fcMap = new Map<number, number[] | null>();
  for (const vod of vods) {
    // FC 전용 판별기 결과(fc.json, scripts/fco-local/fc_detect.py)가 있으면 그걸 먼저 쓴다 — 롤 공용 지도보다 FC 결과 화면을 잘 찾는다.
    const fcp = `out/ck/${vod}/local/fc.json`;
    if (existsSync(fcp)) {
      const f = JSON.parse(readFileSync(fcp, "utf8"));
      const sj = existsSync(`out/ck/${vod}/local/scan.json`) ? JSON.parse(readFileSync(`out/ck/${vod}/local/scan.json`, "utf8")) : null;
      const ok = !(sj?.failed ?? []).length;
      fcMap.set(vod, ok ? f.results : null);
      console.log(`지도 VOD ${vod}: ${ok ? `FC 결과 화면 ${f.results.length}곳 (FC 판별기 ${f.version})` : "썸네일 실패 구간이 있어 쓰지 않음"}`);
      continue;
    }
    const p = `out/ck/${vod}/local/scan.json`;
    const j = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
    const ok = j?.fc?.supported === true && !(j.failed ?? []).length;
    fcMap.set(vod, ok ? j.fc.results : null);
    console.log(`지도 VOD ${vod}: ${ok ? `FC 결과 화면 ${j.fc.results.length}곳` : j ? (j.fc?.supported ? "썸네일 실패 구간이 있어 쓰지 않음" : "FC 를 모르는 옛 지도 — npm run ck:local -- --vod " + vod + " 로 다시") : "없음(기존 5분할)"}`);
  }
  let missing = 0;
  for (const t of targets.sort((a, b) => a.played_at.localeCompare(b.played_at))) {
    console.log(`\n${t.label ? `[${t.label}] ` : ""}${t.who}  ${t.provider_match_id}`);
    let found = false;
    for (const span of spans) {
      const o = fcoVodOffsets(t, span);
      if (!o) continue;
      found = true;
      const plan = fcoProbePlan(o, span.lengthSec);
      const at = [plan.pre, plan.start, plan.end, plan.post].filter((x): x is number => x != null);
      console.log(`  VOD ${span.vod}  시작 ${o.start ?? "?"}s · 종료 ${o.end}s${o.start == null ? "  (시작이 VOD 앞 — 경기 전·시작 없음)" : ""}`);
      console.log(`    4종   npm run ck:probe -- --vod ${span.vod} --at ${at.join(",")}`);
      // API 종료 −30~+120초 안, 가까운 순. 시간축(HLS vs 방송 시작 차감)이 어긋날 수 있으니 원본으로 참가자·스코어를 확인하고 아니면 5분할
      const near = (fcMap.get(span.vod) ?? []).filter((x) => x >= o.end - 30 && x <= o.end + 120).sort((x, y) => Math.abs(x - o.end) - Math.abs(y - o.end));
      if (fcMap.get(span.vod) && !near.length) console.log(`    지도  이 시간창에 FC 결과 화면 검출 없음 — 5분할로`);
      if (near.length) console.log(`    지도  FC 결과 화면 ${near.join(",")}s → npm run ck:probe -- --vod ${span.vod} --at ${near.join(",")}   (아니면 아래 5분할)`);
      console.log(`    결과  npm run ck:probe -- --vod ${span.vod} --between ${plan.result[0]}:${plan.result[1]} --divide 5`);
    }
    if (!found) { missing++; console.log("  ✗ 이 경기의 종료가 어느 VOD 에도 없다 — 다른 POV 를 찾거나 미해결로 남긴다"); }
  }
  console.log(`\n경기 ${targets.length}건 · VOD 에 없는 경기 ${missing}건`);
  console.log("결과 화면은 5분할 → 결과창이 보인 칸 사이로 다시 --divide 5 → 좁아지면 --step 1. 연 프레임은 role 을 달아 근거로 건다.");
}

async function draftCommand() {
  const vods = (option("vods") ?? "").split(",").map((v) => Number(v.trim())).filter(Boolean);
  if (!vods.length) throw new Error("사용법: npm run fco:context -- draft --vods 205292057,205320949 (--event slug | --from/--to)");
  const targets = await resolveTargets();

  const byMatch = new Map<string, FcoEvidenceDraft[]>();
  let total = 0;
  for (const vod of vods) {
    // ★ broad_start 는 방송 **시작** 시각 그대로다. `등록시각 − 길이` 로 추정하지 않는다.
    const { startMs: start, channel } = await vodSpan(vod);
    const secs = await framesOnDisk(vod);
    if (!secs.length) console.log(`⚠ VOD ${vod}: out/ck/${vod}/ 에 프레임이 없다 — ck:probe 를 먼저 돌렸나?`);
    for (const at of secs) {
      const when = start + at * 1000;
      let best = targets[0], bestD = Infinity;
      for (const t of targets) {
        const d = Math.abs(Date.parse(t.played_at) - when);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!byMatch.has(best.provider_match_id)) byMatch.set(best.provider_match_id, []);
      byMatch.get(best.provider_match_id)!.push({
        evidence_key: `vod:${vod}@${at}`, kind: "vod_frame", vod_title_no: vod,
        channel_id: channel, at_sec: at,
        frame_path: `out/ck/${vod}/g${String(at).padStart(7, "0")}.jpg`,
        role: null, observed: "", why: "",
      });
      total++;
    }
    console.log(`VOD ${vod} — 방송 시작 ${new Date(start + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")} KST · 프레임 ${secs.length}장`);
  }

  const out = [...byMatch].map(([provider_match_id, evidences]) => ({ provider_match_id, evidences }));
  const path = option("out") ?? `out/fco/draft-${vods[0]}.json`;
  await writeFile(path, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  console.log(`\n${path} — 경기 ${out.length}건에 프레임 ${total}장을 열거했다.`);
  console.log("⚠ 이 파일은 **뽑은 것 전부**다. 실제로 연 것만 observed 를 채우고, 안 연 것은 지워라.");
  console.log("   빈 observed 는 apply 가 거부한다 — 그게 '읽음' 과 '뽑음' 을 가르는 자리다.");
  console.log("   role 은 본 장면대로 단다: pre·start·end·post·result. 결과 화면(result)은 경기마다 있어야 한다.");
}

interface FcoEvidenceDraft {
  evidence_key: string; kind: string; vod_title_no: number; channel_id: string | null;
  at_sec: number; frame_path: string; role: string | null; observed: string; why: string;
}

async function showCommand() {
  const id = option("match-id");
  if (!id) throw new Error("사용법: npm run fco:context -- show --match-id 넥슨matchId");
  const detail = await getFcoContextDetail(id);
  if (!detail) { console.log("수집되지 않은 경기다 — 먼저 FC 수집을 돌린다."); return; }
  console.log(`${detail.provider_match_id}  (${detail.match_id})`);
  console.log(`시각(UTC) ${detail.played_at} · 모드 ${detail.mode_key} · 상태 ${STATUS_LABEL[detail.status]}`);
  for (const p of detail.participants) console.log(`  ${p.slug ?? p.nickname}  ${p.outcome}  ${p.score ?? "?"}골`);
  if (detail.event) console.log(`행사: ${detail.event.name} (${detail.event.kind}) ${detail.event.source_url ?? ""}`);
  if (detail.history.length) {
    console.log("판단 이력 (최신부터):");
    for (const h of detail.history) console.log(`  [${h.created_at}] ${h.judgment} (${h.created_by}) — ${h.note}`);
  }
  if (detail.evidences.length) {
    console.log("근거:");
    for (const e of detail.evidences) {
      const at = e.vod_title_no ? ` VOD ${e.vod_title_no}@${e.at_sec}${e.end_sec ? `~${e.end_sec}` : ""}` : e.url ? ` ${e.url}` : "";
      console.log(`  [${e.evidence_key}] ${e.kind}${at} — ${e.observed}${e.why ? ` / 판단: ${e.why}` : ""}`);
    }
  }
}

async function applyCommand() {
  const file = option("file");
  if (!file) throw new Error("사용법: npm run fco:context -- apply --file out/fco/<이름>.json [--dry-run] [--admin]");
  const parsed = JSON.parse(await readFile(file, "utf8")) as FcoContextInput | FcoContextInput[];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const dryRun = flag("dry-run");
  const createdBy = flag("admin") ? "admin" as const : "auto" as const;
  let failed = 0;
  for (const item of items) {
    try {
      const out = await applyFcoMatchContext(item, { dryRun, createdBy });
      console.log(`\n${item.provider_match_id}`);
      for (const a of out.actions) console.log(`  ✓ ${a}`);
      for (const s of out.skipped) console.log(`  ⏭ ${s}`);
      if (!out.actions.length && !out.skipped.length) console.log("  (변경 없음)");
    } catch (e) {
      failed++;
      console.log(`\n${item.provider_match_id}`);
      console.log(`  ✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // ★ 뽑아 놓고 안 건 프레임을 알린다 (2026-09-24: 26장 읽고 2장만 걸었다).
  //   근거는 「결론을 설득할 최소」가 아니라 「실제로 연 것」이다. draft 가 기본 동선이지만
  //   손으로 쓴 파일도 여기서 한 번 더 비춘다.
  const cited = new Map<number, Set<number>>();
  for (const item of items) {
    for (const ev of item.evidences ?? []) {
      if (ev.kind !== "vod_frame" || ev.vod_title_no == null) continue;
      if (!cited.has(ev.vod_title_no)) cited.set(ev.vod_title_no, new Set());
      if (ev.at_sec != null) cited.get(ev.vod_title_no)!.add(ev.at_sec);
    }
  }
  for (const [vod, secs] of cited) {
    // 이 파일만이 아니라 이미 저장된 근거까지 합쳐 센다 — 나눠 반영한 파일마다 거짓 경고가 뜨지 않게.
    const stored = await db()<{ at_sec: number }[]>`
      SELECT DISTINCT at_sec FROM fco_context_evidence
       WHERE kind = 'vod_frame' AND vod_title_no = ${vod} AND at_sec IS NOT NULL`;
    for (const r of stored) secs.add(Number(r.at_sec));
    const onDisk = await framesOnDisk(vod);
    if (onDisk.length > secs.size) {
      console.log(`⚠ VOD ${vod}: 뽑은 프레임 ${onDisk.length}장 중 ${secs.size}장만 근거로 걸려 있다 (이 파일 + 저장분)`);
      console.log(`   연 것을 다 걸었나? 전부 열거하려면: npm run fco:context -- draft --vods ${vod} …`);
    }
  }

  // ★ 결과 화면은 모든 경기 필수(A안, 2026-09-24) — 검수자가 가장 먼저 보는 프레임이다.
  if (!dryRun) {
    const touched = items.filter((item) => item.conclusion === "event" || item.event || item.evidences?.length)
      .map((item) => item.provider_match_id);
    if (touched.length) {
      const noResult = await db()<{ provider_match_id: string }[]>`
        SELECT d.provider_match_id FROM fco_match_detail d
         WHERE d.provider_match_id = ANY(${touched})
           AND NOT EXISTS (SELECT 1 FROM fco_context_evidence fe WHERE fe.match_id = d.match_id AND fe.role = 'result')
      `;
      if (noResult.length) {
        console.log(`⚠ 결과 화면(role=result) 근거가 없는 경기 ${noResult.length}건 — locate 로 찾아 걸어야 한다:`);
        for (const r of noResult) console.log(`   ${r.provider_match_id}`);
      }
    }
  }

  const queue = await listFcoContextQueue({});
  const remain = queue.filter((r) => r.status === "uninvestigated").length;
  const open = queue.filter((r) => r.status === "unresolved").length;
  console.log(`\n남은 일: 미조사 ${remain}건 · 미해결 ${open}건${failed ? ` · 실패 ${failed}건(위 ✗)` : ""}`);
  if (dryRun) {
    console.log("(dry-run — 아무것도 저장되지 않았다)");
    // 항목마다 트랜잭션을 되돌리므로, 같은 파일의 앞 항목이 만든 시리즈·행사를 뒤 항목이 못 본다.
    // 「같은 시리즈에 다른 대진」 같은 교차 검증은 실제 반영 때 비로소 걸린다.
    if (items.some((item) => item.series)) {
      console.log("⚠ dry-run 은 항목 간 상호작용을 못 본다 — 같은 시리즈에 뒤따라 들어오는 세트의 대진 충돌은 실제 반영 때 걸린다");
    }
  }
}

async function clueCommand() {
  const vod = Number(option("vod"));
  const at = Number(option("at"));
  const observed = option("observed");
  let channel = option("channel");
  if (!Number.isInteger(vod) || !Number.isInteger(at) || !observed) {
    throw new Error("사용법: npm run fco:context -- clue --vod 207643193 --at 2400 --observed '본 것' [--channel id]");
  }
  const { vodDetail, vodBroadcastTimes } = await import("./lib/soop-vod.mjs");
  const detail = await vodDetail(vod);
  if (!channel) channel = detail?.copyright_user_id ?? detail?.bj_id ?? detail?.user_id;
  if (!channel) throw new Error("채널을 알 수 없다 — --channel 로 지정한다");
  const fresh = await addFcoCrossClue({
    vod_title_no: vod, channel_id: channel, at_sec: at, observed,
    title: detail?.title ?? undefined,
    // ★ 상세 응답엔 reg_date 가 없다(목록 응답에만 있다) — 그래서 매번 "방송 시각을 알 수 없다"로 실패해 재시도가 필요했다.
    //   방송 시각은 공용 vodBroadcastTimes(write_tm·broad_start)로 읽는다. 종료 시각이 단서 시각의 정본이다(ck-probe·ck-merge 와 같다).
    observed_at: option("observed-at") ?? vodBroadcastTimes(detail).end ?? vodBroadcastTimes(detail).start
      ?? (() => { throw new Error("방송 시각을 알 수 없다 — --observed-at 로 지정한다"); })(),
  });
  console.log(fresh ? `교차 단서 저장 — fc:${vod}:${at}` : `이미 있는 단서다 — fc:${vod}:${at} (중복 저장 안 함)`);
}

/**
 * 화면 경기 저장. 입력 파일(배열):
 *   [{ "vod": 207643193, "at_sec": 5310,                 ← 결과 화면의 VOD 전체 초(ck:probe 축)
 *      "sides": [{ "nickname": "알파감독", "score": 2 }, { "nickname": "일반감독", "score": 1 }],
 *      "mode_key": null, "observed": "결과 화면 2:1 …",  ← 본 것. 근거 프레임 g<초>.jpg 에 건다
 *      "ended_at": null }]                                ← 없으면 방송 시작 + at_sec 로 계산
 * 사람 붙이기: 등록 계정 닉네임과 **정확히 하나만** 일치하면 도구가 붙인다. 방송 주인 본인 칸은
 *   "streamer_slug": "…", "basis": "vod_owner" 로 명시한다. 근거 없이 slug 를 적지 않는다.
 */
async function screenCommand() {
  const file = option("file");
  if (!file) throw new Error("사용법: npm run fco:context -- screen --file out/fco/<이름>.json [--dry-run]");
  type Side = { nickname: string; score: number | null; outcome?: "win" | "draw" | "loss"; streamer_slug?: string; basis?: "vod_owner" | "manual" };
  type Item = { vod: number; at_sec: number; sides: [Side, Side]; mode_key?: string | null; observed: string; why?: string; ended_at?: string | null };
  const parsed = JSON.parse(await readFile(file, "utf8")) as Item | Item[];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const dryRun = flag("dry-run");
  const { saveFcoScreenMatch, screenMatchId } = await import("@soop-lol/core/lib/games/fconline/screen");
  const spans = new Map<number, Awaited<ReturnType<typeof vodSpan>>>();
  const tally: Record<string, number> = {};
  let failed = 0;
  for (const it of items) {
    const label = `vod ${it.vod} @${it.at_sec}s`;
    try {
      if (!Number.isInteger(it.vod) || !Number.isInteger(it.at_sec)) throw new Error("vod·at_sec 는 정수다");
      if (!Array.isArray(it.sides) || it.sides.length !== 2) throw new Error("sides 는 두 칸이다(1:1 경기만)");
      if (!it.observed?.trim()) throw new Error("observed(본 것)가 비었다 — 읽은 것을 적는다");
      if (!spans.has(it.vod)) spans.set(it.vod, await vodSpan(it.vod));
      const span = spans.get(it.vod)!;
      if (it.at_sec > span.lengthSec) throw new Error(`at_sec ${it.at_sec} 가 VOD 길이(${span.lengthSec}초) 밖이다`);
      const endedAt = it.ended_at ?? new Date(span.startMs + it.at_sec * 1000).toISOString();
      const frame = `out/ck/${it.vod}/g${String(it.at_sec).padStart(7, "0")}.jpg`;
      if (!existsSync(frame)) throw new Error(`근거 프레임이 없다: ${frame} — npm run ck:probe -- --vod ${it.vod} --at ${it.at_sec} 로 뽑고 연 뒤 저장한다`);
      const input = {
        vodTitleNo: it.vod, atSec: it.at_sec, endedAt, channelId: span.channel, modeKey: it.mode_key ?? null,
        sides: it.sides.map((x) => ({ nickname: x.nickname, score: x.score, outcome: x.outcome, streamerSlug: x.streamer_slug, basis: x.basis })) as never,
        evidence: [{ observed: it.observed, why: it.why, frame_path: frame }],
      };
      if (dryRun) {
        console.log(`  · ${label} → ${screenMatchId(it.vod, it.at_sec)} · 종료 ${endedAt} · ${it.sides.map((x) => `${x.nickname} ${x.score ?? "?"}`).join(" : ")} (dry-run)`);
        continue;
      }
      const r = await saveFcoScreenMatch(input);
      tally[r.status] = (tally[r.status] ?? 0) + 1;
      const extra = r.status === "linked" ? ` → ${r.link_to} (${r.link_to_source === "provider_api" ? "API 경기" : "다른 화면 경기"}에 연결·근거 복사)`
        : r.status === "needs_review" ? ` → 검수 대기: 후보 ${r.candidates.join(", ")}`
        : r.status === "protected" ? ` — ${r.reason}`
        : r.expect_api ? " (최근 30일·등록 계정 — API 경기가 오면 reconcile 이 연결한다)" : "";
      console.log(`  ✓ ${label} ${r.status} ${r.match_id}${extra}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n${dryRun ? "(dry-run — 저장하지 않았다) " : ""}${Object.entries(tally).map(([k, n]) => `${k} ${n}`).join(" · ") || "저장 0"}${failed ? ` · 실패 ${failed}` : ""}`);
  if (failed) process.exitCode = 1;
}

/** FC 조사 도장. done 은 VOD 전 범위를 본 뒤에만 — 범위가 모자라면 partial 로 다시 큐에 든다(vodWork). */
async function scanCommand() {
  const vod = Number(option("vod"));
  const status = option("status");
  if (!Number.isInteger(vod) || !["done", "running", "failed"].includes(String(status))) {
    throw new Error("사용법: npm run fco:context -- scan --vod 207643193 --status done|running|failed [--requested 0-12000] [--opened 5310,5400] [--failed a-b] [--note '…']");
  }
  const ranges = (v?: string) => (v ?? "").split(",").filter(Boolean).map((r) => r.split("-").map(Number) as [number, number]);
  const { markLeadScan, upsertEventLead } = await import("@soop-lol/core/lib/db/ck");
  const { vodWork } = await import("@soop-lol/core/lib/metrics/ck-vod-status");
  const span = await vodSpan(vod);
  const [lead] = await db()<{ id: string }[]>`SELECT id FROM event_lead WHERE source = 'vod_title' AND source_key = ${`vod:${vod}`}`;
  // FC 만 있는 VOD 는 롤 조사 단서가 없을 수 있다 — 같은 키의 VOD 단서를 만든다(롤 도장은 비어 있어 롤 큐 판정에 영향 없다).
  const title = lead ? null : (await (await import("./lib/soop-vod.mjs")).vodDetail(vod))?.title ?? `vod:${vod}`;
  const leadId = lead?.id ?? await upsertEventLead({
    source: "vod_title", source_key: `vod:${vod}`, url: `https://vod.sooplive.com/player/${vod}`,
    channel_id: span.channel, title: String(title), observed_at: new Date(span.startMs), raw: { vod_total_sec: span.lengthSec },
  });
  const next = await markLeadScan(leadId, {
    status: status as "done" | "running" | "failed",
    requested: ranges(option("requested")), failed: ranges(option("failed")),
    opened: (option("opened") ?? "").split(",").filter(Boolean).map(Number),
    note: option("note"), finished_at: new Date().toISOString(),
  }, { key: "fco_scan" });
  const [row] = await db()<{ raw: Record<string, unknown> }[]>`SELECT raw FROM event_lead WHERE id = ${leadId}::uuid`;
  const work = vodWork(row.raw, span.lengthSec, "fco_scan");
  console.log(`FC 도장 vod:${vod} — ${next.status} · 남은 일 ${work.reason ?? "없음(완료)"}${work.uncovered ? ` · 덜 본 ${work.uncovered}초` : ""}`);
}

async function main() {
  switch (command) {
    case "list": return listCommand();
    case "locate": return locateCommand();
    case "draft": return draftCommand();
    case "show": return showCommand();
    case "apply": return applyCommand();
    case "clue": return clueCommand();
    case "screen": return screenCommand();
    case "scan": return scanCommand();
    default:
      throw new Error("사용법: npm run fco:context -- <list|locate|draft|show|apply|clue|screen|scan> …  (파일 상단 주석 참고)");
  }
}

try { await main(); } finally { await closeDb(); }

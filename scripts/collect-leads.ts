/**
 * **매일 돈다.** 와치리스트 스트리머의 새 VOD 를 순차로 훑어, 그날 무슨 내전·대회가
 * 열렸고 누가 참가했는지를 텍스트로만 긁어
 * `event_lead` 에 쌓는다. LLM 을 부르지 않는다 — 토큰 0.
 *
 *   npm run ck:collect                          # 어제
 *   npm run ck:collect -- --date 2026-08-09
 *   npm run ck:collect -- --dry-run             # 무엇이 쌓일지만 본다
 *
 * ★ 왜 매일 돌아야 하나
 *   참가 신청 게시글은 지워지고, 방송 채팅은 VOD 가 사라지면 같이 사라진다.
 *   **오늘 안 쌓으면 오늘은 영원히 구멍**이다 — rank_snapshot 과 같은 성격이다.
 *   그래서 기본이 '쓰기'다. 확인만 하려면 --dry-run 을 준다.
 *
 * ★ 쌓기만 한다. 확정하지 않는다
 *   여기 들어온 건 전부 **단서**다. 예고만 하고 안 연 내전, 신청만 하고 안 나온
 *   사람이 섞여 있다. 확정은 VOD 검수가 하고 그때 `event` 가 만들어진다.
 *   docs/CK-COLLECTION.md §6.5
 *
 * ★ 호출 순서가 중요하다 — 제한된 호출을 마지막·최소로 둔다
 *   `api-channel.../board` 는 조금만 몰아쳐도 **515(CHA0002)** 로 막히고 몇 분씩
 *   안 풀린다. 그래서 "채널 60개를 게시판부터 훑기"는 정확히 막히는 방식이다.
 *
 *     1. **와치리스트 채널을 하나씩** 훑어 그날 새 VOD 를 본다 (제한 없음·노이즈 0)
 *     2. 내전이 확인된 채널만 게시판 검색   (← 제한된 호출. 60회가 아니라 5~15회)
 *     3. 그 글의 댓글로 참가 명단          (chapi. 제한 없음)
 *     4. 그 VOD 채팅에서 `!공지`(승패)     (제한 없음. 원문은 저장하지 않는다)
 *
 *   이러면 호출이 줄 뿐 아니라 정확해진다 — 실제로 방송한 내전만 보게 된다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";

import { BoardBlocked, comments, posts } from "./lib/soop-board.mjs";
import {
  LOL_CATEGORY, confirmShots, detect, hlsSegments, hms, listBroadcasts, noticesFrom,
  playableFiles, scanSheets, segmentAt, vodDetail,
} from "./lib/soop-vod.mjs";
import { soopPace } from "./lib/soop-http.mjs";
import { kstDate, makeOpt } from "./lib/cli.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const DRY = argv.includes("--dry-run");
const DATE = opt("--date", kstDate(1));   // 기본 = 어제(KST)
/**
 * 날짜 **범위**. 안 주면 --date 하루치다.
 * listBroadcasts 가 서버에서 범위를 걸러 주므로, 12일치를 훑어도 채널당 호출은 한 번이다
 * (api-channel 은 515 로 잘 막히는 호스트라 호출 수가 곧 위험이다).
 */
const FROM = opt("--from", "") || DATE;
const TO = opt("--to", "") || DATE;
/**
 * 채널 하나만 본다. 새 경로를 한 사람으로 검증하거나, 과거를 사람별로 채울 때 쓴다.
 * 와치리스트 여부와 무관하게 그 채널을 본다 — 등록만 돼 있으면 된다.
 */
const ONLY_CHANNEL = opt("--channel", "");
/**
 * 확인 프레임을 둘 곳. 시트로는 롤인지 FC온라인인지 못 가르므로(detect 주석),
 * 후보마다 원본 해상도 한 장을 남긴다. 판정이 끝나면 지워도 된다.
 */
const CONFIRM_DIR = join(process.cwd(), "out", "confirm", DATE);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/**
 * ffmpeg 이 실제로 도는지 **시작할 때 한 번** 본다.
 *
 * ★ 왜 여기서 보나 — 2026-08-13 에 조용히 당했다
 *   확인 프레임 뽑기가 try/catch 안에 있어서, ffmpeg 이 없어도 예외가 삼켜지고
 *   실행은 성공으로 끝났다. 세그먼트 548개(≈3GB)를 받아 놓고 프레임은 0장인데
 *   아무도 그 말을 안 했다. **비싼 일이 헛돌면 반드시 시끄러워야 한다.**
 */
function ffmpegWorks(): boolean {
  try { execFileSync(FFMPEG, ["-version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}
/** VOD 하나에서 뽑을 확인 프레임 상한. 구간당 6MB — 넘치면 긴 구간부터 자른다. */
const MAX_CONFIRM = 6;
const BOARD_BUDGET = Number(opt("--board-budget", "10"));
/**
 * 채팅에서 `!공지`(경기 종료·승자)를 뽑을 VOD 수.
 * 채팅은 VOD 하나에 ~10MB 라 전부 받을 수 없다 — **우선순위 상위 CHAT_BUDGET 채널**을
 * 훑는다. 게시판 예산과는 독립이다(한때 묶여 있어서 --board-budget 0 이면 채팅도
 * 조용히 안 돌았다 — 그래서 갈랐다). 원문은 저장하지 않는다: 창 하나씩 훑고
 * `!공지` 몇 줄만 남긴 뒤 바로 버린다.
 */
const CHAT_BUDGET = Number(opt("--chat-budget", "20"));
/**
 * 전역 VOD 검색까지 돌려 **새 채널을 찾는다.** 기본은 끔.
 *
 * ★ 왜 기본이 아닌가 — 실측(2026-08-09)
 *     전역 317건 중 와치리스트 것은 22건(**7%**). 나머지 93% 는 우리가 안 보는 사람이다.
 *     그리고 롤 내전만 놓고 보면 **채널별 조회가 전역을 완전히 덮었다**
 *     (둘 다 15건 · 채널별만 0 · 전역만 7건인데 그 7건은 전부 LCK 시청·서든어택).
 *     채널별은 `vod_category=40019` 로 걸러지니 노이즈가 애초에 안 들어온다.
 *   → 매일 할 일이 아니다. 다만 미등록 채널 303개를 찾아준 건 전역이라
 *     **로스터 확장용으로 가끔** 돌린다. 주 1회면 충분하다.
 */

/** 게시판 검색어. **여기를 늘리면 그만큼 차단에 가까워진다** — 채널당 호출 수다. */
/** 시트 훑기를 건너뛴다 — 제목만으로 빠르게 돌려 볼 때. 평소엔 쓰지 않는다. */
const NO_SCAN = process.argv.includes("--no-scan");
/**
 * 하룻밤에 훑을 시간 상한. 넘으면 남은 VOD 는 건너뛰고 그렇게 말한다.
 * 실측 6.1초·11.4MB/시간이라 400시간이면 41분·4.6GB 다.
 */
const SCAN_BUDGET_H = Number(opt("--scan-budget", "400"));
const KEYWORD_BOARD = String(opt("--board-keywords", "ck")).split(",").map((x) => x.trim()).filter(Boolean);
/**
 * 신청 댓글로 읽을 패턴. 포지션이나 명시적 신청어가 있어야 한다.
 * 넓게 잡으면 시청자 잡담이 참가 기록이 되고, 좁게 잡으면 신청을 놓친다.
 * **틀리는 쪽을 고르라면 놓치는 쪽**이다 — 거짓 관측은 나중에 구분이 안 된다.
 */
const SIGNUP = /(탑|정글|미드|원딜|서폿|서포터|adc|jgl)\s*[가-힣a-z]*(아이언|브론즈|실버|골드|골|플래|플|에메|다이아|다야|마스터|그마|챌린저)|신청|참가|저요|하실분|넣어주세|갈게요|할게요/i;

interface Vod { title_no: number; channel_id: string; title: string; at: string; category: string; views: number }
/** `findVods` 가 돌려주는 모양. 방송 종료 시각이 `ended_at` 이다. */
interface ChannelVod { title_no: number; channel_id: string; title: string; ended_at: string; hours: number; views: number; url: string }
/** `lib/soop-board.mjs` 가 돌려주는 모양. 그쪽은 .mjs 라 타입이 없어 여기서 적는다. */
interface Post {
  title_no: number; bbs_no: number; title: string;
  author_nick: string; author_id: string; at: string; comments: number; url: string;
}
interface Comment { channel_id: string; nickname: string; text: string; at: string }


const sql = db();
try {
  console.log(`${FROM === TO ? DATE : `${FROM} ~ ${TO}`} 치 단서 수집${DRY ? "  (확인만 — 아무것도 쓰지 않는다)" : ""}\n`);

  // 등록된 채널 ↔ 스트리머. 참가자를 즉시 이어붙이는 데 쓴다.
  const known = new Map<string, { id: string; name: string; watch: boolean }>(
    (await sql<{ channel_id: string; id: string; display_name: string; watch: boolean }[]>`
      SELECT c.channel_id, s.id, s.display_name, s.watch
        FROM streamer_channel c JOIN streamer s ON s.id = c.streamer_id
       WHERE c.platform = 'soop' AND c.active_to IS NULL
    `).map((r) => [r.channel_id, { id: r.id, name: r.display_name, watch: r.watch }]),
  );
  console.log(`등록 채널 ${known.size}개 · 그중 매일 훑을 대상 ${[...known.values()].filter((k) => k.watch).length}명`);

  const FFMPEG_OK = DRY || NO_SCAN || ffmpegWorks();
  if (!FFMPEG_OK) {
    console.error(`\n✖ ffmpeg 을 못 찾았다 (${FFMPEG}).`);
    console.error(`  확인 프레임 없이 훑으면 시트가 '게임'이라고 한 것을 롤인지 FC온라인인지`);
    console.error(`  가릴 수 없다 — 세그먼트만 수 GB 받고 판정은 못 하는 헛일이 된다.`);
    console.error(`  설치하고 다시 돌려라:  npm i -g ffmpeg-static  또는  FFMPEG_PATH=... 지정`);
    process.exit(1);
  }

  /**
   * 이미 사람이 판정한 VOD. 확인 프레임을 다시 받지 않는다.
   * 판정은 **한 번**만 하면 되는 일인데, 안 걸러 두면 범위를 다시 훑을 때마다
   * 기각된 FC온라인 방송의 프레임을 매번 다시 내려받는다.
   */
  const judged = new Set<string>(
    (await sql<{ source_key: string }[]>`
      SELECT source_key FROM event_lead WHERE source = 'vod_title' AND state <> 'new'
    `).map((r) => r.source_key),
  );

  // ── 1. 그날 롤 본방을 **전부** 가져와, 시트로 훑어 경기가 있는 것만 남긴다 ──
  //
  // ★ 제목 필터를 버렸다. 회수율이 10% 였다
  //   이상호 2026-08 실측: 롤 경기가 실제로 잡힌 방송 10건 중 제목에 ck·내전이
  //   들어간 건 **1건**뿐이었다. `!공지` 4건이 붙은 다전제가 "이상호 피파" 라는
  //   제목 아래 있었다. 제목으로 거르면 그런 게 통째로 사라진다.
  //
  // ★ 카테고리도 양방향으로 못 믿는다
  //   "덕몽어스 출격합니다" 가 롤 화면 84%, "좋은아침 신길동요리왕" 이 1% 였다.
  //   그래서 카테고리로 **후보만** 좁히고, 판정은 시트가 한다.
  //
  // ★ 그래도 event_lead 에는 **경기가 잡힌 것만** 넣는다
  //   전부 넣으면 채널당 하루 열 건씩 쌓이는데 대부분 롤이 아니다. 단서 표에
  //   쓰레기가 차면 정작 볼 것을 못 본다 — 실제로 그렇게 524건이 쌓여 있었다.
  const watchList = ONLY_CHANNEL
    ? [ONLY_CHANNEL]
    : [...known.entries()].filter(([, v]) => v.watch).map(([ch]) => ch);
  const vods: Vod[] = [];
  const evidence = new Map<number, { ratio: number; games: number; notices: number; ends: unknown[]; confirm?: string[] }>();
  let truncatedChannels = 0;
  let scannedHours = 0, skippedNoGame = 0, confirmFailed = 0;

  for (const ch of watchList) {
    const list = (await listBroadcasts(ch, { from: FROM, to: TO, category: Number(LOL_CATEGORY) })) as
      Awaited<ReturnType<typeof listBroadcasts>> & { truncated?: boolean };
    if (list.truncated) truncatedChannels++;
    for (const v of list) {
      const day = v.ended_at.slice(0, 10);
      if (day < FROM || day > TO) continue;
      const cand: Vod = { ...v, at: v.ended_at, category: LOL_CATEGORY, views: v.views };
      if (NO_SCAN) { vods.push(cand); continue; }
      if (scannedHours >= SCAN_BUDGET_H) { skippedNoGame++; continue; }

      // 시트로 훑는다 — 시간당 6.1초·11.4MB. 프레임은 여기서 받지 않는다.
      let ratio = 0, games = 0, notices = 0;
      const ends: unknown[] = [];
      // 확인 프레임을 뽑을 자리 — 경기 구간마다 한 곳. 파일이 여럿이면 파일별로 모은다.
      const spots: { file: unknown; at: number; fi: number }[] = [];
      let fi = 0;
      try {
        for (const file of playableFiles(await vodDetail(v.title_no))) {
          fi++;
          const sheet = await scanSheets(file);
          scannedHours += file.duration / 3_600_000;
          if (sheet.frames.length === 0) continue;
          const d = detect(sheet.frames, sheet.sec);
          ratio = Math.max(ratio, d.gameRatio);
          games += d.games.length;
          for (const at of confirmShots(d.games)) spots.push({ file, at, fi });
          // ★ 채팅은 경기가 잡힌 파일에서만 본다. 롤이 아닌 방송까지 훑으면 비용이 두 배다.
          if (d.games.length > 0 && file.chat) {
            const n = await noticesFrom(file);
            notices += n.ends.length;
            ends.push(...n.ends);
          }
        }
      } catch { /* 한 VOD 실패가 그날 수집을 죽이지 않는다 */ }

      if (games === 0 && notices === 0) { skippedNoGame++; continue; }

      // ★ 확인 프레임. 시트로는 게임 종류를 못 가르므로(detect 주석 참조)
      //   경기 구간마다 원본 해상도 한 장을 남겨 사람이 1초 만에 판정하게 한다.
      const confirm: string[] = [];
      if (!DRY && FFMPEG && !judged.has(`vod:${v.title_no}`)) {
        for (const spot of spots.slice(0, MAX_CONFIRM)) {
          try {
            const seg = await segmentAt(await hlsSegments(spot.file as never), spot.at);
            if (!seg) continue;
            mkdirSync(CONFIRM_DIR, { recursive: true });
            // ★ 파일 번호를 반드시 넣는다 — `at` 은 **파일별 오프셋**이라 파일이 둘이면
            //   f1 의 3:21 과 f2 의 1:39 중 뭐가 먼저인지 이름만 보고는 알 수 없다.
            const out = join(CONFIRM_DIR, `${v.channel_id}_${v.title_no}_f${spot.fi}_${hms(spot.at).replace(/:/g, "")}.jpg`);
            const tmp = join(CONFIRM_DIR, `.tmp_${process.pid}.mp4`);
            writeFileSync(tmp, seg.data);
            try {
              execFileSync(FFMPEG, ["-v", "error", "-ss", seg.offset.toFixed(2), "-i", tmp,
                "-frames:v", "1", "-vf", "scale=1568:-2", "-q:v", "3", "-y", out], { stdio: "ignore" });
              confirm.push(out);
            } finally { rmSync(tmp, { force: true }); }   // 영상은 남기지 않는다
          } catch { confirmFailed++; /* 한 장 실패가 수집을 죽이지 않는다 */ }
        }
      }
      evidence.set(v.title_no, { ratio, games, notices, ends, confirm });
      vods.push(cand);
    }
  }
  console.log(`\n▸ ${ONLY_CHANNEL ? `채널 ${ONLY_CHANNEL}` : `와치리스트 ${watchList.length}명`}`
    + ` → 롤 본방을 시트로 훑음 (${scannedHours.toFixed(0)}시간)`);
  console.log(`   경기가 잡힌 VOD ${vods.length}건 · 경기 없어 버린 것 ${skippedNoGame}건`);
  if (truncatedChannels > 0) {
    console.log(`   ⚠ ${truncatedChannels}개 채널이 페이지 상한에서 멈췄다 — 그만큼 빠졌다`);
  }

  // ★ 전역 검색(--discover)은 없앴다.
  //   SOOP 전체를 훑어 제목에 ck 가 든 VOD 를 긁어 오던 경로인데, **93% 가 잡음**이었다.
  //   실측: 그렇게 쌓인 단서 504건 중 대회로 확정된 것은 **0건**이다.
  //   지금은 제목이 아니라 화면으로 판정하므로 전역에 같은 걸 하려면 SOOP 전체를
  //   시트로 훑어야 하는데 그건 감당이 안 된다.
  //   와치리스트 밖 스트리머는 **결과 화면에서 읽은 이름**으로 발견해 등록한다
  //   (seed-tournament 가 미등록이면 이름을 찍고 멈춘다).

  let leadCount = 0;
  for (const v of vods) {
    const key = `vod:${v.title_no}`;
    const who = known.get(v.channel_id);
    if (DRY) { leadCount++; continue; }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO event_lead (source, source_key, url, channel_id, streamer_id, kind, title, observed_at, raw)
      VALUES ('vod_title', ${key}, ${`https://vod.sooplive.com/player/${v.title_no}`},
              ${v.channel_id}, ${who?.id ?? null}, ${v.category === LOL_CATEGORY ? "scrim" : "unknown"},
              ${v.title}, ${new Date(`${v.at.replace(" ", "T")}+09:00`)},
              ${sql.json({ title_no: v.title_no, category: v.category, views: v.views,
                            ...(evidence.get(v.title_no) ?? {}) } as never)})
      ON CONFLICT (source, source_key) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
      RETURNING id
    `;
    void row; // RETURNING 은 upsert 성공 확인용
    leadCount++;
  }
  console.log(`   단서 ${leadCount}건 ${DRY ? "쌓을 예정" : "쌓았다"}`);
  // ★ 무엇을 보고 단서로 삼았는지 그 자리에서 보여준다. 근거 없이 쌓이면
  //   나중에 "이건 왜 여기 있지" 를 아무도 답할 수 없다(524건이 그랬다).
  const confirms = [...evidence.values()].reduce((n, e) => n + (e.confirm?.length ?? 0), 0);
  if (confirms > 0) {
    console.log(`\n   ⚠ 시트는 **게임 종류를 못 가른다** — FC온라인·덕몽어스가 롤로 잡힌다(실측 오탐 67%).`);
    console.log(`     확인 프레임 ${confirms}장 (경기 구간마다 한 장): ${CONFIRM_DIR}`);
    console.log(`     한 방송이 게임을 갈아타기도 한다 — 구간별로 보고 롤 아닌 것만 뺀다.`);
  }
  // ★ 뽑아야 했는데 못 뽑은 것을 반드시 말한다. 조용하면 "판정 끝났다" 로 읽힌다.
  if (confirmFailed > 0) {
    console.log(`\n   ✖ 확인 프레임 ${confirmFailed}장 실패 — 그만큼은 게임 종류를 못 가렸다.`);
  }
  if (evidence.size > 0) {
    const withNotice = [...evidence.values()].filter((e) => e.notices > 0).length;
    const games = [...evidence.values()].reduce((a, e) => a + e.games, 0);
    console.log(`   근거: 경기 구간 ${games}개 · 채팅 !공지가 있는 VOD ${withNotice}건`);
    const top = [...evidence.entries()]
      .map(([no, e]) => ({ no, ...e, v: vods.find((x) => x.title_no === no) }))
      .sort((a, b) => b.notices - a.notices || b.games - a.games)
      .slice(0, 8);
    for (const t of top) {
      console.log(`     ${String(Math.round(t.ratio * 100)).padStart(3)}%  경기 ${String(t.games).padStart(2)}`
        + `  공지 ${String(t.notices).padStart(2)}  ${(t.v?.channel_id ?? "").padEnd(14)} ${String(t.v?.title ?? "").slice(0, 38)}`);
    }
  }

  // ── 2. 게시판 — 제한된 호출이라 예산 안에서만 ───────────────────
  //   watch 명단을 먼저, 그다음 조회수 높은 채널 순.
  const byChannel = new Map<string, Vod[]>();
  for (const v of vods) byChannel.set(v.channel_id, [...(byChannel.get(v.channel_id) ?? []), v]);
  //   ★ 우선순위 목록은 한 번만 만들고, 예산은 **경로마다 따로** 자른다.
  //     한 목록을 미리 잘라 쓰면 게시판 예산이 채팅 예산까지 묶어버린다
  //     (--board-budget 0 으로 두면 채팅도 안 도는 식으로 조용히 어긋난다).
  const priority = [...byChannel.entries()]
    .map(([ch, vs]) => ({ ch, vs, watch: known.get(ch)?.watch ?? false, views: Math.max(...vs.map((v) => v.views)) }))
    .sort((a, b) => Number(b.watch) - Number(a.watch) || b.views - a.views);
  const ranked = priority.slice(0, BOARD_BUDGET);
  console.log(`\n▸ 게시판 검색 — 채널 ${ranked.length}개 (예산 ${BOARD_BUDGET})`);

  let postCount = 0;
  let partCount = 0;
  let linked = 0;
  const blocked: string[] = [];

  // ★ 회로 차단기. 게시판이 막히면 **그 판은 접는다.**
  //   실측: 한 번 515 가 걸리면 10분 넘게 안 풀리고, 계속 두드리면 시계가 다시 돈다.
  //   그래서 연달아 막히면 남은 채널은 아예 건드리지 않고 다음 실행에 맡긴다.
  //   조용히 넘기지는 않는다 — 무엇을 못 봤는지 끝에 보고한다.
  let consecutiveBlocks = 0;
  const skipped: string[] = [];

  for (const { ch, watch } of ranked) {
    if (consecutiveBlocks >= 2) { skipped.push(ch); continue; }
    const hits: Post[] = [];
    try {
      // 키워드 검색은 bbsNo 없이 게시판을 가로지른다. **채널당 1번만** 친다.
      //   처음엔 ck·내전 두 번씩 쳤는데, 15채널이면 30회라 그것만으로 차단이
      //   걸렸다(실측). 검색이 제목뿐 아니라 본문까지 보므로 한 번으로 충분하다.
      //   호출 간격은 lib/soop-http 가 호스트별로 건다 — 여기서 sleep 하지 않는다.
      for (const kw of KEYWORD_BOARD) {
        const r = (await posts(ch, { keyword: kw, perPage: 20 })) as { posts: Post[] };
        hits.push(...r.posts);
      }
      consecutiveBlocks = 0;
    } catch (e) {
      // ★ 515 를 0건으로 넘기면 "그날 공지가 없었다"로 잘못 기록된다.
      //   다만 **차단(515)일 때만** 회로를 센다. 404·네트워크 오류까지 세면
      //   멀쩡한 API 를 막힌 것으로 오해하고 그 판을 통째로 접는다.
      if (e instanceof BoardBlocked) consecutiveBlocks++;
      blocked.push(`${ch}: ${e instanceof Error ? e.message.slice(0, 70) : e}`);
      continue;
    }
    // 그날 ±1일 글만. 예고는 하루 전에 올라온다.
    const near = hits.filter((p) => {
      const d = p.at.slice(0, 10);
      const diff = (new Date(`${d}T00:00:00Z`).getTime() - new Date(`${DATE}T00:00:00Z`).getTime()) / 86400_000;
      return Math.abs(diff) <= 1;
    });
    const uniq = [...new Map(near.map((p) => [p.title_no, p])).values()];
    if (uniq.length === 0) continue;
    console.log(`   ${known.get(ch)?.name ?? ch}${watch ? " ★" : ""} — 글 ${uniq.length}건`);

    for (const p of uniq) {
      const key = `post:${ch}:${p.title_no}`;
      let leadId: string | null = null;
      if (!DRY) {
        const [row] = await sql<{ id: string }[]>`
          INSERT INTO event_lead (source, source_key, url, channel_id, streamer_id, kind, title, observed_at, raw)
          VALUES ('board_post', ${key}, ${p.url}, ${ch}, ${known.get(ch)?.id ?? null}, 'unknown',
                  ${p.title}, ${new Date(`${p.at.replace(" ", "T")}+09:00`)},
                  ${sql.json({ title_no: p.title_no, author: p.author_nick, comments: p.comments } as never)})
          ON CONFLICT (source, source_key) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
          RETURNING id
        `;
        leadId = row.id;
      }
      postCount++;
      // ★ 목록이 주는 댓글 수를 믿지 않는다. 실측에서 **전부 0** 으로 왔다 —
      //   필드명이 다르거나 안 채워 주는데, 그걸 믿고 건너뛰면 정작 신청 명단이
      //   있는 글을 통째로 놓친다. 댓글 API 는 chapi 라 제한이 없으니 그냥 받는다.

      // ── 3. 댓글 = 참가 신청 명단 ───────────────────────────────
      //   user_id 가 SOOP 채널 아이디다. 우리 조인 키와 같은 값이라
      //   등록 안 된 사람도 이 값으로 남기면 나중에 등록될 때 이어진다.
      const cs: Comment[] = await comments(ch, p.title_no).catch(() => []);
      // ★ 댓글 = 참가 신청이 **아니다.** 실측에서 크게 틀렸다 —
      //   뿌뿌박스 '후지급 뿌ck' 는 모집글이라 댓글이 전부 신청이었지만
      //   이상호 'LCK 끝나고 시그니처 ck 멤버입니다' 는 **발표글**이라
      //   댓글 22건이 전부 시청자 반응(`/하이/`, `ㅅㅅ`)이었다.
      //   구분 없이 담으면 승인 큐가 시청자로 덮이고, 더 나쁘게는
      //   "이 사람이 내전에 있었다" 는 거짓 관측이 쌓인다.
      //   → 신청으로 읽히는 댓글만 남긴다. 나머지는 **버린다.**
      const signup = cs.filter((c) => SIGNUP.test(c.text));
      console.log(`      "${p.title.slice(0, 30)}" 댓글 ${cs.length}건 → 신청으로 읽히는 것 ${signup.length}건`);
      for (const c of signup) {
        if (!c.channel_id) continue;
        const owner = known.get(c.channel_id);
        if (owner) linked++;
        partCount++;
        if (DRY || !leadId) continue;
        await sql`
          INSERT INTO event_lead_participant (lead_id, channel_id, nickname, streamer_id, source, note, observed_at)
          VALUES (${leadId}::uuid, ${c.channel_id}, ${c.nickname}, ${owner?.id ?? null}, 'board_comment',
                  ${c.text}, ${new Date(`${c.at.replace(" ", "T")}+09:00`)})
          ON CONFLICT (lead_id, channel_id) DO UPDATE SET
            nickname = EXCLUDED.nickname, note = EXCLUDED.note,
            streamer_id = coalesce(event_lead_participant.streamer_id, EXCLUDED.streamer_id)
        `;
      }
    }
  }

  // ── 3.5 채팅 `!공지` — 경기 종료 시각과 승자가 공짜로 나온다 ──────
  //   있는 방송이 10곳 중 1곳뿐이지만(실측) 있으면 프레임 판독을 통째로 아낀다.
  //   ★ 채팅 원문은 **어디에도 저장하지 않는다.** 남기는 건 뽑아낸 몇 줄뿐이다.
  let noticeVods = 0;
  let noticeEnds = 0;
  let chatMB = 0;
  for (const { ch } of priority.slice(0, CHAT_BUDGET)) {
    const best = (byChannel.get(ch) ?? []).sort((a, b) => b.views - a.views)[0];
    if (!best) continue;
    const files = playableFiles(await vodDetail(best.title_no)).filter((f: { chat?: string }) => f.chat);

    // ★ 파일별로 INSERT 하지 않는다 — **VOD 당 한 번**이다.
    //   SOOP 은 긴 방송을 여러 파일로 쪼개는데(5시간급 내전은 2개 이상이 보통),
    //   source_key 가 VOD 단위라 파일마다 upsert 하면 마지막 파일의 game_ends 가
    //   앞 파일 것을 통째로 덮어썼다(감사에서 발견). 채팅은 VOD 와 함께 사라지는
    //   시한부 데이터라 그 손실은 복구 불가였다. 파일 전체를 모아 한 번에 넣고,
    //   시각(`at`)은 파일 상대라 어느 파일인지(`file`)를 같이 남긴다.
    const allEnds: unknown[] = [];
    for (const [fi, file] of files.entries()) {
      const { ends, bytes } = await noticesFrom(file);
      chatMB += bytes / 1e6;
      for (const e of ends as Record<string, unknown>[]) allEnds.push({ file: fi + 1, ...e });
    }
    if (allEnds.length === 0) continue;
    noticeVods++;
    noticeEnds += allEnds.length;
    console.log(`   ★ ${known.get(ch)?.name ?? ch} — !공지로 경기 종료 ${allEnds.length}건 (승자까지)`);
    if (DRY) continue;
    await sql`
      INSERT INTO event_lead (source, source_key, url, channel_id, streamer_id, kind, title, observed_at, raw)
      VALUES ('chat_notice', ${`chat:${best.title_no}`}, ${`https://vod.sooplive.com/player/${best.title_no}`},
              ${ch}, ${known.get(ch)?.id ?? null}, 'scrim', ${best.title},
              ${new Date(`${best.at.replace(" ", "T")}+09:00`)},
              ${sql.json({ game_ends: allEnds, files: files.length } as never)})
      ON CONFLICT (source, source_key) DO UPDATE SET raw = EXCLUDED.raw, updated_at = now()
    `;
  }

  // ── 4. 지난 관측 중 이제 등록된 사람을 잇는다 ───────────────────
  //   §11-5 와 같은 원리 — 새로 등록되면 과거가 되살아나야 한다.
  let relinked = 0;
  if (!DRY) {
    const r = await sql`
      UPDATE event_lead_participant p SET streamer_id = c.streamer_id
        FROM streamer_channel c
       WHERE p.streamer_id IS NULL AND c.platform = 'soop' AND c.active_to IS NULL
         AND c.channel_id = p.channel_id
      RETURNING p.channel_id
    `;
    relinked = r.length;
  }

  console.log(`\n${"─".repeat(58)}`);
  console.log(`단서  VOD ${leadCount}건 · 게시글 ${postCount}건`);
  // ★ 예전엔 3단계(채팅 전용 훑기)의 카운터만 찍어서, 1단계 스캔이 찾은 !공지 가
  //   요약에서 통째로 사라졌다 — 실제로 4개 VOD·13건을 찾고도 "0건" 이라고 찍혔다.
  //   두 경로를 합쳐서 말한다.
  const scanNoticeVods = [...evidence.values()].filter((e) => e.notices > 0).length;
  const scanNoticeEnds = [...evidence.values()].reduce((a, e) => a + e.notices, 0);
  console.log(`채팅 !공지  VOD ${noticeVods + scanNoticeVods}개에서 경기 종료 ${noticeEnds + scanNoticeEnds}건`
    + `  (시트 훑기에서 ${scanNoticeVods}개 · 채팅 전용 훑기에서 ${noticeVods}개)`);
  console.log(`            채팅 원문은 저장하지 않는다 — 창 단위로 훑고 바로 버린다`);
  console.log(`참가자 관측 ${partCount}건 — 등록된 사람 ${linked}명 · 아직 모르는 사람 ${partCount - linked}명`);
  if (relinked > 0) console.log(`과거 관측 ${relinked}건이 새로 이어졌다 (그 사이 등록된 사람)`);
  if (blocked.length > 0 || skipped.length > 0) {
    console.log(`\n⚠ 게시판을 못 본 채널 — 다음 실행이 다시 시도한다`);
    if (blocked.length > 0) {
      console.log(`   막힘 ${blocked.length}개:`);
      for (const b of blocked.slice(0, 3)) console.log(`     ${b}`);
    }
    if (skipped.length > 0) {
      console.log(`   회로 차단으로 건너뜀 ${skipped.length}개: ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? " …" : ""}`);
    }
    console.log(`   (게시판은 IP 단위로 막히고 10분 넘게 안 풀린다. 재시도가 차단을 늘린다)`);
  }
  const pace = soopPace();
  console.log(`\nSOOP 호출 (배속 ${pace.pace}x): `
    + Object.entries(pace.hosts).map(([h, n]) => `${h.split(".")[0]} ${n}`).join(" · "));
  console.log(`LLM 토큰 0${DRY ? "  (--dry-run 이라 아무것도 쓰지 않았다)" : ""}`);
} finally {
  await closeDb();
}

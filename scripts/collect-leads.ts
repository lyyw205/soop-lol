/**
 * **매일 돈다.** 와치리스트 스트리머의 새 VOD 를 순차로 훑어, 그날 무슨 내전·대회가
 * 열렸고 누가 참가했는지를 텍스트로만 긁어
 * `event_lead` 에 쌓는다. LLM 을 부르지 않는다 — 토큰 0.
 *
 *   npm run ck:collect                          # 어제
 *   npm run ck:collect -- --date 2026-08-09
 *   npm run ck:collect -- --dry-run             # 무엇이 쌓일지만 본다
 *   npm run ck:collect -- --discover            # 전역 검색으로 새 채널까지 (주 1회면 충분)
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
import { LOL_CATEGORY, findVods, noticesFrom, playableFiles, searchVods, vodDetail } from "./lib/soop-vod.mjs";
import { soopPace } from "./lib/soop-http.mjs";
import { kstDate, makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const DRY = argv.includes("--dry-run");
const DATE = opt("--date", kstDate(1));   // 기본 = 어제(KST)
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
const DISCOVER = argv.includes("--discover");

/** 게시판 검색어. **여기를 늘리면 그만큼 차단에 가까워진다** — 채널당 호출 수다. */
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
  console.log(`${DATE} 치 단서 수집${DRY ? "  (확인만 — 아무것도 쓰지 않는다)" : ""}\n`);

  // 등록된 채널 ↔ 스트리머. 참가자를 즉시 이어붙이는 데 쓴다.
  const known = new Map<string, { id: string; name: string; watch: boolean }>(
    (await sql<{ channel_id: string; id: string; display_name: string; watch: boolean }[]>`
      SELECT c.channel_id, s.id, s.display_name, s.watch
        FROM streamer_channel c JOIN streamer s ON s.id = c.streamer_id
       WHERE c.platform = 'soop' AND c.active_to IS NULL
    `).map((r) => [r.channel_id, { id: r.id, name: r.display_name, watch: r.watch }]),
  );
  console.log(`등록 채널 ${known.size}개 · 그중 매일 훑을 대상 ${[...known.values()].filter((k) => k.watch).length}명`);

  // ── 1. 그날 내전을 찾는다 — **와치리스트 채널을 직접 본다** ──────
  //   전역 검색이 아니라 채널별 조회다. 이유는 DISCOVER 주석에 실측으로 적었다.
  const watchList = [...known.entries()].filter(([, v]) => v.watch).map(([ch]) => ch);
  const vods: Vod[] = [];
  let truncatedChannels = 0;
  for (const ch of watchList) {
    const list = (await findVods(ch, { since: DATE })) as ChannelVod[] & { truncated?: boolean };
    if (list.truncated) truncatedChannels++;
    for (const v of list) {
      if (v.ended_at.slice(0, 10) !== DATE) continue;
      // findVods 는 롤 카테고리(40019)만 돌려주므로 category 를 채워 준다.
      vods.push({ ...v, at: v.ended_at, category: LOL_CATEGORY });
    }
  }
  console.log(`\n▸ 와치리스트 ${watchList.length}명 조회 → 내전 VOD ${vods.length}건`
    + ` · 채널 ${new Set(vods.map((v) => v.channel_id)).size}개`);
  if (truncatedChannels > 0) {
    // 페이지 상한에 닿아 목표일까지 못 내려간 채널. **빠진 게 있다는 뜻이다.**
    console.log(`   ⚠ ${truncatedChannels}개 채널이 페이지 상한에서 멈췄다 — 그만큼 빠졌다`);
  }

  // 새 채널 발견은 별개 작업이다. --discover 일 때만 전역을 훑는다.
  if (DISCOVER) {
    const g = (await searchVods(DATE)) as Vod[] & { truncated?: string[] };
    const fresh = g.filter((v) => !known.has(v.channel_id));
    console.log(`   [발견] 전역 ${g.length}건 · 미등록 채널 ${new Set(fresh.map((v) => v.channel_id)).size}개`);
    if (g.truncated?.length) console.log(`   ⚠ 전역 검색 '${g.truncated.join("', '")}' 가 상한에서 멈췄다`);
    for (const v of g) if (!vods.some((x) => x.title_no === v.title_no)) vods.push(v);
  }

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
              ${sql.json({ title_no: v.title_no, category: v.category, views: v.views } as never)})
      ON CONFLICT (source, source_key) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
      RETURNING id
    `;
    void row; // RETURNING 은 upsert 성공 확인용
    leadCount++;
  }
  console.log(`   단서 ${leadCount}건 ${DRY ? "쌓을 예정" : "쌓았다"}`);

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
  console.log(`채팅 !공지  VOD ${noticeVods}개에서 경기 종료 ${noticeEnds}건 (채팅 ${chatMB.toFixed(0)}MB 훑고 버림 — 원문 미저장)`);
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

/**
 * **밤에 무인으로 돌린다.** 1단계(ck:collect)가 쌓아 둔 그날의 event_lead 를 읽어
 * 판독할 프레임만 골라 저장한다. LLM 을 한 번도 부르지 않는다 — 토큰 0.
 *
 *   npm run ck:prep                        # 어제치, 5세션
 *   npm run ck:prep -- --date 2026-08-09
 *   npm run ck:prep -- --sessions 3 --per-session 2
 *
 * ★ 발견을 다시 하지 않는다 — event_lead 가 대상 목록이다
 *   한동안 이 스크립트가 418채널을 자체 순회해 VOD 를 재발견했다. 그러면 1단계가
 *   모은 신청글·!공지 단서가 대표 선정에 반영되지 않고, --discover 로 잡힌 미등록
 *   채널 내전은 여기서 영영 안 보였다(감사에서 발견). 지금은 **ck:collect 가 먼저**고,
 *   그날 lead 가 없으면 여기서 멈추고 그렇게 말한다 — 조용한 전체 재발견 폴백은 없다.
 *
 * 아침에 CLI 에서 `out/ck/<날짜>/` 를 열어 프레임을 판독하고,
 * 그 결과를 DB(수기 매치)로 넣는 게 다음 단계다. docs/CK-COLLECTION.md §6
 *
 * ★ 왜 세션으로 묶나
 *   같은 내전을 평균 6.1명이 동시에 방송한다(실측). 6개를 다 훑으면 같은 경기를
 *   여섯 번 판독하게 된다. **시간이 겹치는 VOD 를 한 세션으로 묶고 대표만 고른다.**
 *   대표가 실패하면 `--per-session 2` 로 시점을 늘린다 — 그게 중복의 쓸모다.
 *
 * ★ 프레임만 남기고 영상은 버린다
 *   1080p 세그먼트는 6초에 6MB 다. 프레임을 뽑은 뒤 지운다.
 *   남는 건 장당 ~200KB 의 JPEG 뿐이다.
 *
 * ★ 다시 돌려도 안전하다
 *   이미 뽑아 둔 프레임은 건너뛴다. 중간에 끊겨도 이어서 하면 된다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { kstDate, makeOpt } from "./lib/cli.mjs";
import { soopPace } from "./lib/soop-http.mjs";
import {
  detect, hms, hlsSegments, noticesFrom, playableFiles, scanSheets, segmentAt, vodDetail,
} from "./lib/soop-vod.mjs";

const args = process.argv.slice(2);
const opt = makeOpt(args);
const DATE = opt("--date", kstDate(1));   // 기본 = 어제(KST)
const SESSIONS = Number(opt("--sessions", 5));
const PER_SESSION = Number(opt("--per-session", 1));
/**
 * 파일 하나에서 뽑을 프레임 상한.
 * 실측 밀도는 시간당 2.4~5.2곳인데, 오버레이가 계속 어두운 방송은 **2.7시간에
 * 43곳**이 나왔다. 상한이 없으면 그런 VOD 하나가 아침 세션을 통째로 잡아먹고
 * 다운로드도 세그먼트당 6MB 씩 불어난다. 넘치면 **고르게 솎아낸다** —
 * 앞에서 자르면 방송 후반 경기를 통째로 잃는다.
 */
const MAX_PER_FILE = Number(opt("--max-frames", 12));
const OUT = join(process.cwd(), "out", "ck", DATE);

/** N 개만 남기되 시간축에 고르게 남긴다. */
function thin(list, n) {
  if (list.length <= n) return list;
  const step = (list.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => list[Math.round(i * step)]);
}

/** ffmpeg 은 시스템 것을 쓴다. 없으면 뭘 해야 하는지 알려주고 멈춘다. */
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
try {
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
} catch {
  console.error(
    `ffmpeg 을 찾지 못했다 (${FFMPEG}).\n`
    + `  Ubuntu/WSL:  sudo apt install ffmpeg\n`
    + `  다른 경로면:  FFMPEG_PATH=/경로/ffmpeg npm run ck:prep`,
  );
  process.exit(1);
}

const sql = db();
try {
  const chans = await sql`
    SELECT s.id, s.slug, s.display_name, c.channel_id
      FROM streamer s
      JOIN streamer_channel c ON c.streamer_id = s.id AND c.platform = 'soop' AND c.active_to IS NULL
     ORDER BY s.display_name`;
  const byChannel = new Map(chans.map((c) => [c.channel_id, c]));

  // ── 1. 그날의 event_lead 가 대상 목록이다 ──────────────────────────
  //   1단계(ck:collect)가 이미 발견을 끝냈다. 여기서 다시 찾지 않는다 —
  //   같은 발견 루프가 두 벌 있으면 두 단계가 서로 다른 VOD 집합을 보게 된다.
  const leads = await sql`
    SELECT channel_id, streamer_id, title, observed_at, raw
      FROM event_lead
     WHERE source = 'vod_title'
       AND kind = 'scrim'   -- --discover 가 심는 비-롤 lead(kind='unknown')는 여기 볼 일이 없다.
                            -- 미등록 채널의 진짜 내전은 롤 카테고리라 'scrim' 으로 들어온다.
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::date = ${DATE}::date`;
  console.log(`${DATE} 치 준비 — event_lead 에서 내전 VOD ${leads.length}건\n`);
  if (leads.length === 0) {
    console.log(`그날 lead 가 없다. 먼저 수집을 돌려라:\n  npm run ck:collect -- --date ${DATE}`);
    process.exit(0);
  }

  // 1단계가 남긴 단서 — 대표 선정에 쓴다 (docs/CK-COLLECTION.md §0-4 순서).
  //   신청 게시글: 그날 ±1일 (예고는 하루 전에 올라온다)
  const signupCh = new Set((await sql`
    SELECT DISTINCT channel_id FROM event_lead
     WHERE source = 'board_post'
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::date
           BETWEEN (${DATE}::date - 1) AND (${DATE}::date + 1)`).map((r) => r.channel_id));
  const noticeCh = new Set((await sql`
    SELECT DISTINCT channel_id FROM event_lead
     WHERE source = 'chat_notice'
       AND (observed_at AT TIME ZONE 'Asia/Seoul')::date = ${DATE}::date`).map((r) => r.channel_id));

  // VOD 상세는 세션 묶기(시작·끝 시각)와 파일 목록 둘 다에 필요하다.
  // lead 는 15~30건/일이라 상세 POST 그만큼은 싸다(제한 없는 엔드포인트).
  const vods = [];
  for (const l of leads) {
    const titleNo = Number(l.raw?.title_no);
    if (!titleNo) continue;
    const detail = await vodDetail(titleNo);
    if (!detail) continue;
    // ★ 재생 가능한 파일이 없는 조각 VOD 는 여기서 거른다. repRank 의 '짧은 VOD
    //   우선'이 이런 것을 대표로 뽑아 세션 슬롯을 헛돌게 했다(적대 리뷰에서 발견).
    //   durMs=0 이면 더 나쁘다 — overlap 판정의 shorter*0.5 가 0 이 돼 그날의
    //   모든 VOD 를 한 세션으로 빨아들인다.
    const files = playableFiles(detail);
    if (files.length === 0) continue;
    const durMs = Number(detail.total_file_duration ?? 0)
      || files.reduce((t, f) => t + f.duration, 0);
    if (durMs <= 0) continue;
    const endMs = new Date(l.observed_at).getTime();
    vods.push({
      files,
      channel_id: l.channel_id,
      title: l.title,
      title_no: titleNo,
      url: `https://vod.sooplive.com/player/${titleNo}`,
      ended_at: l.observed_at,
      views: Number(l.raw?.views ?? 0),
      endMs,
      startMs: endMs - durMs,
      hours: durMs / 3_600_000,
      detail,
      hasSignup: signupCh.has(l.channel_id),
      hasNotice: noticeCh.has(l.channel_id),
    });
  }
  if (vods.length === 0) { console.log("상세를 하나도 못 열었다 — VOD 가 벌써 내려갔을 수 있다."); process.exit(0); }

  // ── 2. 시간이 겹치면 같은 세션이다 ─────────────────────────────────
  //
  // ★ 겹치면 무조건 잇는 방식은 못 쓴다
  //   처음엔 "시작이 앞 세션 끝보다 이르면 같은 세션"으로 했더니 **26개 VOD 가
  //   세션 2개로 뭉쳤고 하나가 23시점**이었다. 20시간짜리 긴 방송이 서로 다른
  //   내전을 사슬처럼 이어붙인 것이다. 그러면 그날의 다른 내전이 통째로 빠진다.
  //
  //   대신 **대표를 먼저 정하고 그 대표와 실제로 겹치는 것만** 붙인다.
  //   대표는 아래 repRank(§0-4 순서)로 잡고, 짧은 쪽 길이의 절반 이상 겹치는 것만
  //   같은 세션으로 본다. 사슬이 끊기고 대표가 곧 우리가 훑을 VOD 가 된다.
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
  // 대표 선정 순서 (docs/CK-COLLECTION.md §0-4 — 실측 근거가 거기 있다):
  //   ① 신청 게시글이 있는 채널 — 주최자다. 명단이 통째로 나온다
  //   ② !공지 가 있는 채널 — 승패가 공짜로 나온다
  //   ③ VOD 가 짧은 채널 — 시트가 적어 싸다
  //   ④ 조회수 — 화질·오버레이가 대체로 낫다
  const repRank = (a, b) =>
    Number(b.hasSignup) - Number(a.hasSignup)
    || Number(b.hasNotice) - Number(a.hasNotice)
    || a.hours - b.hours
    || b.views - a.views;
  const pool = [...vods].sort(repRank);
  const sessions = [];
  while (pool.length > 0) {
    const rep = pool.shift();
    const mates = [];
    for (let i = pool.length - 1; i >= 0; i--) {
      const shorter = Math.min(rep.endMs - rep.startMs, pool[i].endMs - pool[i].startMs);
      if (overlap(rep, pool[i]) >= shorter * 0.5) mates.push(...pool.splice(i, 1));
    }
    sessions.push({ vods: [rep, ...mates.sort(repRank)] });
  }
  const picked = sessions.slice(0, SESSIONS);

  console.log(`\n내전 VOD ${vods.length}건 → 동시 방송 묶음 ${sessions.length}개 → 상위 ${picked.length}개 처리`);
  for (const [i, s] of picked.entries()) {
    const r0 = s.vods[0];
    const clue = [r0.hasSignup ? "신청글" : null, r0.hasNotice ? "!공지" : null].filter(Boolean).join("·");
    console.log(`  ${i + 1}: 동시 ${s.vods.length}개 · 대표 ${byChannel.get(r0.channel_id)?.display_name ?? r0.channel_id}`
      + `${clue ? ` [${clue}]` : ""} · ${r0.title.slice(0, 40)}`);
  }
  // 묶음은 **같은 내전이라는 뜻이 아니다.** 시간이 겹칠 뿐이다.
  // 다만 묶음마다 대표를 하나씩 고르면 서로 다른 내전으로 잘 흩어진다 —
  // 실측에서 묶음 4개가 실제로 서로 다른 내전 4개를 줬다. 그게 이 묶기의 쓸모다.

  // ── 3. 시트로 훑고 프레임을 뽑는다 ─────────────────────────────────
  mkdirSync(OUT, { recursive: true });
  const manifest = { date: DATE, sessions: [] };
  let frameCount = 0, downloadMB = 0;
  const skippedFiles = [];   // 타임아웃 등으로 못 훑은 파일. 끝에 보고한다

  // ★ 이름 대조표를 같이 낸다
  //   프레임에는 **방송 닉네임**(김민교)과 **인게임 닉네임**(사나이묵직한주먹)이 섞여
  //   나오는데, 대회 시드(seed/tournaments*.json)가 요구하는 건 `slug` 다.
  //   아침에 판독할 때 DB 를 다시 뒤지지 않도록 여기서 미리 붙여 둔다.
  const roster = await sql`
    SELECT s.slug, s.display_name, s.aliases,
           coalesce(array_agg(ra.game_name) FILTER (WHERE ra.game_name IS NOT NULL), '{}') AS game_names
      FROM streamer s
      LEFT JOIN streamer_account sa ON sa.streamer_id = s.id AND sa.active_to IS NULL
      LEFT JOIN riot_account ra ON ra.puuid = sa.puuid
     GROUP BY s.id, s.slug, s.display_name, s.aliases
     ORDER BY s.display_name`;
  writeFileSync(join(OUT, "names.json"), `${JSON.stringify(roster, null, 1)}\n`);
  console.log(`\n이름 대조표 ${roster.length}명 → names.json`);

  for (const [si, s] of picked.entries()) {
    const rec = {
      session: si + 1,
      concurrent: s.vods.length,
      // ★ **참가자 명단이 아니다.** 같은 시간대에 내전을 방송한 사람들일 뿐이다.
      //   실측에서 확인했다 — 이 14명 안에 시그니처CK 참가자와 BJ댕라칸의 다른
      //   내전 참가자가 **같이** 들어 있었다. 같은 시각에 내전이 여럿 열린다.
      //   이건 판독할 때 "이 이름이 등록된 사람인가"를 빨리 맞춰 보는 힌트다.
      concurrent_streamers: s.vods.map((x) => {
        const w = byChannel.get(x.channel_id);
        return { slug: w?.slug ?? null, name: w?.display_name ?? x.channel_id, channel_id: x.channel_id };
      }),
      vods: [],
    };
    for (const v of s.vods.slice(0, PER_SESSION)) {
      const who = byChannel.get(v.channel_id);
      console.log(`\n▸ 세션 ${si + 1} · ${who?.display_name ?? v.channel_id} · ${v.title.slice(0, 44)}`);
      const files = v.files;   // §1 에서 이미 걸러 뒀다 (재생 가능 파일만)
      if (files.length === 0) { console.log("   훑을 파일이 없다"); continue; }

      const entry = {
        channel_id: v.channel_id,
        streamer: who?.display_name ?? null,
        streamer_id: who?.id ?? null,
        title: v.title,
        title_no: v.title_no,
        // 이 VOD 가 곧 근거다. 수기 매치의 source_url 이 된다 (§11-2).
        vod_url: v.url,
        ended_at: v.ended_at,
        files: [],
      };

      for (const [fi, file] of files.entries()) {
        // 채팅을 먼저 훑는다 — 시트가 없는 파일이어도 !공지(승패)는 건질 수 있다.
        // (loadChat 전체 적재가 아니라 noticesFrom — 원문은 창 단위로 훑고 바로 버린다)
        //
        // ★ 여기부터는 실패해도 **그 파일만 건너뛴다.** 게이트웨이에 60초 타임아웃이
        //   생기면서 느린 응답 하나가 AbortError 로 올라오는데, 그게 위로 새면
        //   이미 훑어 둔 세션 전부의 manifest 가 안 써진 채 밤 작업이 끝난다.
        //   무엇을 못 봤는지는 끝에 보고한다 — 조용히 넘기지 않는다.
        let chat = { ends: [], notices: 0 };
        let scan;
        try {
          if (file.chat) {
            const r = await noticesFrom(file);
            downloadMB += r.bytes / 1e6;
            chat = r;
            if (chat.ends.length > 0) {
              console.log(`   ★ 채팅 !공지 → 경기 종료 ${chat.ends.length}건 (승자까지 나온다)`);
            }
          }
          scan = await scanSheets(file);
        } catch (e) {
          const why = e instanceof Error ? `${e.name}: ${e.message.slice(0, 60)}` : String(e);
          console.log(`   ⚠ [파일 ${fi + 1}/${files.length}] 훑다가 실패 — 이 파일만 건너뛴다 (${why})`);
          skippedFiles.push(`${v.channel_id}/${v.title_no} 파일${fi + 1}: ${why}`);
          continue;
        }
        const { frames, bytes, total, sec } = scan;
        downloadMB += bytes / 1e6;
        if (frames.length === 0) {
          console.log("   시트가 없다" + (chat.ends.length ? ` (채팅 종료 ${chat.ends.length}건은 기록)` : ""));
          entry.files.push({
            index: fi + 1, hours: +(file.duration / 3_600_000).toFixed(2),
            games: [], shots_found: 0, shots_kept: 0, frames: [],
            chat_game_ends: chat.ends.map((e) => ({ at: e.at ?? hms(e.t), winner: e.winner, score: e.score })),
          });
          continue;
        }
        const { games, shots: allShots, gameRatio } = detect(frames, sec);
        const shots = thin(allShots, MAX_PER_FILE);
        console.log(`   [파일 ${fi + 1}/${files.length}] ${(total / 3600).toFixed(1)}h · 시트 ${(bytes / 1e6).toFixed(0)}MB`
          + ` · 롤 화면 ${(gameRatio * 100).toFixed(0)}% · 경기 ${games.length}구간 · 판독 지점 ${allShots.length}곳`
          + (allShots.length > shots.length ? ` → ${shots.length}곳으로 솎음 (--max-frames)` : ""));

        let hls;
        try {
          hls = await hlsSegments(file);
        } catch (e) {
          console.log(`   ⚠ HLS 목록을 못 받았다 — 프레임 없이 구간·채팅만 기록한다`);
          skippedFiles.push(`${v.channel_id}/${v.title_no} 파일${fi + 1}: HLS ${e instanceof Error ? e.name : e}`);
          hls = null;
        }
        const shotRecs = [];
        for (const at of (hls ? shots : [])) {
          // ★ title_no 를 넣는다. 같은 채널이 하루에 방송을 두 번 하면
          //   (실제로 BJ댕라칸이 그랬다) 채널+시각만으로는 파일명이 겹쳐 덮어쓴다.
          const name = `${v.channel_id}_${v.title_no}_f${fi + 1}_${hms(at).replace(/:/g, "")}.jpg`;
          const path = join(OUT, name);
          if (!existsSync(path)) {
            let seg;
            try {
              seg = await segmentAt(hls, at);
            } catch {
              continue;   // 이 지점만 건너뛴다 (타임아웃·CDN 오류). 나머지는 계속한다
            }
            if (!seg) continue;
            downloadMB += seg.bytes / 1e6;
            const tmp = join(OUT, `.tmp_${process.pid}.mp4`);
            writeFileSync(tmp, seg.data);
            try {
              // 1568px 로 줄인다 — 판독 쪽이 어차피 그렇게 리사이즈한다. 디스크만 아낀다.
              execFileSync(FFMPEG, ["-v", "error", "-ss", seg.offset.toFixed(2), "-i", tmp,
                "-frames:v", "1", "-vf", "scale=1568:-2", "-q:v", "3", "-y", path], { stdio: "ignore" });
            } catch {
              continue;                       // 이 지점만 건너뛴다. 나머지는 계속한다
            } finally {
              rmSync(tmp, { force: true });    // 영상은 남기지 않는다
            }
          }
          shotRecs.push({ file: name, at_sec: Math.round(at), at: hms(at) });
          frameCount++;
        }
        entry.files.push({
          index: fi + 1,
          hours: +(total / 3600).toFixed(2),
          games: games.map((g) => ({ start: hms(g.start), end: hms(g.end) })),
          chat_game_ends: chat.ends.map((e) => ({ at: e.at ?? hms(e.t), winner: e.winner, score: e.score })),
          // 솎아냈으면 그 사실을 남긴다 — 조용히 자르면 "다 봤다"로 읽힌다.
          shots_found: allShots.length,
          shots_kept: shots.length,
          frames: shotRecs,
        });
        console.log(`   프레임 ${shotRecs.length}장 저장`);
      }
      rec.vods.push(entry);
    }
    manifest.sessions.push(rec);
  }

  manifest.summary = { frames: frameCount, download_mb: Math.round(downloadMB) };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\n${"─".repeat(60)}`);
  const pace = soopPace();
  console.log(`프레임 ${frameCount}장 · 다운로드 ${downloadMB.toFixed(0)}MB · LLM 토큰 0`);
  if (skippedFiles.length > 0) {
    console.log(`\n⚠ 못 훑은 파일 ${skippedFiles.length}개 — 다음 실행이 다시 시도한다`);
    for (const x of skippedFiles.slice(0, 5)) console.log(`   ${x}`);
  }
  console.log(`SOOP 호출 (배속 ${pace.pace}x): `
    + Object.entries(pace.hosts).map(([h, n]) => `${h.split(".")[0]} ${n}`).join(" · "));
  console.log(`저장 위치: out/ck/${DATE}/`);
  console.log(`\n아침에 CLI 에서:`);
  console.log(`  out/ck/${DATE}/ 를 판독해서 seed/tournaments-ck-${DATE}.json 을 만들어줘`);
  console.log(`\n그 다음:`);
  console.log(`  npm run seed:tournament -- seed/tournaments-ck-${DATE}.json --dry-run`);
} finally {
  await closeDb();
}

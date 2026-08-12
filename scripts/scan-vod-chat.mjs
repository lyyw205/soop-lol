/**
 * VOD **채팅 로그**에서 내전 경기 경계를 찾는다. 토큰을 한 개도 쓰지 않는다.
 *
 *   node scripts/scan-vod-chat.mjs <채널아이디> [--days 7] [--limit 5]
 *   node scripts/scan-vod-chat.mjs lshooooo --limit 1
 *
 * ★ 왜 채팅인가
 *   5시간 VOD 를 프레임으로 훑으면 시트 60장을 LLM 에 태워야 한다. 그런데 방송
 *   채팅은 **텍스트**다. 받아서 정규식만 돌리면 되고 비용이 사실상 0 이다.
 *
 *   그리고 실측해 보니 채팅이 프레임보다 **더 정확한 것**을 준다 —
 *   내전 진행자가 `!공지` 로 시리즈 스코어를 갱신한다:
 *
 *     0:22:11  !공지 3/2) 상호팀 0 : 0 성훈팀
 *     1:04:46  !공지 3/2) 상호팀 0 : 1 성훈팀   ← 점수가 바뀐 순간 = 한 판이 끝난 순간
 *     1:39:55  !공지 3/2) 상호팀 0 : 2 성훈팀
 *
 *   **언제 끝났는지와 누가 이겼는지**가 같이 나온다. 프레임에서 읽어내려던 게
 *   바로 이거였다.
 *
 * ★ 채팅만 믿지는 않는다
 *   `!공지` 는 진행자의 습관이지 규격이 아니다. 아무 시청자나 흉내낼 수도 있다
 *   (실측에서 실제로 한 명이 반대 점수를 올렸다). 그래서 이 스크립트는 **후보를
 *   좁히는 데까지만** 한다 — 확정은 그 시각의 프레임을 봐야 한다.
 *   `!공지` 가 아예 없는 방송을 위해 **메시지 폭증**도 같이 뽑는다.
 *
 * ★ 무엇을 내놓나
 *   경기 종료 후보 시각의 목록. 다음 단계가 그 시각의 1080p 프레임만 받으면 된다.
 */

import {
  chatSpikes, findVods, gameEndsFromNotice, hms, loadChat, playableFiles, vodDetail,
} from "./lib/soop-vod.mjs";
import { makeOpt } from "./lib/cli.mjs";

const args = process.argv.slice(2);
const CHANNEL = args[0];
if (!CHANNEL) {
  console.error("사용법: node scripts/scan-vod-chat.mjs <채널아이디> [--days 7] [--limit 5]");
  process.exit(1);
}
const num = (n, d) => Number(makeOpt(args)(n, d));
const DAYS = num("--days", 7);
const LIMIT = num("--limit", 5);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

const vods = (await findVods(CHANNEL, { since })).slice(0, LIMIT);
console.log(`${CHANNEL} — 최근 ${DAYS}일 내전 VOD ${vods.length}건\n`);
if (vods.length === 0) process.exit(0);

let totalBytes = 0;
for (const v of vods) {
  console.log(`▸ ${v.ended_at.slice(0, 16)}  ${v.hours.toFixed(1)}h  ${v.title.slice(0, 50)}`);
  const files = playableFiles(await vodDetail(v.title_no)).filter((f) => f.chat);
  if (files.length === 0) { console.log("   10분 넘는 파일이 없다 (조각 VOD)\n"); continue; }

  for (const [i, file] of files.entries()) {
    const total = file.duration / 1000;
    const { msgs, bytes } = await loadChat(file);
    totalBytes += bytes;
    const tag = files.length > 1 ? `[파일 ${i + 1}/${files.length}] ` : "";
    console.log(`   ${tag}${(total / 3600).toFixed(1)}h · 채팅 ${msgs.length}건 · ${(bytes / 1e6).toFixed(1)}MB`);

    const { ends, notices, rejected } = gameEndsFromNotice(msgs);
    if (ends.length > 0) {
      console.log(`   ★ !공지 ${notices}건 (앞뒤 안 맞아 버린 것 ${rejected}건) → 경기 종료 ${ends.length}건`);
      for (const e of ends) {
        console.log(`      ${hms(e.t)}  ${e.score.padEnd(5)} ${e.winner} 승`
          + (e.skipped > 0 ? `   ⚠ 공지를 ${e.skipped}번 건너뛰었다 — 그만큼 시각을 모르는 경기가 있다` : ""));
      }
    } else {
      const { spikes, mean } = chatSpikes(msgs, total);
      console.log(`   !공지 없음 (${notices}건) → 채팅 폭증으로 대체: 분당 평균 ${mean.toFixed(0)}건, 후보 ${spikes.length}곳`);
      for (const s of spikes.slice(0, 8)) console.log(`      ${hms(s.t)}  ${s.n}건/분`);
    }
  }
  console.log();
}
console.log(`총 다운로드 ${(totalBytes / 1e6).toFixed(1)}MB · LLM 토큰 0`);

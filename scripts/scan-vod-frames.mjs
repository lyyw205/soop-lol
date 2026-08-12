/**
 * VOD **썸네일 시트**를 코드로 훑어 경기 구간과 밴픽 지점을 찾는다. **토큰 0.**
 *
 *   npm run ck:scan -- <채널아이디> [--days 10] [--limit 1]
 *
 * ★ 이게 왜 필요한가 — 비용이 여기서 갈린다
 *   5시간 VOD 는 썸네일 시트 60장(6,000프레임, 3초 간격, 45MB)으로 통째로 훑을 수
 *   있다. 이 60장을 LLM 에 태우면 VOD 하나에 $0.11 이 든다. 하루 700장이면 월 $45 다.
 *   그런데 시트에서 할 일은 "이 구간에 롤 경기가 있나" 뿐이라 **코드로 된다.**
 *   LLM 은 사람 이름을 읽어야 하는 몇 장에만 쓴다.
 *
 * ★ 무엇으로 판정하나 (실측으로 고른 규칙)
 *   프레임 6,000장의 통계를 이미 아는 정답(채팅 !공지가 알려준 경기 종료 5건)과
 *   맞춰 보고 정했다.
 *
 *   · 협곡 화면  = 어둡고 알록달록하다 → `밝기 < 75 && 채도 > 28`
 *                 (게임 중 밝기 56~70 / 채도 30~40, 브라우저·메모는 밝기 84~230)
 *   · 판독 지점  = **채도가 튄다** → `채도 > 45 && 밝기 < 110`
 *                 (전체 중앙값 34, 99%tile 48)
 *
 * ★ 채도 트리거가 잡는 건 밴픽만이 아니다 — 그게 오히려 좋다
 *   처음엔 "밴픽 화면 탐지기"로 만들었고 12곳 중 5곳만 실제 경기라 **오탐 7곳**
 *   이라고 적어 뒀었다. 실제로 프레임을 받아 보니 **틀린 판단이었다.**
 *   같은 트리거가 이것들을 같이 잡는다:
 *     · 로딩 화면 — 10명 이름 + 챔피언 10개. 규격 배치라 판독이 제일 쉽다
 *     · 메모장 대진표 — 라인별 매치업을 스트리머가 직접 적어 둔 것 (제일 흔했다)
 *     · Tab 스코어보드 — 10명 + 챔피언 + KDA
 *   실측 11장 중 7장이 10명 전원을 줬다. 흰 메모창은 채도가 아니라 밝기 대비로
 *   걸리는데, 어느 쪽이든 **사람 이름이 있는 화면**이라는 게 공통점이다.
 *
 * ★ 한계는 그대로 남아 있다
 *   · **경기 종료 시각은 못 맞춘다.** 종료 화면과 로비도 어둡고 알록달록해서
 *     구간이 3~8분 더 끌린다. 정답 5건이 전부 탐지 구간 '안'에는 들어왔지만
 *     경계는 아니다. (다만 승패는 오버레이 시리즈 스코어로 나와서 종료 화면이
 *     필요 없어졌다 — docs/CK-COLLECTION.md §3)
 *   · 후보 밀도가 스트리머마다 다르다. 이상호 12곳/4.9h, 김민교 24곳/5.6h.
 *     오버레이 구성이 달라서다. **두 명으로만 맞춘 규칙이다.**
 */

import { detect, findVods, hms, playableFiles, scanSheets, vodDetail } from "./lib/soop-vod.mjs";
import { makeOpt } from "./lib/cli.mjs";

const args = process.argv.slice(2);
const CHANNEL = args[0];
if (!CHANNEL) {
  console.error("사용법: node scripts/scan-vod-frames.mjs <채널아이디> [--days 10] [--limit 1]");
  process.exit(1);
}
const num = (n, d) => Number(makeOpt(args)(n, d));
const DAYS = num("--days", 10);
const LIMIT = num("--limit", 1);
const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);

const vods = (await findVods(CHANNEL, { since })).slice(0, LIMIT);
console.log(`${CHANNEL} — 최근 ${DAYS}일 내전 VOD ${vods.length}건\n`);

for (const v of vods) {
  console.log(`▸ ${v.ended_at.slice(0, 16)}  ${v.title.slice(0, 52)}`);
  const files = playableFiles(await vodDetail(v.title_no)).filter((f) => f.snapshot);
  if (files.length === 0) { console.log("   훑을 파일이 없다\n"); continue; }

  for (const [fi, file] of files.entries()) {
    const { frames, bytes, total, sec } = await scanSheets(file);
    if (frames.length === 0) { console.log("   시트가 없다"); continue; }
    const { games, shots, gameRatio } = detect(frames, sec);

    const tag = files.length > 1 ? `[파일 ${fi + 1}/${files.length}] ` : "";
    console.log(`   ${tag}${(total / 3600).toFixed(1)}h · 시트 ${Math.ceil(frames.length / 100)}장 ${(bytes / 1e6).toFixed(0)}MB`
      + ` · 프레임 ${frames.length}개 (${sec.toFixed(1)}초 간격)`);
    console.log(`   롤 경기 구간 ${games.length}개 · 판독 후보 ${shots.length}곳`);
    for (const g of games) {
      console.log(`      경기  ${hms(g.start)} ~ ${hms(g.end)}  (${((g.end - g.start) / 60).toFixed(0)}분)`);
    }
    console.log(`   → 프레임을 받을 지점: ` + shots.map(hms).join(", "));
    console.log(`   (전체 중 롤 화면 ${(gameRatio * 100).toFixed(0)}% · LLM 토큰 0)\n`);
  }
}

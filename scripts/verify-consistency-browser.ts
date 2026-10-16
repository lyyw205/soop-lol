/**
 * 실행 중인 production 빌드의 공개 화면만 읽는다. DB나 수집 상태를 바꾸지 않는다.
 * RECORD_VERIFY_URL=http://localhost:3102 node scripts/verify-consistency-browser.ts
 * 김민교·저라뎃·두치와뿌꾸 공개 기록이 있는 로컬 DB용 교차 검증이다.
 * 개발 모드는 Link prefetch를 하지 않으므로 요청 수 검증은 production 빌드에서 실행한다.
 */
import assert from "node:assert/strict";
import { chromium, type Request } from "playwright";

const base = process.env.RECORD_VERIFY_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(45_000);
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));

async function applyDates() {
  await page.getByTitle("시작일", { exact: true }).fill("2026-09-01");
  await page.getByTitle("종료일", { exact: true }).fill("2026-10-13");
  await page.getByRole("button", { name: "기간 적용", exact: true }).click();
}
async function assertScope(game: "fc" | "lol") {
  const query = new URL(page.url()).searchParams;
  assert.equal(query.get("from"), "2026-09-01");
  assert.equal(query.get("to"), "2026-10-13");
  assert.equal(query.get("sort"), "oldest");
  assert.equal(query.get(game === "fc" ? "mode" : "category"), game === "fc" ? "40" : "ck");
  assert.equal(await page.getByTitle("시작일", { exact: true }).inputValue(), "2026-09-01");
  assert.equal(await page.getByTitle("종료일", { exact: true }).inputValue(), "2026-10-13");
}

try {
  for (const game of ["fc", "lol"] as const) {
    const path = game === "fc" ? "/fc/versus?a=kimmingyo&b=doochiwa-ppukku" : "/lol/versus?a=kimmingyo&b=jeoradet";
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const requests: string[] = [];
    const track = (request: Request) => {
      if (["fetch", "document"].includes(request.resourceType())) requests.push(request.url());
    };
    page.on("request", track);
    await page.getByRole("combobox", { name: game === "fc" ? "경기 모드" : "경기 카테고리" }).selectOption(game === "fc" ? "40" : "ck");
    await applyDates();
    await page.getByRole("button", { name: /정렬 최신순/ }).click();
    await page.waitForTimeout(1300);
    page.off("request", track);
    assert.deepEqual(requests, [], `${game}: 필터 변경에 서버 요청이 없어야 한다`);
    await assertScope(game);

    if (game === "fc") {
      for (const name of ["경기 지표", "사용 선수", "경기 기록"]) {
        await page.getByRole("link", { name, exact: true }).click();
        await page.waitForLoadState("networkidle");
        await assertScope(game);
        if (name !== "경기 기록") await page.getByText("전체 맞대결 기준", { exact: true }).waitFor();
      }
    }
    const before = new URL(page.url());
    await page.getByRole("link", { name: "스트리머 순서 바꾸기" }).click();
    await page.waitForURL(url => url.searchParams.get("a") === before.searchParams.get("b"));
    await page.waitForLoadState("networkidle");
    await assertScope(game);
    await page.reload({ waitUntil: "networkidle" });
    await assertScope(game);
    await page.goBack({ waitUntil: "networkidle" });
    await assertScope(game);
    assert.equal(new URL(page.url()).searchParams.get("a"), before.searchParams.get("a"));
    console.log(`${game}: 필터 요청 0건 · 탭/좌우 교체/새로고침/뒤로 가기 선택 유지`);
  }

  for (const game of ["fc", "lol"]) {
    await page.goto(`${base}/${game}/s/kimmingyo`, { waitUntil: "networkidle" });
    const rows = page.locator(".personal-timeline-card");
    const first = await rows.allTextContents();
    await page.getByRole("link", { name: "이전 기록 더 보기 →", exact: true }).click();
    await page.waitForURL(/cursor=/);
    await page.waitForLoadState("networkidle");
    const next = await rows.allTextContents();
    assert.ok(next.length > 0);
    assert.notDeepEqual(next, first);
    await page.getByRole("link", { name: "처음으로", exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("cursor"));
    await page.waitForLoadState("networkidle");
    assert.deepEqual(await rows.allTextContents(), first);
    await page.goto(`${base}/${game}/s/kimmingyo?cursor=${encodeURIComponent("2026-02-30T00:00:00.000Z|sample")}`, { waitUntil: "networkidle" });
    assert.deepEqual(await rows.allTextContents(), first, "잘못된 커서는 임의 날짜로 보정하지 않고 첫 목록으로 복원한다");
    console.log(`${game}: 개인 기록 커서 이동 · 첫 목록 복원`);
  }

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${base}/fc/club-value`, { waitUntil: "networkidle" });
    // 실데이터의 행별 기간이 같을 때 표시될 가장 긴 머리글도 같은 열 안에 들어가야 한다.
    const rangeHeader = page.locator(".cv-streamer-columns > span").nth(6);
    await rangeHeader.evaluate(node => { node.textContent = "10.08 ~ 10.13"; });
    const overflow = await page.locator(".cv-streamer-columns > span").evaluateAll(cells => cells.flatMap(cell => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const text = range.getBoundingClientRect(), box = cell.getBoundingClientRect();
      return text.left < box.left - 1 || text.right > box.right + 1 ? [cell.textContent] : [];
    }));
    assert.deepEqual(overflow, [], `${width}px: 정렬 화살표와 실제 비교 날짜가 열 밖으로 넘치면 안 된다`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log(`${width}px: 구단가치 정렬 머리글·실제 날짜·페이지 너비 검증`);
  }
  assert.deepEqual(errors, []);
  console.log("브라우저 교차 검증 통과");
} finally {
  await browser.close();
}

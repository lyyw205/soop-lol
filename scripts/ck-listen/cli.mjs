import { join } from "node:path";
import { acknowledge, before, config, configure, context, loadPacket, packet, prepareRanges, ranges, readPage, status, vodKey } from "./core.mjs";

const ROOT = join(import.meta.dirname, "../..");
const usage = `ck:listen prepare --vod N [--between 시작초:끝초 | --plan lol|fc] [--if-enabled]  # --plan: 화면 지도의 경기 앞·사이(+5분)만
ck:listen read --vod N (--before 경기시작초 [--previous-end 직전종료초] | --between 시작초:끝초 | --packet ID) [--page N]
ck:listen ack --vod N --packets ID[,ID]  # 모든 페이지를 실제로 읽은 뒤
ck:listen status --vod N
ck:listen search --vod N --text 검색어 [--page N]
ck:listen config on|off [--vod N]       # off는 전체 적용과 VOD별 적용 모두 해제
기본 첫 경기 전 30분. read/search는 캐시만 읽는다. 기존 --vod N --at 시작초:길이초 호출도 유지한다.`;

export async function main(args, root = ROOT) {
  const [command, ...tail] = args;
  if (command === "help") { console.log(usage); return; }
  const opts = {};
  const flags = {
    prepare: ["--vod", "--between", "--plan", "--if-enabled"], read: ["--vod", "--before", "--previous-end", "--between", "--packet", "--page"],
    ack: ["--vod", "--packets", "--packet"], status: ["--vod"], search: ["--vod", "--text", "--page"], config: ["--vod"],
  };
  if (!flags[command]) throw new Error(usage);
  let toggle;
  if (command === "config") { toggle = tail.shift(); if (!["on", "off"].includes(toggle)) throw new Error(usage); }
  while (tail.length) {
    const key = tail.shift();
    if (!flags[command].includes(key) || Object.hasOwn(opts, key)) throw new Error(`알 수 없거나 중복된 옵션: ${key}`);
    if (key === "--if-enabled") opts[key] = true;
    else { const value = tail.shift(); if (!value || value.startsWith("--")) throw new Error(`${key} 값 필요`); opts[key] = value; }
  }
  const vod = opts["--vod"] ? vodKey(opts["--vod"]) : null;
  const emit = (value) => console.log(JSON.stringify(value, null, 2));
  if (command === "config") { emit(configure(root, toggle === "on", vod)); return; }
  if (!vod) throw new Error("--vod 필요");
  if (command === "prepare") {
    const { prepare } = await import("./prepare.mjs");
    if (opts["--between"] && opts["--plan"]) throw new Error("--between 과 --plan 중 하나만");
    // --plan: 화면 지도로 계산한 필수 창만. 지도가 없으면 예전처럼 VOD 전체, 경기·FC 화면이 없으면 받을 것이 없다.
    let requested = opts["--between"] ? ranges(opts["--between"]) : undefined;
    if (opts["--plan"]) {
      const planned = prepareRanges(root, vod, opts["--plan"]);
      const seconds = (planned ?? []).reduce((sum, [a, b]) => sum + b - a, 0);
      console.error(`LISTEN PLAN ${opts["--plan"]}: ${planned === null ? "화면 지도 없음 — VOD 전체" : planned.length ? `${planned.map(([a, b]) => `${Math.floor(a)}:${Math.ceil(b)}`).join(",")} (${Math.round(seconds / 60)}분)` : "경기·화면 없음 — 받을 구간 없음"}`);
      if (planned?.length === 0) { console.log(`LISTEN: ${JSON.stringify({ vod, plan: opts["--plan"], planned: [], skipped: "no-games" })}`); return; }
      requested = planned ?? undefined;
    }
    const result = await prepare(root, vod, requested, { ifEnabled: !!opts["--if-enabled"] });
    const { packets, ...compact } = result;
    console.log(`LISTEN: ${JSON.stringify(compact)}`);
    if (result.requested_missing?.length) process.exitCode = 2;
    return;
  }
  if (command === "status") {
    try { emit(status(context(root, vod))); }
    catch (e) { emit({ vod, ...config(root, vod), unavailable: e.message }); }
    return;
  }
  const ctx = context(root, vod);
  if (command === "ack") {
    const ids = opts["--packets"] ?? opts["--packet"]; // --packet 도 받는다(세션이 read 출력의 packet 이름을 그대로 쓰곤 한다)
    if (!ids) throw new Error("--packets 필요");
    emit(acknowledge(ctx, ids.split(","))); return;
  }
  const page = opts["--page"] == null ? 1 : Number(opts["--page"]);
  if (command === "search") {
    if (!opts["--text"]?.trim()) throw new Error("--text 필요 (문자열 검색, 분류 아님)");
    const hits = ctx.data.chunks.filter((c) => c.text.toLocaleLowerCase().includes(opts["--text"].toLocaleLowerCase())).sort((a, b) => a.at - b.at);
    const pages = Math.max(1, Math.ceil(hits.length / 20));
    if (!Number.isInteger(page) || page < 1 || page > pages) throw new Error(`--page: 1~${pages}`);
    emit({ total: hits.length, page, pages, next_page: page < pages ? page + 1 : null, note: "검색은 준비된 범위만 대상이며 열람 기록에 포함되지 않는다. 전후 원문은 read --between으로 읽는다.",
      hits: hits.slice((page - 1) * 20, page * 20).map(({ at, end, text }) => ({ at, end, text })) }); return;
  }
  if (["--before", "--between", "--packet"].filter((k) => opts[k] != null).length !== 1) throw new Error("--before / --between / --packet 중 하나 필요");
  if (opts["--previous-end"] != null && opts["--before"] == null) throw new Error("--previous-end는 --before와 함께 쓴다");
  const p = opts["--packet"] ? loadPacket(ctx, opts["--packet"]) : packet(ctx, opts["--between"] ? ranges(opts["--between"]) : before(Number(opts["--before"]), opts["--previous-end"] == null ? undefined : Number(opts["--previous-end"])));
  emit(readPage(ctx, p, page));
}

/** 로컬 실행 큐 CLI. 모든 호출은 ck-auto.sh의 queue.lock 아래에서 직렬화한다. */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claim, emptyQueue, enqueue, recover, release, type AutoQueue, type AutoVod } from "./lib/ck-auto-queue.ts";

const [command, base, ...args] = process.argv.slice(2);
if (!base) throw new Error("명령과 큐 폴더가 필요하다");
const file = join(base, "queue.json"), wake = join(base, "wake");
const q: AutoQueue = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : emptyQueue();
if (q.version !== 1 || !q.jobs) throw new Error("지원하지 않는 실행 큐");
const now = Date.now();
let code = 0, output = "", wakeUp = false, clearWake = false;
if (command === "enqueue") {
  const plan = JSON.parse(readFileSync(args[0], "utf8")) as { queue: AutoVod[] };
  wakeUp = enqueue(q, plan.queue, now);
  output = `실행 큐 ${Object.keys(q.jobs).length}개`;
} else if (command === "recover") {
  // daily.lock으로 이전 조사 프로세스가 모두 끝났음을 확인한 뒤에만 호출한다.
  recover(q); clearWake = true;
} else if (command === "claim") {
  if (!args[0]) throw new Error("작업자 ID가 필요하다");
  const item = claim(q, args[0], now);
  if (item === "wait") code = 4;
  else if (!item) code = 3;
  else output = [item.title_no, item.channel_id, item.reason, item.streamer].map((s) => String(s).replace(/[\t\r\n]/g, " ")).join("\t");
} else if (command === "release") {
  const [key, owner, delay] = args;
  const seconds = Number(delay);
  if (delay !== "done" && (!Number.isFinite(seconds) || seconds < 0)) throw new Error("재시도 간격이 필요하다");
  release(q, key, owner, delay === "done" ? null : now + seconds * 1000);
} else if (command === "pause") {
  // 중단·실패 시 남은 깨우기 요청 때문에 즉시 재시작하지 않는다. 다음 시간별 조회가 재시도한다.
  clearWake = true;
} else throw new Error(`알 수 없는 큐 명령: ${command}`);

const tmp = `${file}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(q, null, 2));
renameSync(tmp, file);
if (wakeUp) writeFileSync(wake, "");
if (clearWake) rmSync(wake, { force: true });
if (output) console.log(output);
process.exitCode = code;

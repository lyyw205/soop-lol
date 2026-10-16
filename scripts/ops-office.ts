/** Minute collector. No AI, retries, job dispatch or external messaging. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { closeDb } from "../packages/core/lib/db/client.ts";
import { collectSnapshot } from "../packages/core/lib/ops/collector.ts";
import { readSnapshot, saveSnapshot } from "../packages/core/lib/ops/storage.ts";

process.env.OPS_OUT_ROOT ||= process.env.CK_OUT_ROOT || fileURLToPath(new URL("../out", import.meta.url));
try {
  const previous = await readSnapshot();
  const snapshot = await saveSnapshot(await collectSnapshot("scheduled"));
  const fresh = snapshot.incidents.filter(i => !i.resolvedAt && !previous?.incidents.some(p => p.id === i.id && !p.resolvedAt));
  // Opt-in local desktop notifications, never send logs or credentials to a third party.
  if (process.argv.includes("--notify") && fresh.length) {
    try { await promisify(execFile)("notify-send", ["--app-name=SOOP SEEK", "--urgency=normal", "운영 오피스 · 확인 필요", `${fresh.length}개 새 알림\n${fresh.slice(0, 3).map(i => i.title).join("\n")}`], { timeout: 3000 }); }
    catch { console.warn("데스크톱 알림을 전달하지 못했습니다. 오피스 알림함에 보존했습니다."); }
  }
  console.log(`${snapshot.at} · ${snapshot.jobs.length}개 작업 · ${snapshot.alerts.length}개 알림 · DB ${snapshot.sources.database ? "연결" : "미관측"}`);
} finally { await closeDb(); }

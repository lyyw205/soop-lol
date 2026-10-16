import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opsRoot } from "./collector.ts";
import { reconcileIncidents, type Snapshot } from "./model.ts";

export async function readSnapshot(root = opsRoot()): Promise<Snapshot | null> {
  if (!root) return null;
  try {
    const data = JSON.parse(await readFile(join(root, "ops/office/snapshot.json"), "utf8"));
    if (data.version !== 1 || !Array.isArray(data.jobs) || !Array.isArray(data.incidents) || !Number.isFinite(Date.parse(data.at))) return null;
    return data;
  } catch { return null; }
}
/** One writer (the systemd oneshot); readers always see a complete snapshot. */
export async function saveSnapshot(snapshot: Snapshot, root = opsRoot()): Promise<Snapshot> {
  if (!root) throw new Error("OPS_OUT_ROOT or CK_OUT_ROOT is required");
  const previous = await readSnapshot(root);
  // Loss of evidence is not recovery. Keep unresolved incidents until their source is observable again.
  const alerts = [...snapshot.alerts];
  for (const incident of previous?.incidents ?? []) {
    if (incident.resolvedAt || alerts.some(a => a.id === incident.id)) continue;
    const job = snapshot.jobs.find(j => j.id === incident.jobId);
    // 등록부에서 빠지거나 이름이 바뀐 작업(2026-10-16 id 전환 등)의 경보는 붙잡아 두지 않는다 — 다시 관측될 일이 없어 영영 "해소 확인 대기"가 된다.
    if (incident.jobId && !job) continue;
    const unverified = incident.jobId
      ? ["unknown", "working"].includes(job!.state) || (!snapshot.sources.database && job!.evidence === "관측 기록 없음")
      : incident.id.startsWith("health:") && incident.id !== "health:stale" && !snapshot.health;
    if (unverified) alerts.push({ id: incident.id, jobId: incident.jobId, room: incident.room, title: incident.title,
      detail: `${incident.detail.replace(/ · 해소 확인 대기$/, "")} · 해소 확인 대기`, severity: incident.severity });
  }
  const result = { ...snapshot, alerts, incidents: reconcileIncidents(previous?.incidents ?? [], alerts, snapshot.at) };
  const dir = join(root, "ops/office");
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `snapshot.${process.pid}.tmp`);
  await writeFile(temp, JSON.stringify(result), { mode: 0o600 });
  await rename(temp, join(dir, "snapshot.json"));
  return result;
}

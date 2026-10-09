import type { MemoVerdict } from "./ck-memo.ts";

const verdict = (s: unknown): s is MemoVerdict => s === "memo" || s === "not_memo" || s === "unknown";
async function location(vod: string) {
  if (!/^\d{1,12}$/.test(vod) || !process.env.CK_OUT_ROOT) throw new Error("로컬 수집 폴더가 없습니다.");
  const fs = await import("node:fs/promises"), path = await import("node:path");
  const root = await fs.realpath(process.env.CK_OUT_ROOT);
  const directory = await fs.realpath(path.join(root, "ck", vod, "local"));
  if (!directory.startsWith(root + path.sep)) throw new Error("잘못된 수집 경로입니다.");
  return { fs, file: path.join(directory, "memo-feedback.jsonl") };
}

/** Append-only human labels. Never writes scan, evidence, match or review tables. */
export async function readMemoFeedback(vod: string, source: string): Promise<Record<string, MemoVerdict>> {
  const result: Record<string, MemoVerdict> = {};
  try {
    const { fs, file } = await location(vod), { constants } = await import("node:fs");
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.stat()).size > 4_000_000) return result;
      for (const line of (await handle.readFile("utf8")).split("\n")) {
        try {
          const row = JSON.parse(line);
          if (row.source_sha256 === source && Number.isFinite(row.at) && row.at >= 0 && verdict(row.label)) result[String(row.at)] = row.label;
        } catch { /* A truncated append does not discard earlier labels. */ }
      }
    } finally { await handle.close(); }
  } catch { /* No feedback yet. */ }
  return result;
}

export async function appendMemoFeedback(input: { vod: string; at: number; label: MemoVerdict; model: string; source: string }) {
  if (!Number.isFinite(input.at) || !verdict(input.label)) throw new Error("잘못된 표시입니다.");
  const { readMemoReferences } = await import("./ck-memo.ts");
  const current = await readMemoReferences(input.vod);
  if (!current || current.model_sha256 !== input.model || current.source_sha256 !== input.source
    || !current.groups.some(g => g.frames.some(f => f.at === input.at))) throw new Error("수집 자료가 바뀌었습니다. 새로고침해 주세요.");
  const { fs, file } = await location(input.vod), { constants } = await import("node:fs");
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if ((await handle.stat()).size > 3_900_000) throw new Error("표시 기록이 가득 찼습니다. 학습 자료 정리가 필요합니다.");
    const record = JSON.stringify({ schema: 1, vod: input.vod, at: input.at, label: input.label,
      model_sha256: input.model, source_sha256: input.source, created_at: new Date().toISOString() }) + "\n";
    await handle.write(record);
  } finally { await handle.close(); }
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendMemoFeedback, readMemoFeedback } from "./ck-memo-feedback.ts";

test("feedback is frame-specific, append-only, source-bound and isolated from scan state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memo-feedback-")), old = process.env.CK_OUT_ROOT;
  process.env.CK_OUT_ROOT = root;
  try {
    const dir = join(root, "ck/123/local"); await mkdir(dir, { recursive: true });
    const meta = '{"parts":[]}', source = createHash("sha256").update(meta).digest("hex"), model = "a".repeat(64);
    await writeFile(join(dir, "sheets.json"), meta); await writeFile(join(dir, "scan.json"), "protected");
    await writeFile(join(dir, "memo.json"), JSON.stringify({ schema: 1, vod: "123", kind: "memo_references", source_sha256: source, model_sha256: model,
      groups: [{ key: "123:3000:memo", kind: "memo", from: 3, to: 6, representative_at: 3,
        thumbnail: "ck/123/local/memo/0123456789abcdef/t3000.jpg", frames: [{ at: 3, score: .9 }, { at: 6, score: .9 }] }] }));
    const input = { vod: "123", at: 3, label: "memo" as const, model, source };
    await appendMemoFeedback(input); await appendMemoFeedback({ ...input, label: "not_memo" });
    assert.deepEqual(await readMemoFeedback("123", source), { "3": "not_memo" });
    assert.deepEqual(await readMemoFeedback("123", "other-source"), {});
    assert.equal((await readFile(join(dir, "memo-feedback.jsonl"), "utf8")).trim().split("\n").length, 2);
    await assert.rejects(appendMemoFeedback({ ...input, model: "b".repeat(64) }));
    await assert.rejects(appendMemoFeedback({ ...input, at: 9 }));
    assert.equal(await readFile(join(dir, "scan.json"), "utf8"), "protected");
    await rm(join(dir, "memo-feedback.jsonl")); await symlink(join(dir, "scan.json"), join(dir, "memo-feedback.jsonl"));
    await assert.rejects(appendMemoFeedback(input));
    assert.equal(await readFile(join(dir, "scan.json"), "utf8"), "protected");
  } finally {
    if (old === undefined) delete process.env.CK_OUT_ROOT; else process.env.CK_OUT_ROOT = old;
    await rm(root, { recursive: true, force: true });
  }
});

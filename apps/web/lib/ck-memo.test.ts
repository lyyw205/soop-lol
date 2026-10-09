import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseMemoReferences, readMemoReferences } from "./ck-memo.ts";

const fixture = () => ({ schema: 1, kind: "memo_references", vod: "123", model_sha256: "a".repeat(64), source_sha256: "b".repeat(64), groups: [{
  key: "123:10000:memo", kind: "memo", from: 10, to: 13, representative_at: 13,
  thumbnail: "ck/123/local/memo/0123456789abcdef/t13000.jpg",
  frames: [{ at: 10, score: .55 }, { at: 13, score: .9 }],
}] });

test("memo references preserve times and never acquire evidence or review fields", () => {
  const raw = fixture(); Object.assign(raw.groups[0], { match_id: "wrong", reviewed_at: "now" });
  const result = parseMemoReferences(raw, "123")!;
  assert.equal(result.groups[0].frames.length, 2);
  assert.equal(result.experimental, true);
  assert.ok(!("match_id" in result.groups[0]));
  assert.ok(!("reviewed_at" in result.groups[0]));
});

test("memo manifest rejects traversal, wrong VOD, duplicate timestamps and overlapping groups", () => {
  const unsafe = fixture(); unsafe.groups[0].thumbnail = "ck/123/local/../../secret.jpg";
  assert.equal(parseMemoReferences(unsafe, "123"), null);
  assert.equal(parseMemoReferences(fixture(), "../../etc"), null);
  assert.equal(parseMemoReferences(fixture(), "456"), null);
  const duplicate = fixture(); duplicate.groups[0].frames[1].at = 10;
  assert.equal(parseMemoReferences(duplicate, "123"), null);
  const overlap = fixture(); overlap.groups.push({ ...overlap.groups[0], key: "another" });
  assert.equal(parseMemoReferences(overlap, "123"), null);
});

test("local memo reads reject stale metadata and external symlinks; never create missing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ck-memo-test-"));
  const old = process.env.CK_OUT_ROOT;
  process.env.CK_OUT_ROOT = root;
  try {
    const dir = join(root, "ck/123/local"); await mkdir(dir, { recursive: true });
    const raw = fixture(), meta = '{"parts":[]}';
    raw.source_sha256 = createHash("sha256").update(meta).digest("hex");
    await writeFile(join(dir, "sheets.json"), meta);
    await writeFile(join(dir, "memo.json"), JSON.stringify(raw));
    const before = await readMemoReferences("123");
    assert.equal(before?.groups.length, 1);
    assert.equal(before?.groups[0].original, undefined);
    await writeFile(join(dir, "sheets.json"), '{"parts":[1]}');
    assert.equal(await readMemoReferences("123"), null);
    await rm(join(dir, "memo.json"));
    await symlink("/etc/passwd", join(dir, "memo.json"));
    assert.equal(await readMemoReferences("123"), null);
    assert.equal(await readMemoReferences("124"), null);
  } finally {
    if (old === undefined) delete process.env.CK_OUT_ROOT; else process.env.CK_OUT_ROOT = old;
    await rm(root, { recursive: true, force: true });
  }
});

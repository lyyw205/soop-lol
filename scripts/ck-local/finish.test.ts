import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// --finish 는 DB·SOOP 없이 준비 산출물(scan.json·scan-draft.json)과 원본 파일만으로 돈다.
const SCAN = join(import.meta.dirname, "scan.mjs");

function finish(extra: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), "ck-finish-"));
  try {
    const dir = join(cwd, "out/ck/777/local");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(cwd, "out/ck/777/g0000100.jpg"), "x");
    writeFileSync(join(dir, "scan.json"), JSON.stringify({ run_id: "R1", total_sec: 1200, map: [] }));
    // 실행기(준비 단계)가 만든 초안 — 요청 범위는 영상 전체다. 세션이 손댄 흔적(조각)이 있어도 되돌려야 한다.
    writeFileSync(join(dir, "scan-draft.json"), JSON.stringify({ resultType: "scan",
      lead: { source_key: "vod:777", title: "t" },
      scan: { status: "running", requested: [[500, 600]], sampled: [[0, 1200]], opened: [], failed: [], note: "준비" }, frames: [], candidates: [] }));
    const out = execFileSync(process.execPath, [SCAN, "--finish", "--vod", "777", "--run", "R1", "--opened", "100", ...extra],
      { cwd, encoding: "utf8" });
    return { out, final: JSON.parse(readFileSync(join(dir, "final.json"), "utf8")) };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("--requested 를 줘도 요청 범위는 준비 단계의 전체 범위다", () => {
  const { out, final } = finish(["--status", "done", "--requested", "10-20"]);
  assert.deepEqual(final.scan.requested, [[0, 1200]]);
  assert.match(out, /--requested 는 받지 않는다/);
});

test("세션이 한 일은 opened·status·note 에 남는다", () => {
  const { final } = finish(["--status", "running", "--note", "후보 1 확인"]);
  assert.deepEqual(final.scan.opened, [100]);
  assert.equal(final.scan.status, "running");
  assert.match(final.scan.note, /후보 1 확인/);
  assert.deepEqual(final.scan.requested, [[0, 1200]]);
});

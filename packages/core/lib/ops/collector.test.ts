import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSnapshot } from "./collector.ts";

test("collector survives DB/systemd outages and preserves local stop, queue and block evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "office-collector-"));
  const before = { OPS_OUT_ROOT: process.env.OPS_OUT_ROOT, DATABASE_URL: process.env.DATABASE_URL, PATH: process.env.PATH };
  try {
    process.env.OPS_OUT_ROOT = root;
    process.env.DATABASE_URL = ""; // No production database connection is possible.
    process.env.PATH = root; // No host scheduler command is invoked in this test.
    await mkdir(join(root, "ops"), { recursive: true });
    await mkdir(join(root, "ck/auto"), { recursive: true });
    await writeFile(join(root, "ck/auto/STOP"), "");
    await writeFile(join(root, "ops/usage.jsonl"), JSON.stringify({ at: new Date().toISOString(), verdict: "block", totalBytes: 999_000_000, reasons: ["DB 읽기 전용"] }) + "\n");
    await writeFile(join(root, "ck/auto/queue.json"), JSON.stringify({ version: 1, jobs: {
      first: { not_before: 0 }, second: { not_before: 0, owner: "one" }, third: { not_before: Date.now() + 60_000 },
    } }));
    const result = await collectSnapshot();
    assert.deepEqual(result.sources, { database: false, systemd: false, local: true });
    assert.equal(result.completed24h, null, "unavailable totals must not become zero");
    assert.equal(result.jobs.find(j => j.id === "ck-auto-lol-work")?.state, "paused");
    assert.equal(result.alerts.find(a => a.id === "health:verdict")?.severity, "error");
    assert.equal(result.alerts.find(a => a.id === "health:verdict")?.detail, "DB 읽기 전용");
    assert.equal(result.queue?.pending, 1); assert.equal(result.queue?.owned, 1); assert.equal(result.queue?.deferred, 1);
    assert.ok(result.alerts.some(a => a.id === "source:db"));
    assert.ok(result.alerts.some(a => a.id === "source:systemd"));
  } finally {
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

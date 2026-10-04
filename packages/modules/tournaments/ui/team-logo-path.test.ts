import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import logos from "../data/team-logos.json" with { type: "json" };
import { teamLogoPath } from "./team-logo-path.ts";

test("대회와 팀이 일치하는 로고만 쓰고 공백 차이는 허용한다", () => {
  assert.ok(teamLogoPath("meljang-2026-geng", "교권보호국"));
  assert.equal(teamLogoPath("meljang-2026-geng", "명수"), teamLogoPath("meljang-2026-geng", "명 수"));
  assert.equal(teamLogoPath("meljang-2025-s1", "교권보호국"), null);
  assert.equal(teamLogoPath("meljang-2026-geng", "미확인 팀"), null);
});

test("로고 매핑은 중복 없이 원본 파일·출처·해시와 연결된다", () => {
  const keys = new Set<string>();
  for (const logo of logos) {
    const key = `${logo.eventSlug}:${logo.team.replace(/\s+/gu, "").toLowerCase()}`;
    assert.ok(!keys.has(key), key);
    keys.add(key);
    assert.ok(logo.sourceUrl.startsWith("https://"));
    const bytes = readFileSync(new URL(`../../../../apps/web/public${logo.src}`, import.meta.url));
    assert.ok(bytes.length > 100, logo.team);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), logo.sha256, logo.team);
  }
});

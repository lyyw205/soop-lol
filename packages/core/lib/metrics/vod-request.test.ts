import { test } from "node:test";
import assert from "node:assert/strict";

import { soopVodId } from "./vod-request.ts";

test("SOOP VOD 링크·번호 → VOD 번호, 다른 것은 null", () => {
  for (const s of ["209748301", "https://vod.sooplive.com/player/209748301", "vod.sooplive.co.kr/player/209748301/embed?change_second=30",
    "https://vod.afreecatv.com/player/209748301/catch", "https://v.afree.ca/ST/209748301", " https://vod.sooplive.com/player/209748301/ "]) {
    assert.equal(soopVodId(s), 209748301, s);
  }
  for (const s of ["", null, "0", "https://www.youtube.com/watch?v=1", "https://vod.sooplive.com/player/abc", "https://evil.com/player/1", "1".repeat(16)]) {
    assert.equal(soopVodId(s as string | null), null, String(s));
  }
});

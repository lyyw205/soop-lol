/** 회원·쓰기 권한만 독립 검사한다. 외부 DB 대신 매번 새 메모리 DB를 쓴다. */
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { applyAll } from "./lib/migrations.ts";
import { freePort } from "./lib/disposable-postgres.ts";
import { verifyMemberDb } from "./lib/verify-member-db.ts";
import { verifyCommunityDb } from "./lib/verify-community-db.ts";

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function expectReject(name: string, work: () => Promise<unknown>, expected: string) {
  try { await work(); check(name, false, "거부되지 않음"); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(expected), message.includes(expected) ? "" : message);
  }
}
const memory = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: memory, host: "127.0.0.1", port });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX = "1";
const { closeDb } = await import("../packages/core/lib/db/client.ts");
try {
  await applyAll((sql) => memory.exec(sql), join(import.meta.dirname, ".."));
  await verifyMemberDb(check, expectReject);
  await verifyCommunityDb(check, expectReject);
  console.log(`\n${checks} checks, ${failures} failures`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await closeDb();
  await server.stop();
  await memory.close();
}

/**
 * 지명 수집 다루기 — docs/COLLECTION-DESIGNATION-PLAN.md §7. 쓰기는 전부 core(collection.ts) 함수 하나씩을 거친다.
 *
 *   npm run collect -- list
 *   npm run collect -- show <slug>
 *   npm run collect -- create --slug ttgyo-duo --title "뜨교듀오 마스터 도전" --owner module:solo_challenge/ttgyo-duo \
 *                             --queues 420 --from 2026-08-21 [--to 2026-09-30] --members seokwngud,kimmingyo [--note …] [--apply]
 *   npm run collect -- update <slug> [--title …] [--queues 420,440] [--from 날짜] [--to 날짜 | --open] [--note …] [--apply]
 *   npm run collect -- add-member <slug> <스트리머 slug> [--apply]
 *   npm run collect -- remove-member <slug> <스트리머 slug> [--apply]
 *   npm run collect -- delete <slug> [--apply]
 *
 * ★ 쓰기 명령은 기본이 **미리보기**다 — 한 트랜잭션 안에서 끝까지 해 보고(정리로 지워질 판 수까지) 되돌린다. `--apply` 로만 남긴다.
 * 날짜는 KST 날짜다. `--from` 은 그날 0시부터, `--to` 는 **그날까지 포함**(다음 날 0시 전까지).
 */
import { parseArgs } from "node:util";

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import {
  addMemberInTx, createOrderInTx, deleteOrderInTx, getOrderInTx, listOrders, removeMemberInTx, updateOrderInTx,
  type ChangeReport, type CollectionOrder,
} from "@soop-lol/core/lib/db/collection";
import { kstDateString } from "@soop-lol/core/lib/time";

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    slug: { type: "string" }, title: { type: "string" }, owner: { type: "string" }, queues: { type: "string" },
    from: { type: "string" }, to: { type: "string" }, open: { type: "boolean" }, members: { type: "string" },
    note: { type: "string" }, apply: { type: "boolean" },
  },
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const kstStart = (d: string) => {
  if (!DAY.test(d)) throw new Error(`날짜는 YYYY-MM-DD(KST): ${d}`);
  return new Date(`${d}T00:00:00+09:00`);
};
/** `--to` 는 그날 포함 → 다음 날 0시(KST) 전까지. */
const kstEndInclusive = (d: string) => new Date(kstStart(d).getTime() + 86_400_000);
const queues = (s: string) => s.split(",").map((x) => Number(x.trim()));

function describe(o: CollectionOrder): string {
  const until = o.ends_at ? `${kstDateString(new Date(o.ends_at.getTime() - 1))}까지` : "끝 없음";
  return `${o.slug} — ${o.title}\n  목적 ${o.owner} · 큐 ${o.queue_ids.join(",")} · ${kstDateString(o.starts_at)}부터 ${until}` +
    `\n  사람 ${o.members.map((m) => `${m.name}(${m.slug})`).join(", ") || "없음"}${o.note ? `\n  메모 ${o.note}` : ""}`;
}

function print(r: ChangeReport): void {
  console.log(r.order ? describe(r.order) : "(지명 없음)");
  const people = new Map<string, number>();
  for (const s of r.scope) people.set(s.streamer, (people.get(s.streamer) ?? 0) + 1);
  console.log(`  범위 ${r.scope.length}칸(계정×큐)${[...people].map(([p, n]) => ` · ${p} ${n}`).join("")}`);
  for (const m of r.order?.members ?? []) if (!people.has(m.slug)) console.log(`  ⚠ ${m.name}: 연결된 계정이 없다 — 계정을 연결하면 그때부터 모은다`);
  console.log(`  정리 — 범위 밖이 되어 지우는 개인 기록 판 ${r.pruned.matches.length} · 상세 행 ${r.pruned.details}`);
  if (r.pruned.matches.length) console.log(`    ${r.pruned.matches.slice(0, 10).join(", ")}${r.pruned.matches.length > 10 ? " …" : ""}`);
}

class Preview extends Error {}

/** 한 트랜잭션 안에서 쓰기 → 보고. 미리보기면 되돌린다. */
async function write(fn: (tx: Parameters<Parameters<ReturnType<typeof db>["begin"]>[0]>[0]) => Promise<ChangeReport>): Promise<void> {
  let report: ChangeReport | null = null;
  try {
    await db().begin(async (tx) => {
      report = await fn(tx);
      if (!opt.apply) throw new Preview();
    });
  } catch (e) {
    if (!(e instanceof Preview)) throw e;
  }
  print(report!);
  console.log(opt.apply ? "\n✔ 적용했다." : "\n미리보기 — 아무것도 바꾸지 않았다. 남기려면 --apply.");
}

async function main(): Promise<void> {
  const [cmd, a, b] = pos;
  switch (cmd) {
    case "list": {
      const all = await listOrders();
      console.log(all.length ? all.map(describe).join("\n\n") : "지명이 없다.");
      return;
    }
    case "show": {
      if (!a) throw new Error("show <slug>");
      const o = await getOrderInTx(db(), a);
      if (!o) throw new Error(`지명 ${a} 가 없다.`);
      const progress = await db()<{ name: string; game_name: string | null; queue_id: number; state: string; reached_end: boolean; cursor_before: Date | null; last_error: string | null }[]>`
        SELECT s.display_name AS name, ra.game_name, c.queue_id, coalesce(p.state, '(아직 안 집음)') AS state,
               coalesce(p.reached_end, false) AS reached_end, p.cursor_before, p.last_error
          FROM collection_scope c JOIN streamer s ON s.id = c.streamer_id
          LEFT JOIN riot_account ra ON ra.puuid = c.puuid
          LEFT JOIN collection_progress p ON p.order_id = c.order_id AND p.puuid = c.puuid AND p.queue_id = c.queue_id
         WHERE c.order_id = ${o.id}::uuid ORDER BY s.slug, ra.game_name, c.queue_id`;
      const [games] = await db()<{ n: number }[]>`
        SELECT count(DISTINCT m.match_id)::int AS n FROM match m JOIN match_participant p ON p.match_id = m.match_id
          JOIN collection_scope s ON s.order_id = ${o.id}::uuid AND s.puuid = p.puuid AND s.queue_id = m.queue_id
         WHERE m.scope = 'personal' AND m.game_creation >= s.starts_at AND (s.ends_at IS NULL OR m.game_creation < s.ends_at)`;
      console.log(describe(o));
      console.log(`  모은 개인 기록 판 ${games.n}`);
      for (const p of progress) {
        const cur = p.cursor_before ? ` · ${kstDateString(p.cursor_before)} 이전을 볼 차례` : "";
        console.log(`  - ${p.name} ${p.game_name ?? "?"} 큐 ${p.queue_id}: ${p.state}${p.reached_end ? " · 시작일까지 다 봄" : cur}${p.last_error ? ` · 실패: ${p.last_error}` : ""}`);
      }
      return;
    }
    case "create": {
      if (!opt.slug || !opt.title || !opt.owner || !opt.queues || !opt.from || !opt.members) {
        throw new Error("create 에는 --slug --title --owner --queues --from --members 가 필요하다.");
      }
      const input = {
        slug: opt.slug, title: opt.title, owner: opt.owner, queue_ids: queues(opt.queues), starts_at: kstStart(opt.from),
        ends_at: opt.to ? kstEndInclusive(opt.to) : null, note: opt.note ?? null, members: opt.members.split(",").map((x) => x.trim()),
      };
      return write((tx) => createOrderInTx(tx, input));
    }
    case "update": case "end": {
      if (!a) throw new Error(`${cmd} <slug>`);
      if (cmd === "end" && !opt.to) throw new Error("end 에는 --to 날짜(그날까지 포함)가 필요하다.");
      if (opt.to && opt.open) throw new Error("--to 와 --open 은 함께 쓸 수 없다.");
      const patch = {
        title: opt.title, note: opt.note, queue_ids: opt.queues ? queues(opt.queues) : undefined,
        starts_at: opt.from ? kstStart(opt.from) : undefined,
        ends_at: opt.open ? null : opt.to ? kstEndInclusive(opt.to) : undefined,
      };
      return write((tx) => updateOrderInTx(tx, a, patch));
    }
    case "add-member":
      if (!a || !b) throw new Error("add-member <slug> <스트리머 slug>");
      return write((tx) => addMemberInTx(tx, a, b));
    case "remove-member":
      if (!a || !b) throw new Error("remove-member <slug> <스트리머 slug>");
      return write((tx) => removeMemberInTx(tx, a, b));
    case "delete":
      if (!a) throw new Error("delete <slug>");
      return write((tx) => deleteOrderInTx(tx, a));
    default:
      throw new Error("명령: list · show · create · update · end · add-member · remove-member · delete (파일 머리말 참고)");
  }
}

main().then(closeDb, async (e) => {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  await closeDb();
  process.exitCode = 1;
});

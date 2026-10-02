/**
 * FC 검수의 목록 단위 — **대전**: 누가 누구와 한 자리에서 연달아 한 경기 묶음. (사용자 결정 2026-10-02, 방안 C)
 *
 *   경기 하나는 **딱 한 대전**에 들어간다. 방송(VOD)은 대전의 기준이 아니라 경기의 **시점**일 뿐이다 —
 *   방송을 기준으로 묶으면 같은 경기를 방송마다 다시 보게 된다(스맵임 vs 서도일을 두 방송에서, 시청한 김민교 vs 이상호를 세 방송에서).
 *
 *   묶는 순서
 *     1. 대회(행사)에 붙은 경기 → 대회 단위(여기서 다루지 않는다 — 기존 대회 단위)
 *     2. 두 칸 다 스트리머        → 그 두 사람의 대전
 *     3. 한 칸만 스트리머         → 그 스트리머의 「일반 유저전」
 *     4. 둘 다 스트리머가 아님     → 두 닉네임의 대전(사람을 붙이면 2·3 으로 옮겨 간다)
 *   같은 묶음 키 안에서 경기 사이 간격(종료 시각 차)이 SESSION_GAP_MIN 이하면 한 대전이다.
 *   실측(2026-10-02): 같은 상대 연속 경기는 대부분 20분 이내, 20~40분 사이는 거의 없다 → 40분. 822경기 → 394대전.
 *
 *   검수 대상 경기(정본만 — 이어진 화면 기록은 그 정본의 시점이다)
 *     · 화면 기록이 정본인 경기 · VOD 로 본 넥슨 경기(상대가 일반 유저여도) · 스트리머끼리 넥슨 경기
 *     (VOD 로 본 적 없는 일반 유저전 넥슨 경기는 넣지 않는다 — 예전 맥락 검수와 같다)
 *
 * ★ 묶음은 저장하지 않고 매번 계산한다(마이그레이션 없음). 사람을 붙이거나 경기가 이어지면 다음에 열 때 맞는 대전으로 옮겨 간다.
 */

import { db } from "../../db/client.ts";
import { OBS_CTE } from "./match-units.ts";

export const SESSION_GAP_MIN = 40;

/** meet = 스트리머끼리 모임(대전 하나뿐이어도 meet) · solo = 그 스트리머의 일반 유저전 · names = 닉네임끼리 */
export type FcoSessionKind = "meet" | "solo" | "names";

export interface FcoSession {
  /** `<kind>~<키>~<첫 경기 유닉스 초>` — 주소에 쓴다 */
  id: string;
  kind: FcoSessionKind;
  /** 화면에 쓸 이름 — 「스맵임 vs 서도일」·「키리콩 · 일반 유저전」 */
  title: string;
  /** 이 대전에 나온 스트리머(뛴 사람 + 이 경기들을 본 방송 주인) — 거르기에 쓴다 */
  people: { slug: string; name: string }[];
  from: string;
  to: string;
  total: number;
  completed: number;
  /** 넥슨 기록이 정본인 경기 수 */
  api: number;
  /** 조사(근거·판단)가 하나라도 있나 — 없으면 「조사 필요」 */
  investigated: boolean;
  /** 이 대전의 경기들을 본 방송 — 「이 방송에 나온 대전」 거르기에 쓴다 */
  vods: string[];
  match_ids: string[];
  /** 모임 안의 두 사람 대전들(시간 순) — 모임이 아니면 자기 하나 */
  pairs: { title: string; total: number }[];
}

interface Row {
  match_id: string; source: string; game_creation: Date; review_completed_at: Date | null; investigated: boolean;
  parts: { nickname: string; streamer_id: string | null; slug: string | null; name: string | null }[] | null;
  owners: { slug: string; name: string }[] | null;
  vods: string[] | null;
}

const norm = (s: string) => s.normalize("NFKC").trim().replace(/\s+/g, "").toLowerCase();

/** 검수 대상 정본 경기 전부 — 대전으로 묶을 재료. */
async function loadCandidates(): Promise<Row[]> {
  return db().unsafe<Row[]>(`
    WITH ${OBS_CTE},
    cand AS (
      SELECT m.match_id FROM match m
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE m.game_code = 'fconline'
         AND COALESCE(ms.event_id, m.event_id) IS NULL
         AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
         AND (   (m.source = 'manual' AND m.origin = 'vod_scan')
              OR EXISTS (SELECT 1 FROM obs WHERE obs.canon = m.match_id)
              OR (m.source = 'provider_api' AND (SELECT count(*) FROM fco_match_participant p JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
                                                  WHERE p.match_id = m.match_id) >= 2))
    )
    SELECT m.match_id, m.source, m.game_creation, m.review_completed_at,
           (EXISTS (SELECT 1 FROM fco_context_evidence e WHERE e.match_id = m.match_id)
            OR EXISTS (SELECT 1 FROM fco_match_context c WHERE c.match_id = m.match_id)
            OR m.source = 'manual') AS investigated,
           -- 사람: 정본 칸에 없으면 이어진 시점(화면 기록)이 같은 닉네임 칸에 붙인 사람을 쓴다.
           --   예) 정본(스맵임 방송)은 「불꽃열정」이 누군지 모르는데, 서도일 방송 기록은 「불꽃열정 = 서도일(방송 주인)」을 안다.
           --   읽기만 이렇게 본다 — 정본 칸을 고치지 않는다(넥슨 기록 칸은 계정 연결로만 사람이 정해진다).
           (SELECT json_agg(json_build_object('nickname', p.nickname, 'streamer_id', who.id, 'slug', who.slug, 'name', who.display_name) ORDER BY p.side_no)
              FROM fco_match_participant p
              LEFT JOIN LATERAL (
                SELECT s.id, s.slug, s.display_name FROM streamer s
                 WHERE s.visibility = 'public' AND s.id = COALESCE(p.streamer_id, (
                   SELECT q.streamer_id FROM fco_screen_link l JOIN fco_match_participant q ON q.match_id = l.screen_match_id
                    WHERE l.api_match_id = m.match_id AND q.streamer_id IS NOT NULL
                      AND lower(regexp_replace(q.nickname, '[[:space:]]+', '', 'g')) = lower(regexp_replace(p.nickname, '[[:space:]]+', '', 'g'))
                    LIMIT 1))) who ON true
             WHERE p.match_id = m.match_id) AS parts,
           (SELECT json_agg(DISTINCT jsonb_build_object('slug', st.slug, 'name', st.display_name))
              FROM obs o JOIN event_lead el ON el.url LIKE '%/player/' || o.vod::text JOIN streamer st ON st.id = el.streamer_id
             WHERE o.canon = m.match_id) AS owners,
           (SELECT array_agg(DISTINCT o.vod::text) FROM obs o WHERE o.canon = m.match_id) AS vods
      FROM cand JOIN match m ON m.match_id = cand.match_id
     ORDER BY m.game_creation`);
}

/** 경기 하나의 묶음 키와 이름. */
function keyOf(r: Row): { kind: "pair" | "solo" | "names"; key: string; title: string; people: { slug: string; name: string }[] } {
  const parts = r.parts ?? [];
  const named = parts.filter((p) => p.streamer_id && p.slug);
  const people = named.map((p) => ({ slug: p.slug!, name: p.name ?? p.nickname }));
  if (named.length >= 2) {
    const s = [...named].sort((a, b) => (a.streamer_id! < b.streamer_id! ? -1 : 1));
    return { kind: "pair", key: s.map((p) => p.slug).join("+"), title: s.map((p) => p.name ?? p.nickname).join(" vs "), people };
  }
  if (named.length === 1) return { kind: "solo", key: named[0].slug!, title: `${named[0].name ?? named[0].nickname} · 일반 유저전`, people };
  const nicks = parts.map((p) => p.nickname).sort((a, b) => (norm(a) < norm(b) ? -1 : 1));
  return { kind: "names", key: nicks.map(norm).join("+"), title: nicks.join(" vs "), people };
}

/** 모든 대전 — 최근 것부터. */
export async function listFcoSessions(): Promise<FcoSession[]> {
  const rows = await loadCandidates();
  const byKey = new Map<string, { k: ReturnType<typeof keyOf>; rows: Row[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    const id = `${k.kind}~${k.key}`;
    (byKey.get(id) ?? byKey.set(id, { k, rows: [] }).get(id)!).rows.push(r);
  }
  const out: FcoSession[] = [];
  for (const [base, { k, rows: list }] of byKey) {
    list.sort((a, b) => a.game_creation.getTime() - b.game_creation.getTime());
    let cur: Row[] = [];
    const flush = () => {
      if (!cur.length) return;
      const people = new Map<string, string>();
      for (const r of cur) {
        for (const p of keyOf(r).people) people.set(p.slug, p.name);
        for (const o of r.owners ?? []) people.set(o.slug, o.name);
      }
      out.push({
        id: `${base}~${Math.floor(cur[0].game_creation.getTime() / 1000)}`, kind: k.kind as FcoSessionKind, pairs: [], title: k.title,
        people: [...people].map(([slug, name]) => ({ slug, name })),
        from: cur[0].game_creation.toISOString(), to: cur[cur.length - 1].game_creation.toISOString(),
        total: cur.length, completed: cur.filter((r) => r.review_completed_at).length,
        api: cur.filter((r) => r.source === "provider_api").length,
        investigated: cur.some((r) => r.investigated), match_ids: cur.map((r) => r.match_id),
        vods: [...new Set(cur.flatMap((r) => r.vods ?? []))].sort(),
      });
      cur = [];
    };
    for (const r of list) {
      const last = cur[cur.length - 1];
      if (last && r.game_creation.getTime() - last.game_creation.getTime() > SESSION_GAP_MIN * 60_000) flush();
      cur.push(r);
    }
    flush();
  }
  const pairs = out.filter((x) => (x.kind as string) === "pair");
  const rest = out.filter((x) => (x.kind as string) !== "pair").map((x) => ({ ...x, pairs: [{ title: x.title, total: x.total }] }));
  return [...gatherMeets(pairs), ...rest].sort((a, b) => b.from.localeCompare(a.from));
}

/**
 * 스트리머끼리 대전을 **모임**으로 잇는다 — 사용자 결정(2026-10-02).
 *   두 대전이 SESSION_GAP_MIN 안에 이어지거나 겹치고, **그 자리에 있던 사람**이 한 명이라도 겹치면 같은 모임(사슬로 이어진다).
 *   그 자리에 있던 사람 = 뛴 사람 + 그 판을 자기 방송에 띄운 방송 주인(서로 경기를 띄워 보는 모임에서 서도일 방송에 김민교 vs 이상호가 나오면 서도일도 있던 것).
 *   4~5명이 돌아가며 하거나 CK 대진을 돌리면 두 사람 대전이 여러 개로 쪼개져 흐름이 안 보였다(실측: 330대전 중 170이 56개 모임으로 묶임, 가장 큰 모임 8판).
 * ★ 모임은 검수 화면에서만 쓰고 저장하지 않는다. 공개에 닿는 것은 모임에서 내린 **행사 연결**뿐이다.
 */
function gatherMeets(list: FcoSession[]): FcoSession[] {
  const present = list.map((x) => new Set(x.people.map((p) => p.slug)));
  const parent = list.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const gap = SESSION_GAP_MIN * 60_000;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (Date.parse(a.from) - gap > Date.parse(b.to) || Date.parse(b.from) - gap > Date.parse(a.to)) continue;
      if ([...present[i]].some((x) => present[j].has(x))) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, FcoSession[]>();
  list.forEach((x, i) => (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(x));
  return [...groups.values()].map((g) => {
    g.sort((a, b) => a.from.localeCompare(b.from));
    const people = new Map<string, string>();
    for (const x of g) for (const p of x.people) people.set(p.slug, p.name);
    const from = g[0].from, to = g.map((x) => x.to).sort().at(-1)!;
    const ids = g.flatMap((x) => x.match_ids);
    const players = new Set(g.flatMap((x) => x.title.split(" vs ")));
    return {
      id: `meet~${Math.floor(Date.parse(from) / 1000)}~${ids.length}`,
      kind: "meet" as const,
      title: g.length === 1 ? g[0].title : `${players.size}명 모임 · ${[...players].slice(0, 4).join(", ")}${players.size > 4 ? " 외" : ""}`,
      people: [...people].map(([slug, name]) => ({ slug, name })),
      from, to,
      total: g.reduce((n, x) => n + x.total, 0),
      completed: g.reduce((n, x) => n + x.completed, 0),
      api: g.reduce((n, x) => n + x.api, 0),
      investigated: g.some((x) => x.investigated),
      vods: [...new Set(g.flatMap((x) => x.vods))].sort(),
      // 모임 안 경기는 시간 순 — 대전들을 섞어 그 자리의 흐름 그대로
      match_ids: ids,
      pairs: g.map((x) => ({ title: x.title, total: x.total })),
    };
  });
}

/**
 * 주소의 대전 id 로 대전 하나. 그 사이 경기가 더해져 첫 경기가 바뀌었을 수 있다 —
 * 같은 묶음 키에서 그 시각을 포함하는(또는 가장 가까운) 대전을 준다.
 */
export async function getFcoSession(id: string): Promise<FcoSession | null> {
  const m = /^(meet|solo|names)~(.+?)~?(\d{9,11})?$/.exec(id);
  if (!m) return null;
  const all = await listFcoSessions();
  const exact = all.find((x) => x.id === id);
  if (exact) return exact;
  // 그 사이 경기가 더해지거나 묶음이 바뀌었으면 — 같은 종류에서 그 시각을 포함하는 것(없으면 가장 가까운 것)
  const at = Number((/~(\d{9,11})(?:~|$)/.exec(id) ?? [])[1] ?? NaN) * 1000;
  if (!Number.isFinite(at)) return null;
  const same = all.filter((x) => x.kind === m[1] && (m[1] === "meet" || x.id.startsWith(`${m[1]}~${id.split("~")[1]}~`)));
  if (!same.length) return null;
  return same.find((x) => Date.parse(x.from) <= at && at <= Date.parse(x.to))
    ?? same.sort((a, b) => Math.abs(Date.parse(a.from) - at) - Math.abs(Date.parse(b.from) - at))[0];
}

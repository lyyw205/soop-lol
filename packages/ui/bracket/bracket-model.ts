/**
 * 대진표 화면 모델. DB 대진(EventBracket) + 계산 결과(BracketResult) → 그릴 것.
 * 롤·FC 공통이다 — 게임마다 다른 것은 경기 주소(matchHref)뿐이라 호출부가 넘긴다.
 * 순수 함수라 서버에서 만들어 클라이언트 컴포넌트(bracket-board.tsx)에 넘긴다.
 */
import {
  displayRank, rankText, slotDepths,
  type BracketResult, type Certainty, type EventBracket, type ResolvedSlot,
} from "@soop-lol/core/lib/contract";

export interface BoardEntrant {
  id: string;
  name: string;
  image: string | null;
  channelId: string | null;
  /** 개인전(1인 팀)이면 그 사람의 slug — 프로필 링크용 */
  slug: string | null;
}
export interface BoardSide {
  entrant: BoardEntrant | null;
  score: number | null;
  /** 단판이 동점으로 끝나 승부차기로 갈렸을 때의 승부차기 점수 */
  shootout: number | null;
  won: boolean;
}
/** 칸의 상태 뱃지. 확인된 경기 결과는 뱃지를 달지 않는다(기본값이 확인이다). */
export type BoardBadge = "미정" | "기록 없음" | "추론" | "공식 발표" | "방송 확인" | "주최측 결정" | "부전승" | "기권" | "취소" | null;
export interface BoardSlot {
  id: string;
  no: number;
  title: string;
  lane: string | null;
  depth: number;
  kind: "match" | "selection";
  bestOf: number | null;
  sides: BoardSide[];
  badge: BoardBadge;
  /** 경기 상세 주소(첫 판). 기록이 없으면 null */
  href: string | null;
  games: number;
  /** 이 칸에 이어진 경기 id(경기 순서). 화면이 자기 상세(팝업 등)를 열 때 쓴다 */
  matchIds: string[];
  /** 이 칸에서 확정되는 순위(패자 → 8위 등). 그림에 작게 단다 */
  loserRank: string | null;
  evidence: string;
}
export interface BoardEdge { from: string; to: string; outcome: "winner" | "loser" }
export interface BoardPlacement {
  entrant: BoardEntrant;
  rank: string | null;
  min: number | null;
  /** official 공식 발표 · source_inferred 출처에서 유도 · computed 대진 규칙으로 계산 */
  from: "official" | "source_inferred" | "computed" | null;
  certainty: Certainty;
  evidence: string | null;
}
export interface BoardModel {
  lanes: { name: string | null; slots: BoardSlot[] }[];
  columns: number;
  edges: BoardEdge[];
  placements: BoardPlacement[];
  champion: BoardEntrant | null;
}

const BADGE: Record<string, BoardBadge> = { official: "공식 발표", observed: "방송 확인", organizer: "주최측 결정", inferred: "추론" };

function badgeOf(s: ResolvedSlot): BoardBadge {
  if (s.state === "pending") return "미정";
  if (s.state === "unrecorded") return "기록 없음";
  if (s.state === "walkover") return "부전승";
  if (s.state === "forfeit") return "기권";
  if (s.state === "cancelled") return "취소";
  if (s.source === "inferred") return "추론";
  if (s.source === "decision" && s.basis) return BADGE[s.basis] ?? null;
  return null;
}

/** image 를 주면 참가 단위 그림을 그것으로 쓴다(롤: 팀 로고). 없으면 개인전 참가자의 프로필 사진. */
export function bracketBoard(bracket: EventBracket, result: BracketResult, matchHref: (matchId: string) => string | null,
  opts: { image?: (entrant: EventBracket["entrants"][number]) => string | null } = {}): BoardModel {
  const entrants = new Map(bracket.entrants.map((e): [string, BoardEntrant] => {
    const solo = e.members.length === 1 ? e.members[0] : null;
    return [e.id, { id: e.id, name: e.name, image: opts.image?.(e) ?? solo?.image ?? null, channelId: solo?.channelId ?? null, slug: solo?.slug ?? null }];
  }));
  const depth = slotDepths(bracket.input.slots, bracket.input.routes);
  const routes = bracket.input.routes;
  const slots: BoardSlot[] = result.slots.map((r) => {
    const s = r.slot;
    // 승부차기: 단판 경기 기록이고 화면 점수가 같은데 승부차기 점수가 있을 때만(0:0 은 승부차기가 없었던 것이다)
    const single = r.games.length === 1 && r.source === "match" ? r.games[0] : null;
    const level = single && single.entrants.length === 2 && single.entrants[0].score != null
      && single.entrants[0].score === single.entrants[1].score;
    const pk = level && single.entrants.some((x) => (x.shootout ?? 0) > 0);
    const lose = routes.find((x) => x.fromSlot === s.id && x.outcome === "loser");
    const first = [...r.games].sort((a, b) => a.playedAt.localeCompare(b.playedAt))[0];
    return {
      id: s.id, no: s.no, title: `${s.no}경기${s.label ? ` · ${s.label}` : ""}`, lane: s.lane, depth: depth.get(s.id) ?? 0,
      kind: s.kind, bestOf: s.bestOf,
      sides: r.occupants.map((e, i) => ({
        entrant: e ? entrants.get(e) ?? null : null,
        // 단판이면 그 판의 점수(골·킬이 아니라 경기 화면 점수), 여러 판이면 세트 수
        score: s.kind !== "match" ? null
          : r.games.length === 1 && r.source === "match" ? r.games[0].entrants.find((x) => x.entrant === e)?.score ?? null
          : r.score[i] ?? null,
        shootout: pk ? single!.entrants.find((x) => x.entrant === e)?.shootout ?? null : null,
        won: e != null && r.winners.includes(e),
      })),
      badge: badgeOf(r),
      href: first ? matchHref(first.matchId) : null,
      games: r.games.length,
      matchIds: [...r.games].sort((a, b) => a.playedAt.localeCompare(b.playedAt)).map((g) => g.matchId),
      loserRank: lose?.to.kind === "placement" ? rankText(lose.to.min, lose.to.max) : null,
      evidence: bracket.decisionEvidence[s.id] ?? bracket.slotEvidence[s.id] ?? "",
    };
  });
  // 줄 순서: 처음 나오는 칸 번호 순. 줄 안에서는 깊이 → 번호
  const laneOrder: (string | null)[] = [];
  for (const s of [...slots].sort((a, b) => a.no - b.no)) if (!laneOrder.includes(s.lane)) laneOrder.push(s.lane);
  const lanes = laneOrder.map((name) => ({
    name, slots: slots.filter((s) => s.lane === name).sort((a, b) => a.depth - b.depth || a.no - b.no),
  }));
  const edges: BoardEdge[] = routes.flatMap((r) => (r.to.kind === "slot" ? [{ from: r.fromSlot, to: r.to.slot, outcome: r.outcome }] : []));
  const placements: BoardPlacement[] = result.placements.map((p) => {
    const r = displayRank(p);
    const entrant = bracket.entrants.find((e) => e.id === p.entrant);
    return {
      entrant: entrants.get(p.entrant)!, rank: r ? rankText(r.min, r.max) : null, min: r?.min ?? null, from: r?.from ?? null,
      certainty: p.certainty, evidence: p.official ? entrant?.finalRankEvidence ?? null : null,
    };
  }).filter((p) => p.entrant);
  // 순위가 없는 참가 단위도 목록 끝에 둔다(탈락·미정) — 빠뜨리면 참가자가 사라진 것처럼 보인다
  for (const e of entrants.values()) if (!placements.some((p) => p.entrant.id === e.id))
    placements.push({ entrant: e, rank: null, min: null, from: null, certainty: "confirmed", evidence: null });
  placements.sort((a, b) => (a.min ?? 999) - (b.min ?? 999) || a.entrant.name.localeCompare(b.entrant.name, "ko"));
  const top = placements.find((p) => p.min === 1 && p.rank === "1위");
  return {
    lanes, columns: Math.max(0, ...slots.map((s) => s.depth)) + 1, edges, placements,
    champion: top?.entrant ?? null,
  };
}

/** 순위 출처 문구. 추론이 섞였으면 그 사실을 함께 말한다(계산이 확실해 보이지 않게). */
export function placementNote(p: BoardPlacement): string {
  if (!p.rank) return "순위 미정";
  const base = p.from === "official" ? "공식 발표" : p.from === "source_inferred" ? "출처에서 확인" : "대진 규칙으로 계산";
  if (p.from === "official") return base;
  return p.certainty === "inferred" ? `${base} · 일부 경기 결과 추론` : p.certainty === "organizer" ? `${base} · 주최측 결정 포함` : base;
}

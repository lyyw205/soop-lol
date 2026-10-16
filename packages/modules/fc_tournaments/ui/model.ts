import { fcoPlayerAppearance, pairSetOutcome, tally, type Tally } from "@soop-lol/core/lib/contract/client";
/**
 * FC 대회 화면의 해석 — 참가자 성적·상대 전적표·하이라이트·선수 카드 기록.
 * core 에는 경기 사실만 있고 이건 이 모듈 것이다. 순수 함수라 테스트가 그대로 부른다.
 *
 * ★ 순위를 지어내지 않는다. 승수로 줄 세우면 순위처럼 읽히는데, 대회 순위는 대진 규칙이 정한다
 *   (2026-10-02 뿌챔스: 승수 1위 도현 ≠ 우승 임유진). 그래서 참가자 기록은 이름순이고,
 *   순위는 대진(docs/TOURNAMENT-FORMAT-PLAN.md)이 있을 때만 그쪽에서 온다.
 * ★ 미연결 상대(ouid 가 'unlinked:…')는 신원을 모르므로 성적·전적표에서 뺀다 — 같은 사람인지
 *   알 수 없는 칸을 한 줄로 합치면 없는 사람의 기록이 생긴다.
 */
import { recordText as recordCountsText } from "../../../ui/record-pair-model.ts";
import { addFcoStats, EMPTY_FCO_STATS, fcoNumber, type FcoGame, type FcoParticipant, type FcoStatLine } from "@soop-lol/core/lib/contract";

export type Outcome = FcoParticipant["outcome"];

/** 화면 점수. 몰수 경기에서 goals 와 다를 수 있어 표시 점수가 우선이다(0030). */
export const sideScore = (p: FcoParticipant | undefined): number | null => p ? p.score_display ?? p.goals : null;

/** 점수가 같은데 승패가 갈린 경기. 결정 방식(승부차기 등)은 저장돼 있지 않아 "동점 승부"까지만 말한다. */
export function isLevelDecided(game: FcoGame): boolean {
  const [a, b] = game.participants;
  const sa = sideScore(a), sb = sideScore(b);
  return sa != null && sa === sb && game.participants.some((p) => p.outcome === "win");
}

export interface PersonInfo { image: string | null; channel_id: string | null }

export interface Entrant {
  key: string;
  slug: string | null;
  name: string;
  image: string | null;
  channelId: string | null;
  games: number;
  /** 세트·시리즈 기록 — 세는 규칙은 core 의 tally 하나다. 아래 wins·draws·losses·unknown 은 그 세트 값이다(표 칸용). */
  record: Tally;
  wins: number;
  draws: number;
  losses: number;
  /** 결과 미상 세트 — 숨기지 않는다. */
  unknown: number;
  /** 화면 점수 기준 득점·실점 */
  goalsFor: number;
  goalsAgainst: number;
  /** 경기 순서대로 */
  form: Outcome[];
  stats: FcoStatLine;
}

const linked = (p: FcoParticipant) => p.streamer_id != null;

/** 참가자별 기록. **이름순** — 순위가 아니다(파일 머리 주석). */
export function entrants(games: FcoGame[], people: Map<string, PersonInfo> = new Map()): Entrant[] {
  const rows = new Map<string, Entrant>();
  const sets = new Map<string, { series_id: string; outcome: Outcome }[]>();
  for (const game of games) {
    for (const p of game.participants) {
      if (!linked(p)) continue;
      const rival = game.participants.find((o) => o !== p);
      const info = people.get(p.streamer_id!);
      const row = rows.get(p.streamer_id!) ?? {
        key: p.streamer_id!, slug: p.streamer_slug, name: p.streamer_name ?? p.nickname,
        image: info?.image ?? null, channelId: info?.channel_id ?? null,
        games: 0, record: tally([]), wins: 0, draws: 0, losses: 0, unknown: 0, goalsFor: 0, goalsAgainst: 0, form: [], stats: EMPTY_FCO_STATS,
      };
      row.games++;
      (sets.get(row.key) ?? sets.set(row.key, []).get(row.key)!).push({ series_id: game.series_id ?? game.id, outcome: p.outcome });
      row.goalsFor += sideScore(p) ?? 0;
      row.goalsAgainst += sideScore(rival) ?? 0;
      row.form.push(p.outcome);
      row.stats = addFcoStats(row.stats, p);
      rows.set(row.key, row);
    }
  }
  for (const row of rows.values()) {
    row.record = tally(sets.get(row.key) ?? []);
    ({ win: row.wins, draw: row.draws, loss: row.losses, unknown: row.unknown } = row.record.sets);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export interface H2HResult { gameId: string; providerId: string; own: number | null; rival: number | null; outcome: Outcome }

/**
 * 상대 전적표. matrix.get(a)?.get(b) 는 a 입장에서 본 b 와의 경기들(경기 순서).
 * ★ 칸의 결과는 두 사람의 결과 짝으로 정한다(pairSetOutcome) — 양쪽 몰수패는 무, 그래서 a 칸과 b 칸이 언제나 거울이다.
 */
export function headToHead(games: FcoGame[]): Map<string, Map<string, H2HResult[]>> {
  const matrix = new Map<string, Map<string, H2HResult[]>>();
  for (const game of games) {
    const [a, b] = game.participants;
    if (!a || !b || !linked(a) || !linked(b)) continue;
    for (const [own, rival] of [[a, b], [b, a]] as const) {
      const row = matrix.get(own.streamer_id!) ?? new Map<string, H2HResult[]>();
      const cell = row.get(rival.streamer_id!) ?? [];
      cell.push({ gameId: game.id, providerId: game.provider_id, own: sideScore(own), rival: sideScore(rival), outcome: pairSetOutcome(own.outcome, rival.outcome) });
      row.set(rival.streamer_id!, cell);
      matrix.set(own.streamer_id!, row);
    }
  }
  return matrix;
}

export interface CardRecord {
  key: string;
  playerId: number;
  streamer: string;
  slug: string | null;
  games: number;
  goals: number;
  assists: number;
  /** 평점이 있는 경기만 평균에 넣는다 */
  ratingSum: number;
  rated: number;
  passes: number;
  passTry: number;
}

/** 스트리머 × 선수 카드별 대회 기록. 같은 선수라도 쓴 사람이 다르면 다른 줄이다. */
export function cardRecords(games: FcoGame[]): CardRecord[] {
  const rows = new Map<string, CardRecord>();
  for (const game of games) for (const p of game.participants) {
    if (!linked(p) || !Array.isArray(p.match_info.player)) continue;
    for (const raw of p.match_info.player) {
      if (!raw || typeof raw !== "object") continue;
      const player = raw as Record<string, unknown>;
      const playerId = fcoNumber(player.spId);
      if (!playerId) continue;
      const status = player.status && typeof player.status === "object" ? player.status as Record<string, unknown> : {};
      const { appeared, rating } = fcoPlayerAppearance(status);
      if (!appeared) continue;
      const key = `${p.streamer_id}:${playerId}`;
      const row = rows.get(key) ?? {
        key, playerId, streamer: p.streamer_name ?? p.nickname, slug: p.streamer_slug,
        games: 0, goals: 0, assists: 0, ratingSum: 0, rated: 0, passes: 0, passTry: 0,
      };
      row.games++;
      row.goals += fcoNumber(status.goal);
      row.assists += fcoNumber(status.assist);
      row.passes += fcoNumber(status.passSuccess);
      row.passTry += fcoNumber(status.passTry);
      if (rating !== null) { row.ratingSum += rating; row.rated++; }
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.goals - a.goals || b.assists - a.assists || b.games - a.games || a.key.localeCompare(b.key));
}

/** 평균 평점을 순위에 올리는 최소 출전 수. 한 경기 반짝 평점이 1위가 되지 않게 한다. */
export const MIN_RATED_GAMES = 3;

export interface Highlights {
  topScorer: Entrant | null;
  /** 두 사람 점수 합이 가장 큰 경기 */
  highestScoring: { game: FcoGame; total: number } | null;
  /** 점수차가 가장 큰 승리 */
  biggestWin: { game: FcoGame; margin: number } | null;
  topCard: CardRecord | null;
  bestRated: CardRecord | null;
}

export function highlights(games: FcoGame[], people: Entrant[], cards: CardRecord[]): Highlights {
  let highestScoring: Highlights["highestScoring"] = null;
  let biggestWin: Highlights["biggestWin"] = null;
  for (const game of games) {
    const [a, b] = game.participants;
    const sa = sideScore(a), sb = sideScore(b);
    if (sa == null || sb == null) continue;
    if (!highestScoring || sa + sb > highestScoring.total) highestScoring = { game, total: sa + sb };
    const margin = Math.abs(sa - sb);
    if (margin > 0 && (!biggestWin || margin > biggestWin.margin)) biggestWin = { game, margin };
  }
  const scorer = people.reduce<Entrant | null>((best, e) => (!best || e.goalsFor > best.goalsFor ? e : best), null);
  const rated = cards.filter((c) => c.rated >= MIN_RATED_GAMES)
    .sort((a, b) => b.ratingSum / b.rated - a.ratingSum / a.rated || b.rated - a.rated)[0] ?? null;
  return {
    topScorer: scorer && scorer.goalsFor > 0 ? scorer : null,
    highestScoring,
    biggestWin,
    topCard: cards[0] && cards[0].goals > 0 ? cards[0] : null,
    bestRated: rated,
  };
}

export { formatLabel } from "@soop-lol/core/lib/contract/client";
/** 세트 기록 한 줄 — 문구 규칙은 공용 기록 부품의 것(미상이 있으면 늘 보인다, 승+무+패+미상 = 판 수). */
export const recordText = (e: Pick<Entrant, "record">) => recordCountsText(e.record.sets);
export const outcomeLabel = (o: Outcome) => o === "win" ? "승" : o === "loss" ? "패" : o === "draw" ? "무" : "?";

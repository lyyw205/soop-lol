/**
 * 다시점 경기 비교 — 한 경기를 여러 VOD 가 봤을 때 "이 시점이 읽은 값" 과 "경기 값" 을 맞춘다.
 * docs/CK-MULTI-POV-PLAN.md §4. DB 를 모르는 순수 함수만 둔다(검증은 pov.test.ts).
 *
 * ★ 일치·불일치는 저장하지 않는다. 시점은 직접 읽은 값(observed)만 남기고, 비교는 볼 때마다 여기서 한다.
 *   그래야 사람이 경기 값을 고치는 순간 모든 시점의 비교가 새 값 기준으로 바뀐다.
 *
 * ★ 참가자는 줄 순서가 아니라 **사람**으로 맞춘다. 롤 결과창은 보는 사람의 팀이 위에 오므로
 *   시점마다 팀 순서가 뒤집힌다. 팀 번호도 시점이 붙인 이름표일 뿐이라, 사람들이 어느 팀에
 *   함께 있었는지로 경기 쪽 팀 번호에 대응시킨다.
 */

/** 칸 하나의 관측. 제출 시각은 "사람이 이 불일치를 봤나" 를 가를 때 쓴다. */
export interface Seen<T> { v: T; at: string }

export type ParticipantField = "team" | "position" | "champion_id" | "kills" | "deaths" | "assists";
export type MatchField = "winning_team" | "duration" | "series_game_no";

/** 사람을 가리키는 값. 하나라도 있어야 비교 대상이 된다. */
export interface PovIdent {
  streamer_id?: string | null;
  puuid?: string | null;
  observed_name?: string | null;
}

export interface ObservedParticipant {
  ident: PovIdent;
  team?: Seen<100 | 200>;
  position?: Seen<string>;
  champion_id?: Seen<number>;
  kills?: Seen<number>;
  deaths?: Seen<number>;
  assists?: Seen<number>;
}

export interface PovObserved {
  match?: Partial<Record<MatchField, Seen<number>>>;
  participants?: Record<string, ObservedParticipant>;
}

/**
 * 이번 제출. **키가 없으면 "안 읽음 — 그대로 둠", null 이면 "철회", 값이면 "읽은 값"** 이다.
 * `kills: 0` 은 읽은 값이다. 0 과 생략을 같게 다루면 0킬이 사라지거나 모름이 0킬이 된다.
 */
export interface PovSubmission {
  match?: Partial<Record<MatchField, number | null>>;
  participants?: Array<{ ident: PovIdent } & Partial<Record<ParticipantField, number | string | null>>>;
}

export interface PovHistoryEntry {
  at: string;
  scope: "match" | "participant";
  key: string;
  field: string;
  before: unknown;
  after: unknown;
}

const PARTICIPANT_FIELDS: ParticipantField[] = ["team", "position", "champion_id", "kills", "deaths", "assists"];
const MATCH_FIELDS: MatchField[] = ["winning_team", "duration", "series_game_no"];

const normName = (s: string) => s.normalize("NFC").replace(/\s+/g, "").toLowerCase();

/** 시점 안에서 사람을 한 줄로 부르는 키. 계정·사람이 있으면 그게 먼저다(이름은 바뀐다). */
export function identKey(id: PovIdent): string | null {
  if (id.streamer_id) return `s:${id.streamer_id}`;
  if (id.puuid) return `p:${id.puuid}`;
  if (id.observed_name?.trim()) return `n:${normName(id.observed_name)}`;
  return null;
}

/**
 * 이전 관측에 이번 제출을 합친다. **보낸 칸만 바꾸고, 안 보낸 칸은 그대로 둔다.**
 * 값이 같으면 제출 시각을 옮기지 않는다 — 사람이 이미 확인한 불일치가 같은 값 재전송으로 다시
 * "미해결" 이 되면 안 된다. 바뀌거나 철회된 칸은 이력에 남긴다.
 */
export function mergeObserved(prev: PovObserved, sub: PovSubmission, now: string): {
  observed: PovObserved; history: PovHistoryEntry[];
} {
  const observed: PovObserved = structuredClone(prev ?? {});
  const history: PovHistoryEntry[] = [];

  if (sub.match) {
    observed.match ??= {};
    for (const f of MATCH_FIELDS) {
      if (!(f in sub.match)) continue;
      const next = sub.match[f];
      const cur = observed.match[f];
      if (next === null || next === undefined) {
        if (cur) { history.push({ at: now, scope: "match", key: "match", field: f, before: cur.v, after: null }); delete observed.match[f]; }
      } else if (!cur || cur.v !== next) {
        if (cur) history.push({ at: now, scope: "match", key: "match", field: f, before: cur.v, after: next });
        observed.match[f] = { v: next, at: now };
      }
    }
  }

  for (const p of sub.participants ?? []) {
    const key = identKey(p.ident);
    if (!key) continue;
    observed.participants ??= {};
    const cur = observed.participants[key] ?? { ident: {} };
    cur.ident = { ...cur.ident, ...Object.fromEntries(Object.entries(p.ident).filter(([, v]) => v != null)) };
    for (const f of PARTICIPANT_FIELDS) {
      if (!(f in p)) continue;
      const next = p[f];
      const old = cur[f] as Seen<unknown> | undefined;
      if (next === null || next === undefined) {
        if (old) { history.push({ at: now, scope: "participant", key, field: f, before: old.v, after: null }); delete cur[f]; }
      } else if (!old || old.v !== next) {
        if (old) history.push({ at: now, scope: "participant", key, field: f, before: old.v, after: next });
        (cur as unknown as Record<string, Seen<unknown>>)[f] = { v: next, at: now };
      }
    }
    observed.participants[key] = cur;
  }
  return { observed, history };
}

/** 비교할 경기 쪽 참가자. `person_id` 는 계정 주인을 먼저 본 사람(조우 파생과 같은 순서). */
export interface StoredParticipant {
  participant_id: number;
  person_id: string | null;
  puuid: string | null;
  observed_name: string | null;
  team_id: 100 | 200;
  team_position: string | null;
  champion_id: number;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface StoredMatch {
  winning_team: 100 | 200 | null;
  game_duration: number | null;
  series_id: string | null;
  series_game_no: number | null;
  review_completed_at: string | Date | null;
  participants: StoredParticipant[];
}

export type CompareStatus = "agree" | "mismatch" | "empty" | "pending";

export interface CompareItem {
  scope: "match" | "participant";
  /** 사람 키(참가자) 또는 "match". */
  key: string;
  /** 경기 쪽 자리. 사람을 못 찾았으면 null. */
  participant_id: number | null;
  field: MatchField | ParticipantField;
  stored: unknown;
  observed: unknown;
  /**
   * agree 같음 · mismatch 다름 · empty 경기 칸이 비어 있음(채울 수 있음) ·
   * pending 대응이 불확실해 비교하지 않음(사람을 못 찾음, 팀 대응 불가 등).
   */
  status: CompareStatus;
  /** mismatch 일 때만: 사람이 검수 완료로 이미 확인했나. 완료 시각이 이 칸 제출보다 나중이면 true. */
  reviewed: boolean;
  at: string;
}

export interface PovComparison {
  /** 시점의 팀 번호 → 경기 쪽 팀 번호. 알 수 없으면 null. */
  team_map: { 100: 100 | 200 | null; 200: 100 | 200 | null };
  items: CompareItem[];
  unmatched: string[];
}

/** 시점의 사람 한 명을 경기 쪽 자리에 대응시킨다. 둘 이상이 걸리면 대응하지 않는다(추측 금지). */
export function matchParticipant(ident: PovIdent, stored: StoredParticipant[]): StoredParticipant | null {
  const pick = (rows: StoredParticipant[]) => (rows.length === 1 ? rows[0] : null);
  if (ident.streamer_id) {
    const hit = pick(stored.filter((s) => s.person_id === ident.streamer_id));
    if (hit) return hit;
  }
  if (ident.puuid) {
    const hit = pick(stored.filter((s) => s.puuid === ident.puuid));
    if (hit) return hit;
  }
  if (ident.observed_name?.trim()) {
    const n = normName(ident.observed_name);
    return pick(stored.filter((s) => s.observed_name != null && normName(s.observed_name) === n));
  }
  return null;
}

const toTime = (v: string | Date | null) => (v == null ? null : new Date(v).getTime());

/** 경기 값과 시점 관측을 비교한다. 저장하지 않는다 — 부를 때마다 현재 값 기준으로 다시 계산한다. */
export function comparePov(stored: StoredMatch, observed: PovObserved): PovComparison {
  const done = toTime(stored.review_completed_at);
  const items: CompareItem[] = [];
  const unmatched: string[] = [];
  const reviewedAt = (at: string) => done != null && done > new Date(at).getTime();

  // 1) 사람 대응.
  const pairs: Array<{ key: string; obs: ObservedParticipant; row: StoredParticipant | null }> = [];
  for (const [key, obs] of Object.entries(observed.participants ?? {})) {
    const row = matchParticipant(obs.ident, stored.participants);
    if (!row) unmatched.push(key);
    pairs.push({ key, obs, row });
  }

  // 2) 팀 번호 대응 — 이 시점의 100 에 있던 사람들이 경기 쪽에서 어느 팀이었나. 만장일치일 때만 잇는다.
  const votes: Record<100 | 200, Set<100 | 200>> = { 100: new Set(), 200: new Set() };
  for (const { obs, row } of pairs) if (row && obs.team) votes[obs.team.v].add(row.team_id);
  const one = (s: Set<100 | 200>) => (s.size === 1 ? [...s][0] : null);
  const team_map = { 100: one(votes[100]), 200: one(votes[200]) } as PovComparison["team_map"];
  // 두 이름표가 같은 경기 팀으로 가면 대응이 깨진 것이다.
  if (team_map[100] != null && team_map[100] === team_map[200]) { team_map[100] = null; team_map[200] = null; }
  const mapTeam = (t: 100 | 200): 100 | 200 | null =>
    team_map[t] ?? (team_map[t === 100 ? 200 : 100] != null ? (team_map[t === 100 ? 200 : 100] === 100 ? 200 : 100) : null);

  const push = (base: Omit<CompareItem, "status" | "reviewed">, status: CompareStatus) =>
    items.push({ ...base, status, reviewed: status === "mismatch" && reviewedAt(base.at) });

  // 3) 경기 칸.
  for (const f of MATCH_FIELDS) {
    const seen = observed.match?.[f];
    if (!seen) continue;
    const base = { scope: "match" as const, key: "match", participant_id: null, field: f, observed: seen.v, at: seen.at };
    if (f === "winning_team") {
      const mapped = mapTeam(seen.v as 100 | 200);
      if (mapped == null) { push({ ...base, stored: stored.winning_team }, "pending"); continue; }
      push({ ...base, stored: stored.winning_team, observed: mapped },
        stored.winning_team == null ? "empty" : stored.winning_team === mapped ? "agree" : "mismatch");
    } else if (f === "duration") {
      const s = stored.game_duration;
      push({ ...base, stored: s }, s == null ? "empty" : Math.abs(s - seen.v) <= 10 ? "agree" : "mismatch");
    } else {
      // 세트 번호는 시리즈가 있을 때만 의미가 있다.
      if (!stored.series_id) { push({ ...base, stored: null }, "pending"); continue; }
      const s = stored.series_game_no;
      push({ ...base, stored: s }, s == null ? "empty" : s === seen.v ? "agree" : "mismatch");
    }
  }

  // 4) 참가자 칸.
  for (const { key, obs, row } of pairs) {
    for (const f of PARTICIPANT_FIELDS) {
      const seen = obs[f] as Seen<unknown> | undefined;
      if (!seen) continue;
      const base = { scope: "participant" as const, key, participant_id: row?.participant_id ?? null, field: f, observed: seen.v, at: seen.at };
      if (!row) { push({ ...base, stored: null }, "pending"); continue; }
      if (f === "team") {
        const mapped = mapTeam(seen.v as 100 | 200);
        if (mapped == null) { push({ ...base, stored: row.team_id }, "pending"); continue; }
        push({ ...base, stored: row.team_id, observed: mapped }, row.team_id === mapped ? "agree" : "mismatch");
      } else if (f === "position") {
        const s = row.team_position;
        push({ ...base, stored: s }, s == null ? "empty"
          : s.toUpperCase() === String(seen.v).toUpperCase() ? "agree" : "mismatch");
      } else if (f === "champion_id") {
        const s = row.champion_id;
        push({ ...base, stored: s }, !s ? "empty" : s === seen.v ? "agree" : "mismatch");
      } else {
        const s = row[f];
        push({ ...base, stored: s }, s == null ? "empty" : s === seen.v ? "agree" : "mismatch");
      }
    }
  }
  return { team_map, items, unmatched };
}

/** 비교 결과 중 **빈 칸 채우기**로 쓸 것. 대응이 확실한 empty 만 — pending 은 절대 채우지 않는다. */
export function fillPlan(cmp: PovComparison): Array<{ scope: "match" | "participant"; participant_id: number | null; field: string; value: unknown }> {
  return cmp.items
    .filter((i) => i.status === "empty" && i.field !== "winning_team" && i.field !== "team")
    .map((i) => ({ scope: i.scope, participant_id: i.participant_id, field: i.field, value: i.observed }));
}

/** 한 시점의 요약. 검수 화면·조회 도구가 같은 숫자를 쓰게 한 곳에 둔다. */
export function summarizeComparison(cmp: PovComparison) {
  const count = (s: CompareStatus) => cmp.items.filter((i) => i.status === s).length;
  const mismatches = cmp.items.filter((i) => i.status === "mismatch");
  return {
    compared: count("agree") + count("mismatch"),
    agree: count("agree"),
    mismatch_open: mismatches.filter((i) => !i.reviewed).length,
    mismatch_reviewed: mismatches.filter((i) => i.reviewed).length,
    pending: count("pending"),
    empty: count("empty"),
  };
}

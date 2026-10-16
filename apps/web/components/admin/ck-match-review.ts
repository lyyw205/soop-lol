/**
 * 경기 검수 화면의 규칙 — **검수 대상은 경기 하나로 고정**하고, 작업 목록과 근거는 그 주변 정보로 다룬다.
 *
 * ★ 왜 이렇게 바꿨나(2026-10-11, docs/CK-MULTI-POV-PLAN.md §6):
 *   예전 검수 화면은 VOD 하나를 기준으로 큐·사진·편집 대상을 꾸렸다. 그래서 들어온 길에 따라 경기 수가
 *   달랐고(대회 7경기 / VOD 4경기), 방송만 바꿨는데 고른 경기가 바뀌었고, 드롭다운으로 편집 대상만 바꿔
 *   보는 사진과 편집하는 경기가 어긋났다. 이전·다음·완료 후 이동도 서로 다른 순서였다.
 * ★ 규칙
 *   · 편집 대상 = 화면의 경기. 방송 필터·사진 선택은 편집 대상을 바꾸지 않는다.
 *   · 이전·다음·완료 후 이동 = 들어온 목록(`from`) 하나와 그 순서(listOverviewWorkList).
 *   · 근거 = 이 경기에 연결된 사진(모든 방송) + 같은 구간의 미연결 **참고** 사진. 둘은 구별해 표시한다.
 *     참고 사진의 구간 규칙은 VOD 화면과 같은 projectReviewQueue 하나다(그 판의 사진을 연결 수와 무관하게 넘겨 본다).
 *   · 방송 필터는 보이는 사진만 고른다. 그 방송에 사진이 없으면 없다고 보여 준다.
 */
import { isStandaloneSet, isUnbundledSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { collectedViaLabel } from "../../lib/admin-labels.ts";
import { projectReviewQueue, UNPLACED } from "./ck-review-queue.ts";

export interface WorkItem { match_id: string; completed: boolean }

/** 화면이 쓰는 작업 목록 요약 — 서버가 목록 전체에서 계산해 보낸다(목록은 수천 건이라 통째로 싣지 않는다). */
export type WorkNav = ReturnType<typeof workPosition> & { nextUncompleted: string | null };

/** 작업 목록에서 지금 경기의 자리와 앞뒤. 목록에 없으면(목록 밖에서 열었거나 범위를 벗어남) index -1. */
export function workPosition(items: readonly WorkItem[], current: string) {
  const index = items.findIndex((item) => item.match_id === current);
  return {
    index,
    total: items.length,
    prev: index > 0 ? items[index - 1].match_id : null,
    next: index >= 0 && index < items.length - 1 ? items[index + 1].match_id : null,
  };
}

/** 검수 완료 뒤 갈 곳 — 같은 목록에서 지금 경기 다음의 미완료, 끝까지 없으면 앞에서부터. 없으면 null. */
export function nextUncompleted(items: readonly WorkItem[], current: string): string | null {
  const index = items.findIndex((item) => item.match_id === current);
  const order = index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)];
  return order.find((item) => !item.completed && item.match_id !== current)?.match_id ?? null;
}

export interface EvidenceFrameInput {
  id: string;
  match_id: string | null;
  frame_path: string;
  at_sec: number | null;
  kind: "result" | "roster" | "other";
}

export interface EvidenceVodInput {
  lead_id: string;
  vod_started_at: string | null;
  frames: EvidenceFrameInput[];
  matches: Array<{ match_id: string; game_creation_epoch_ms: number; game_duration: number | null }>;
  pov: { role: "created" | "added" } | null;
}

export type EvidenceFrame = EvidenceFrameInput & { lead_id: string; linked: boolean };

export interface MatchEvidenceVod<V extends { lead_id: string }> {
  vod: V;
  /** 시각 순. linked = 이 경기에 연결된 사진, 아니면 같은 구간의 참고 사진. */
  frames: EvidenceFrame[];
  linked: number;
  reference: number;
}

const byTime = (a: { at_sec: number | null; frame_path: string }, b: { at_sec: number | null; frame_path: string }) =>
  (a.at_sec ?? UNPLACED) - (b.at_sec ?? UNPLACED) || a.frame_path.localeCompare(b.frame_path);

/** 경기 하나의 방송별 사진. 이 경기를 만든 방송을 먼저, 나머지는 받은 순서 그대로. */
export function matchEvidence<V extends EvidenceVodInput>(matchId: string, vods: readonly V[]): MatchEvidenceVod<V>[] {
  const created = (v: V) => (v.pov?.role === "created" ? 0 : 1);
  return vods.map((vod, order) => ({ vod, order })).sort((a, b) => created(a.vod) - created(b.vod) || a.order - b.order).map(({ vod }) => {
    const group = projectReviewQueue(vod.frames, vod.matches, { vodStartedAt: vod.vod_started_at })
      .find((item) => item.match.match_id === matchId);
    const linked = vod.frames.filter((frame) => frame.match_id === matchId);
    const reference = (group?.frames ?? []).filter((frame) => frame.match_id == null);
    const frames = [
      ...linked.map((frame) => ({ ...frame, lead_id: vod.lead_id, linked: true })),
      ...reference.map((frame) => ({ ...frame, lead_id: vod.lead_id, linked: false })),
    ].sort(byTime);
    return { vod, frames, linked: linked.length, reference: reference.length };
  });
}

/** 방송 필터(null = 전체)가 보여 줄 사진. 방송 순서대로, 방송 안에서는 시각 순. */
export function visibleEvidence<V extends { lead_id: string }>(evidence: readonly MatchEvidenceVod<V>[], leadId: string | null): EvidenceFrame[] {
  return evidence.filter((item) => leadId == null || item.vod.lead_id === leadId).flatMap((item) => item.frames);
}

/** 처음 띄울 사진 — 연결된 결과창, 없으면 연결된 사진, 없으면 첫 사진. */
export function representativeEvidence(frames: readonly EvidenceFrame[]): EvidenceFrame | null {
  return frames.find((frame) => frame.linked && frame.kind === "result")
    ?? frames.find((frame) => frame.linked)
    ?? frames[0] ?? null;
}

/** 경기 화면 제목 — 대회 · 세트 · 시각 · 출처. 서버 페이지에서 부르므로 이 모듈(클라이언트 전용 아님)에 둔다. */
export function matchReviewTitle(match: {
  match_id: string; series_id: string | null; best_of: number | null; set_order_known: boolean; series_game_no: number | null;
  game_creation_epoch_ms: number; game_creation_precision: "datetime" | "date"; collected_via: string;
}, eventName: string | null): string {
  const set = setLabel({ standalone: isStandaloneSet(match.match_id, match.series_id), unassigned: isUnbundledSet(match.match_id, match.series_id),
    best_of: match.best_of, set_order_known: match.set_order_known, series_game_no: match.series_game_no });
  return `${eventName ?? "행사 없음(개인 기록)"} · ${set} · ${kstPlayedAt(new Date(match.game_creation_epoch_ms), match.game_creation_precision)} · ${collectedViaLabel(match)}`;
}

/**
 * 검수 화면의 **선택 규칙** — 무엇을 고르면 무엇이 인스펙터에 뜨나.
 *
 * ★ 왜 컴포넌트 밖으로 뺐나: 선택을 **프레임에서만** 끌어내던 시절, 근거 프레임이 안 붙은
 *   경기는 타임라인에 보이는데도 고를 수 없어서 고칠 수도 없었다. 순수 함수로 두면
 *   회귀 검사가 **편집 폼까지 도달하는지**를 잰다.
 * ★ 규칙: 사람이 직접 고른 것이 가장 세고, 없으면 고른 프레임에서 끌어낸다.
 *   프레임이 한 장도 없어도(손으로 만든 경기) 경기를 고를 수 있어야 한다.
 */

export interface SelectableFrame {
  id: string;
  match_id: string | null;
  at_sec: number | null;
  kind: "result" | "roster" | "other";
}
export interface SelectableMatch { match_id: string }

/** 사람이 명시적으로 고른 것. 둘 다 비어 있을 수 있다(처음 열었을 때). */
export interface Picked {
  frameId?: string | null;
  matchId?: string | null;
}

export interface Resolved<F, M> {
  frame: F | null;
  match: M | null;
}

/** 좌우 탐색은 선택한 큐 항목 안에서만 한다. 미연결 항목은 해당 사진 하나다. */
export function framesForSelection<F extends SelectableFrame>(
  frames: readonly F[], selection: Resolved<F, SelectableMatch>,
  groups?: readonly { match: SelectableMatch; frames: F[] }[],
): F[] {
  if (selection.match && groups) return groups.find(group => group.match.match_id === selection.match!.match_id)?.frames ?? [];
  if (selection.match) return frames.filter(frame => frame.match_id === selection.match!.match_id)
    .sort((a, b) => (a.at_sec ?? Number.MAX_SAFE_INTEGER) - (b.at_sec ?? Number.MAX_SAFE_INTEGER));
  return selection.frame ? [selection.frame] : [];
}

/** 경기의 대표 비교 프레임 — 결과창을 먼저, 없으면 첫 프레임. */
export function representativeFrame<F extends SelectableFrame>(frames: readonly F[], matchId: string): F | null {
  return frames.find((f) => f.match_id === matchId && f.kind === "result")
    ?? frames.find((f) => f.match_id === matchId)
    ?? null;
}

/**
 * 지금 인스펙터에 띄울 것 둘을 정한다. 우선순위는 **직접 고른 것 → 프레임에서 끌어낸 것 → 첫 경기**.
 * ⚠ 프레임이 0장이어도 경기가 있으면 그걸 띄워야 한다 — 안 그러면 편집 폼이 없다.
 */
export function resolveSelection<F extends SelectableFrame, M extends SelectableMatch>(
  frames: readonly F[],
  matches: readonly M[],
  picked: Picked = {},
): Resolved<F, M> {
  const frame = picked.frameId ? frames.find((f) => f.id === picked.frameId) ?? null : null;
  const match =
    (picked.matchId ? matches.find((m) => m.match_id === picked.matchId) : null)
    ?? (frame?.match_id ? matches.find((m) => m.match_id === frame.match_id) : null)
    ?? (picked.frameId || picked.matchId ? null : matches[0])
    ?? null;
  // 경기만 정해졌으면 그 경기의 대표 프레임을 같이 띄운다 — 비교할 화면이 비면 검수가 끊긴다.
  return { frame: frame ?? (match ? representativeFrame(frames, match.match_id)
    : !picked.frameId && !picked.matchId ? frames[0] ?? null : null), match };
}

/**
 * 타임라인의 오른쪽 끝(초).
 * ⚠ 방송 길이(API `duration`)는 못 믿는다 — 실제 HLS 보다 길게 보고되는 VOD 가 있다.
 *   그래서 **우리가 아는 시각들**(프레임·경기 범위)의 최대값으로 잡는다.
 */
export function timelineSpan(
  frames: readonly { at_sec: number | null }[],
  ranges: readonly [number, number][] = [],
): number {
  return Math.max(1, ...frames.map((f) => f.at_sec ?? 0), ...ranges.map((r) => r[1]));
}

/**
 * **제보 판정 기준의 단일 출처** — 사실(Facts)을 받아 판정(Verdict)을 낸다. DB 를 모르는 순수 함수다.
 * 설계: docs/SUBMISSION-POLICY-PLAN.md
 *
 *   사실 모으기(db/submission.ts) → decide(여기) → 실행(db/submission.ts enact — 기존 쓰기 길만 부른다)
 *
 * ★ 검증 기준을 바꾸는 일은 이 파일의 규칙 목록(RULES)·설정값(POLICY.config)만 고치는 일이다.
 *   사실 모으기·실행은 기준을 모른다 — 새 기준 때문에 그쪽에 if 가 생기면 뼈대가 틀어진 것이다.
 * ★ 판정은 두 축 — 보임(공개 기록에 들어가 있나) × 믿음(집계에 넣나). "보이지만 아직 안 믿음" = 확인 전.
 *   옛 상태 이름(applied·held·…)은 두 축에서 계산되는 이름표다(stateOf).
 * ★ 사람(운영자)의 결정은 언제나 맨 위 — 기준이 바뀌어 다시 판정해도 뒤집히지 않는다.
 */
import type { HoldReason, SubmissionKind, SubmissionState } from "./submission.ts";

/** 접수 때 대상에서 본 것(경기 고치기). 접수 순간에 고정해 둔다 — 나중에 다시 판정해도 같은 사실로 본다. */
export interface IntakeFacts {
  not_public?: boolean;
  review_completed?: boolean;
  api_observed?: boolean;
  account_identity?: boolean;
  contested?: boolean;
}

export interface Facts {
  kind: SubmissionKind;
  intake: IntakeFacts;
  /** 운영자의 처리 — 확인(verify)·반려(reject). 없으면 null. */
  admin: "verify" | "reject" | null;
}

export type Visibility = "shown" | "hidden";
export type Trust = "pending" | "verified" | "rejected";

export interface Verdict {
  visibility: Visibility;
  trust: Trust;
  /** 보류 이유(보임=hidden·믿음=pending 일 때 화면 문구). */
  hold_reason: HoldReason | null;
  /** 어느 규칙이 정했나 — 제보에 남는다("어떤 기준으로 검증됐나"). */
  rule: string;
}

export interface Rule {
  id: string;
  when: (f: Facts) => boolean;
  then: (f: Facts) => Omit<Verdict, "rule">;
}

const show = (trust: Trust): Omit<Verdict, "rule"> => ({ visibility: "shown", trust, hold_reason: null });
const hold = (hold_reason: HoldReason): Omit<Verdict, "rule"> => ({ visibility: "hidden", trust: "pending", hold_reason });

/** 경기 고치기의 보류 사실 → 보류 이유. 순서가 우선순위다(앞의 것이 먼저 — 1단계 동작 그대로). */
const INTAKE_HOLDS: readonly (keyof IntakeFacts & HoldReason)[] = ["not_public", "review_completed", "api_observed", "account_identity", "contested"];

/**
 * 규칙 목록 — 위에서부터 처음 맞는 것. v1 = 1단계(경기 고치기)·3단계(편성표)의 동작을 그대로 옮긴 것.
 * 2단계 규칙(VOD 판독·신뢰 계정·합의·직접 입력·VOD 단서)은 docs/SUBMISSION-POLICY-PLAN.md §4 순서로 여기에 더한다.
 */
const RULES: readonly Rule[] = [
  { id: "admin_reject", when: (f) => f.admin === "reject", then: () => ({ visibility: "hidden", trust: "rejected", hold_reason: null }) },
  { id: "admin_verify", when: (f) => f.admin === "verify", then: () => show("verified") },
  ...INTAKE_HOLDS.map((r): Rule => ({ id: `hold_${r}`, when: (f) => f.kind === "match_correction" && f.intake[r] === true, then: () => hold(r) })),
  // 편성표 제보는 언제나 운영자가 반영한다(사용자 결정 2026-10-17).
  { id: "schedule_review", when: (f) => f.kind === "schedule_report", then: () => hold("schedule_review") },
  // 경기 고치기 — 바로 반영하고 확인 전(결정 A).
  { id: "apply_pending", when: (f) => f.kind === "match_correction", then: () => show("pending") },
];

export const POLICY = { version: "2026-10-17.1", rules: RULES } as const;

export function decide(f: Facts, rules: readonly Rule[] = POLICY.rules): Verdict {
  for (const r of rules) if (r.when(f)) return { ...r.then(f), rule: r.id };
  throw new Error(`판정 규칙이 없습니다: ${f.kind}`);
}

/**
 * 두 축 → 옛 상태 이름(화면·뷰가 읽는 submission.state). 보였다가 거부되면 되돌림(reverted), 처음부터 숨김이면 반려(rejected).
 * duplicate 는 판정이 아니라 합침이라 여기에 없다.
 */
export function stateOf(v: Pick<Verdict, "visibility" | "trust">, wasShown: boolean): Exclude<SubmissionState, "duplicate"> {
  if (v.trust === "rejected") return wasShown ? "reverted" : "rejected";
  if (v.trust === "verified") return "verified";
  return v.visibility === "shown" ? "applied" : "held";
}

/** 옛 상태 → 지금 보이나(제안이 공개 기록에 들어가 있나). 실행(enact)이 보임의 변화를 이것으로 안다. */
export function shownIn(state: SubmissionState | null): boolean {
  return state === "applied" || state === "verified";
}

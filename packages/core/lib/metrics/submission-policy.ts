/**
 * **제보 판정 기준의 단일 출처** — 사실(Facts)을 받아 판정(Verdict)을 낸다. DB 를 모르는 순수 함수다.
 * 설계: docs/SUBMISSION-POLICY-PLAN.md
 *
 *   사실 모으기(db/submission.ts) → decide(여기) → 실행(db/submission.ts enact — 기존 쓰기 길만 부른다)
 *
 * ★ 검증 기준을 바꾸는 일은 이 파일의 규칙 목록(RULES)·설정값(POLICY.config)만 고치는 일이다. 바꾸면 version 을 올리고
 *   열린 제보를 다시 판정한다(db/submission.ts reconsiderOpenSubmissions).
 *   사실 모으기·실행은 기준을 모른다 — 새 기준 때문에 그쪽에 if 가 생기면 뼈대가 틀어진 것이다.
 * ★ 판정은 두 축 — 보임(공개 기록에 들어가 있나) × 믿음(집계에 넣나). "보이지만 아직 안 믿음" = 확인 전.
 *   옛 상태 이름(applied·held·…)은 두 축에서 계산되는 이름표다(stateOf).
 * ★ 사람(운영자)의 결정은 언제나 맨 위 — 기준이 바뀌어 다시 판정해도 뒤집히지 않는다.
 */
import type { MemberRole } from "./member-role.ts";
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
  /** 보낸 사람의 지금 유효한 역할(member_role). 탈퇴했으면 빈 목록. */
  reporter: { roles: readonly MemberRole[] };
  /** 같은 내용을 낸 서로 다른 회원 — 보낸 사람 + 같은 내용이에요(+1). trusted = 그중 신뢰 제보자 수. */
  agreement: { members: number; trusted: number };
  /**
   * 이 제보가 가리키는 VOD 의 판독(0097 vod_request) — VOD 가 없는 종류는 none.
   *   none 아직 요청 없음 · queued 판독 대기열(요청됨·대기열에 넣음) · found 판독이 그 경기를 찾았다
   *   not_found 판독이 끝났는데 (그 시점에) 경기가 없다 · unavailable 영상을 열 수 없다 · no_vod 판독할 VOD 를 못 찾았다(직접 입력, 링크 없음)
   */
  vod: { state: VodFact };
}

export type VodFact = "none" | "queued" | "found" | "not_found" | "unavailable" | "no_vod";

/**
 * 판정이 함께 내놓는 할 일 — 실행(db/submission.ts syncEffectsInTx)이 옮긴다.
 *   vod_priority 그 VOD 를 판독 대기열 맨 앞으로(열린 동안)
 *   adopt_vod    판독 값이 회원 값과 다른 칸을 판독 값으로 덮는다(§9 "판독 값으로 덮고 검증" — 관측이 수기보다 강하다)
 */
export type Effect = "vod_priority" | "adopt_vod";

/**
 * 설정값 — 규칙의 손잡이. 2026-10-17 사용자 결정: 신뢰 계정·합의 **둘 다 꺼 둔 채** 시작(처음엔 VOD 판독·운영자만 검증).
 *   trustedReporter   true 면 신뢰 제보자가 보낸 경기 고치기는 바로 검증
 *   consensusMembers  N 이면 서로 다른 회원 N명이 같은 값을 낸 경기 고치기는 검증(null = 끔)
 */
export interface PolicyConfig {
  trustedReporter: boolean;
  consensusMembers: number | null;
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
  effects: readonly Effect[];
}

export interface Rule {
  id: string;
  when: (f: Facts, c: PolicyConfig) => boolean;
  then: (f: Facts) => Omit<Verdict, "rule" | "effects"> & { effects?: readonly Effect[] };
}

export interface Policy {
  version: string;
  config: PolicyConfig;
  rules: readonly Rule[];
}

type Then = ReturnType<Rule["then"]>;
const show = (trust: Trust): Then => ({ visibility: "shown", trust, hold_reason: null });
const hold = (hold_reason: HoldReason, effects: readonly Effect[] = []): Then => ({ visibility: "hidden", trust: "pending", hold_reason, effects });

/** 경기 고치기의 보류 사실 → 보류 이유. 순서가 우선순위다(앞의 것이 먼저 — 1단계 동작 그대로). */
const INTAKE_HOLDS: readonly (keyof IntakeFacts & HoldReason)[] = ["not_public", "review_completed", "api_observed", "account_identity", "contested"];

/**
 * 규칙 목록 — 위에서부터 처음 맞는 것. v1 = 1단계(경기 고치기)·3단계(편성표)의 동작 + 2단계의 신뢰 계정·합의(설정으로 꺼 둠).
 * VOD 단서(hint_*, 2단계 ④)·직접 입력(addition_*, ⑤)은 VOD 판독 사실(vod)로 정한다.
 *
 * ★ 신뢰 계정·합의는 **보류 사실 아래**에 둔다 — "바로 반영(확인 전)"이 될 제보를 검증으로 올릴 뿐, 보류(공식 기록·다툼·검수 끝난 판…)를
 *   건너뛰게 하지 않는다. 편성표 제보에도 쓰지 않는다 — 편성표는 운영자가 저장해야 바뀌므로 "검증"만 하면 반영 없이 닫혀 버린다.
 */
const RULES: readonly Rule[] = [
  { id: "admin_reject", when: (f) => f.admin === "reject", then: () => ({ visibility: "hidden", trust: "rejected", hold_reason: null }) },
  { id: "admin_verify", when: (f) => f.admin === "verify", then: () => show("verified") },
  ...INTAKE_HOLDS.map((r): Rule => ({ id: `hold_${r}`, when: (f) => f.kind === "match_correction" && f.intake[r] === true, then: () => hold(r) })),
  // VOD 단서 — 공개하지 않는다. 판독이 경기를 찾으면 확인(경기는 판독 경기로 이미 집계에 있다), 못 찾거나 영상이 없으면 운영자.
  { id: "hint_found", when: (f) => f.kind === "vod_hint" && f.vod.state === "found", then: () => show("verified") },
  { id: "hint_not_found", when: (f) => f.kind === "vod_hint" && f.vod.state === "not_found", then: () => hold("vod_not_found") },
  { id: "hint_unavailable", when: (f) => f.kind === "vod_hint" && f.vod.state === "unavailable", then: () => hold("vod_unavailable") },
  { id: "hint_pending", when: (f) => f.kind === "vod_hint", then: () => hold("vod_pending", ["vod_priority"]) },
  // 빠진 경기 직접 입력 — 바로 공개·검증 전(집계 제외). 판독이 그 경기들을 찾으면 판독 값으로 덮고 검증, 판독할 수 없으면 검증 전 그대로 + 운영자(§9).
  { id: "addition_found", when: (f) => f.kind === "match_addition" && f.vod.state === "found", then: () => ({ ...show("verified"), effects: ["adopt_vod"] }) },
  {
    id: "addition_unverifiable",
    when: (f) => f.kind === "match_addition" && (f.vod.state === "not_found" || f.vod.state === "unavailable" || f.vod.state === "no_vod"),
    then: () => show("pending"),
  },
  { id: "addition_pending", when: (f) => f.kind === "match_addition", then: () => ({ ...show("pending"), effects: ["vod_priority"] }) },
  // 편성표 제보는 언제나 운영자가 반영한다(사용자 결정 2026-10-17).
  { id: "schedule_review", when: (f) => f.kind === "schedule_report", then: () => hold("schedule_review") },
  {
    id: "trusted",
    when: (f, c) => c.trustedReporter && f.kind === "match_correction" && f.reporter.roles.includes("trusted_reporter"),
    then: () => show("verified"),
  },
  {
    id: "consensus",
    when: (f, c) => c.consensusMembers !== null && f.kind === "match_correction" && f.agreement.members >= c.consensusMembers,
    then: () => show("verified"),
  },
  // 경기 고치기 — 바로 반영하고 확인 전(결정 A).
  { id: "apply_pending", when: (f) => f.kind === "match_correction", then: () => show("pending") },
];

export const POLICY: Policy = { version: "2026-10-17.4", config: { trustedReporter: false, consensusMembers: null }, rules: RULES };

export function decide(f: Facts, policy: Policy = POLICY): Verdict {
  for (const r of policy.rules) if (r.when(f, policy.config)) { const t = r.then(f); return { ...t, effects: t.effects ?? [], rule: r.id }; }
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

/** 그 역할이 지금 기준에서 판정에 쓰이나 — 운영 화면이 "권한을 줘도 지금은 효과 없음"을 알린다. */
export function roleInEffect(role: MemberRole, policy: Policy = POLICY): boolean {
  switch (role) {
    case "trusted_reporter": return policy.config.trustedReporter;
  }
}

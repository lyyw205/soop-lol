import type { FcoParticipant } from "../../db/fconline.ts";

/** 서버·브라우저에서 함께 쓰는 FC 온라인 표시 전용 계산. DB 연결을 가져오지 않는다. */
export const FCO_MODE_LABEL: Record<string, string> = {
  "30": "리그 친선", "40": "클래식 1on1", "50": "공식경기", "52": "감독모드",
  "60": "공식 친선", "204": "볼타 친선", "214": "볼타 공식",
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function fcoNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export interface FcoStatLine {
  games: number;
  wins: number;
  draws: number;
  losses: number;
  goals: number;
  shots: number;
  shotsOnTarget: number;
  passTry: number;
  passSuccess: number;
  tackles: number;
  possessionTotal: number;
}

export function addFcoStats(line: FcoStatLine, participant: FcoParticipant): FcoStatLine {
  const info = participant.match_info;
  const shoot = object(info.shoot);
  const pass = object(info.pass);
  const defence = object(info.defence);
  const detail = object(info.matchDetail);
  return {
    games: line.games + 1,
    wins: line.wins + Number(participant.outcome === "win"),
    draws: line.draws + Number(participant.outcome === "draw"),
    losses: line.losses + Number(participant.outcome === "loss"),
    goals: line.goals + (participant.goals ?? 0),
    shots: line.shots + fcoNumber(shoot.shootTotal),
    shotsOnTarget: line.shotsOnTarget + fcoNumber(shoot.effectiveShootTotal),
    passTry: line.passTry + fcoNumber(pass.passTry),
    passSuccess: line.passSuccess + fcoNumber(pass.passSuccess),
    tackles: line.tackles + fcoNumber(defence.tackleSuccess),
    possessionTotal: line.possessionTotal + fcoNumber(detail.possession),
  };
}

export const EMPTY_FCO_STATS: FcoStatLine = {
  games: 0, wins: 0, draws: 0, losses: 0, goals: 0, shots: 0,
  shotsOnTarget: 0, passTry: 0, passSuccess: 0, tackles: 0, possessionTotal: 0,
};

/**
 * goalTime 은 초가 아니다. 상위 비트에 경기 구간이, 하위에 그 구간에서 흐른 초가 들어 있다.
 * 실측: 16777415 → 후반 199초 → 경기 2899초(48분19초), 50332222 → 연장후반 → 6874초.
 */
const GOAL_TIME_BASE = 1 << 24;
const PHASE_OFFSET_SECONDS = [0, 45 * 60, 90 * 60, 105 * 60, 120 * 60];

export const GOAL_PHASE_LABEL = ["전반", "후반", "연장 전반", "연장 후반", "승부차기"];

export interface FcoGoalTime {
  /** 0 전반 · 1 후반 · 2 연장전반 · 3 연장후반 · 4 승부차기 */
  phase: number;
  /** 킥오프부터의 초. 화면 정렬과 타임라인 위치에 쓴다. */
  seconds: number;
  /** "48'" 처럼 분 단위로만 표기한다. 축구 표기 관례다. */
  label: string;
}

export function decodeGoalTime(raw: unknown): FcoGoalTime | null {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  if (value === null || value < 0) return null;
  const phase = Math.min(Math.floor(value / GOAL_TIME_BASE), PHASE_OFFSET_SECONDS.length - 1);
  const seconds = (value % GOAL_TIME_BASE) + PHASE_OFFSET_SECONDS[phase];
  return { phase, seconds, label: `${Math.floor(seconds / 60)}'` };
}

/** 슛 종류. 문서의 12종을 그대로 옮긴다. */
export const FCO_SHOOT_TYPE_LABEL: Record<number, string> = {
  // 1 은 특별한 기술 없는 보통 슈팅이다. "일반" 만 쓰면 "일반 경기" 처럼 읽혀 "일반 슛" 으로 적는다.
  1: "일반 슛", 2: "감아차기", 3: "헤딩", 4: "로빙", 5: "플레어", 6: "낮은 슛",
  7: "발리", 8: "프리킥", 9: "페널티킥", 10: "무회전", 11: "바이시클", 12: "파워샷",
  // 13·14 는 공식 문서(1~12)에 없다. 13 은 2026 여름 업데이트 특성 "레이저 슈터"(리턴 패스·루즈볼을
  // 박스 라인 근처에서 논스톱으로 차는 낮고 빠른 슛)와 데이터가 맞아 떨어진다 — 도움 99%, 평균 약 22m,
  // 박스 안 9%, 헤딩·프리킥·PK 집계에 안 들어감. 넥슨 확인이 아니라 추정이라 이름에 그렇게 적는다.
  // 14 는 근거를 못 찾아 이름을 짓지 않는다(화면에선 "기타 슛").
  13: "레이저 슈터(추정)",
};

/**
 * 볼타는 등급표가 따로다. division-volta.json 의 13개 번호가 전부 일반 등급과 겹치므로
 * matchType 을 보지 않고 한 표만 쓰면 1100(볼타 최상위 월드 스타)이 챌린저1로 잘못 나온다.
 */
export function isVoltaMode(modeKey: string | null | undefined): boolean {
  const n = Number(modeKey);
  return Number.isFinite(n) && n >= 200;
}

/** matchEndType: 0 정상종료 · 1 몰수승 · 2 몰수패. 저장된 경기의 19%가 몰수라 숨기지 않는다. */
export function fcoMatchEndLabel(raw: unknown): string | null {
  const value = fcoNumber(raw);
  return value === 1 ? "몰수승" : value === 2 ? "몰수패" : null;
}

/** spid 앞 3자리가 시즌, 나머지 6자리가 선수 번호다. 이미지 주소는 pid 로 만든다. */
export function fcoPlayerPid(spId: unknown): number {
  return fcoNumber(spId) % 1_000_000;
}

/* ── 경기 흐름 ─────────────────────────────────────────────────────── */

export interface FcoTimedShot {
  side: 0 | 1;
  /** 킥오프부터의 초 (decodeGoalTime 결과) */
  seconds: number;
  phase: number;
  /** 1 유효 슛 · 2 빗나감 · 3 골 */
  result: number;
}

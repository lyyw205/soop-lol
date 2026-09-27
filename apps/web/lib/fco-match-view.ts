import {
  decodeGoalTime, fcoNumber, fcoPlayerPid, FCO_SHOOT_TYPE_LABEL, isVoltaMode,
} from "@soop-lol/core/lib/games/fconline/view";
import type { FcoParticipant } from "@soop-lol/core/lib/db/fconline";

/**
 * match_info(jsonb) 를 화면이 쓰는 모양으로 한 번에 펴는 곳.
 * 클라이언트 컴포넌트로 넘어가므로 전부 직렬화 가능한 값만 담는다.
 */

interface Meta {
  names: Map<number, string>;
  positions: Map<number, string>;
  divisions: Map<number, string>;
  voltaDivisions: Map<number, string>;
  seasons: Map<number, { name: string; icon: string }>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === "object") as Record<string, unknown>[] : [];
}

/** 액션샷은 시즌마다 달라 spid 로 부른다. 오래된 시즌은 파일이 없으니 얼굴로 떨어뜨려야 한다. */
export function fcoActionUrl(spId: unknown): string | null {
  const id = fcoNumber(spId);
  return id ? `https://fo4.dn.nexoncdn.co.kr/live/externalAssets/common/playersAction/p${id}.png` : null;
}

/** 선수 얼굴은 시즌과 무관하게 pid 한 장뿐이다. 액션샷만 spid 를 쓴다. */
export function fcoFaceUrl(spId: unknown): string | null {
  const pid = fcoPlayerPid(spId);
  return pid ? `https://fo4.dn.nexoncdn.co.kr/live/externalAssets/common/players/p${pid}.png` : null;
}

export interface FcoShotView {
  index: number;
  seconds: number;
  time: string | null;
  phase: number;
  x: number;
  y: number;
  type: string;
  result: number;
  playerName: string;
  playerFace: string | null;
  /** 그 시즌 카드의 액션샷. 오래된 시즌은 없어서 얼굴로 떨어뜨려야 한다. */
  playerAction: string | null;
  seasonName: string | null;
  seasonIcon: string | null;
  assistName: string | null;
  /**
   * 이 슛을 만든 패스가 출발한 위치(슛 좌표와 같은 공격 방향 기준 0~1).
   * 도움이 없으면 API 가 0.5/0.5(구장 정중앙)를 채워 보내므로 null 로 바꾼다 — 그대로 그리면 가짜 패스가 된다.
   */
  assistFrom: { x: number; y: number } | null;
  hitPost: boolean;
  inPenalty: boolean;
}

export interface FcoSquadPlayerView {
  key: string;
  name: string;
  face: string | null;
  action: string | null;
  /** 이 카드의 시즌(spid 앞 3자리). 같은 선수도 시즌마다 다른 카드다. */
  seasonName: string | null;
  seasonIcon: string | null;
  position: string;
  positionId: number;
  grade: number;
  rating: number | null;
  goal: number;
  assist: number;
  shoot: number;
  passSuccess: number;
  passTry: number;
  dribbleSuccess: number;
  tackle: number;
  block: number;
  intercept: number;
  defending: number;
  aerialSuccess: number;
  possession: number;
  yellowCards: number;
  redCards: number;
}

export interface FcoSideView {
  ouid: string;
  name: string;
  slug: string | null;
  image: string | null;
  channelId: string | null;
  outcome: FcoParticipant["outcome"];
  score: number | null;
  divisionName: string | null;
  rating: number | null;
  controller: string | null;
  forfeit: string | null;
  detail: Record<string, number>;
  shoot: Record<string, number>;
  pass: Record<string, number>;
  defence: Record<string, number>;
  shots: FcoShotView[];
  squad: FcoSquadPlayerView[];
}

function averageOf(values: (number | null)[]): number | null {
  const played = values.filter((v): v is number => v != null);
  return played.length ? played.reduce((a, b) => a + b, 0) / played.length : null;
}

const CONTROLLER_LABEL: Record<string, string> = { keyboard: "키보드", gamepad: "패드", pad: "패드" };

function numbers(source: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function fcoSideView(
  p: FcoParticipant, meta: Meta, modeKey: string | null,
  person?: { image: string | null; channel_id: string | null } | null,
): FcoSideView {
  const info = p.match_info;
  const detail = object(info.matchDetail);
  const shoot = object(info.shoot);
  // spid 앞 3자리가 시즌이다. 같은 선수도 시즌마다 다른 카드라 시즌 아이콘을 같이 보여준다.
  const seasonOf = (spId: unknown) => meta.seasons.get(Math.floor(fcoNumber(spId) / 1_000_000));
  const nameOf = (spId: unknown) => meta.names.get(fcoNumber(spId)) ?? `선수 ${fcoNumber(spId)}`;

  // 볼타는 등급표가 따로다. 한 표만 쓰면 1100 이 챌린저1 로 잘못 나온다.
  const table = isVoltaMode(modeKey) ? meta.voltaDivisions : meta.divisions;

  const shots = array(info.shootDetail).map((s, index): FcoShotView => {
    const decoded = decodeGoalTime(s.goalTime);
    return {
      index,
      seconds: decoded?.seconds ?? 0,
      time: decoded?.label ?? null,
      phase: decoded?.phase ?? 0,
      x: fcoNumber(s.x),
      y: fcoNumber(s.y),
      // 문서엔 1~12 만 있는데 실제로는 13·14 도 온다(전체 슛의 약 7%). 뜻을 몰라 이름을 짓지 않는다.
      type: FCO_SHOOT_TYPE_LABEL[fcoNumber(s.type)] ?? "기타 슛",
      result: fcoNumber(s.result),
      playerName: nameOf(s.spId),
      playerFace: fcoFaceUrl(s.spId),
      playerAction: fcoActionUrl(s.spId),
      seasonName: seasonOf(s.spId)?.name ?? null,
      seasonIcon: seasonOf(s.spId)?.icon ?? null,
      // 어시스트가 없으면 -1 이 온다. 그대로 이름 조회하면 "선수 -1" 이 된다.
      assistName: s.assist === true && fcoNumber(s.assistSpId) > 0 ? nameOf(s.assistSpId) : null,
      assistFrom: s.assist === true ? { x: fcoNumber(s.assistX), y: fcoNumber(s.assistY) } : null,
      hitPost: s.hitPost === true,
      inPenalty: s.inPenalty === true,
    };
  }).sort((a, b) => a.seconds - b.seconds);

  const squad = array(info.player).map((player, i): FcoSquadPlayerView => {
    const status = object(player.status);
    const positionId = fcoNumber(player.spPosition);
    return {
      key: `${fcoNumber(player.spId)}-${i}`,
      name: nameOf(player.spId),
      face: fcoFaceUrl(player.spId),
      action: fcoActionUrl(player.spId),
      seasonName: seasonOf(player.spId)?.name ?? null,
      seasonIcon: seasonOf(player.spId)?.icon ?? null,
      position: meta.positions.get(positionId) ?? `${positionId}`,
      positionId,
      grade: fcoNumber(player.spGrade),
      // 평점 0 은 못한 게 아니라 끝까지 안 나온 교체 선수다. 낮은 평점으로 칠하면 거짓말이 된다.
      rating: typeof status.spRating === "number" && status.spRating > 0 ? status.spRating : null,
      goal: fcoNumber(status.goal),
      assist: fcoNumber(status.assist),
      shoot: fcoNumber(status.shoot),
      passSuccess: fcoNumber(status.passSuccess),
      passTry: fcoNumber(status.passTry),
      dribbleSuccess: fcoNumber(status.dribbleSuccess),
      tackle: fcoNumber(status.tackle),
      block: fcoNumber(status.block),
      intercept: fcoNumber(status.intercept),
      defending: fcoNumber(status.defending),
      aerialSuccess: fcoNumber(status.aerialSuccess),
      // 넥슨 응답의 철자가 ballPossesion 이다(Possession 아님). 고쳐 읽으면 값이 사라진다.
      possession: fcoNumber(status.ballPossesionSuccess),
      yellowCards: fcoNumber(status.yellowCards),
      redCards: fcoNumber(status.redCards),
    };
  });

  const controller = typeof detail.controller === "string" ? detail.controller : null;
  const endType = fcoNumber(detail.matchEndType);

  return {
    ouid: p.ouid,
    name: p.streamer_name ?? p.nickname,
    slug: p.streamer_slug,
    image: person?.image ?? null,
    channelId: person?.channel_id ?? null,
    outcome: p.outcome,
    // 화면에 보이는 골 수는 goalTotalDisplay 다. goalTotal 은 자책골을 빼고 센다.
    score: p.score_display ?? p.goals ?? (shoot.goalTotalDisplay == null ? null : fcoNumber(shoot.goalTotalDisplay)),
    divisionName: p.division == null ? null : table.get(p.division) ?? `등급 ${p.division}`,
    // API 의 averageRating 은 안 나온 교체 선수의 0점까지 18명으로 나눈 값이다(실측으로 일치 확인).
    // 출전 선수 평균보다 2점 넘게 낮게 나오므로 쓰지 않고 직접 계산한다.
    rating: averageOf(squad.map((player) => player.rating)),
    controller: controller ? CONTROLLER_LABEL[controller] ?? controller : null,
    forfeit: endType === 1 ? "몰수승" : endType === 2 ? "몰수패" : null,
    detail: numbers(detail),
    shoot: numbers(shoot),
    pass: numbers(object(info.pass)),
    defence: numbers(object(info.defence)),
    shots,
    squad,
  };
}

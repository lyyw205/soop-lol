/** NEXON FC온라인 Open API에서 Phase 0/1에 실제로 쓰는 응답 면. */

export interface FcoOuidResponse {
  ouid: string;
}

export interface FcoUserBasic {
  ouid: string;
  nickname: string;
  level: number;
}

export type FcoMatchResult = "승" | "무" | "패";

export interface FcoMatchPlayer {
  /** 공급자 식별자. 공식 문서가 변경 가능성을 경고하므로 영구 불변키로 가정하지 않는다. */
  ouid: string;
  nickname: string;
  /** 2026-05-21부터 매치 당시 등급 식별자가 제공된다. */
  division?: number | null;
  matchDetail: {
    seasonId?: number | null;
    matchResult: FcoMatchResult;
    /** 0 정상종료, 1 몰수승, 2 몰수패. */
    matchEndType?: number | null;
    [key: string]: unknown;
  };
  shoot?: {
    goalTotal?: number | null;
    goalTotalDisplay?: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface FcoMatchDetail {
  matchId: string;
  /** 공식 스펙상 UTC0 문자열. Date로 바꾸는 일은 변환기 한 곳에서 한다. */
  matchDate: string;
  matchType: number;
  matchInfo: FcoMatchPlayer[];
  [key: string]: unknown;
}

export interface NexonErrorBody {
  error?: {
    name?: string;
    message?: string;
  };
}

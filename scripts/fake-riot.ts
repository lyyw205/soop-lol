/**
 * 가짜 Riot API. `RiotClient` 의 `fetchImpl` 자리에 그대로 꽂는다.
 *
 * ★ 클라이언트를 모킹하지 않는다 — **HTTP 경계에서만** 가짜다.
 *   그래서 라우팅(regional/platform), 레이트리밋 헤더 해석, 404 처리,
 *   쿼리 파라미터(startTime 이 초 단위인지) 까지 진짜 코드가 그대로 검증된다.
 */

export interface FakeParticipant {
  puuid: string;
  teamId: number;
  position: string;
  win: boolean;
  championId: number;
}

export interface FakeMatch {
  matchId: string;
  gameCreation: number; // ms
  queueId: number;
  roster: FakeParticipant[];
  /** true 면 상세 조회가 404 를 낸다 (2년 지나 삭제된 경기). */
  dead?: boolean;
  /** 내전 픽스처용. 있으면 info.tournamentCode 로 들어간다. */
  tournamentCode?: string;
  /** 기본 MATCHED_GAME. 내전은 CUSTOM_GAME. */
  gameType?: string;
  /** 채움 참가자의 puuid 접두사(기본 'filler')·표시 이름 접두사. 내전 테스트가 구분에 쓴다. */
  fillerPrefix?: string;
  fillerNamePrefix?: string;
}

export interface FakeRiotOptions {
  matches: FakeMatch[];
  /** puuid → 그 계정의 매치 ID 목록 (최신순). */
  history: Record<string, string[]>;
  /** puuid → league-v4 응답. 없으면 빈 배열(언랭). */
  league?: Record<string, unknown[]>;
  /** puuid → spectator 응답. 없으면 404 (게임 중 아님). */
  activeGames?: Record<string, unknown>;
  riotIds?: Record<string, { gameName: string; tagLine: string }>;
}

export interface FakeRiot {
  fetchImpl: typeof fetch;
  /** 엔드포인트별 호출 수. "낭비 없이 부르는가"를 숫자로 확인한다. */
  calls: Record<string, number>;
}

const HEADERS = {
  "content-type": "application/json",
  // 리밋을 넉넉히 알려준다. 첫 응답 뒤 RateLimiter 가 이 값으로 재구성되므로
  // 검증이 초기 추정치(20 req/s)에 묶여 느려지지 않는다.
  "x-app-rate-limit": "1000:1",
  "x-app-rate-limit-count": "1:1",
  "x-method-rate-limit": "1000:1",
  "x-method-rate-limit-count": "1:1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS });

const notFound = () => json({ status: { message: "Data not found", status_code: 404 } }, 404);

/** 10인 정원을 채운다. 이름 없는 참가자는 그냥 일반인이다. */
function fullRoster(m: FakeMatch): (FakeParticipant & { fillerIndex?: number })[] {
  const out: (FakeParticipant & { fillerIndex?: number })[] = [...m.roster];
  const positions = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
  const prefix = m.fillerPrefix ?? "filler";
  let filler = 0;
  while (out.length < 10) {
    const teamId = out.filter((p) => p.teamId === 100).length < 5 ? 100 : 200;
    const used = new Set(out.filter((p) => p.teamId === teamId).map((p) => p.position));
    const position = positions.find((p) => !used.has(p)) ?? "MIDDLE";
    out.push({
      puuid: `${prefix}${String(filler).padStart(2, "0")}${m.matchId}`.padEnd(78, "x"),
      teamId,
      position,
      win: teamId === 100,
      championId: 100 + filler + 1,
      fillerIndex: filler,
    });
    filler++;
  }
  return out;
}

/**
 * 픽스처 빌더. verify-ingest 가 내전 검증에서도 이걸 쓴다 —
 * 손으로 만든 MatchDto 사본이 생기면 타입이 바뀌어도 컴파일러에 안 걸린다.
 */
export function buildMatchDto(m: FakeMatch) {
  return matchDto(m);
}

function matchDto(m: FakeMatch) {
  const roster = fullRoster(m);
  const duration = 1800;
  return {
    metadata: { dataVersion: "2", matchId: m.matchId, participants: roster.map((p) => p.puuid) },
    info: {
      gameId: Number(m.matchId.split("_")[1]),
      platformId: "KR",
      gameCreation: m.gameCreation,
      gameStartTimestamp: m.gameCreation + 30_000,
      gameEndTimestamp: m.gameCreation + 30_000 + duration * 1000,
      gameDuration: duration,
      gameMode: m.queueId === 450 ? "ARAM" : "CLASSIC",
      gameType: m.gameType ?? "MATCHED_GAME",
      ...(m.tournamentCode ? { tournamentCode: m.tournamentCode } : {}),
      gameVersion: "16.3.512.1234",
      mapId: m.queueId === 450 ? 12 : 11,
      queueId: m.queueId,
      teams: [
        { teamId: 100, win: roster.find((p) => p.teamId === 100)?.win ?? true },
        { teamId: 200, win: roster.find((p) => p.teamId === 200)?.win ?? false },
      ],
      participants: roster.map((p, i) => ({
        puuid: p.puuid,
        ...(m.fillerNamePrefix != null && p.fillerIndex != null
          ? { riotIdGameName: `${m.fillerNamePrefix}${p.fillerIndex}`, riotIdTagline: "KR1" }
          : {}),
        participantId: i + 1,
        teamId: p.teamId,
        win: p.win,
        // 칼바람엔 포지션이 없다. 실제 응답도 여기서 빈 문자열이 온다.
        teamPosition: m.queueId === 450 ? "" : p.position,
        individualPosition: m.queueId === 450 ? "Invalid" : p.position,
        lane: p.position,
        role: "SOLO",
        championId: p.championId,
        championName: `Champ${p.championId}`,
        champLevel: 16,
        kills: 5, deaths: 3, assists: 8,
        goldEarned: 12000,
        totalMinionsKilled: 180,
        neutralMinionsKilled: 20,
        totalDamageDealtToChampions: 24000,
        totalDamageTaken: 21000,
        visionScore: 30,
        wardsPlaced: 12, wardsKilled: 4, detectorWardsPlaced: 3,
        turretKills: 1,
        firstBloodKill: i === 0,
        gameEndedInSurrender: false,
        summoner1Id: 4, summoner2Id: 12,
        item0: 3153, item1: 3006, item2: 0, item3: 0, item4: 0, item5: 0, item6: 3340,
        perks: { statPerks: { defense: 5002 } },
        challenges: { soloKills: 2, laneMinionsFirst10Minutes: 78, killParticipation: 0.55 },
      })),
    },
  };
}

export function createFakeRiot(opts: FakeRiotOptions): FakeRiot {
  const byId = new Map(opts.matches.map((m) => [m.matchId, m]));
  const calls: Record<string, number> = {};
  const bump = (k: string) => { calls[k] = (calls[k] ?? 0) + 1; };

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const path = url.pathname;

    let match: RegExpExecArray | null;

    if ((match = /^\/riot\/account\/v1\/accounts\/by-puuid\/(.+)$/.exec(path))) {
      bump("account");
      const id = opts.riotIds?.[match[1]];
      return id ? json({ puuid: match[1], ...id }) : notFound();
    }

    if ((match = /^\/lol\/summoner\/v4\/summoners\/by-puuid\/(.+)$/.exec(path))) {
      bump("summoner");
      return json({
        puuid: match[1],
        id: `sid-${match[1].slice(0, 6)}`,
        profileIconId: 4568,
        summonerLevel: 512,
        revisionDate: Date.now(),
      });
    }

    if ((match = /^\/lol\/league\/v4\/entries\/by-puuid\/(.+)$/.exec(path))) {
      bump("league");
      return json(opts.league?.[match[1]] ?? []);
    }

    if ((match = /^\/lol\/spectator\/v5\/active-games\/by-summoner\/(.+)$/.exec(path))) {
      bump("spectator");
      const game = opts.activeGames?.[match[1]];
      return game ? json(game) : notFound();
    }

    if ((match = /^\/lol\/match\/v5\/matches\/by-puuid\/(.+)\/ids$/.exec(path))) {
      bump("matchIds");
      const puuid = match[1];
      const startTime = Number(url.searchParams.get("startTime") ?? 0);
      const endTime = Number(url.searchParams.get("endTime") ?? Number.MAX_SAFE_INTEGER);
      const count = Number(url.searchParams.get("count") ?? 20);
      const ids = (opts.history[puuid] ?? []).filter((id) => {
        const m = byId.get(id);
        if (!m) return false;
        const sec = Math.floor(m.gameCreation / 1000); // ★ 초 단위. ms 로 오면 여기서 다 걸러진다.
        return sec >= startTime && sec <= endTime;
      });
      return json(ids.slice(0, count));
    }

    if ((match = /^\/lol\/match\/v5\/matches\/([A-Z0-9_]+)$/.exec(path))) {
      bump("match");
      const m = byId.get(match[1]);
      if (!m || m.dead) return notFound();
      return json(matchDto(m));
    }

    throw new Error(`가짜 Riot 이 모르는 경로: ${path}`);
  };

  return { fetchImpl, calls };
}

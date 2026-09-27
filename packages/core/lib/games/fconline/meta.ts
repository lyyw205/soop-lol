interface PlayerMeta { id: number; name: string }
interface PositionMeta { spposition: number; desc: string }
interface DivisionMeta { divisionId: number; divisionName: string }
interface SeasonMeta { seasonId: number; className: string; seasonImg: string }

const ROOT = "https://open.api.nexon.com/static/fconline/meta";

type Metadata = {
  names: Map<number, string>;
  positions: Map<number, string>;
  divisions: Map<number, string>;
  voltaDivisions: Map<number, string>;
  /** spid 앞 3자리 → 시즌 이름·아이콘(30×24). 선수 카드의 시즌 표시에 쓴다. */
  seasons: Map<number, { name: string; icon: string }>;
};

// spid.json은 2MB를 넘어 Next 데이터 캐시에 저장되지 않는다. 프로세스 안에서만
// 하루 동안 재사용하고, 조회 실패 때는 짧게 다시 시도한다.
let cached: { expiresAt: number; value: Promise<Metadata> } | null = null;

function list<T>(path: string): Promise<T[]> {
  return fetch(`${ROOT}/${path}`, { cache: "no-store" })
    .then((r) => r.ok ? r.json() as Promise<T[]> : [])
    .catch(() => [] as T[]);
}

export async function fcoMetadata(): Promise<Metadata> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = Promise.all([
    list<PlayerMeta>("spid.json"),
    list<PositionMeta>("spposition.json"),
    // 등급표는 두 벌이고 번호가 통째로 겹친다. 볼타 13개 ID가 전부 일반 등급과
    // 충돌하므로 matchType 을 보고 고른 쪽만 써야 한다.
    list<DivisionMeta>("division.json"),
    list<DivisionMeta>("division-volta.json"),
    list<SeasonMeta>("seasonid.json"),
  ]).then(([players, positions, divisions, voltaDivisions, seasons]) => {
    if (!players.length) cached = { expiresAt: Date.now() + 5 * 60_000, value };
    return {
      names: new Map(players.map((p) => [p.id, p.name])),
      positions: new Map(positions.map((p) => [p.spposition, p.desc])),
      divisions: new Map(divisions.map((d) => [d.divisionId, d.divisionName])),
      voltaDivisions: new Map(voltaDivisions.map((d) => [d.divisionId, d.divisionName])),
      // className 은 "UC (Untouchable Champions)" 꼴이다. 괄호 앞 약칭만 쓴다.
      seasons: new Map(seasons.map((s) => [s.seasonId, { name: s.className.replace(/\s*\(.*\)\s*$/, ""), icon: s.seasonImg }])),
    };
  });
  cached = { expiresAt: Date.now() + 24 * 60 * 60_000, value };
  return value;
}

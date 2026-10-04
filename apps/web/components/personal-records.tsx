import { Fragment, type CSSProperties, type ReactNode } from "react";
import { RecordOverviewCard, RecordTimeline, RecordTimelineRow, RecordTimelineYear } from "../../../packages/ui/record-structure";
import type { PublicRosterEntry } from "@soop-lol/core/lib/contract";
import { MatchDetails } from "../../../packages/ui/match-details";
import { LinkedRecordFilters } from "../../../packages/ui/record-filters";
import { RecordPeriodFilters } from "./record-period-filters";
import type { RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import { CATEGORY_LABEL, RIFT_MATCH_CATEGORIES, expandCategory, type MatchCategoryFilter } from "@soop-lol/core/lib/metrics/category";
import { rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import { isStandaloneSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { kstDateString } from "@soop-lol/core/lib/time";
import { formatBadge, isRepeatedDate, matchOutcome, OUTCOME_LABEL } from "../../../packages/ui/match-row-model";
import type { PersonalCategoryRecord, PersonalMatch } from "@soop-lol/core/lib/db/personal";
import type { HrefFor } from "./profile";

/**
 * 개인 기록의 상단 필터 한 줄 — **분류 · 기간 하나로 모았다.**
 *
 * ★ 왜 합쳤나
 *   기간 필터를 탭마다(매치 히스토리·상대 전적·챔피언) 따로 뒀더니, 여기 연도 선택과
 *   서로를 덮어썼다. `?year=` 와 `?period=` 는 배타적이라 한쪽을 누르면 다른 쪽이 조용히
 *   풀리는데, 두 줄에 떨어져 있으면 그게 화면에서 안 보인다. 한 줄에 두면 보인다.
 */
export function PersonalRecordFilters({ category, year, period, hrefFor }: {
  category: MatchCategoryFilter; year?: number; period: RecordPeriod; hrefFor: HrefFor;
}) {
  return <LinkedRecordFilters category={category} year={year ? String(year) : "all"}
    categories={RIFT_MATCH_CATEGORIES.map((c)=>({value:c.key,label:c.label,href:hrefFor({category:c.key,page:null})}))}
    years={[]}
    trailing={<RecordPeriodFilters href={hrefFor({})} period={period} />} />;
}

/**
 * @param art 카드 배경으로 쓸 챔피언의 영문 ID(`Pantheon`). 없으면 기본 그림을 쓴다.
 *   ⚠ 파일이 없으면 `background-image` 의 **뒤쪽 레이어**가 그대로 보인다 — CSS 가
 *     기본 그림을 아래에 깔아 두므로 404 여도 카드가 비지 않는다.
 */
export function PersonalRecordSummary({ records, category, art, portrait, identity, details }: {
  records: PersonalCategoryRecord[]; category: MatchCategoryFilter; art?: string;
  portrait: ReactNode; identity: ReactNode; details: ReactNode;
}) {
  const categories = expandCategory(category);
  const rows = records.filter((r) => !categories || categories.includes(r.category));
  const total = rows.reduce((sum,r) => ({ matches:sum.matches+r.matches, wins:sum.wins+r.wins, draws:sum.draws+r.draws, losses:sum.losses+r.losses, sets:sum.sets+r.sets, set_wins:sum.set_wins+r.set_wins }),{matches:0,wins:0,draws:0,losses:0,sets:0,set_wins:0});
  const rate = rawWinRate(total);
  return <>
    <RecordOverviewCard className="personal-profile-card" label="개인 프로필 및 전적 요약"
      dataArt={art ? "champion" : "Thresh"}
      style={art ? { "--profile-art": `url('/images/champion-splash/${art}.jpg')` } as CSSProperties : undefined}>
    <div className="personal-profile-portrait">{portrait}</div>
    <header className="personal-profile-identity">{identity}</header>
    <div className="personal-stat-grid">
      <div><small>경기</small><strong>{total.matches.toLocaleString()}</strong><span>{total.sets.toLocaleString()}세트</span></div>
      <div><small>승 · 무 · 패</small><strong className="personal-wdl">{total.wins}<i> / </i>{total.draws}<i> / </i>{total.losses}</strong><span>세트 {total.set_wins}승 {total.sets-total.set_wins}패</span></div>
      {/* 표본이 작다는 말은 뺐다 — 바로 왼쪽 칸에 경기 수와 승·무·패가 그대로 있다. */}
      <div><small>경기 승률</small><strong>{rate===null?'—':`${(rate*100).toFixed(1)}%`}</strong><span>무승부 제외</span></div>
    </div>
    {details}
    </RecordOverviewCard>
    {!total.matches && <p className="personal-profile-empty">선택한 조건에 맞는 경기가 없습니다.</p>}
  </>;
}

/** A history row is one series, even when several opposing streamers participated. */
export function PersonalMatchHistory({ matches, rosters, streamerId, streamerName }: {
  matches: PersonalMatch[]; rosters: PublicRosterEntry[]; streamerId: string; streamerName: string;
}) {
  if (!matches.length) return <p className="personal-history-empty">선택한 조건에 해당하는 매치가 없습니다.</p>;
  const byMatch = new Map<string, PublicRosterEntry[]>();
  for (const player of rosters) {
    const rows = byMatch.get(player.match_id) ?? [];
    rows.push(player);
    byMatch.set(player.match_id, rows);
  }
  let previousYear = "";
  let previousDate = "";
  return <RecordTimeline>
    {matches.map((m) => {
      const result = matchOutcome(m.set_wins, m.sets);
      const resultLabel = OUTCOME_LABEL[result];
      const date = kstDateString(m.played_at).replaceAll("-", ".");
      const matchYear = date.slice(0, 4);
      const showYear = previousYear !== matchYear;
      previousYear = matchYear;
      // 같은 날이 이어지면 날짜는 맨 위 한 번만. 판정은 match-row-model 이 단일 출처다.
      const repeatedDate = isRepeatedDate(date, previousDate, showYear);
      previousDate = date;
      const opponents = new Map<string, PublicRosterEntry>();
      const ownTeams = new Set<string>();
      const otherTeams = new Set<string>();
      // 맞라인 상대의 이름 → 그 상대와 선 세트 수. 시리즈 안에서 포지션이 바뀌면 여럿이 된다.
      const laneRivals = new Map<string, number>();
      for (const matchId of m.match_ids) {
        const players = byMatch.get(matchId) ?? [];
        const me = players.find((p) => p.streamer_id === streamerId);
        if (!me) continue;
        for (const player of players) {
          const sameTeam = player.team_id === me.team_id;
          // ⚠ 사람을 못 붙인 자리도 상대 명단에 넣는다(0022) — 빼면 "상대 4명" 이 된다.
          //   키는 사람이 있으면 사람으로, 없으면 화면에서 읽은 이름으로.
          if (!sameTeam) opponents.set(player.streamer_id ?? `?${player.observed_name}`, player);
          if (player.team_name) (sameTeam ? ownTeams : otherTeams).add(player.team_name);
          // ★ 맞라인 = 다른 팀 + **같은 포지션**. core 의 isLaneMatchup() 과 같은 규칙이고,
          //   포지션이 비어 있으면(판독 실패) 아무것도 세지 않는다 — 원칙 10.
          if (!sameTeam && me.team_position && player.team_position === me.team_position) {
            const name = player.display_name ?? player.observed_name;
            if (name) laneRivals.set(name, (laneRivals.get(name) ?? 0) + 1);
          }
        }
      }
      const opponentNames = [...opponents.values()]
        .map((p) => p.display_name ?? p.observed_name)
        .filter((n): n is string => n != null);
      const myLabel = ownTeams.size === 1 ? [...ownTeams][0] : `${streamerName} 팀`;
      /**
       * ★ 왼쪽이 `{나} 팀` 이므로 오른쪽도 **`{맞라인 상대} 팀`** 으로 맞춘다.
       *   예전엔 오른쪽만 상대 5명을 나열해서(`클리드1 · 스맵임 외 3명`) 팀 대 개인처럼
       *   읽혔다. 같은 축으로 읽히는 편이 "누가 누구를 이겼나" 에 가깝다.
       *
       *   ⚠ 시리즈 안에서 포지션이 바뀌면 맞라인 상대가 여럿이다(실측: 단판에서 스왑이 있었다).
       *     그때는 한 명으로 단정하지 않고 예전처럼 명단으로 돌아간다.
       *   ⚠ event_team 으로 확정된 팀 이름이 있으면 그게 언제나 우선이다.
       */
      const [soleRival] = laneRivals.size === 1 ? [...laneRivals.keys()] : [];
      const opponentLabel = otherTeams.size === 1 ? [...otherTeams][0]
        : soleRival ? `${soleRival} 팀`
        : opponentNames.length ? `${opponentNames.slice(0, 2).join(" · ")}${opponentNames.length > 2 ? ` 외 ${opponentNames.length - 2}명` : ""}` : "상대 팀";
      return <Fragment key={`${m.category}:${m.series_key}`}>
        {showYear && <RecordTimelineYear year={matchYear} />}
        <RecordTimelineRow result={result} dateTime={kstDateString(m.played_at)} title={date}
          date={repeatedDate ? <span className="sr-only">{date}</span>
            : <><span className="personal-match-date-year">{date.slice(0, 5)}</span>{date.slice(5)}</>}>
            <details className="personal-match-detail">
              <summary className="arena-match-toggle personal-match-toggle personal-match-summary">
                {/* ★ 말줄임(…)은 **안쪽** 요소가 맡는다. 바깥(=flex 아이템)에 overflow:hidden 을
                    걸면 그 아이템은 글자 밑선 대신 '박스 아래 모서리' 를 베이스라인으로 내놓아
                    베이스라인 정렬이 통째로 깨진다. 그래서 자르는 일만 한 겹 안으로 내린다. */}
                <span className="record-match-event" title={m.event_name ?? CATEGORY_LABEL[m.category]}><span className="record-match-clip">{m.event_name ?? CATEGORY_LABEL[m.category]}</span></span>
                <span className="personal-match-teams"><span title={myLabel}><span className="record-match-clip">{myLabel}</span></span><strong>{m.set_wins}<i>:</i>{m.sets - m.set_wins}</strong><span title={opponentLabel}><span className="record-match-clip">{opponentLabel}</span></span></span>
                {/* 순서는 세 화면 공통 — 스코어 → 형식 → 승패. 승패가 늘 끝에 와야
                    줄을 훑을 때 눈이 같은 자리에서 결과를 찾는다. */}
                <small>{formatBadge(m.best_of, m.sets, m.sets === 1 && isStandaloneSet(m.match_ids[0], m.series_key))}</small>
                <span className="personal-match-result">{resultLabel}</span>
                <span className="personal-match-expand" aria-hidden="true" />
              </summary>
              <MatchDetails sets={m.match_ids.map((matchId,index)=>({matchId,label:setLabel({standalone:isStandaloneSet(matchId,m.series_key),best_of:m.best_of,set_order_known:m.set_order_known,series_game_no:m.set_nos[index]}),players:byMatch.get(matchId) ?? []}))}
                streamerId={streamerId} />
            </details>
        </RecordTimelineRow>
      </Fragment>;
    })}
  </RecordTimeline>;
}

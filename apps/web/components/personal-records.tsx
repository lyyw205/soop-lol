import { isLaneMatchup } from "@soop-lol/core/lib/contract/client";
import { Fragment, type CSSProperties, type ReactNode } from "react";
import { RecordOverviewCard, RecordTimeline, RecordTimelineRow, RecordTimelineYear } from "../../../packages/ui/record-structure";
import type { PublicRosterEntry } from "@soop-lol/core/lib/contract";
import { MatchDetails } from "../../../packages/ui/match-details";
import { LOL_FORMAT_CHOICES, LinkedRecordFilters, MapTabs } from "../../../packages/ui/record-filters";
import { RecordPair } from "../../../packages/ui/record-pair";
import { RecordPeriodFilters } from "./record-period-filters";
import type { RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import type { FormatFilter, MapTab } from "@soop-lol/core/lib/metrics/record-scope";
import { formatLabel } from "@soop-lol/core/lib/metrics/format";
import type { Tally } from "@soop-lol/core/lib/metrics/tally";
import { headToHead, rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import { isStandaloneSet, setLabel } from "@soop-lol/core/lib/metrics/set-label";
import { kstDateString } from "@soop-lol/core/lib/time";
import { formatBadge, isRepeatedDate, OUTCOME_LABEL } from "../../../packages/ui/match-row-model";
import type { PersonalMatch } from "@soop-lol/core/lib/db/personal";
import type { HrefFor } from "./profile";

/**
 * 개인 기록의 상단 필터 한 줄 — **맵 탭 · 진행 방식 · 기간 하나로 모았다.**
 *
 * ★ 왜 합쳤나
 *   기간 필터를 탭마다(매치 히스토리·상대 전적·챔피언) 따로 뒀더니, 여기 연도 선택과
 *   서로를 덮어썼다. `?year=` 와 `?period=` 는 배타적이라 한쪽을 누르면 다른 쪽이 조용히
 *   풀리는데, 두 줄에 떨어져 있으면 그게 화면에서 안 보인다. 한 줄에 두면 보인다.
 * ★ 진행 방식 칩은 `전체` + format.ts 의 롤 순서(마지막 "분류 전"). 칼바람 탭에서는 진행 방식으로 나누지 않는다.
 */
export function PersonalRecordFilters({ map, format, year, period, hrefFor }: {
  map: MapTab; format: FormatFilter; year?: number; period: RecordPeriod; hrefFor: HrefFor;
}) {
  return <LinkedRecordFilters category={format} year={year ? String(year) : "all"} categoryLabel="진행 방식"
    categories={LOL_FORMAT_CHOICES.map((c)=>({...c,href:hrefFor({format:c.value as FormatFilter,page:null})}))}
    years={[]} hideCategory={map === "aram"}
    leading={<MapTabs value={map} hrefFor={(m) => hrefFor({ map: m, page: null })} />}
    trailing={<RecordPeriodFilters href={hrefFor({})} period={period} />} />;
}

/**
 * @param record 고른 세트 전부의 tally — 세트·시리즈를 RecordPair 로 함께 보인다(승+무+패+미상 = 판 수).
 * @param art 카드 배경으로 쓸 챔피언의 영문 ID(`Pantheon`). 없으면 기본 그림을 쓴다.
 *   ⚠ 파일이 없으면 `background-image` 의 **뒤쪽 레이어**가 그대로 보인다 — CSS 가
 *     기본 그림을 아래에 깔아 두므로 404 여도 카드가 비지 않는다.
 */
export function PersonalRecordSummary({ record, art, portrait, identity, details }: {
  record: Tally; art?: string;
  portrait: ReactNode; identity: ReactNode; details: ReactNode;
}) {
  // 승률은 시리즈 기준, 무·미상은 분모에서 뺀다(headToHead).
  const rate = rawWinRate(headToHead(record.series));
  const seriesCount = record.series.win + record.series.draw + record.series.loss + record.series.unknown;
  const setCount = record.sets.win + record.sets.draw + record.sets.loss + record.sets.unknown;
  return <>
    <RecordOverviewCard className="personal-profile-card" label="개인 프로필 및 전적 요약"
      dataArt={art ? "champion" : "Thresh"}
      style={art ? { "--profile-art": `url('/images/champion-splash/${art}.jpg')` } as CSSProperties : undefined}>
    <div className="personal-profile-portrait">{portrait}</div>
    <header className="personal-profile-identity">{identity}</header>
    <div className="personal-stat-grid">
      <div><small>시리즈</small><strong>{seriesCount.toLocaleString()}</strong><span>{setCount.toLocaleString()}세트</span></div>
      <div><small>세트 · 시리즈 전적</small><RecordPair tally={record} compact /></div>
      <div><small>시리즈 승률</small><strong>{rate===null?'—':`${(rate*100).toFixed(1)}%`}</strong><span>무승부·미상 제외</span></div>
    </div>
    {details}
    </RecordOverviewCard>
    {!setCount && <p className="personal-profile-empty">선택한 조건에 맞는 경기가 없습니다.</p>}
  </>;
}

/** A history row is one series, even when several opposing streamers participated. */
export function PersonalMatchHistory({ matches, rosters, streamerId, streamerName }: {
  matches: PersonalMatch[]; rosters: PublicRosterEntry[]; streamerId: string; streamerName: string;
}) {
  // ★ 줄의 결과는 core 가 정한 시리즈 결과(m.result — tally 규칙)다. 화면이 다수결·랜드 분기로 다시 판정하지 않는다.
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
      const result = m.result;
      const resultLabel = OUTCOME_LABEL[m.result];
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
      // 보너스 판은 팀을 조금 바꿔 하므로 줄 제목(팀·맞라인)은 본게임만으로 정한다(0079).
      const mainIds = m.sets.filter((s) => s.set_role !== "bonus").map((s) => s.match_id);
      for (const matchId of mainIds) {
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
          if (isLaneMatchup({ teamId: me.team_id, teamPosition: me.team_position ?? undefined, individualPosition: me.individual_position ?? undefined }, { teamId: player.team_id, teamPosition: player.team_position ?? undefined, individualPosition: player.individual_position ?? undefined })) {
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
      /**
       * ★ 랜드는 팀이 매 판 바뀐다 — 팀 대 팀이 아니라 **나 대 맞라인 상대**, 스코어는 판 단위 n승 m패다(0079).
       *   맞라인 상대를 정하고 하는 방식이라 보통 한 명이고, 여럿이면 몇 명과 붙었는지만 적는다.
       */
      // 표시만 — 랜드는 팀이 매 판 바뀌어 "나 대 맞라인 상대" 로 읽는다. 세는 규칙은 다른 진행 방식과 같다.
      const land = m.format === "land";
      const opponentLabel = land ? (soleRival ? `맞라인 ${soleRival}` : `상대 ${opponentNames.length}명`)
        : otherTeams.size === 1 ? [...otherTeams][0]
        : soleRival ? `${soleRival} 팀`
        : opponentNames.length ? `${opponentNames.slice(0, 2).join(" · ")}${opponentNames.length > 2 ? ` 외 ${opponentNames.length - 2}명` : ""}` : "상대 팀";
      const ownLabel = land ? streamerName : myLabel;
      const label = formatLabel(m.format);
      const title = [label, m.event_name].filter(Boolean).join(" · ");
      const sets = m.record.win + m.record.draw + m.record.loss + m.record.unknown;
      return <Fragment key={m.series_id}>
        {showYear && <RecordTimelineYear year={matchYear} />}
        <RecordTimelineRow result={result} dateTime={kstDateString(m.played_at)} title={date}
          date={repeatedDate ? <span className="sr-only">{date}</span>
            : <><span className="personal-match-date-year">{date.slice(0, 5)}</span>{date.slice(5)}</>}>
            <details className="personal-match-detail">
              <summary className="arena-match-toggle personal-match-toggle personal-match-summary">
                {/* ★ 말줄임(…)은 **안쪽** 요소가 맡는다. 바깥(=flex 아이템)에 overflow:hidden 을
                    걸면 그 아이템은 글자 밑선 대신 '박스 아래 모서리' 를 베이스라인으로 내놓아
                    베이스라인 정렬이 통째로 깨진다. 그래서 자르는 일만 한 겹 안으로 내린다. */}
                <span className="record-match-event" title={title}><span className="record-match-clip">{m.event_name}</span></span>
                {/* 스코어 = 본게임 세트 승:패. 무·미상 세트가 있으면 그 옆에 적는다(숨기지 않는다). */}
                <span className="personal-match-teams"><span title={ownLabel}><span className="record-match-clip">{ownLabel}</span></span><strong>{m.record.win}<i>:</i>{m.record.loss}{(m.record.draw > 0 || m.record.unknown > 0) && <small>{m.record.draw > 0 ? ` 무${m.record.draw}` : ""}{m.record.unknown > 0 ? ` 미상${m.record.unknown}` : ""}</small>}</strong><span title={opponentLabel}><span className="record-match-clip">{opponentLabel}</span></span></span>
                {/* 순서는 세 화면 공통 — 스코어 → 형식 → 승패. 승패가 늘 끝에 와야
                    줄을 훑을 때 눈이 같은 자리에서 결과를 찾는다. */}
                <small>{land ? `랜드 ${sets}판` : formatBadge(m.best_of, sets, mainIds.length === 1 && isStandaloneSet(mainIds[0], m.series_id))}</small>
                <span className="personal-match-result">{resultLabel}</span>
                <span className="personal-match-expand" aria-hidden="true" />
              </summary>
              <MatchDetails sets={m.sets.map((s)=>({matchId:s.match_id,label:setLabel({standalone:isStandaloneSet(s.match_id,m.series_id),best_of:m.best_of,set_order_known:m.set_order_known,series_game_no:s.series_game_no,set_role:s.set_role,set_label:s.set_label,land}),players:byMatch.get(s.match_id) ?? []}))}
                streamerId={streamerId} />
            </details>
        </RecordTimelineRow>
      </Fragment>;
    })}
  </RecordTimeline>;
}

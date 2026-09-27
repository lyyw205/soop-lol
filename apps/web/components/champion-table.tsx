"use client";

/**
 * 모스트 챔피언 표. **챔피언 하나가 한 줄**이고, 열 구성은 전적 검색 사이트의 관례를 따른다 —
 * 순위 · 챔피언 · 경기 · 승률 막대 · 승률 · 승·패 · KDA · 펼치기.
 *
 * ★ 펼치면 나오는 것
 *   그 챔피언으로 **맞라인에서 만난 상대 챔피언**별 전적이다. 이 사이트의 한 문장
 *   ("누가 누구를 이겼나")을 챔피언 축으로 옮긴 것이고, 개인 전적 사이트가 못 하는 자리다.
 *
 * ★ 맞라인 줄은 **같은 표의 행**이다 (중첩 표가 아니다)
 *   예전엔 `<td colSpan>` 안에 표를 하나 더 넣었다. 그러면 ① 열이 부모와 어긋나 눈으로
 *   비교가 안 되고 ② 바깥 칸의 패딩 때문에 아래만 비어 보였다. 같은 표의 행으로 두면
 *   열이 저절로 맞고, 순위 칸에 `VS` 를 넣어 어느 줄에 딸렸는지 표시한다.
 *
 * ★ '표본 N판 · 참고용' 뱃지를 달지 않는다
 *   바로 옆 칸에 **경기 수와 승·패가 그대로 있다.** 1판이면 `1` 과 `1승 0패` 가 보이므로
 *   같은 말을 뱃지로 한 번 더 하지 않는다. 숫자를 숨기는 게 아니라 중복을 지우는 것이다.
 */

import { Fragment, useState } from "react";
import { championById, championIconPath } from "@soop-lol/core/lib/riot/champions";
import type { ChampionMatchup, ChampionRecord } from "@soop-lol/core/lib/db/public";
import { EmptyLine } from "../../../packages/ui/empty-line";

/**
 * 챔피언 표시 이름.
 * ★ `champion_id = 0` 은 챔피언이 아니라 **'모른다'** 다 — 방송을 읽어 넣은 내전 중
 *   결과 화면을 못 구해 챔피언까지는 확정하지 못한 경기가 그렇게 저장된다
 *   (없는 값을 지어내지 않는다). 그대로 두면 화면에 '챔피언 0' 이라고 뜬다.
 * ★ 한글 이름표가 먼저다. `champion_name` 은 Riot 이 준 영문(`Pantheon`)이라 그대로 쓰면
 *   같은 챔피언이 매치 상세에서는 '판테온', 챔피언 탭에서는 'Pantheon' 으로 나온다.
 */
export function championLabel(c: { champion_name: string | null; champion_id: number }): string {
  if (c.champion_id === 0) return "챔피언 미상";
  return championById(c.champion_id)?.name ?? c.champion_name ?? `챔피언 ${c.champion_id}`;
}

/**
 * @param vs 맞라인 줄 표시. **챔피언 이미지가 서던 자리**에 `VS` 를 세우고 아이콘은 그만큼
 *   오른쪽으로 밀린다 — 들여쓰기가 곧 "위 줄에 딸렸다" 는 뜻이 된다. 순위 칸은 비운다.
 */
function ChampionCell({ row, vs }: { row: { champion_id: number; champion_name: string | null }; vs?: string }) {
  const champion = championById(row.champion_id);
  return <span className="record-cell-name">
    {vs && <i className="champion-vs"><span className="sr-only">{vs} 상대</span><span aria-hidden="true">VS</span></i>}
    {champion
      ? <img src={championIconPath(champion)} alt="" loading="lazy" />
      : <span className="record-icon-blank" aria-hidden="true">?</span>}
    {/* 좁은 화면에서는 말줄임이 날 수 있다 — 전체 이름은 title 로 남긴다. */}
    <span title={championLabel(row)}>{championLabel(row)}</span>
  </span>;
}

/**
 * KDA 칸.
 * ★ 평균의 분모는 `games` 가 아니라 `kda_games` 다 — 방송에서 승패만 읽은 판은 KDA 가
 *   NULL 이라 합에서 빠지고, `games` 로 나누면 평균이 묽어진다. 한 판도 못 읽었으면
 *   평균을 내지 않고 '—' 를 그린다 (0020 ⑧).
 */
function KdaCell({ row }: { row: Pick<ChampionMatchup, "kills" | "deaths" | "assists" | "kda_games"> }) {
  if (!row.kda_games) return <span className="record-dash" title="KDA 를 읽은 경기가 없습니다">—</span>;
  const [k, d, a] = [row.kills, row.deaths, row.assists].map((n) => n / row.kda_games);
  const ratio = d ? (k + a) / d : k + a;
  return <span className="champion-kda">
    <b>{ratio.toFixed(2)}</b><small>({k.toFixed(1)} / {d.toFixed(1)} / {a.toFixed(1)})</small>
  </span>;
}

/** 막대와 퍼센트는 **다른 칸**이다. 숫자끼리 세로로 줄이 서야 위아래 비교가 된다. */
function statCells(row: { games: number; wins: number }) {
  const rate = row.games ? row.wins / row.games : 0;
  return <>
    <td className="champion-col-bar">
      <span className="champion-bar" aria-hidden="true"><i style={{ width: `${rate * 100}%` }} /></span>
    </td>
    <td className="champion-col-rate">{Math.round(rate * 100)}%</td>
    {/* ★ 승과 패에 위계를 주지 않는다. 예전엔 승이 <b>, 패가 <small> 이라 0승 1패 인데도
        승 쪽이 더 크고 밝았다 — 읽는 사람에게 "승이 더 중요하다" 는 거짓 신호다. */}
    <td><span className="record-wl"><span>{row.wins}승</span><span>{row.games - row.wins}패</span></span></td>
  </>;
}

export function ChampionList({ champions }: { champions: ChampionRecord[] }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  if (champions.length === 0) return <EmptyLine>아직 집계된 챔피언이 없습니다.</EmptyLine>;
  return (
    <div className="record-table-wrap">
      <table className="record-table champion-table">
        <thead>
          <tr>
            <th scope="col" className="record-col-rank"><span className="sr-only">순위</span>#</th>
            <th scope="col" className="record-col-name">챔피언</th>
            <th scope="col">경기</th>
            <th scope="col" className="champion-col-bar"><span className="sr-only">승률 막대</span></th>
            {/* ⚠ table-layout: fixed 는 **첫 줄(머리글)의 폭만** 본다. 여기 클래스를 빼먹으면
                그 열만 남는 폭을 나눠 갖는다 — 실제로 승률·펼치기가 그랬다. */}
            <th scope="col" className="champion-col-rate">승률</th>
            <th scope="col">승 · 패</th>
            <th scope="col">KDA</th>
            <th scope="col" className="champion-col-toggle"><span className="sr-only">맞라인 상대 펼치기</span></th>
          </tr>
        </thead>
        <tbody>
          {champions.map((c, index) => {
            const isOpen = !!open[c.champion_id];
            const name = championLabel(c);
            return (
              <Fragment key={c.champion_id}>
                <tr data-open={isOpen || undefined}>
                  <td className="record-col-rank">{index + 1}</td>
                  <th scope="row" className="record-col-name"><ChampionCell row={c} /></th>
                  <td className="champion-col-games">{c.games}</td>
                  {statCells(c)}
                  <td><KdaCell row={c} /></td>
                  <td className="champion-col-toggle">
                    {/* ▸/▾ 는 Pretendard 서브셋에 글리프가 없어 안 그려진다 — +/− 를 쓴다 */}
                    <button type="button" aria-expanded={isOpen}
                      aria-label={`${name} 맞라인 상대 ${isOpen ? "접기" : "펼치기"}`}
                      onClick={() => setOpen((prev) => ({ ...prev, [c.champion_id]: !isOpen }))}>
                      {isOpen ? "−" : "+"}
                    </button>
                  </td>
                </tr>
                {isOpen && (c.matchups.length === 0 ? (
                  <tr className="champion-matchup-row">
                    <td className="record-col-rank" />
                    <td colSpan={7} className="champion-matchup-empty">
                      맞라인 상대를 확인한 경기가 없습니다 — 포지션을 읽지 못한 경기는 세지 않습니다.
                    </td>
                  </tr>
                ) : c.matchups.map((m) => (
                  <tr className="champion-matchup-row" key={m.champion_id}>
                    {/* 순위 칸은 비운다 — 이 줄은 순위가 없다. 표시는 챔피언 칸의 VS 가 맡는다. */}
                    <td className="record-col-rank" />
                    <th scope="row" className="record-col-name"><ChampionCell row={m} vs={name} /></th>
                    <td className="champion-col-games">{m.games}</td>
                    {statCells(m)}
                    <td><KdaCell row={m} /></td>
                    <td className="champion-col-toggle" />
                  </tr>
                )))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

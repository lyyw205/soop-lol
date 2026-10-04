/** Oldest endpoint only: list IDs to the tail, fetch one oldest detail per 1v1 mode.
 * Never advance the full-sync cursor; intermediate match details are not fetched.
 * Without --refresh, analyze the oldest already stored match inside the 30-day window.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { db, closeDb } from "../packages/core/lib/db/client.ts";
import { NexonClient, NexonApiError } from "../packages/core/lib/games/fconline/client.ts";
import { saveFcoMatch, fcoMatchTimestamp } from "../packages/core/lib/games/fconline/ingest.ts";
import { FcoSiteClient } from "../packages/core/lib/games/fconline/club/site-client.ts";
import { syncCardPrices } from "../packages/core/lib/games/fconline/club/sync.ts";
import { fcoMetadata } from "../packages/core/lib/games/fconline/meta.ts";
import { kstDateString } from "../packages/core/lib/time.ts";
import { shiftDay } from "../packages/core/lib/metrics/club-value.ts";

type Card = { spid: number; grade: number; name?: string; season?: string | null };
const key = (p: Card) => `${p.spid}:${p.grade}`;
const unique = (cards: Card[]) => [...new Map(cards.map(c => [key(c), c])).values()];
const args = new Set(process.argv.slice(2));
const today = kstDateString(new Date()), cutoff = shiftDay(today, -30);
const types = [40, 50, 60]; // human 1v1 squads, no league/Volta/manager-mode mixing
try {
  const sql = db();
  const accounts = await sql<{ slug: string; name: string; ouid: string; nickname: string; slot: string | null }[]>`
    SELECT s.slug, s.display_name AS name, a.ouid, a.nickname, tc.source_slot AS slot
    FROM streamer s JOIN streamer_fco_account l ON l.streamer_id=s.id AND l.visibility='public'
    JOIN fco_account a ON a.ouid=l.ouid
    LEFT JOIN fco_team_colors tc ON tc.ouid=a.ouid AND tc.nickname=a.nickname
    WHERE s.visibility='public' ORDER BY s.display_name`;
  const refresh: { slug: string; mode: number; listed: number; matchId?: string; status: string }[] = [];
  let apiError: string | null = null;
  if (args.has('--refresh')) {
    const client = new NexonClient({ apiKey: process.env.NEXON_API_KEY ?? '', maxRetries: 1, maxRateLimitRetries: 1 });
    refreshLoop: for (const account of accounts) for (const mode of types) {
      let offset = 0, oldest: string | undefined;
      try {
        for (;;) {
          const ids = await client.matchIds(account.ouid, mode, offset, 100);
          oldest = ids.at(-1) ?? oldest;
          offset += ids.length;
          if (ids.length < 100) break;
        }
        if (oldest) {
          const detail = await client.matchDetail(oldest);
          if (!detail || !detail.matchInfo.some(p => p.ouid === account.ouid)) throw new Error('oldest detail missing or account mismatch');
          await saveFcoMatch(detail);
        }
        refresh.push({ slug: account.slug, mode, listed: offset, matchId: oldest, status: oldest ? 'saved' : 'empty' });
      } catch (e) {
        apiError = e instanceof Error ? e.message : String(e);
        refresh.push({ slug: account.slug, mode, listed: offset, status: apiError });
        if (e instanceof NexonApiError && (e.status === 429 || e.isAuthProblem)) break refreshLoop;
      }
    }
  }
  const metadata = await fcoMetadata();
  const comparisons = [];
  for (const account of accounts) {
    const [old] = await sql<{ payload: { matchId: string; matchDate: string; matchType: number; matchInfo: { ouid: string; player?: { spId: number; spGrade: number; spPosition: number }[] }[] } }[]>`
      SELECT d.payload FROM fco_match_detail d JOIN fco_match_participant p ON p.match_id=d.match_id
      JOIN match m ON m.match_id=d.match_id
      WHERE p.ouid=${account.ouid} AND m.game_creation >= ${cutoff + 'T00:00:00+09:00'}::timestamptz
        AND m.game_creation < ${shiftDay(today, 1) + 'T00:00:00+09:00'}::timestamptz
        AND (d.payload->>'matchType')::int=ANY(${types})
      ORDER BY m.game_creation, d.provider_match_id LIMIT 1`;
    const current = await sql<{ spid: string; grade: number | null; name: string; season: string | null; team_type: number; slot: number }[]>`
      SELECT p.spid::text,p.grade,p.name,p.season,p.team_type,p.slot FROM fco_squad_player p
      WHERE snapshot_id=(SELECT id FROM fco_club_snapshot WHERE ouid=${account.ouid} AND status='ok' AND nickname=${account.nickname}
        ORDER BY captured_at DESC,id DESC LIMIT 1)`;
    const past = unique((old?.payload.matchInfo.find(p=>p.ouid===account.ouid)?.player ?? [])
      .filter(p=>Number.isInteger(p.spId)&&p.spId>0&&Number.isInteger(p.spGrade)&&p.spGrade>=0&&p.spGrade<=13)
      .map(p=>({spid:p.spId,grade:p.spGrade,name:metadata.names.get(p.spId) ?? String(p.spId),season:metadata.seasons.get(Math.floor(p.spId/1e6))?.name ?? null})));
    const now = unique(current.filter(p=>p.grade!==null).map(p=>({spid:Number(p.spid),grade:p.grade!,name:p.name,season:p.season})));
    const selected = /^(대표팀|클럽팀) ([ABC])$/.exec(account.slot ?? '');
    const defaultSquad = selected ? unique(current.filter(p=>p.grade!==null&&p.team_type===(selected[1]==='대표팀'?1:0)&&p.slot==='ABC'.indexOf(selected[2])+1)
      .map(p=>({spid:Number(p.spid),grade:p.grade!,name:p.name,season:p.season}))) : [];
    const day = old ? kstDateString(new Date(fcoMatchTimestamp(old.payload.matchDate))) : null;
    const unknownCurrent = [...new Map(current.filter(p=>p.grade===null).map(p=>[p.spid,{spid:Number(p.spid),name:p.name,season:p.season}])).values()];
    const currentDefaultUnknown = selected ? [...new Set(current.filter(p=>p.grade===null&&p.team_type===(selected[1]==='대표팀'?1:0)&&p.slot==='ABC'.indexOf(selected[2])+1).map(p=>p.spid))].length : 0;
    const unmatchedPast = past.filter(p=>!now.some(c=>key(c)===key(p)));
    const uncertain = unmatchedPast.filter(p=>unknownCurrent.some(c=>c.spid===p.spid));
    const oldOnly = unmatchedPast.filter(p=>!unknownCurrent.some(c=>c.spid===p.spid));
    const currentOnly = now.filter(p=>!past.some(c=>key(c)===key(p)));
    const common = past.filter(p=>now.some(c=>key(c)===key(p)));
    const gradeChanges = oldOnly.filter(p=>now.some(c=>c.spid===p.spid)).map(p=>({past:p,current:now.filter(c=>c.spid===p.spid)}));
    comparisons.push({slug:account.slug,name:account.name,nickname:account.nickname,oldestMatch:old ? {id:old.payload.matchId,day,mode:old.payload.matchType} : null,
      currentSlot:account.slot,past,current:now,defaultSquad,oldOnly,currentOnly,common,gradeChanges,uncertain,unknownCurrent,currentDefaultUnknown,unknownCurrentGrades:unknownCurrent.length});
  }
  const pastCards = unique(comparisons.flatMap(c=>c.past));
  const [coverage] = await sql`SELECT count(*)::int AS cards FROM unnest(${pastCards.map(p=>p.spid)}::bigint[],${pastCards.map(p=>p.grade)}::smallint[]) w(spid,grade)
    WHERE EXISTS(SELECT 1 FROM fco_card_price_daily p WHERE p.spid=w.spid AND p.grade=w.grade)`;
  console.log({accounts:accounts.length,cachedMatches:comparisons.filter(c=>c.oldestMatch).length,oldestDays:comparisons.map(c=>[c.name,c.oldestMatch?.day]),pastCards:pastCards.length,pricesAlreadyKnown:coverage.cards});
  if (args.has('--prices')) {
    console.log('Refreshing historical-card prices through the 1 request/second website gateway...');
    console.log(await syncCardPrices(new FcoSiteClient(),pastCards));
  }
  const cards = unique(comparisons.flatMap(c=>[...c.past,...c.current]));
  const prices = await sql<{ spid: string; grade: number; day: string; price: string }[]>`
    SELECT p.spid::text,p.grade,p.day::text,p.price::text FROM fco_card_price_daily p
    JOIN unnest(${cards.map(p=>p.spid)}::bigint[],${cards.map(p=>p.grade)}::smallint[]) w(spid,grade) USING(spid,grade)
    WHERE p.day>=${cutoff}::date`;
  const map = new Map(prices.map(p=>[`${p.spid}:${p.grade}|${p.day}`,Number(p.price)]));
  const valuation = (cards: Card[], day: string | null) => {
    const rows=cards.map(p=>({...p,price:day ? map.get(`${key(p)}|${day}`) ?? null : null}));
    return {day,cards:rows.length,priced:rows.filter(p=>p.price!==null&&p.price>0).length,
      subtotal:rows.reduce((sum,p)=>sum+(p.price!==null&&p.price>0?p.price:0),0),rows};
  };
  const results = comparisons.map(c=>({...c,
    pastAtMatch:valuation(c.past,c.oldestMatch?.day ?? null),currentDefaultAtMatch:valuation(c.defaultSquad,c.oldestMatch?.day ?? null),
    oldOnlyAtMatch:valuation(c.oldOnly,c.oldestMatch?.day ?? null),currentOnlyAtMatch:valuation(c.currentOnly,c.oldestMatch?.day ?? null),
    pastAtLatest:valuation(c.past,shiftDay(today,-1)),currentDefaultAtLatest:valuation(c.defaultSquad,shiftDay(today,-1))}));
  const out = `out/fconline/oldest-squad-${today}`;
  await mkdir('out/fconline',{recursive:true});
  await writeFile(`${out}.json`,JSON.stringify({generatedAt:new Date().toISOString(),cutoff,today,types,apiError,refresh,
    source:refresh.length && !apiError?'refreshed oldest endpoint per mode; cached matches included':'stored matches only; oldest API availability not verified',results},null,2));
  const money=(v:number)=>`${(v/1e8).toFixed(2)}억`;
  const cardLabel=(p:Card)=>`${p.season ?? ''} ${p.name} +${p.grade}`;
  const md=[`# 과거 경기 명단과 현재 스쿼드 비교 (${today})`, '',
    `대상: ${cutoff}~${today}의 저장된 1대1 경기(40·50·60) 중 계정별 가장 오래된 경기. ${apiError ? `API 최장 조회 확인 실패: ${apiError}.` : refresh.length ? "모드별 목록 끝을 확인하고 마지막 경기 상세만 조회했다." : "저장 기록만 사용했다. API 최장 조회 가능 기록은 별도 확인이 필요하다."} 중간 경기 상세 신규 수집 없음.`,
    '', '과거 경기 명단은 전체 보유 목록이 아니다. 현재는 6칸 합집합과 비교하며, 가치 비교는 프로필 기본 슬롯을 별도로 사용한다. 과거만/현재만 관측은 판매/영입 확정이 아니다. 강화 변경도 포함된다. 현재 강화 미확인 카드는 별도 표기하고 같은 카드의 과거 기록을 과거만 관측으로 단정하지 않는다. 금액은 시세가 있는 카드만의 부분합이며 날짜 사이의 구성 변경 시점은 알 수 없다.', '',
    '| 스트리머 | 과거 경기(KST) | 과거 명단 | 현재(강화확인) | 공통 | 과거만 | 현재만 | 비교 미확정 | 과거 명단 당시 시세 | 시세 확인 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(c=>`| ${c.name} | ${c.oldestMatch?.day ?? '없음'} | ${c.past.length} | ${c.current.length} | ${c.common.length} | ${c.oldOnly.length} | ${c.currentOnly.length} | ${c.uncertain.length} | ${money(c.pastAtMatch.subtotal)} | ${c.pastAtMatch.priced}/${c.past.length} |`),
    ...results.flatMap(c=>['',`## ${c.name}`,`근거 경기: ${c.oldestMatch?.id ?? '없음'} · 현재 기본 슬롯: ${c.currentSlot ?? '미확인'}`,
      `과거만 관측: ${c.oldOnly.map(cardLabel).join(', ') || '없음'}`,
      `현재만 관측: ${c.currentOnly.map(cardLabel).join(', ') || '없음'}`,
      `현재 강화 미확인 카드: ${c.unknownCurrent.map(p=>`${p.season} ${p.name}`).join(", ") || "없음"}. 과거 명단 중 이로 인해 비교 미확정: ${c.uncertain.map(cardLabel).join(", ") || "없음"}`,
      `동일 카드 강화 차이: ${c.gradeChanges.map(g=>`${cardLabel(g.past)} → ${g.current.map(cardLabel).join(' / ')}`).join(', ') || '없음'}`,
      `당시 명단의 당시 시세: ${money(c.pastAtMatch.subtotal)} (${c.pastAtMatch.priced}/${c.past.length}장). 현재 기본 스쿼드를 같은 날짜 시세로 소급: ${money(c.currentDefaultAtMatch.subtotal)} (${c.currentDefaultAtMatch.priced}/${c.defaultSquad.length+c.currentDefaultUnknown}장).`])];
  await writeFile(`${out}.md`,md.join('\n')+'\n');
  console.log(`Reports: ${out}.json / .md`);
} finally { await closeDb(); }

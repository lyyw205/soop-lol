import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpponentHistory } from "./opponent-history.ts";
import type { OpponentGame } from "../db/public.ts";
const row=(id:string,overrides:Partial<OpponentGame>={}):OpponentGame=>({other_id:"opponent",match_id:id,series_key:id,series_game_no:null,best_of:null,relation:"opponent",source:"manual",event_name:"CK",played_at:new Date("2026-09-19T01:00:00Z"),me_outcome:"win" as const,is_lane_matchup:true,...overrides});

test("ally-only streamers and allied results are excluded before aggregation",()=>{
  const result=buildOpponentHistory([row("vs"),row("ally",{relation:"ally",other_id:"friend"}),row("same-person-ally",{relation:"ally",played_at:new Date("2026-09-22T01:00:00Z")})],{key:"all"},false);
  assert.equal(result.length,1);assert.equal(result[0].vs_matches,1);assert.equal(result[0].ally_matches,0);assert.equal(result[0].last_met.toISOString(),"2026-09-19T01:00:00.000Z");
});
test("drawn series and duplicated input sets are counted once",()=>{
  const first=row("set1",{series_key:"series"});
  const result=buildOpponentHistory([first,first,row("set2",{series_key:"series",me_outcome:"loss" as const})],{key:"all"},false)[0];
  assert.equal(result.vs_matches,1);assert.equal(result.vs_sets,2);assert.equal(result.vs_match_draws,1);assert.equal(result.vs_match_wins,0);
});
test("lane filter excludes the entire mixed-lane series",()=>{
  const rows=[row("set1",{series_key:"mixed"}),row("set2",{series_key:"mixed",is_lane_matchup:false}),row("lane")];
  assert.equal(buildOpponentHistory(rows,{key:"all"},false)[0].vs_matches,2);
  const result=buildOpponentHistory(rows,{key:"all"},true)[0];assert.equal(result.vs_matches,1);assert.equal(result.matches[0].series,"lane");assert.equal(result.vs_sets,1);
});
test("date filtering uses series start and preserves all of a cross-midnight series",()=>{
  const rows=[row("before",{series_key:"series",played_at:new Date("2026-09-19T14:00:00Z")}),row("after",{series_key:"series",played_at:new Date("2026-09-19T16:00:00Z"),me_outcome:"loss" as const})];
  const result=buildOpponentHistory(rows,{key:"custom",from:"2026-09-19",to:"2026-09-19"},false)[0];
  assert.equal(result.vs_sets,2);assert.equal(result.vs_match_draws,1);
  assert.equal(buildOpponentHistory(rows,{key:"custom",from:"2026-09-20",to:"2026-09-20"},false).length,0);
});
test("invalid or empty date scopes return no opponents",()=>{
  assert.deepEqual(buildOpponentHistory([row("match")],{key:"custom",error:"invalid"},false),[]);
  assert.deepEqual(buildOpponentHistory([row("match")],{key:"custom",from:"1999-01-01",to:"1999-12-31"},false),[]);
});


test("a repeated opponent is aggregated once across the selected period",()=>{
  const rows=[row("day1-win"),row("day2-loss",{played_at:new Date("2026-09-20T01:00:00Z"),me_outcome:"loss" as const}),row("ally",{relation:"ally"})];
  const result=buildOpponentHistory(rows,{key:"custom",from:"2026-09-19",to:"2026-09-20"},false);
  assert.equal(result.length,1);
  assert.equal(result[0].vs_matches,2);
  assert.equal(result[0].vs_match_wins,1);
  assert.equal(result[0].vs_sets,2);
  assert.equal(result[0].last_met.toISOString(),"2026-09-20T01:00:00.000Z");
  const filtered=buildOpponentHistory(rows,{key:"custom",from:"2026-09-20",to:"2026-09-20"},false);
  assert.equal(filtered[0].vs_matches,1);
  assert.equal(filtered[0].vs_match_wins,0);
});

test("a land session is one row but counts one match per game (0080)",()=>{
  const land=(id:string,me_outcome:"win"|"loss")=>row(id,{series_key:"land-night:land",category:"land",me_outcome});
  const result=buildOpponentHistory([land("g1","win"),land("g2","loss"),land("g3","loss"),row("ck1",{series_key:"ck",category:"ck"}),row("ck2",{series_key:"ck",category:"ck",me_outcome:"loss" as const}),row("ck3",{series_key:"ck",category:"ck"})],{key:"all"},false)[0];
  assert.equal(result.matches.length,2);
  assert.equal(result.vs_matches,4);   // 랜드 3판 + CK 1경기
  assert.equal(result.vs_match_wins,2); // 랜드 1승 + CK 2:1 승
  assert.equal(result.vs_sets,6);
  assert.ok(result.matches.find((m)=>m.series==="land-night:land")?.land);
});

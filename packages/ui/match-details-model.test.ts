import { test } from "node:test";
import assert from "node:assert/strict";
import type { PublicRosterEntry } from "@soop-lol/core/lib/contract";
import { participantKey, participantKda, teamPlayers } from "./match-details-model.ts";

const player = (id:string, team:number, position:PublicRosterEntry["team_position"]=null):PublicRosterEntry=>({
  match_id:"set1",participant_id:1,observed_name:null,streamer_id:id,slug:id,display_name:id,team_id:team,team_name:null,
  team_position:position,champion_id:0,champion_name:null,outcome:team===100?"win" as const:"loss" as const,kills:null,deaths:null,assists:null,
});
test("team rosters use lane order without modifying or mixing the source roster",()=>{
  const players=[player("support",100,"UTILITY"),player("red",200,"TOP"),player("unknown",100),player("top",100,"TOP"),player("jungle",100,"JUNGLE"),player("bottom",100,"BOTTOM"),player("mid",100,"MIDDLE")];
  assert.deepEqual(teamPlayers(players,100).map((p)=>p.slug),["top","jungle","mid","bottom","support","unknown"]);
  assert.equal(players[0].slug,"support");
  assert.deepEqual(teamPlayers([],200),[]);
});

test("unknown KDA stays distinct from zero, including partially recorded results",()=>{
  assert.equal(participantKda({kills:null,deaths:null,assists:null}),"— / — / —");
  assert.equal(participantKda({kills:0,deaths:0,assists:0}),"0 / 0 / 0");
  assert.equal(participantKda({kills:2,deaths:null,assists:0}),"2 / — / 0");
});

test("unknown roster seats have stable distinct keys and no identity links",()=>{
  const one={...player("",100),streamer_id:null,slug:null,display_name:null,observed_name:"같은 이름",participant_id:1};
  const two={...one,participant_id:2};
  assert.notEqual(participantKey(one),participantKey(two));
  const corrected={...one,champion_id:34,observed_name:"고친 이름"};
  assert.equal(participantKey(one),participantKey(corrected));
  assert.notEqual(participantKey(one),participantKey({...one,match_id:"set2"}));
  assert.equal(teamPlayers([one,two],100).length,2);
});

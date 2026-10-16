import { isTitle, isRunnerUp } from "@soop-lol/core/lib/contract";
import { listStreamerEvents, summarizePlacements, listChampions, championById, championIconPath, type PublicStreamer, kstYear } from "@soop-lol/core/lib/contract";
import { Portrait } from "./fixture.tsx";
import { RecordSidebar } from "../../../ui/record-sidebar.tsx";
import { TopPairs } from "./top-pairs.tsx";

export async function ProfileSidebar({ person, exclude }: { person: PublicStreamer; exclude?: [string, string] }) {
  const [placements, events, champions] = await Promise.all([
    summarizePlacements(person.streamer_id), listStreamerEvents(person.streamer_id), listChampions(person.streamer_id, 4),
  ]);
  return <RecordSidebar name={person.display_name} slug={person.slug} isPro={person.is_pro} portrait={<Portrait person={person} />} placements={placements}
    awards={events.filter((e)=>(isTitle(e) || isRunnerUp(e))).slice(0,3).map((e)=>({id:e.event_slug,title:e.event_name,placement:e.placement,year:e.starts_at ? kstYear(new Date(e.starts_at)) : undefined,team:e.team_name}))}
    champions={champions.map((c)=>{const champion=championById(c.champion_id);return {id:c.champion_id,name:champion?.name ?? (c.champion_id ? `챔피언 ${c.champion_id}` : '챔피언 미상'),image:champion ? championIconPath(champion) : undefined,games:c.games};})}>
    <TopPairs person={person} exclude={exclude} />
  </RecordSidebar>;
}

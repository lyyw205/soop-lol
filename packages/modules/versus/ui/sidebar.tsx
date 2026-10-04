import { listStreamerEvents, summarizePlacements, listChampions, championById, championIconPath, type PublicStreamer, kstYear } from "@soop-lol/core/lib/contract";
import { Portrait } from "./fixture.tsx";
import { RecordSidebar } from "../../../ui/record-sidebar.tsx";
import { TopPairs } from "./top-pairs.tsx";

export async function ProfileSidebar({ person, exclude }: { person: PublicStreamer; exclude?: [string, string] }) {
  const [placements, events, champions] = await Promise.all([
    summarizePlacements(person.streamer_id), listStreamerEvents(person.streamer_id), listChampions(person.streamer_id),
  ]);
  return <RecordSidebar name={person.display_name} slug={person.slug} isPro={person.is_pro} portrait={<Portrait person={person} />} placements={placements}
    awards={events.filter((e)=>e.counts_toward_titles && (e.placement_rank===1 || e.placement_rank===2)).slice(0,3).map((e)=>({id:e.event_slug,title:e.event_name,placement:e.placement,year:kstYear(new Date(e.starts_at)),team:e.team_name}))}
    champions={champions.slice(0,4).map((c)=>{const champion=championById(c.champion_id);return {id:c.champion_id,name:champion?.name ?? c.champion_name ?? '챔피언',image:champion ? championIconPath(champion) : undefined,games:c.games};})}>
    <TopPairs person={person} exclude={exclude} />
  </RecordSidebar>;
}

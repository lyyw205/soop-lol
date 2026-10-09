import { UnknownParticipantsList, type UnknownParticipantsQuery } from "@/components/admin/UnknownParticipantsList";
export const metadata = { title: "협곡 참가자 연결" };
export const dynamic = "force-dynamic";
export default async function UnknownParticipantsPage({ searchParams }: { searchParams: Promise<UnknownParticipantsQuery> }) {
  return <UnknownParticipantsList query={await searchParams} collection="rift" />;
}

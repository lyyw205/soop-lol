import { UnknownParticipantsList, type UnknownParticipantsQuery } from "@/components/admin/UnknownParticipantsList";
export const metadata = { title: "칼바람 참가자 연결" };
export const dynamic = "force-dynamic";
export default async function AramUnknownParticipantsPage({ searchParams }: { searchParams: Promise<UnknownParticipantsQuery> }) {
  return <UnknownParticipantsList query={await searchParams} collection="aram" />;
}

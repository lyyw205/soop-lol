import { LoLReviewList, type LoLListQuery } from "@/components/admin/LoLReviewList";
export const metadata = { title: "칼바람 경기 검수" };
export const dynamic = "force-dynamic";
export default async function AramReviewList({ searchParams }: { searchParams: Promise<LoLListQuery> }) {
  return <LoLReviewList query={await searchParams} mode="queue" collection="aram" />;
}

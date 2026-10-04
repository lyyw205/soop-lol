import { LoLReviewList, type LoLListQuery } from "@/components/admin/LoLReviewList";
export const metadata = { title: "LoL 경기 검수" };
export const dynamic = "force-dynamic";
export default async function CkReviewList({ searchParams }: { searchParams: Promise<LoLListQuery> }) {
  return <LoLReviewList query={await searchParams} mode="queue" />;
}

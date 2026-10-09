import { LoLReviewList, type LoLListQuery } from "@/components/admin/LoLReviewList";
export const metadata = { title: "칼바람 시리즈 비교" };
export const dynamic = "force-dynamic";
export default async function AramOverview({ searchParams }: { searchParams: Promise<LoLListQuery> }) {
  return <LoLReviewList query={await searchParams} mode="compare" collection="aram" />;
}

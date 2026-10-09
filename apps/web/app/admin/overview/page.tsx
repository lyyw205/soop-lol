import { LoLReviewList, type LoLListQuery } from "@/components/admin/LoLReviewList";
export const metadata = { title: "협곡 시리즈 비교" };
export const dynamic = "force-dynamic";
export default async function MatchOverviewPage({ searchParams }: { searchParams: Promise<LoLListQuery> }) {
  return <LoLReviewList query={await searchParams} mode="compare" />;
}

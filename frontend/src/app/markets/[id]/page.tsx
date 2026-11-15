import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PRESET_MARKETS, getMarketDefinition } from "@/lib/markets";
import { TradePageClient } from "@/components/trade/TradePageClient";
import { buildMarketMetadata } from "@/lib/seo";

interface MarketsPageProps {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateStaticParams(): Promise<{ id: string }[]> {
  return PRESET_MARKETS.map((m) => ({ id: m.id }));
}

export async function generateMetadata({
  params,
}: MarketsPageProps): Promise<Metadata> {
  const { id } = await params;
  return buildMarketMetadata(id, "markets");
}

export default async function MarketDetailPage({
  params,
  searchParams,
}: MarketsPageProps) {
  const { id } = await params;
  const query = searchParams ? await searchParams : undefined;

  const marketDef = getMarketDefinition(id);
  if (!marketDef) {
    notFound();
  }

  const initialTab = typeof query?.tab === "string" ? query.tab : "swap";

  return <TradePageClient market={marketDef} initialTab={initialTab} />;
}

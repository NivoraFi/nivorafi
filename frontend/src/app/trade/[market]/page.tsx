import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PRESET_MARKETS, getMarketDefinition } from "@/lib/markets";
import { TradePageClient } from "@/components/trade/TradePageClient";
import { buildMarketMetadata } from "@/lib/seo";

interface TradePageProps {
  params: Promise<{ market: string }>;
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateStaticParams(): Promise<{ market: string }[]> {
  return PRESET_MARKETS.map((m) => ({ market: m.id }));
}

export async function generateMetadata({
  params,
}: TradePageProps): Promise<Metadata> {
  const { market } = await params;
  return buildMarketMetadata(market, "trade");
}

export default async function TradePage({ params, searchParams }: TradePageProps) {
  const { market } = await params;
  const query = searchParams ? await searchParams : undefined;

  const marketDef = getMarketDefinition(market);
  if (!marketDef) {
    notFound();
  }

  const initialTab = typeof query?.tab === "string" ? query.tab : "swap";

  return <TradePageClient market={marketDef} initialTab={initialTab} />;
}

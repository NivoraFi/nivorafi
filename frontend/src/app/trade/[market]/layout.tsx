import { getMarketDefinition } from "@/lib/markets";
import { buildMarketJsonLd } from "@/lib/seo";

interface TradeLayoutProps {
  children: React.ReactNode;
  params: Promise<{ market: string }>;
}

export default async function TradeMarketLayout({
  children,
  params,
}: TradeLayoutProps) {
  const { market } = await params;
  const marketDef = getMarketDefinition(market);

  return (
    <>
      {marketDef ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(buildMarketJsonLd(marketDef)),
          }}
        />
      ) : null}
      {children}
    </>
  );
}

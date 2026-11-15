import type { Metadata } from "next";
import { PortfolioPageClient } from "@/components/portfolio/PortfolioPageClient";
import { constructMetadata } from "@/lib/seo";

export const metadata: Metadata = constructMetadata({
  title: "My Portfolio",
  description:
    "Aggregated yield positions, PnL analytics, average entry yield, and claimable rewards across Stellar Soroban markets.",
  path: "/portfolio",
});

interface PortfolioPageProps {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function PortfolioPage({ searchParams }: PortfolioPageProps) {
  const query = searchParams ? await searchParams : undefined;
  const initialTab = typeof query?.tab === "string" ? query.tab : undefined;
  const initialFilter = typeof query?.filter === "string" ? query.filter : undefined;

  return (
    <PortfolioPageClient
      initialTab={initialTab}
      initialFilter={initialFilter}
    />
  );
}

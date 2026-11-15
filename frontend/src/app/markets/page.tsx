import type { Metadata } from "next";
import { MarketsPageClient } from "./MarketsPageClient";
import { constructMetadata } from "@/lib/seo";

export const metadata: Metadata = constructMetadata({
  title: "Active Yield Markets",
  description:
    "Explore institutional-grade fixed yield and leveraged yield markets on Stellar Soroban Testnet.",
  path: "/markets",
});

export default function MarketsPage() {
  return <MarketsPageClient />;
}

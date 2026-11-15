import type { Metadata } from "next";
import { constructMetadata } from "@/lib/seo";
import { PoolsPageClient } from "./PoolsPageClient";

export const metadata: Metadata = constructMetadata({
  title: "Liquidity Pools",
  description:
    "Supply dual-sided PT and SY liquidity to Soroban log-normal YieldSpace AMM pools and earn swap fees plus underlying yield.",
  path: "/pools",
});

export default function PoolsPage() {
  return <PoolsPageClient />;
}

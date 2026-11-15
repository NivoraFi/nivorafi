import type { MetadataRoute } from "next";
import { PRESET_MARKETS } from "@/lib/markets";
import { getBaseUrl } from "@/lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = getBaseUrl();
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: baseUrl, lastModified: now, changeFrequency: "daily", priority: 1.0 },
    { url: `${baseUrl}/pools`, lastModified: now, changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/portfolio`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${baseUrl}/terms`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
    { url: `${baseUrl}/privacy`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];

  const marketRoutes: MetadataRoute.Sitemap = PRESET_MARKETS.flatMap((market) => [
    {
      url: `${baseUrl}/trade/${market.id}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 0.9,
    },
    {
      url: `${baseUrl}/markets/${market.id}`,
      lastModified: now,
      changeFrequency: "hourly" as const,
      priority: 0.8,
    },
  ]);

  return [...staticRoutes, ...marketRoutes];
}

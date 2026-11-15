import type { Metadata } from "next";
import {
  MarketDefinition,
  getMarketDefinition,
  PRESET_MARKETS,
} from "./markets";

/**
 * Global site branding constants for NivoraFi.
 */
export const SITE_NAME = "NivoraFi";
export const PROTOCOL_TITLE = "NivoraFi | Fixed Yield & AMM Trading Desk";
export const DEFAULT_DESCRIPTION =
  "Non-custodial fixed yield and yield tokenization AMM on Stellar Soroban. Split Blend bUSDC & XLM into Principal (PT) and Yield Tokens (YT) to lock fixed APY.";
export const DEFAULT_BASE_URL = "https://nivorafi.xyz";
export const TWITTER_HANDLE = "@NivoraFi";

export const SITE_CONFIG = {
  name: SITE_NAME,
  shortName: "NivoraFi",
  titleTemplate: `%s | ${SITE_NAME}`,
  defaultTitle: PROTOCOL_TITLE,
  fallbackTitle: "Trade bUSDC 90D | NivoraFi",
  defaultDescription: DEFAULT_DESCRIPTION,
  siteUrl: DEFAULT_BASE_URL,
  twitterCreator: TWITTER_HANDLE,
  twitterSite: TWITTER_HANDLE,
  defaultOgImage: {
    url: "/og-image.png",
    width: 1200,
    height: 630,
    alt: "NivoraFi — Fixed Yield & Yield Tokenization on Stellar",
  },
  defaultKeywords: [
    "NivoraFi",
    "Stellar",
    "Soroban",
    "Fixed Yield",
    "DeFi",
    "AMM",
    "Principal Token",
    "Yield Token",
    "Tokenized Yield",
    "Smart Contracts",
    "Crypto Yield",
  ],
} as const;

/**
 * Normalizes URL path ensuring leading slash and stripping trailing slashes.
 */
export function normalizePath(path?: string | null): string {
  if (!path || typeof path !== "string") {
    return "/";
  }
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const stripped = leading.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * Resolves the absolute base URL with graceful fallback for empty or malformed env vars.
 */
export function getBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (!envUrl || typeof envUrl !== "string" || envUrl.trim() === "") {
    return DEFAULT_BASE_URL;
  }
  try {
    const parsed = new URL(envUrl.trim());
    return parsed.origin;
  } catch {
    return DEFAULT_BASE_URL;
  }
}

/**
 * Standard icon declarations for favicon and apple touch icons.
 */
export const DEFAULT_ICONS: Metadata["icons"] = {
  icon: [
    { url: "/icon.svg", type: "image/svg+xml" },
    { url: "/favicon.ico" },
    { url: "/favicon.png", type: "image/png" },
  ],
  apple: [{ url: "/icon.png" }],
};

/**
 * Production search engine crawler directives.
 */
export const DEFAULT_ROBOTS: Metadata["robots"] = {
  index: true,
  follow: true,
  googleBot: {
    index: true,
    follow: true,
    "max-video-preview": -1,
    "max-image-preview": "large",
    "max-snippet": -1,
  },
};

export const NO_INDEX_ROBOTS: Metadata["robots"] = {
  index: false,
  follow: false,
  nocache: true,
  googleBot: {
    index: false,
    follow: false,
  },
};

export interface DynamicSeoOptions {
  title?: string;
  description?: string;
  path?: string;
  ogType?: "website" | "article";
  image?: string | { url: string; width?: number; height?: number; alt?: string };
  images?: Array<string | { url: string; width?: number; height?: number; alt?: string }>;
  noIndex?: boolean;
  keywords?: string[];
  locale?: string;
  twitterCard?: "summary" | "summary_large_image" | "app" | "player";
  marketCode?: string;
  marketDuration?: string;
  canonical?: string;
}

/**
 * Pure utility function to construct a fully populated Next.js Metadata object.
 */
export function constructMetadata(options: DynamicSeoOptions = {}): Metadata {
  const {
    title,
    description = DEFAULT_DESCRIPTION,
    path = "/",
    ogType = "website",
    image,
    images: customImages,
    noIndex = false,
    keywords = SITE_CONFIG.defaultKeywords,
    locale = "en_US",
    twitterCard = "summary_large_image",
    canonical: explicitCanonical,
  } = options;

  const baseUrl = getBaseUrl();
  const canonicalPath = explicitCanonical ? normalizePath(explicitCanonical) : normalizePath(path);
  const pageUrl = `${baseUrl}${canonicalPath === "/" ? "" : canonicalPath}`;

  // Title formatting: if title provided and does not already include SITE_NAME, append suffix
  let formattedTitle: string;
  if (!title || title.trim() === "") {
    formattedTitle = PROTOCOL_TITLE;
  } else if (title.includes(SITE_NAME)) {
    formattedTitle = title.trim();
  } else {
    formattedTitle = `${title.trim()} | ${SITE_NAME}`;
  }

  // Normalize OG & Twitter Images
  const resolvedImages = customImages
    ? customImages.map((img) =>
        typeof img === "string"
          ? { url: img, width: 512, height: 512, alt: formattedTitle }
          : img
      )
    : image
      ? [
          typeof image === "string"
            ? { url: image, width: 512, height: 512, alt: formattedTitle }
            : image,
        ]
      : [SITE_CONFIG.defaultOgImage];

  const twitterImages = resolvedImages.map((img) => img.url);

  return {
    metadataBase: new URL(baseUrl),
    title: formattedTitle,
    description,
    keywords: Array.from(new Set(keywords)),
    authors: [{ name: SITE_NAME }],
    creator: SITE_NAME,
    publisher: SITE_NAME,
    icons: DEFAULT_ICONS,
    alternates: {
      canonical: canonicalPath,
    },
    robots: noIndex ? NO_INDEX_ROBOTS : DEFAULT_ROBOTS,
    openGraph: {
      type: ogType,
      locale,
      url: pageUrl,
      siteName: SITE_NAME,
      title: formattedTitle,
      description,
      images: resolvedImages,
    },
    twitter: {
      card: twitterCard,
      title: formattedTitle,
      description,
      images: twitterImages,
      creator: TWITTER_HANDLE,
      site: TWITTER_HANDLE,
    },
  };
}

export type MarketRoutePrefix = "trade" | "markets";
export type MarketMetadataMode = "trade" | "profile" | "markets";
export type MarketTitleFormat = "short" | "full";

export interface MarketMetadataOptions {
  routePrefix?: MarketRoutePrefix;
  mode?: MarketMetadataMode;
  path?: string;
  format?: MarketTitleFormat;
  customImage?: string;
}

/**
 * Formats a market-specific SEO title string.
 * - 'short': "Trade bUSDC 90D | Stellar Pendle V2"
 * - 'full': "Pendle bUSDC PT 90D (PT-bUSDC-90D) | Stellar Pendle V2"
 */
export function formatMarketSeoTitle(
  market: MarketDefinition,
  format: MarketTitleFormat = "full",
  routeOrMode: MarketRoutePrefix | MarketMetadataMode = "trade"
): string {
  const assetLabel = market.sySymbol.startsWith("sy-b")
    ? `b${market.asset.code}`
    : market.asset.code === "USDC"
    ? "bUSDC"
    : market.asset.code;

  if (routeOrMode === "markets" || routeOrMode === "profile") {
    return `${market.name} | Market Profile | ${SITE_NAME}`;
  }

  if (format === "short") {
    return `Trade ${assetLabel} ${market.tenor} | ${SITE_NAME}`;
  }

  // Full format satisfies both legacy tests (toContain market.name & ptSymbol) and V2 branding
  return `${market.name} (${market.ptSymbol}) | ${SITE_NAME}`;
}

/**
 * Builds dynamic Next.js Metadata for market routes (/trade/[market] and /markets/[id]).
 * Accepts either market slug string or MarketDefinition object, and routePrefix ("trade" | "markets") or options.
 */
export function buildMarketMetadata(
  marketInput: MarketDefinition | string | null | undefined,
  prefixOrOptions: MarketRoutePrefix | MarketMetadataOptions = "trade"
): Metadata {
  const options: MarketMetadataOptions =
    typeof prefixOrOptions === "string"
      ? { routePrefix: prefixOrOptions }
      : prefixOrOptions;

  const isProfileMode =
    options.mode === "profile" ||
    options.mode === "markets" ||
    options.routePrefix === "markets";
  const routePrefix = isProfileMode ? "markets" : (options.routePrefix || "trade");
  const baseUrl = getBaseUrl();

  const market =
    typeof marketInput === "string"
      ? getMarketDefinition(marketInput)
      : marketInput;

  // Fallback for non-existent / invalid markets (404 guard)
  if (!market) {
    return {
      metadataBase: new URL(baseUrl),
      title: "Market Not Found | NivoraFi",
      description: "The requested yield market does not exist on this NivoraFi node.",
      robots: NO_INDEX_ROBOTS,
    };
  }

  const assetLabel = market.sySymbol.startsWith("sy-b")
    ? `b${market.asset.code}`
    : market.asset.code === "USDC"
    ? "bUSDC"
    : market.asset.code;

  const canonicalPath = options.path
    ? normalizePath(options.path)
    : `/${routePrefix}/${market.id}`;

  const title = formatMarketSeoTitle(market, options.format || "full", routePrefix);

  let description: string;
  let ogTitle: string;
  let ogDescription: string;

  if (isProfileMode) {
    description = `Detailed market parameters, yield curves, and liquidity for ${market.name}. Tenor: ${market.tenor}, Maturity: ${market.maturityIso}, Asset: ${market.asset.code}.`;
    ogTitle = `${market.name} | Market Profile`;
    ogDescription = `Maturity: ${market.maturityIso} • Tenor: ${market.tenor} • Asset: ${market.asset.code}`;
  } else {
    description = `Trade discounted Principal Tokens (${market.ptSymbol}) and leveraged Yield Tokens (${market.ytSymbol}) on Stellar Soroban Testnet. Asset: ${market.asset.code}, Tenor: ${market.tenor}.`;
    ogTitle = `${market.name} | Fixed Yield Desk`;
    ogDescription = `Maturity: ${market.maturityIso} • Tenor: ${market.tenor} • Asset: ${market.asset.code}`;
  }

  const image = options.customImage || "/og-image.png";
  const pageUrl = `${baseUrl}${canonicalPath}`;

  return {
    metadataBase: new URL(baseUrl),
    title,
    description,
    alternates: {
      canonical: canonicalPath,
    },
    robots: DEFAULT_ROBOTS,
    openGraph: {
      type: "website",
      locale: "en_US",
      url: pageUrl,
      siteName: SITE_NAME,
      title: ogTitle,
      description: ogDescription,
      images: [
        {
          url: image,
          width: 512,
          height: 512,
          alt: `${market.name} Fixed Yield`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: `Trade ${assetLabel} ${market.tenor} | ${SITE_NAME}`,
      description,
      creator: TWITTER_HANDLE,
      site: TWITTER_HANDLE,
      images: [image],
    },
  };
}

/**
 * Pre-configured metadata builder for canonical top-level routes.
 */
export function buildPageMetadata(
  page: "home" | "portfolio" | "markets",
  extra: Partial<DynamicSeoOptions> = {}
): Metadata {
  switch (page) {
    case "portfolio":
      return constructMetadata({
        title: "My Portfolio",
        description:
          "Aggregated yield positions, PnL analytics, average entry yield, and claimable rewards across Stellar Soroban markets.",
        path: "/portfolio",
        ...extra,
      });

    case "markets":
      return constructMetadata({
        title: "Active Yield Markets",
        description:
          "Explore institutional-grade fixed yield and leveraged yield markets on Stellar Soroban Testnet.",
        path: "/markets",
        ...extra,
      });

    case "home":
    default:
      return constructMetadata({
        title: PROTOCOL_TITLE,
        description: DEFAULT_DESCRIPTION,
        path: "/",
        ...extra,
      });
  }
}

/**
 * Generates Schema.org FinancialProduct + BreadcrumbList JSON-LD for a market route.
 */
export function buildMarketJsonLd(market: MarketDefinition) {
  const baseUrl = getBaseUrl();
  const marketUrl = `${baseUrl}/trade/${market.id}`;

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "FinancialProduct",
        name: `${market.name} (${market.ptSymbol} / ${market.ytSymbol})`,
        description: `Tokenized fixed-yield Principal Token (${market.ptSymbol}) and variable Yield Token (${market.ytSymbol}) market on Stellar Soroban, maturing ${market.maturityIso}.`,
        url: marketUrl,
        category: "Fixed Yield & Yield Tokenization",
        provider: {
          "@type": "Organization",
          name: SITE_NAME,
          url: baseUrl,
        },
        feesAndCommissionsSpecification:
          "Non-custodial Soroban time-decaying log-normal AMM swap fee.",
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          {
            "@type": "ListItem",
            position: 1,
            name: "NivoraFi",
            item: baseUrl,
          },
          {
            "@type": "ListItem",
            position: 2,
            name: "Pools",
            item: `${baseUrl}/pools`,
          },
          {
            "@type": "ListItem",
            position: 3,
            name: market.name,
            item: marketUrl,
          },
        ],
      },
    ],
  };
}

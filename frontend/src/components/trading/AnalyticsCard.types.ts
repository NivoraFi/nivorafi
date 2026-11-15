export interface ApyDataPoint {
  timestamp: number;     // Unix epoch seconds
  apyPct: number;        // e.g. 5.42
  ledger?: number;       // Stellar ledger sequence
  ptPriceInSy?: number;  // Price ratio (SY per PT)
}

export interface MarketAnalyticsData {
  impliedApyPct: number;
  apyChange24hPct?: number;
  volume24hUsdc: bigint;        // Stroops (10^7)
  totalVolumeUsdc: bigint;       // Stroops (10^7)
  totalTvlUsdc: bigint;          // Stroops (10^7)
  totalSwapsCount: number;
  totalTransactionsCount: number;
  apyHistory: ApyDataPoint[];
  lastIndexedLedger: number;
  isLoading?: boolean;
}

export type AnalyticsTimeframe = "24H" | "7D" | "30D" | "ALL";

export interface AnalyticsCardProps {
  analytics: MarketAnalyticsData | null;
  daysToMaturity?: number;
  loading?: boolean;
  selectedTimeframe?: AnalyticsTimeframe;
  onTimeframeChange?: (tf: AnalyticsTimeframe) => void;
  className?: string;
}

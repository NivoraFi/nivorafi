import { ENV } from "@/lib/env";
import type { MarketDefinition } from "@/lib/markets";
import type { LiveUserPortfolio } from "@/lib/stellar";
import type {
  UserMarketPosition,
  UserPositionsResponse,
  UserPositionsSummary,
} from "@/lib/indexerAnalytics";

const PORTFOLIO_CACHE_PREFIX = "stellar_pendle_portfolio_cache_v1:";
const WALLET_SESSION_KEY = "stellar_pendle_wallet_session";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface SerializedPortfolioEntry {
  address: string;
  accountExists: boolean;
  xlmBalance: string;
  usdcBalance: string;
  usdcTrustlineExists: boolean;
  syBalance: string;
  ptBalance: string;
  ytBalance: string;
  lpBalance: string;
  lastIndex: string;
  unclaimedYieldRaw: string;
  estimatedPendingYieldSy: string;
}

interface SerializedPortfolioEnvelope {
  savedAt: number;
  entries: Record<string, SerializedPortfolioEntry>;
}

export interface FastIndexerProbeResult {
  reachable: boolean;
  response: UserPositionsResponse | null;
}

export function parseStroopsSafe(raw: string | number | bigint | null | undefined): bigint {
  if (typeof raw === "bigint") return raw >= 0n ? raw : 0n;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return 0n;
    return BigInt(Math.floor(raw));
  }
  if (typeof raw !== "string") return 0n;
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) {
    const asFloat = Number(trimmed);
    if (Number.isFinite(asFloat) && asFloat > 0) {
      return BigInt(Math.floor(asFloat));
    }
    return 0n;
  }
  try {
    const val = BigInt(trimmed);
    return val >= 0n ? val : 0n;
  } catch {
    return 0n;
  }
}

export function hasStoredWalletSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(WALLET_SESSION_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { address?: unknown; mode?: unknown };
    return (
      typeof parsed?.address === "string" &&
      /^G[A-Z0-9]{55}$/.test(parsed.address) &&
      (parsed.mode === "wallet" || parsed.mode === "watch")
    );
  } catch {
    return false;
  }
}

export function serializePortfolioMap(
  map: Record<string, LiveUserPortfolio>,
  savedAt: number = Date.now()
): string {
  const entries: Record<string, SerializedPortfolioEntry> = {};
  for (const [marketId, p] of Object.entries(map)) {
    if (!p) continue;
    entries[marketId] = {
      address: p.address,
      accountExists: Boolean(p.accountExists),
      xlmBalance: String(p.xlmBalance ?? "0"),
      usdcBalance: String(p.usdcBalance ?? "0"),
      usdcTrustlineExists: Boolean(p.usdcTrustlineExists),
      syBalance: (p.syBalance ?? 0n).toString(),
      ptBalance: (p.ptBalance ?? 0n).toString(),
      ytBalance: (p.ytBalance ?? 0n).toString(),
      lpBalance: (p.lpBalance ?? 0n).toString(),
      lastIndex: (p.lastIndex ?? 0n).toString(),
      unclaimedYieldRaw: (p.unclaimedYieldRaw ?? 0n).toString(),
      estimatedPendingYieldSy: (p.estimatedPendingYieldSy ?? 0n).toString(),
    };
  }
  const envelope: SerializedPortfolioEnvelope = { savedAt, entries };
  return JSON.stringify(envelope);
}

export function deserializePortfolioMap(
  rawJson: string | null | undefined,
  nowMs: number = Date.now()
): { savedAt: number; portfolios: Record<string, LiveUserPortfolio> } | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as Partial<SerializedPortfolioEnvelope>;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.savedAt !== "number" ||
      !parsed.entries ||
      typeof parsed.entries !== "object"
    ) {
      return null;
    }
    if (nowMs - parsed.savedAt > CACHE_MAX_AGE_MS) {
      return null;
    }

    const portfolios: Record<string, LiveUserPortfolio> = {};
    for (const [marketId, item] of Object.entries(parsed.entries)) {
      if (!item || typeof item !== "object") continue;
      portfolios[marketId] = {
        address: String(item.address ?? ""),
        accountExists: Boolean(item.accountExists),
        xlmBalance: String(item.xlmBalance ?? "0"),
        usdcBalance: String(item.usdcBalance ?? "0"),
        usdcTrustlineExists: Boolean(item.usdcTrustlineExists),
        syBalance: parseStroopsSafe(item.syBalance),
        ptBalance: parseStroopsSafe(item.ptBalance),
        ytBalance: parseStroopsSafe(item.ytBalance),
        lpBalance: parseStroopsSafe(item.lpBalance),
        lastIndex: parseStroopsSafe(item.lastIndex),
        unclaimedYieldRaw: parseStroopsSafe(item.unclaimedYieldRaw),
        estimatedPendingYieldSy: parseStroopsSafe(item.estimatedPendingYieldSy),
      };
    }

    return { savedAt: parsed.savedAt, portfolios };
  } catch {
    return null;
  }
}

export function loadCachedPortfolioSnapshot(
  address: string | null | undefined
): { savedAt: number; portfolios: Record<string, LiveUserPortfolio> } | null {
  if (typeof window === "undefined" || !address) return null;
  try {
    const raw = window.localStorage.getItem(`${PORTFOLIO_CACHE_PREFIX}${address.trim()}`);
    return deserializePortfolioMap(raw);
  } catch {
    return null;
  }
}

export function saveCachedPortfolioSnapshot(
  address: string | null | undefined,
  portfolios: Record<string, LiveUserPortfolio>
): void {
  if (typeof window === "undefined" || !address) return;
  try {
    const serialized = serializePortfolioMap(portfolios);
    window.localStorage.setItem(`${PORTFOLIO_CACHE_PREFIX}${address.trim()}`, serialized);
  } catch {
    // ignore storage quota errors
  }
}

export function mapIndexedPositionsToPortfolios(
  userAddress: string,
  indexedPositions: UserMarketPosition[],
  markets: MarketDefinition[],
  fallbackPortfolios?: Record<string, LiveUserPortfolio> | null
): Record<string, LiveUserPortfolio> {
  const result: Record<string, LiveUserPortfolio> = {};
  const byMarketId = new Map<string, UserMarketPosition>();
  const byPoolAddress = new Map<string, UserMarketPosition>();

  for (const pos of indexedPositions) {
    if (!pos || typeof pos !== "object") continue;
    if (pos.marketId) byMarketId.set(pos.marketId, pos);
    if (pos.marketAddress) byPoolAddress.set(pos.marketAddress, pos);
  }

  for (const m of markets) {
    const idx = byMarketId.get(m.id) ?? byPoolAddress.get(m.contracts.poolId);
    const cached = fallbackPortfolios?.[m.id];

    result[m.id] = {
      address: userAddress,
      accountExists: cached?.accountExists ?? true,
      xlmBalance: cached?.xlmBalance ?? "0",
      usdcBalance: cached?.usdcBalance ?? "0",
      usdcTrustlineExists: cached?.usdcTrustlineExists ?? true,
      syBalance: cached?.syBalance ?? 0n,
      ptBalance: idx ? parseStroopsSafe(idx.currentPtBalance) : (cached?.ptBalance ?? 0n),
      ytBalance: idx ? parseStroopsSafe(idx.currentYtBalance) : (cached?.ytBalance ?? 0n),
      lpBalance: idx ? parseStroopsSafe(idx.currentLpBalance) : (cached?.lpBalance ?? 0n),
      lastIndex: cached?.lastIndex ?? 0n,
      unclaimedYieldRaw: cached?.unclaimedYieldRaw ?? 0n,
      estimatedPendingYieldSy: cached?.estimatedPendingYieldSy ?? 0n,
    };
  }

  return result;
}

export async function probeIndexerPositionsFast({
  userAddress,
  indexerApiUrl,
  timeoutMs = 900,
  fetchImpl = fetch,
}: {
  userAddress: string;
  indexerApiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<FastIndexerProbeResult> {
  const trimmed = userAddress?.trim();
  if (!trimmed) {
    return { reachable: false, response: null };
  }

  const baseUrl = (indexerApiUrl || ENV.indexerApiUrl || "/api/indexer").replace(
    /\/+$/,
    ""
  );
  const url = `${baseUrl}/positions?user=${encodeURIComponent(trimmed)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      return { reachable: false, response: null };
    }

    const json = (await res.json()) as Partial<UserPositionsResponse>;
    if (!json || typeof json !== "object") {
      return { reachable: false, response: null };
    }

    const rawPositions = Array.isArray(json.positions) ? json.positions : [];
    const positions: UserMarketPosition[] = rawPositions
      .filter((p): p is UserMarketPosition => Boolean(p && typeof p === "object" && p.marketId))
      .map((p) => ({
        marketId: String(p.marketId || ""),
        marketAddress: String(p.marketAddress || ""),
        assetCode: String(p.assetCode || "USDC"),
        costBasisStroops: String(p.costBasisStroops || "0"),
        costBasisUsd: Number(p.costBasisUsd) || 0,
        averageEntryApy: Number(p.averageEntryApy) || 0,
        currentPtBalance: String(p.currentPtBalance || "0"),
        currentYtBalance: String(p.currentYtBalance || "0"),
        currentLpBalance: String(p.currentLpBalance || "0"),
        currentPositionValueUsd: Number(p.currentPositionValueUsd) || 0,
        realizedPnlStroops: String(p.realizedPnlStroops || "0"),
        realizedPnlUsd: Number(p.realizedPnlUsd) || 0,
        unrealizedPnlStroops: String(p.unrealizedPnlStroops || "0"),
        unrealizedPnlUsd: Number(p.unrealizedPnlUsd) || 0,
        netPnlUsd: Number(p.netPnlUsd) || 0,
        cumulativeClaimedYieldStroops: String(p.cumulativeClaimedYieldStroops || "0"),
        cumulativeClaimedYieldUsd: Number(p.cumulativeClaimedYieldUsd) || 0,
        firstTradeTimestamp: Number(p.firstTradeTimestamp) || 0,
        lastActivityTimestamp: Number(p.lastActivityTimestamp) || 0,
        totalTradesCount: Number(p.totalTradesCount) || 0,
      }));

    const rawSummary = json.summary && typeof json.summary === "object" ? json.summary : null;
    const summary: UserPositionsSummary = {
      userAddress: rawSummary?.userAddress || trimmed,
      totalCostBasisUsd: Number(rawSummary?.totalCostBasisUsd) || 0,
      totalCurrentValueUsd: Number(rawSummary?.totalCurrentValueUsd) || 0,
      totalRealizedPnlUsd: Number(rawSummary?.totalRealizedPnlUsd) || 0,
      totalUnrealizedPnlUsd: Number(rawSummary?.totalUnrealizedPnlUsd) || 0,
      totalNetPnlUsd: Number(rawSummary?.totalNetPnlUsd) || 0,
      totalClaimedYieldUsd: Number(rawSummary?.totalClaimedYieldUsd) || 0,
      overallPortfolioApy: Number(rawSummary?.overallPortfolioApy) || 0,
      activePositionsCount: Number(rawSummary?.activePositionsCount) || positions.length,
      totalTransactionsCount: Number(rawSummary?.totalTransactionsCount) || 0,
    };

    return {
      reachable: true,
      response: {
        success: Boolean(json.success ?? true),
        user: trimmed,
        count: positions.length,
        positions,
        summary,
      },
    };
  } catch {
    return { reachable: false, response: null };
  } finally {
    clearTimeout(timer);
  }
}

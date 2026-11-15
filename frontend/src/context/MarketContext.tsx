"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams } from "next/navigation";
import {
  PRESET_MARKETS,
  MarketDefinition,
  MarketSummaryMetrics,
  calculateDaysToMaturity,
  findMarketById,
  getAssetPriceUsd,
  getMarketBaselineMetrics,
} from "@/lib/markets";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  fetchMarketSnapshot,
  fetchUserPortfolio,
} from "@/lib/stellar";
import { useWallet } from "./WalletProvider";

export function buildFallbackSnapshot(m: MarketDefinition): LiveMarketSnapshot {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const isMatured = nowSeconds >= m.maturity;
  const daysToMaturity = calculateDaysToMaturity(m.maturity, nowSeconds);
  const ptReserve = 80_000_0000000n;
  const syReserve = 40_000_0000000n;
  const baseline = getMarketBaselineMetrics(m, nowSeconds);
  return {
    state: {
      total_pt_reserve: ptReserve,
      total_sy_reserve: syReserve,
      total_lp_supply: 56_568_5424949n,
      scalar_root: 50_000000000000000000n,
      initial_anchor: 1_020000000000000000n,
      annual_fee_rate: 3_000000000000000n,
      protocol_fee_bps: 2000n,
      fee_recipient: m.contracts.poolId,
      maturity: BigInt(m.maturity),
      maturity_index: 1_000000000n,
      is_settled: isMatured,
    },
    latestLedger: 0,
    nowSeconds,
    daysToMaturity,
    isMatured,
    blendExchangeRate: 1_001000000n,
    ammExchangeRateWad: 1_020408163265306122n,
    ptPriceInSy: baseline.ptPriceInSy,
    ytPriceInSy: isMatured ? 0.0 : Number(Math.max(0, 1.0 - baseline.ptPriceInSy).toFixed(4)),
    impliedFixedApyPct: baseline.impliedApyPct,
    ptTotalSupply: ptReserve,
    ytTotalSupply: ptReserve,
    syTotalSupply: ptReserve + syReserve,
    ptProportionPct: 66.67,
  };
}

export function deriveMetricsFromSnapshot(
  market: MarketDefinition,
  snap: LiveMarketSnapshot
): MarketSummaryMetrics {
  const baseline = getMarketBaselineMetrics(market, snap.nowSeconds);
  if (!market.isRegisteredOnChain) {
    return baseline;
  }

  const hasOnChainLiquidity =
    snap.state.total_pt_reserve + snap.state.total_sy_reserve > 0n;

  if (hasOnChainLiquidity) {
    const ptTokens = Number(snap.state.total_pt_reserve) / 1e7;
    const syTokens = Number(snap.state.total_sy_reserve) / 1e7;
    const tvlUsd =
      (ptTokens * snap.ptPriceInSy + syTokens) *
      getAssetPriceUsd(market.asset.code);

    return {
      marketId: market.id,
      status: snap.isMatured ? "MATURED" : "ACTIVE",
      daysToMaturity: snap.daysToMaturity,
      impliedApyPct: snap.impliedFixedApyPct,
      blendRate: Number(snap.blendExchangeRate) / 1e9,
      ptPriceInSy: snap.ptPriceInSy,
      tvlSy: snap.state.total_pt_reserve + snap.state.total_sy_reserve,
      tvlUsd,
      ptReserve: snap.state.total_pt_reserve,
      syReserve: snap.state.total_sy_reserve,
      isMatured: snap.isMatured,
      isLoading: false,
    };
  } else {
    return {
      ...baseline,
      status: snap.isMatured ? "MATURED" : "ACTIVE",
      daysToMaturity: snap.daysToMaturity,
      isMatured: snap.isMatured,
      impliedApyPct:
        snap.impliedFixedApyPct > 0
          ? snap.impliedFixedApyPct
          : baseline.impliedApyPct,
      ptPriceInSy:
        snap.ptPriceInSy > 0 ? snap.ptPriceInSy : baseline.ptPriceInSy,
      isLoading: false,
    };
  }
}

export interface MarketContextValue {
  markets: MarketDefinition[];
  activeMarket: MarketDefinition;
  activeMarketId: string;
  selectMarket: (id: string) => void;
  activeSnapshot: LiveMarketSnapshot | null;
  activePortfolio: LiveUserPortfolio | null;
  loadingSnapshot: boolean;
  loadingPortfolio: boolean;
  marketMetrics: Record<string, MarketSummaryMetrics>;
  refreshActiveMarket: () => Promise<void>;
  refreshAllMetrics: () => Promise<void>;
}

export interface MarketProviderProps {
  children: React.ReactNode;
  initialMarketId?: string;
}

export const MarketContext = createContext<MarketContextValue | null>(null);

const STORAGE_KEY = "stellar_pendle_active_market";

export function MarketProvider({ children, initialMarketId }: MarketProviderProps) {
  const existing = useContext(MarketContext);
  if (existing && !initialMarketId) {
    return <>{children}</>;
  }

  return (
    <MarketProviderInner initialMarketId={initialMarketId}>
      {children}
    </MarketProviderInner>
  );
}

function MarketProviderInner({ children, initialMarketId }: MarketProviderProps) {
  const { address } = useWallet();
  const [markets] = useState<MarketDefinition[]>(PRESET_MARKETS);

  let rawParams: Record<string, string | string[] | undefined> | null = null;
  try {
    rawParams = useParams() as Record<string, string | string[] | undefined> | null;
  } catch {
    rawParams = null;
  }

  const routeParamId = useMemo(() => {
    if (!rawParams) return null;
    const raw = rawParams.market ?? rawParams.id;
    if (typeof raw === "string") {
      const match = PRESET_MARKETS.find(
        (m) => m.id.toLowerCase() === raw.trim().toLowerCase()
      );
      if (match) return match.id;
    }
    return null;
  }, [rawParams]);

  const resolvedInitialId = useMemo(() => {
    if (routeParamId) return routeParamId;
    if (initialMarketId) {
      const match = PRESET_MARKETS.find(
        (m) => m.id.toLowerCase() === initialMarketId.trim().toLowerCase()
      );
      if (match) return match.id;
    }
    return PRESET_MARKETS[0].id;
  }, [routeParamId, initialMarketId]);

  const [activeMarketId, setActiveMarketId] = useState<string>(resolvedInitialId);

  const initialMarketDef = useMemo(() => {
    return findMarketById(resolvedInitialId, markets);
  }, [resolvedInitialId, markets]);

  const [activeSnapshot, setActiveSnapshot] = useState<LiveMarketSnapshot | null>(() =>
    buildFallbackSnapshot(initialMarketDef)
  );
  const [activePortfolio, setActivePortfolio] = useState<LiveUserPortfolio | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState<boolean>(true);
  const [loadingPortfolio, setLoadingPortfolio] = useState<boolean>(false);
  const snapshotCacheRef = useRef<Record<string, LiveMarketSnapshot>>({});
  const portfolioCacheRef = useRef<Record<string, LiveUserPortfolio>>({});
  const activeMarketIdRef = useRef<string>(resolvedInitialId);
  activeMarketIdRef.current = activeMarketId;

  const [marketMetrics, setMarketMetrics] = useState<Record<string, MarketSummaryMetrics>>(() => {
    const initial: Record<string, MarketSummaryMetrics> = {};
    const now = Math.floor(Date.now() / 1000);
    for (const m of PRESET_MARKETS) {
      initial[m.id] = getMarketBaselineMetrics(m, now);
    }
    return initial;
  });

  // Synchronize state strictly when the URL route param itself changes (e.g. Back/Forward navigation),
  // without reverting optimistic user selections made via selectMarket() while router.push() is in flight.
  const prevRouteParamRef = useRef<string | null>(routeParamId);
  useEffect(() => {
    if (prevRouteParamRef.current === routeParamId) return;
    prevRouteParamRef.current = routeParamId;

    if (routeParamId && routeParamId !== activeMarketIdRef.current) {
      activeMarketIdRef.current = routeParamId;
      setActiveMarketId(routeParamId);
      const target = markets.find((m) => m.id === routeParamId);
      if (target) {
        setActiveSnapshot(snapshotCacheRef.current[routeParamId] ?? buildFallbackSnapshot(target));
      }
    }
  }, [routeParamId, markets]);

  // Read URL search param or localStorage on mount strictly when no route param is active
  useEffect(() => {
    if (typeof window === "undefined" || routeParamId) return;
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("market");
    const fromStorage = localStorage.getItem(STORAGE_KEY);

    const targetId = fromUrl || fromStorage;
    if (targetId && markets.some((m) => m.id === targetId)) {
      activeMarketIdRef.current = targetId;
      setActiveMarketId(targetId);
      const target = markets.find((m) => m.id === targetId);
      if (target) {
        setActiveSnapshot(snapshotCacheRef.current[targetId] ?? buildFallbackSnapshot(target));
      }
    }
  }, [markets, routeParamId]);

  const activeMarket = useMemo(() => {
    return findMarketById(activeMarketId, markets);
  }, [activeMarketId, markets]);

  const selectMarket = useCallback(
    (id: string) => {
      const target = markets.find((m) => m.id === id);
      if (!target) return;
      activeMarketIdRef.current = id;
      setActiveMarketId(id);
      setActiveSnapshot(snapshotCacheRef.current[id] ?? buildFallbackSnapshot(target));
      if (address) {
        const cachedPort = portfolioCacheRef.current[`${address}:${id}`];
        if (cachedPort) {
          setActivePortfolio(cachedPort);
        }
      }
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem(STORAGE_KEY, id);
          const currentPath = window.location.pathname;
          if (!currentPath.startsWith("/trade/") && !currentPath.startsWith("/markets/")) {
            const url = new URL(window.location.href);
            url.searchParams.set("market", id);
            window.history.replaceState(window.history.state, "", url.toString());
          }
        } catch {
          // ignore storage or history error
        }
      }
    },
    [markets, address]
  );

  const refreshSnapshot = useCallback(async () => {
    const targetMarket = activeMarket;
    setLoadingSnapshot(true);

    if (!targetMarket.isRegisteredOnChain) {
      const fallback = buildFallbackSnapshot(targetMarket);
      snapshotCacheRef.current[targetMarket.id] = fallback;
      if (activeMarketIdRef.current === targetMarket.id) {
        setActiveSnapshot(fallback);
        setLoadingSnapshot(false);
      }
      setMarketMetrics((prev) => ({
        ...prev,
        [targetMarket.id]: getMarketBaselineMetrics(targetMarket),
      }));
      return;
    }

    try {
      const snap = await fetchMarketSnapshot(targetMarket);
      if (snap.state.total_pt_reserve + snap.state.total_sy_reserve === 0n) {
        const baseline = getMarketBaselineMetrics(targetMarket, snap.nowSeconds);
        const hydratedSnap: LiveMarketSnapshot = {
          ...snap,
          state: {
            ...snap.state,
            total_pt_reserve: baseline.ptReserve,
            total_sy_reserve: baseline.syReserve,
          },
          syTotalSupply: baseline.tvlSy,
          ptTotalSupply: baseline.ptReserve,
          ytTotalSupply: baseline.ptReserve,
          ptProportionPct: Number(
            ((Number(baseline.ptReserve) / Number(baseline.tvlSy)) * 100).toFixed(2)
          ),
        };
        snapshotCacheRef.current[targetMarket.id] = hydratedSnap;
        if (activeMarketIdRef.current === targetMarket.id) {
          setActiveSnapshot(hydratedSnap);
        }
      } else {
        snapshotCacheRef.current[targetMarket.id] = snap;
        if (activeMarketIdRef.current === targetMarket.id) {
          setActiveSnapshot(snap);
        }
      }

      // Update active market metrics with live data
      const derived = deriveMetricsFromSnapshot(targetMarket, snap);
      setMarketMetrics((prev) => ({
        ...prev,
        [targetMarket.id]: derived,
      }));
    } catch {
      // In dry-run / network error, retain fallback metrics and snapshot
      if (activeMarketIdRef.current === targetMarket.id) {
        setActiveSnapshot(
          (prev) => prev ?? snapshotCacheRef.current[targetMarket.id] ?? buildFallbackSnapshot(targetMarket)
        );
      }
    } finally {
      if (activeMarketIdRef.current === targetMarket.id) {
        setLoadingSnapshot(false);
      }
    }
  }, [activeMarket]);

  const hydrateRegisteredPools = useCallback(async () => {
    const registered = markets.filter((m) => m.isRegisteredOnChain);
    const results = await Promise.allSettled(
      registered.map(async (m) => {
        const snap = await fetchMarketSnapshot(m);
        return { market: m, snap };
      })
    );

    const updates: Record<string, MarketSummaryMetrics> = {};
    for (const res of results) {
      if (res.status === "fulfilled") {
        const { market, snap } = res.value;
        if (snap.state.total_pt_reserve + snap.state.total_sy_reserve === 0n) {
          const baseline = getMarketBaselineMetrics(market, snap.nowSeconds);
          const hydratedSnap: LiveMarketSnapshot = {
            ...snap,
            state: {
              ...snap.state,
              total_pt_reserve: baseline.ptReserve,
              total_sy_reserve: baseline.syReserve,
            },
            syTotalSupply: baseline.tvlSy,
            ptTotalSupply: baseline.ptReserve,
            ytTotalSupply: baseline.ptReserve,
            ptProportionPct: Number(
              ((Number(baseline.ptReserve) / Number(baseline.tvlSy)) * 100).toFixed(2)
            ),
          };
          snapshotCacheRef.current[market.id] = hydratedSnap;
        } else {
          snapshotCacheRef.current[market.id] = snap;
        }

        updates[market.id] = deriveMetricsFromSnapshot(market, snap);
      }
    }

    if (Object.keys(updates).length > 0) {
      setMarketMetrics((prev) => ({
        ...prev,
        ...updates,
      }));
    }
  }, [markets]);

  const refreshPortfolio = useCallback(async () => {
    const targetMarket = activeMarket;
    if (address) {
      setLoadingPortfolio(true);
      try {
        const port = await fetchUserPortfolio(address, targetMarket);
        portfolioCacheRef.current[`${address}:${targetMarket.id}`] = port;
        if (activeMarketIdRef.current === targetMarket.id) {
          setActivePortfolio(port);
        }
      } catch {
        if (activeMarketIdRef.current === targetMarket.id) {
          setActivePortfolio((prev) => portfolioCacheRef.current[`${address}:${targetMarket.id}`] ?? prev ?? null);
        }
      } finally {
        if (activeMarketIdRef.current === targetMarket.id) {
          setLoadingPortfolio(false);
        }
      }
    } else {
      setActivePortfolio(null);
    }
  }, [activeMarket, address]);

  const refreshActiveMarket = useCallback(async () => {
    await Promise.all([refreshSnapshot(), refreshPortfolio()]);
  }, [refreshSnapshot, refreshPortfolio]);

  const refreshAllMetrics = useCallback(async () => {
    const now = Math.floor(Date.now() / 1000);
    // Refresh active market live
    await refreshActiveMarket();

    // Hydrate all registered pools
    await hydrateRegisteredPools();

    // Re-evaluate temporal boundaries for all other preset markets
    setMarketMetrics((prev) => {
      const next = { ...prev };
      for (const m of markets) {
        const isMatured = now >= m.maturity;
        const current = next[m.id];
        if (current) {
          next[m.id] = {
            ...current,
            status: isMatured ? "MATURED" : "ACTIVE",
            daysToMaturity: calculateDaysToMaturity(m.maturity, now),
            isMatured,
          };
        }
      }
      return next;
    });
  }, [markets, refreshActiveMarket, hydrateRegisteredPools]);

  // Hydrate all registered pools on mount
  useEffect(() => {
    void hydrateRegisteredPools();
  }, [hydrateRegisteredPools]);

  // Trigger snapshot refresh when active market changes
  useEffect(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  // Trigger portfolio refresh when active market or wallet address changes
  useEffect(() => {
    void refreshPortfolio();
  }, [refreshPortfolio]);

  const value = useMemo(
    () => ({
      markets,
      activeMarket,
      activeMarketId,
      selectMarket,
      activeSnapshot,
      activePortfolio,
      loadingSnapshot,
      loadingPortfolio,
      marketMetrics,
      refreshActiveMarket,
      refreshAllMetrics,
    }),
    [
      markets,
      activeMarket,
      activeMarketId,
      selectMarket,
      activeSnapshot,
      activePortfolio,
      loadingSnapshot,
      loadingPortfolio,
      marketMetrics,
      refreshActiveMarket,
      refreshAllMetrics,
    ]
  );

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

const DEFAULT_MARKET_CONTEXT: MarketContextValue = {
  markets: PRESET_MARKETS,
  activeMarket: PRESET_MARKETS[0],
  activeMarketId: PRESET_MARKETS[0].id,
  selectMarket: () => {},
  activeSnapshot: null,
  activePortfolio: null,
  loadingSnapshot: false,
  loadingPortfolio: false,
  marketMetrics: {},
  refreshActiveMarket: async () => {},
  refreshAllMetrics: async () => {},
};

export function useMarket(): MarketContextValue {
  const ctx = useContext(MarketContext);
  if (!ctx) {
    return DEFAULT_MARKET_CONTEXT;
  }
  return ctx;
}

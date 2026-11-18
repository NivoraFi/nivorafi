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
  deriveMarketStatus,
  findMarketById,
  getAssetPriceUsd,
} from "@/lib/markets";
import {
  LiveMarketSnapshot,
  LiveUserPortfolio,
  fetchMarketSnapshot,
  fetchUserPortfolio,
} from "@/lib/stellar";
import { decodeSorobanError } from "@/lib/math";
import { useWallet } from "./WalletProvider";

function createZeroMarketMetrics(
  market: MarketDefinition,
  nowSeconds: number,
  isLoading: boolean
): MarketSummaryMetrics {
  const isMatured = nowSeconds >= market.maturity;
  return {
    marketId: market.id,
    status: deriveMarketStatus(market.maturity, nowSeconds),
    daysToMaturity: calculateDaysToMaturity(market.maturity, nowSeconds),
    impliedApyPct: 0,
    blendRate: 0,
    ptPriceInSy: isMatured ? 1.0 : 0,
    tvlSy: 0n,
    tvlUsd: 0,
    ptReserve: 0n,
    syReserve: 0n,
    isMatured,
    isLoading,
  };
}

export function deriveMetricsFromSnapshot(
  market: MarketDefinition,
  snap: LiveMarketSnapshot
): MarketSummaryMetrics {
  const ptTokens = Number(snap.state.total_pt_reserve) / 1e7;
  const syTokens = Number(snap.state.total_sy_reserve) / 1e7;
  const hasLiquidity = snap.state.total_pt_reserve + snap.state.total_sy_reserve > 0n;
  const tvlUsd = hasLiquidity
    ? (ptTokens * snap.ptPriceInSy + syTokens) * getAssetPriceUsd(market.asset.code)
    : 0;

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
  snapshotError: string | null;
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

function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = "name" in err ? String((err as { name?: unknown }).name) : "";
  const msg = "message" in err ? String((err as { message?: unknown }).message) : "";
  return name === "AbortError" || msg.includes("The operation was aborted");
}

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

  const [activeSnapshot, setActiveSnapshot] = useState<LiveMarketSnapshot | null>(null);
  const [activePortfolio, setActivePortfolio] = useState<LiveUserPortfolio | null>(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState<boolean>(true);
  const [loadingPortfolio, setLoadingPortfolio] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const snapshotCacheRef = useRef<Record<string, LiveMarketSnapshot>>({});
  const portfolioCacheRef = useRef<Record<string, LiveUserPortfolio>>({});
  const activeMarketIdRef = useRef<string>(resolvedInitialId);
  activeMarketIdRef.current = activeMarketId;
  const addressRef = useRef<string | null>(address);
  addressRef.current = address;
  const mountedRef = useRef<boolean>(true);
  const snapshotSeqRef = useRef<number>(0);
  const portfolioSeqRef = useRef<number>(0);
  const hydrateSeqRef = useRef<number>(0);
  const snapshotAbortRef = useRef<AbortController | null>(null);
  const portfolioAbortRef = useRef<AbortController | null>(null);
  const hydrateAbortRef = useRef<AbortController | null>(null);

  const [marketMetrics, setMarketMetrics] = useState<Record<string, MarketSummaryMetrics>>(() => {
    const initial: Record<string, MarketSummaryMetrics> = {};
    const now = Math.floor(Date.now() / 1000);
    for (const m of PRESET_MARKETS) {
      initial[m.id] = createZeroMarketMetrics(m, now, m.isRegisteredOnChain);
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
      setSnapshotError(null);
      const target = markets.find((m) => m.id === routeParamId);
      if (target) {
        setActiveSnapshot(snapshotCacheRef.current[routeParamId] ?? null);
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
        setActiveSnapshot(snapshotCacheRef.current[targetId] ?? null);
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
      setSnapshotError(null);
      setActiveSnapshot(snapshotCacheRef.current[id] ?? null);
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
    snapshotAbortRef.current?.abort();
    const controller = new AbortController();
    snapshotAbortRef.current = controller;
    const seq = ++snapshotSeqRef.current;

    const isStale = () =>
      !mountedRef.current ||
      controller.signal.aborted ||
      snapshotSeqRef.current !== seq ||
      activeMarketIdRef.current !== targetMarket.id;

    setLoadingSnapshot(true);
    setSnapshotError(null);

    if (!targetMarket.isRegisteredOnChain) {
      const now = Math.floor(Date.now() / 1000);
      if (!isStale()) {
        setActiveSnapshot(null);
        setLoadingSnapshot(false);
        setMarketMetrics((prev) => ({
          ...prev,
          [targetMarket.id]: createZeroMarketMetrics(targetMarket, now, false),
        }));
      }
      return;
    }

    try {
      const snap = await fetchMarketSnapshot(targetMarket, { signal: controller.signal });
      if (isStale()) return;
      snapshotCacheRef.current[targetMarket.id] = snap;
      setActiveSnapshot(snap);
      setSnapshotError(null);

      // Update active market metrics with live data
      const derived = deriveMetricsFromSnapshot(targetMarket, snap);
      setMarketMetrics((prev) => ({
        ...prev,
        [targetMarket.id]: derived,
      }));
    } catch (err: unknown) {
      if (isStale() || isAbortLikeError(err)) return;
      const msg = decodeSorobanError(err);
      const now = Math.floor(Date.now() / 1000);
      setSnapshotError(msg);
      setActiveSnapshot((prev) => prev ?? snapshotCacheRef.current[targetMarket.id] ?? null);
      setMarketMetrics((prev) => {
        const existing = prev[targetMarket.id];
        if (existing && !existing.isLoading) return prev;
        return {
          ...prev,
          [targetMarket.id]: createZeroMarketMetrics(targetMarket, now, false),
        };
      });
    } finally {
      if (!isStale()) {
        setLoadingSnapshot(false);
      }
    }
  }, [activeMarket]);

  const hydrateRegisteredPools = useCallback(async () => {
    hydrateAbortRef.current?.abort();
    const controller = new AbortController();
    hydrateAbortRef.current = controller;
    const seq = ++hydrateSeqRef.current;

    const isStale = () =>
      !mountedRef.current || controller.signal.aborted || hydrateSeqRef.current !== seq;

    const registered = markets.filter((m) => m.isRegisteredOnChain);
    const results = await Promise.allSettled(
      registered.map(async (m) => {
        const snap = await fetchMarketSnapshot(m, { signal: controller.signal });
        return { market: m, snap };
      })
    );

    if (isStale()) return;

    const now = Math.floor(Date.now() / 1000);
    const updates: Record<string, MarketSummaryMetrics> = {};
    results.forEach((res, idx) => {
      const market = registered[idx]!;
      if (res.status === "fulfilled") {
        snapshotCacheRef.current[market.id] = res.value.snap;
        updates[market.id] = deriveMetricsFromSnapshot(market, res.value.snap);
      } else if (!isAbortLikeError(res.reason)) {
        updates[market.id] = createZeroMarketMetrics(market, now, false);
      }
    });

    if (Object.keys(updates).length > 0 && !isStale()) {
      setMarketMetrics((prev) => {
        const next = { ...prev };
        for (const [id, metric] of Object.entries(updates)) {
          const prevMetric = prev[id];
          if (metric.tvlSy === 0n && prevMetric && prevMetric.tvlSy > 0n) {
            continue;
          }
          next[id] = metric;
        }
        return next;
      });
    }
  }, [markets]);

  const refreshPortfolio = useCallback(async () => {
    const targetMarket = activeMarket;
    const targetAddress = address;
    portfolioAbortRef.current?.abort();

    if (!targetAddress) {
      portfolioSeqRef.current += 1;
      portfolioAbortRef.current = null;
      if (mountedRef.current) {
        setActivePortfolio(null);
        setLoadingPortfolio(false);
      }
      return;
    }

    const controller = new AbortController();
    portfolioAbortRef.current = controller;
    const seq = ++portfolioSeqRef.current;

    const isStale = () =>
      !mountedRef.current ||
      controller.signal.aborted ||
      portfolioSeqRef.current !== seq ||
      activeMarketIdRef.current !== targetMarket.id ||
      addressRef.current !== targetAddress;

    setLoadingPortfolio(true);
    try {
      const port = await fetchUserPortfolio(targetAddress, targetMarket, {
        signal: controller.signal,
      });
      if (isStale()) return;
      portfolioCacheRef.current[`${targetAddress}:${targetMarket.id}`] = port;
      setActivePortfolio(port);
    } catch (err: unknown) {
      if (isStale() || isAbortLikeError(err)) return;
      setActivePortfolio(
        (prev) => portfolioCacheRef.current[`${targetAddress}:${targetMarket.id}`] ?? prev ?? null
      );
    } finally {
      if (!isStale()) {
        setLoadingPortfolio(false);
      }
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

    if (!mountedRef.current) return;

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

  // Track mount lifecycle and abort all in-flight RPC/Horizon requests cleanly on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      hydrateAbortRef.current?.abort();
      snapshotAbortRef.current?.abort();
      portfolioAbortRef.current?.abort();
    };
  }, []);

  // Hydrate all registered pools on mount
  useEffect(() => {
    void hydrateRegisteredPools();
    return () => {
      hydrateAbortRef.current?.abort();
    };
  }, [hydrateRegisteredPools]);

  // Trigger snapshot refresh when active market changes
  useEffect(() => {
    void refreshSnapshot();
    return () => {
      snapshotAbortRef.current?.abort();
    };
  }, [refreshSnapshot]);

  // Trigger portfolio refresh when active market or wallet address changes
  useEffect(() => {
    void refreshPortfolio();
    return () => {
      portfolioAbortRef.current?.abort();
    };
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
      snapshotError,
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
      snapshotError,
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
  snapshotError: null,
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

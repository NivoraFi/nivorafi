"use client";

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { LiveMarketSnapshot } from "@/lib/stellar";
import { MarketAnalyticsData } from "@/components/trading/AnalyticsCard.types";
import { MarketDefinition } from "@/lib/markets";

// ============================================================================
// Types & Interfaces
// ============================================================================

export type ChartMode = "yield" | "price";
export type ChartTimeframe = "1D" | "1W" | "1M" | "ALL";

export interface ChartDataPoint {
  timestamp: number;
  impliedApy: number;
  underlyingApy: number;
  ptPrice: number;
  ytPrice: number;
  ledger?: number;
}

export interface InteractiveYieldChartProps {
  snapshot?: LiveMarketSnapshot | null;
  analytics?: MarketAnalyticsData | null;
  market?: MarketDefinition | null;
  data?: ChartDataPoint[];
  initialMode?: ChartMode;
  initialTimeframe?: ChartTimeframe;
  loading?: boolean;
  className?: string;
  height?: number;
  onModeChange?: (mode: ChartMode) => void;
  onTimeframeChange?: (timeframe: ChartTimeframe) => void;
}

// ============================================================================
// Helper Utilities
// ============================================================================

function formatTimestampLabel(timestampSec: number, timeframe: ChartTimeframe): string {
  const date = new Date(timestampSec * 1000);
  if (timeframe === "1D") {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatTooltipDateTime(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })} ${date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  })}`;
}

// ============================================================================
// Main Component
// ============================================================================

export function InteractiveYieldChart({
  snapshot,
  analytics,
  market,
  data: customData,
  initialMode = "yield",
  initialTimeframe = "1W",
  loading = false,
  className = "",
  height = 260,
  onModeChange,
  onTimeframeChange,
}: InteractiveYieldChartProps) {
  // 1. Unique IDs for SVG Gradients (React 19 SSR Safe)
  const cyanGradId = useId();
  const emeraldGradId = useId();

  // 2. Interactive State
  const [mode, setMode] = useState<ChartMode>(initialMode);
  const [timeframe, setTimeframe] = useState<ChartTimeframe>(initialTimeframe);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [hoverClientX, setHoverClientX] = useState<number | null>(null);
  const [isMounted, setIsMounted] = useState<boolean>(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const handleModeToggle = (nextMode: ChartMode) => {
    setMode(nextMode);
    onModeChange?.(nextMode);
  };

  const handleTimeframeSelect = (nextTf: ChartTimeframe) => {
    setTimeframe(nextTf);
    onTimeframeChange?.(nextTf);
  };

  // 3. Cache Last Valid Data Series to Prevent Flash During RPC Sync
  const lastValidSeriesRef = useRef<ChartDataPoint[]>([]);
  const lastValidMarketIdRef = useRef<string | undefined>(market?.id);
  if (lastValidMarketIdRef.current !== market?.id) {
    lastValidMarketIdRef.current = market?.id;
    lastValidSeriesRef.current = [];
  }

  // 4. Construct Unified Time-Series
  const rawSeries = useMemo<ChartDataPoint[]>(() => {
    if (customData && customData.length > 0) {
      return customData;
    }

    if (loading) {
      return lastValidSeriesRef.current;
    }

    const now = Math.floor(Date.now() / 1000);
    const maturity = snapshot?.state?.maturity
      ? Number(snapshot.state.maturity)
      : market?.maturity ?? now + 90 * 86400;

    const currentImplied = analytics?.impliedApyPct ?? (snapshot?.daysToMaturity && snapshot.daysToMaturity > 0 ? 8.45 : 0);
    const currentUnderlying = 5.40; // Default Blend Benchmark
    const currentPtPrice = snapshot?.ptPriceInSy ?? 0.98;
    const currentYtPrice = Math.max(0, 1.0 - currentPtPrice);

    const apyHist = analytics?.apyHistory;

    if (apyHist && apyHist.length > 0) {
      return apyHist.map((pt) => {
        const tauYears = Math.max(0, (maturity - pt.timestamp) / 31536000);
        const ptPrice = pt.ptPriceInSy ?? (tauYears > 0 ? Number((1 / Math.pow(1 + pt.apyPct / 100, tauYears)).toFixed(4)) : 1.0);
        const ytPrice = Number(Math.max(0, 1.0 - ptPrice).toFixed(4));
        return {
          timestamp: pt.timestamp,
          impliedApy: Number(pt.apyPct.toFixed(2)),
          underlyingApy: currentUnderlying,
          ptPrice,
          ytPrice,
          ledger: pt.ledger,
        };
      });
    }

    // Graceful Synthetic Baseline if no events indexed yet
    if (lastValidSeriesRef.current.length > 0) {
      return lastValidSeriesRef.current;
    }

    const sampleCount = 24;
    const duration = timeframe === "1D" ? 86400 : timeframe === "1W" ? 7 * 86400 : timeframe === "1M" ? 30 * 86400 : 90 * 86400;
    const step = duration / (sampleCount - 1);
    const startTime = now - duration;
    const isMaturedMarket = (snapshot?.isMatured ?? false) || now >= maturity || currentImplied <= 0;
    const ampScale = timeframe === "1D" ? 0.38 : timeframe === "1W" ? 0.65 : timeframe === "1M" ? 0.95 : 1.25;

    const synthetic: ChartDataPoint[] = [];
    for (let i = 0; i < sampleCount; i++) {
      const t = startTime + i * step;
      const isLast = i === sampleCount - 1;
      const progress = i / (sampleCount - 1);
      // Smooth deterministic harmonic wave vanishing at progress === 1 (exact live anchor at latest point)
      const envelope = 1 - progress;
      const waveImplied = isLast || isMaturedMarket
        ? 0
        : (Math.sin(progress * Math.PI * 3.2 + 0.6) * 0.62 + Math.cos(progress * Math.PI * 1.7) * 0.38) * ampScale * envelope;
      const waveUnderlying = isLast || isMaturedMarket
        ? 0
        : (Math.sin(progress * Math.PI * 2.4 + 1.5) * 0.55 + Math.cos(progress * Math.PI * 1.3 + 0.4) * 0.45) * (ampScale * 0.45) * envelope;

      const pointImplied = Number(Math.max(0, currentImplied + waveImplied).toFixed(2));
      const pointUnderlying = Number(Math.max(0, currentUnderlying + waveUnderlying).toFixed(2));

      const tau = Math.max(0, (maturity - t) / 31536000);
      const ptP = isLast
        ? Number(currentPtPrice.toFixed(4))
        : tau > 0 && !isMaturedMarket
        ? Number((1 / Math.pow(1 + pointImplied / 100, tau)).toFixed(4))
        : 1.0;
      const ytP = isLast
        ? Number(currentYtPrice.toFixed(4))
        : Number(Math.max(0, 1.0 - ptP).toFixed(4));

      synthetic.push({
        timestamp: Math.floor(t),
        impliedApy: pointImplied,
        underlyingApy: pointUnderlying,
        ptPrice: ptP,
        ytPrice: ytP,
      });
    }

    return synthetic;
  }, [customData, loading, analytics, snapshot, market, timeframe]);

  // Update Cache
  if (rawSeries.length > 0) {
    lastValidSeriesRef.current = rawSeries;
  }
  const effectiveSeries = rawSeries.length > 0 ? rawSeries : lastValidSeriesRef.current;

  // 5. Apply Timeframe Filter
  const filteredSeries = useMemo(() => {
    if (effectiveSeries.length === 0) return [];
    if (timeframe === "ALL") return effectiveSeries;

    const now = Math.floor(Date.now() / 1000);
    const windowSec = timeframe === "1D" ? 86400 : timeframe === "1W" ? 7 * 86400 : 30 * 86400;
    const cutoff = now - windowSec;

    const filtered = effectiveSeries.filter((pt) => pt.timestamp >= cutoff);
    return filtered.length >= 2 ? filtered : effectiveSeries;
  }, [effectiveSeries, timeframe]);

  // 6. SVG Virtual Dimensions & Coordinate Interpolation
  const width = 600;
  const paddingTop = 24;
  const paddingBottom = 24;
  const plotHeight = height - paddingTop - paddingBottom;

  const {
    cyanPath,
    cyanArea,
    emeraldPath,
    emeraldArea,
    points,
    yMin,
    yMax,
    yLabels,
  } = useMemo(() => {
    if (!filteredSeries || filteredSeries.length === 0) {
      return {
        cyanPath: "",
        cyanArea: "",
        emeraldPath: "",
        emeraldArea: "",
        points: [],
        yMin: 0,
        yMax: 0,
        yLabels: [],
      };
    }

    // Determine Y Bounds and Coordinate Mapping based on active mode
    let minV = Infinity;
    let maxV = -Infinity;
    let yLabels: { yRatio: number; text: string }[] = [];
    let pts: { x: number; yCyan: number; yEmerald: number; data: ChartDataPoint }[] = [];
    const midBandBaseline = paddingTop + plotHeight * 0.48;

    if (mode === "yield") {
      filteredSeries.forEach((pt) => {
        minV = Math.min(minV, pt.impliedApy, pt.underlyingApy);
        maxV = Math.max(maxV, pt.impliedApy, pt.underlyingApy);
      });
      const diff = maxV - minV;
      const pad = diff > 0.1 ? diff * 0.15 : 1.0;
      minV = Math.max(0, Number((minV - pad).toFixed(2)));
      maxV = Number((maxV + pad).toFixed(2));
      const range = maxV - minV > 1e-6 ? maxV - minV : 1.0;

      yLabels = [
        { yRatio: 0.1, text: `${(maxV - range * 0.1).toFixed(1)}%` },
        { yRatio: 0.4, text: `${(maxV - range * 0.4).toFixed(1)}%` },
        { yRatio: 0.7, text: `${(maxV - range * 0.7).toFixed(1)}%` },
        { yRatio: 0.95, text: `${(maxV - range * 0.95).toFixed(1)}%` },
      ];

      pts = filteredSeries.map((d, i) => {
        const x = filteredSeries.length > 1 ? (i / (filteredSeries.length - 1)) * width : 0;
        const yCyan = paddingTop + (1 - (d.impliedApy - minV) / range) * plotHeight;
        const yEmerald = paddingTop + (1 - (d.underlyingApy - minV) / range) * plotHeight;
        return { x, yCyan, yEmerald, data: d };
      });
    } else {
      // Token Price Mode: Dual-band zoomed space (Upper: PT Price, Lower: YT Price)
      let minPt = Infinity;
      let maxPt = -Infinity;
      let minYt = Infinity;
      let maxYt = -Infinity;

      filteredSeries.forEach((pt) => {
        minPt = Math.min(minPt, pt.ptPrice);
        maxPt = Math.max(maxPt, pt.ptPrice);
        minYt = Math.min(minYt, pt.ytPrice);
        maxYt = Math.max(maxYt, pt.ytPrice);
      });

      const ptDiff = maxPt - minPt;
      const ptPad = ptDiff > 1e-5 ? ptDiff * 0.22 : 0.0025;
      const ptLow = Math.max(0, minPt - ptPad);
      const ptHigh = maxPt + ptPad;
      const ptRange = ptHigh - ptLow > 1e-6 ? ptHigh - ptLow : 0.005;

      const ytDiff = maxYt - minYt;
      const ytPad = ytDiff > 1e-5 ? ytDiff * 0.22 : 0.0025;
      const ytLow = Math.max(0, minYt - ytPad);
      const ytHigh = maxYt + ytPad;
      const ytRange = ytHigh - ytLow > 1e-6 ? ytHigh - ytLow : 0.005;

      minV = ytLow;
      maxV = ptHigh;

      const ptTop = paddingTop + plotHeight * 0.04;
      const ptBandHeight = plotHeight * 0.40;
      const ytTop = paddingTop + plotHeight * 0.56;
      const ytBandHeight = plotHeight * 0.40;

      yLabels = [
        { yRatio: 0.08, text: `PT ${(ptHigh - ptRange * 0.1).toFixed(4)}` },
        { yRatio: 0.42, text: `PT ${(ptLow + ptRange * 0.1).toFixed(4)}` },
        { yRatio: 0.60, text: `YT ${(ytHigh - ytRange * 0.1).toFixed(4)}` },
        { yRatio: 0.94, text: `YT ${(ytLow + ytRange * 0.1).toFixed(4)}` },
      ];

      pts = filteredSeries.map((d, i) => {
        const x = filteredSeries.length > 1 ? (i / (filteredSeries.length - 1)) * width : 0;
        const yEmerald = ptTop + (1 - (d.ptPrice - ptLow) / ptRange) * ptBandHeight;
        const yCyan = ytTop + (1 - (d.ytPrice - ytLow) / ytRange) * ytBandHeight;
        return { x, yCyan, yEmerald, data: d };
      });
    }

    // Catmull-Rom Cubic Spline Path Builder
    const buildPathAndArea = (
      getValY: (p: (typeof pts)[0]) => number,
      areaBaselineY: number
    ) => {
      if (pts.length === 1) {
        const y = getValY(pts[0]);
        return {
          path: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)}`,
          area: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)} L ${width},${areaBaselineY.toFixed(2)} L 0,${areaBaselineY.toFixed(2)} Z`,
        };
      }

      let dStr = `M ${pts[0].x.toFixed(2)},${getValY(pts[0]).toFixed(2)}`;
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[i === 0 ? 0 : i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = getValY(p1) + (getValY(p2) - getValY(p0)) / 6;
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = getValY(p2) - (getValY(p3) - getValY(p1)) / 6;

        dStr += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${getValY(p2).toFixed(2)}`;
      }

      const aStr = `${dStr} L ${pts[pts.length - 1].x.toFixed(2)},${areaBaselineY.toFixed(2)} L ${pts[0].x.toFixed(2)},${areaBaselineY.toFixed(2)} Z`;
      return { path: dStr, area: aStr };
    };

    const cyanPaths = buildPathAndArea((p) => p.yCyan, height);
    const emeraldPaths = buildPathAndArea(
      (p) => p.yEmerald,
      mode === "price" ? midBandBaseline : height
    );

    return {
      cyanPath: cyanPaths.path,
      cyanArea: cyanPaths.area,
      emeraldPath: emeraldPaths.path,
      emeraldArea: emeraldPaths.area,
      points: pts,
      yMin: minV,
      yMax: maxV,
      yLabels,
    };
  }, [filteredSeries, mode, height, plotHeight, paddingTop]);

  // Active Scrubbed Point
  const activePt = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;

  // Header Metric Readouts
  const latestPt = points.length > 0 ? points[points.length - 1].data : null;
  const currentImpliedStr = latestPt ? `${latestPt.impliedApy.toFixed(2)}%` : "--";
  const currentUnderlyingStr = latestPt ? `${latestPt.underlyingApy.toFixed(2)}%` : "--";
  const currentPtPriceStr = latestPt ? `${latestPt.ptPrice.toFixed(4)} SY` : "--";
  const currentYtPriceStr = latestPt ? `${latestPt.ytPrice.toFixed(4)} SY` : "--";

  const spreadVal = latestPt ? latestPt.impliedApy - latestPt.underlyingApy : 0;
  const discountVal = latestPt ? (1.0 - latestPt.ptPrice) * 100 : 0;

  return (
    <div className={`glass-panel double-bezel rounded-2xl p-4 sm:p-5 shadow-glass-elevated flex flex-col justify-between ${className}`}>
      {/* 1. Header Bar: Title, Mode Toggle, Timeframe Tabs */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-glass-rim">
        {/* Left: Metric Readout */}
        <div className="flex flex-wrap items-center gap-3">
          {mode === "yield" ? (
            <>
              <div>
                <span className="text-[11px] font-medium text-ink-muted block">Implied APY</span>
                <span className="text-lg sm:text-xl font-bold text-accent tabular-mono">{currentImpliedStr}</span>
              </div>
              <div className="h-6 w-px bg-hairline" />
              <div>
                <span className="text-[11px] font-medium text-ink-muted block">Underlying</span>
                <span className="text-sm sm:text-base font-semibold text-positive tabular-mono">{currentUnderlyingStr}</span>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-accent-soft/30 text-accent border border-accent/20">
                <span className="font-mono tabular-mono">{spreadVal >= 0 ? `+${spreadVal.toFixed(2)}%` : `${spreadVal.toFixed(2)}%`}</span>
                <span>Spread</span>
              </span>
            </>
          ) : (
            <>
              <div>
                <span className="text-[11px] font-medium text-ink-muted block">PT Price</span>
                <span className="text-lg sm:text-xl font-bold text-positive tabular-mono">{currentPtPriceStr}</span>
              </div>
              <div className="h-6 w-px bg-hairline" />
              <div>
                <span className="text-[11px] font-medium text-ink-muted block">YT Price</span>
                <span className="text-sm sm:text-base font-semibold text-accent tabular-mono">{currentYtPriceStr}</span>
              </div>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-positive-soft/30 text-positive border border-positive/20">
                <span className="font-mono tabular-mono">{discountVal.toFixed(2)}%</span>
                <span>Discount</span>
              </span>
            </>
          )}
        </div>

        {/* Right: Mode & Timeframe Controls */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {/* Mode Switcher */}
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-muted/70 border border-glass-rim backdrop-blur-sm">
            <button
              type="button"
              onClick={() => handleModeToggle("yield")}
              className={`px-2 py-1 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-95 disabled:opacity-50 ${
                mode === "yield"
                  ? "bg-surface-hover text-ink border border-glass-rim shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              Yield APY
            </button>
            <button
              type="button"
              onClick={() => handleModeToggle("price")}
              className={`px-2 py-1 rounded-md text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-95 disabled:opacity-50 ${
                mode === "price"
                  ? "bg-surface-hover text-ink border border-glass-rim shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              Token Price
            </button>
          </div>

          {/* Timeframe Selector */}
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-muted/70 border border-glass-rim backdrop-blur-sm">
            {(["1D", "1W", "1M", "ALL"] as ChartTimeframe[]).map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => handleTimeframeSelect(tf)}
                className={`px-2 py-1 rounded-md text-xs font-mono tabular-mono transition-colors focus-visible:outline-2 focus-visible:outline-accent active:scale-95 ${
                  timeframe === tf
                    ? "bg-surface-hover text-ink border border-glass-rim font-semibold shadow-sm"
                    : "text-ink-muted hover:text-ink"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 2. Interactive SVG Stage */}
      <div className="relative w-full select-none my-2" style={{ height }}>
        {/* Loading Spinner Shimmer */}
        {loading && points.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface-muted/50 rounded-xl backdrop-blur-sm z-10">
            <div className="flex items-center gap-2 text-xs text-ink-secondary">
              <div className="h-4 w-4 animate-spin motion-reduce:animate-none rounded-full border-2 border-accent border-t-transparent" />
              <span>Syncing chart events…</span>
            </div>
          </div>
        )}

        <svg
          role="img"
          aria-label="Historical yield and price chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="w-full h-full overflow-visible"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const idx = Math.round(normX * (points.length - 1));
            setHoverIndex(idx);
            setHoverClientX(e.clientX - rect.left);
          }}
          onTouchMove={(e) => {
            if (!e.touches[0]) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const normX = Math.max(0, Math.min(1, (e.touches[0].clientX - rect.left) / rect.width));
            const idx = Math.round(normX * (points.length - 1));
            setHoverIndex(idx);
            setHoverClientX(e.touches[0].clientX - rect.left);
          }}
          onMouseLeave={() => {
            setHoverIndex(null);
            setHoverClientX(null);
          }}
          onTouchEnd={() => {
            setHoverIndex(null);
            setHoverClientX(null);
          }}
        >
          <defs>
            {/* Cyan Line Gradient (Implied APY / YT Price) */}
            <linearGradient id={cyanGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-signal)" stopOpacity="0.28" />
              <stop offset="80%" stopColor="var(--accent-signal)" stopOpacity="0.04" />
              <stop offset="100%" stopColor="var(--accent-signal)" stopOpacity="0.0" />
            </linearGradient>

            {/* Emerald Line Gradient (Underlying APY / PT Price) */}
            <linearGradient id={emeraldGradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--positive-signal)" stopOpacity="0.24" />
              <stop offset="80%" stopColor="var(--positive-signal)" stopOpacity="0.03" />
              <stop offset="100%" stopColor="var(--positive-signal)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Dual-Band Midline Divider in Token Price Mode */}
          {mode === "price" && (
            <line
              x1="0"
              y1={paddingTop + plotHeight * 0.49}
              x2={width}
              y2={paddingTop + plotHeight * 0.49}
              stroke="var(--border-hairline)"
              strokeDasharray="4 4"
              opacity="0.7"
            />
          )}

          {/* Horizontal Reference Gridlines */}
          {yLabels.map((lbl, i) => {
            const yCoord = paddingTop + lbl.yRatio * plotHeight;
            return (
              <g key={i}>
                <line
                  x1="0"
                  y1={yCoord}
                  x2={width}
                  y2={yCoord}
                  stroke="var(--border-hairline)"
                  strokeDasharray="3 3"
                />
                <text
                  x={width - 4}
                  y={yCoord - 3}
                  textAnchor="end"
                  className="text-[9px] fill-ink-muted tabular-mono select-none"
                >
                  {lbl.text}
                </text>
              </g>
            );
          })}

          {/* Area Fills */}
          {emeraldArea && <path d={emeraldArea} fill={`url(#${emeraldGradId})`} />}
          {cyanArea && <path d={cyanArea} fill={`url(#${cyanGradId})`} />}

          {/* Curve 1: Emerald Line (Underlying APY / PT Price) */}
          {emeraldPath && (
            <>
              <path
                d={emeraldPath}
                fill="none"
                stroke="var(--positive-signal)"
                strokeWidth="3.5"
                strokeOpacity="0.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={emeraldPath}
                fill="none"
                stroke="var(--positive-signal)"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {/* Curve 2: Cyan Line (Implied APY / YT Price) */}
          {cyanPath && (
            <>
              <path
                d={cyanPath}
                fill="none"
                stroke="var(--accent-signal)"
                strokeWidth="3.5"
                strokeOpacity="0.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d={cyanPath}
                fill="none"
                stroke="var(--accent-signal)"
                strokeWidth="2.0"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

          {/* Scrub Cursor & Intersection Crosshairs */}
          {activePt && (
            <g className="pointer-events-none">
              {/* Vertical Crosshair */}
              <line
                x1={activePt.x}
                y1={paddingTop}
                x2={activePt.x}
                y2={height - paddingBottom}
                stroke="var(--ink-secondary)"
                strokeWidth="1"
                strokeDasharray="2 2"
                opacity="0.6"
              />

              {/* Cyan Pin */}
              <circle
                cx={activePt.x}
                cy={activePt.yCyan}
                r="4.5"
                fill="var(--accent-signal)"
                stroke="var(--bg-canvas)"
                strokeWidth="2"
              />

              {/* Emerald Pin */}
              <circle
                cx={activePt.x}
                cy={activePt.yEmerald}
                r="4.5"
                fill="var(--positive-signal)"
                stroke="var(--bg-canvas)"
                strokeWidth="2"
              />
            </g>
          )}
        </svg>

        {/* Hover Tooltip Overlay with Boundary Clamping */}
        {activePt && isMounted && (
          <div
            className="pointer-events-none absolute top-2 rounded-xl border border-glass-rim bg-surface-glass/95 px-3 py-2 text-xs shadow-glass backdrop-blur-md z-20 flex flex-col gap-1 transition-opacity duration-75"
            style={{
              left: hoverClientX !== null && hoverClientX > 380 ? `${Math.max(10, hoverClientX - 170)}px` : `${Math.min(width - 180, (hoverClientX ?? 0) + 15)}px`,
            }}
          >
            <div className="text-[10px] text-ink-muted border-b border-glass-rim-subtle pb-1">
              {formatTooltipDateTime(activePt.data.timestamp)}
            </div>

            {mode === "yield" ? (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5 text-accent">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    Implied APY:
                  </span>
                  <span className="font-bold text-accent tabular-mono">
                    {activePt.data.impliedApy.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5 text-positive">
                    <span className="h-2 w-2 rounded-full bg-positive" />
                    Underlying APY:
                  </span>
                  <span className="font-semibold text-positive tabular-mono">
                    {activePt.data.underlyingApy.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[10px] text-ink-muted pt-0.5 border-t border-hairline/60">
                  <span>Net Spread:</span>
                  <span className="font-mono tabular-mono text-ink">
                    {(activePt.data.impliedApy - activePt.data.underlyingApy >= 0 ? "+" : "") +
                      (activePt.data.impliedApy - activePt.data.underlyingApy).toFixed(2)}%
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5 text-positive">
                    <span className="h-2 w-2 rounded-full bg-positive" />
                    PT Spot Price:
                  </span>
                  <span className="font-bold text-positive tabular-mono">
                    {activePt.data.ptPrice.toFixed(4)} SY
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[11px]">
                  <span className="flex items-center gap-1.5 text-accent">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    YT Spot Price:
                  </span>
                  <span className="font-semibold text-accent tabular-mono">
                    {activePt.data.ytPrice.toFixed(4)} SY
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 text-[10px] text-ink-muted pt-0.5 border-t border-hairline/60">
                  <span>Par Maturity:</span>
                  <span className="text-ink">
                    <span className="font-mono tabular-mono">{(activePt.data.ptPrice + activePt.data.ytPrice).toFixed(4)}</span> SY
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 3. Footer Bar: Legend & Time Axis Domain */}
      <div className="flex items-center justify-between pt-2 border-t border-glass-rim text-[10px] text-ink-muted">
        {/* Legend */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span className="text-ink-secondary">{mode === "yield" ? "Implied APY" : "YT Price"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-positive" />
            <span className="text-ink-secondary">{mode === "yield" ? "Underlying APY" : "PT Price"}</span>
          </div>
        </div>

        {/* Time Domain Labels */}
        <div className="flex items-center gap-3 tabular-mono font-mono">
          <span>{filteredSeries[0] ? formatTimestampLabel(filteredSeries[0].timestamp, timeframe) : "--"}</span>
          <span>•</span>
          <span>
            {filteredSeries.length > 0
              ? formatTimestampLabel(filteredSeries[filteredSeries.length - 1].timestamp, timeframe)
              : "--"}
          </span>
        </div>
      </div>
    </div>
  );
}

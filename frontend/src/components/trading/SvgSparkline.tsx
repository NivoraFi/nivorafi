"use client";

import React, { useId, useMemo, useRef, useState } from "react";

export interface SparklinePoint {
  timestamp: number;
  value: number;
}

export interface SvgSparklineProps {
  data: SparklinePoint[];
  height?: number;
  valuePrefix?: string;
  valueSuffix?: string;
  loading?: boolean;
}

export function SvgSparkline({
  data,
  height = 96,
  valuePrefix = "",
  valueSuffix = "%",
  loading = false,
}: SvgSparklineProps) {
  const gradientId = useId();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const lastValidDataRef = useRef<SparklinePoint[]>([]);
  if (data && data.length > 0) {
    lastValidDataRef.current = data;
  }
  const effectiveData = data && data.length > 0 ? data : lastValidDataRef.current;

  const width = 400; // Normalized virtual coordinate system
  const paddingFraction = 0.12;

  const { pathD, areaD, points, minVal, maxVal, avgVal } = useMemo(() => {
    if (!effectiveData || effectiveData.length === 0) {
      return { pathD: "", areaD: "", points: [], minVal: 0, maxVal: 0, avgVal: 0 };
    }

    if (effectiveData.length === 1) {
      const v = effectiveData[0].value;
      const y = height / 2;
      return {
        pathD: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)}`,
        areaD: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)} L ${width},${height} L 0,${height} Z`,
        points: [{ x: width / 2, y, val: v, timestamp: effectiveData[0].timestamp }],
        minVal: v,
        maxVal: v,
        avgVal: v,
      };
    }

    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    for (const d of effectiveData) {
      if (d.value < min) min = d.value;
      if (d.value > max) max = d.value;
      sum += d.value;
    }
    const avg = sum / effectiveData.length;

    const diff = max - min;
    const range = diff > 1e-6 ? diff : 0.01;
    const bLow = min - range * paddingFraction;
    const bHigh = max + range * paddingFraction;
    const bRange = bHigh - bLow;

    const pts = effectiveData.map((d, i) => {
      const x = (i / (effectiveData.length - 1)) * width;
      const y = height - ((d.value - bLow) / bRange) * height;
      return { x, y, val: d.value, timestamp: d.timestamp };
    });

    // Smooth cubic curve path using Catmull-Rom tangents
    let dStr = `M ${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i === 0 ? 0 : i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2 < pts.length ? i + 2 : i + 1];

      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;

      dStr += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }

    const aStr = `${dStr} L ${width},${height} L 0,${height} Z`;

    return { pathD: dStr, areaD: aStr, points: pts, minVal: min, maxVal: max, avgVal: avg };
  }, [effectiveData, height]);

  if (data.length === 0) {
    if (effectiveData.length === 0) {
      return (
        <div
          className="relative w-full h-[96px] flex items-center justify-center border-t border-dashed border-hairline"
          style={{ height }}
        >
          <span className="text-xs text-ink-muted">
            {loading ? "Syncing historical events..." : "Accumulating ledger events..."}
          </span>
        </div>
      );
    }
  }

  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;

  return (
    <div className="relative w-full select-none">
      {/* SVG Canvas */}
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        className="w-full overflow-visible"
        style={{ height }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const normX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          const idx = Math.round(normX * (points.length - 1));
          setHoverIndex(idx);
        }}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-signal)" stopOpacity="0.32" />
            <stop offset="85%" stopColor="var(--accent-signal)" stopOpacity="0.04" />
            <stop offset="100%" stopColor="var(--accent-signal)" stopOpacity="0.0" />
          </linearGradient>
        </defs>

        {/* Faint Horizontal Reference Guides */}
        <line
          x1="0"
          y1={height * 0.25}
          x2={width}
          y2={height * 0.25}
          stroke="var(--border-hairline)"
          strokeDasharray="3 3"
        />
        <line
          x1="0"
          y1={height * 0.75}
          x2={width}
          y2={height * 0.75}
          stroke="var(--border-hairline)"
          strokeDasharray="3 3"
        />

        {/* Area Gradient Fill */}
        <path d={areaD} fill={`url(#${gradientId})`} />

        {/* Ambient Glow Stroke */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--accent-signal)"
          strokeWidth="3.5"
          strokeOpacity="0.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Primary Sharp Crisp Stroke */}
        <path
          d={pathD}
          fill="none"
          stroke="var(--accent-signal)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Interactive Scrub Cursor */}
        {activePoint && (
          <g className="pointer-events-none">
            <line
              x1={activePoint.x}
              y1={0}
              x2={activePoint.x}
              y2={height}
              stroke="var(--ink-secondary)"
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.6"
            />
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r="4.5"
              fill="var(--accent-signal)"
              stroke="var(--bg-canvas)"
              strokeWidth="2"
            />
          </g>
        )}
      </svg>

      {/* Hover Readout Tooltip / Overlay (Non-disruptive, pointer-events-none to prevent layout jitter) */}
      {activePoint && (
        <div className="pointer-events-none absolute top-1 right-1 rounded-md border border-glass-rim bg-surface-glass/95 px-2 py-0.5 text-[11px] shadow-glass backdrop-blur-md flex items-center gap-1.5 transition-opacity duration-150">
          <span className="text-ink-secondary">
            {new Date(activePoint.timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="tabular-mono font-bold text-accent">
            {valuePrefix}{activePoint.val.toFixed(2)}{valueSuffix}
          </span>
        </div>
      )}

      {/* Baseline Range Labels (Fixed height container: strictly avoids layout shifts or collapsing) */}
      <div className="h-5 flex items-center justify-between text-[10px] text-ink-muted pt-1 px-1 tabular-mono">
        <span>Min: {valuePrefix}{minVal.toFixed(2)}{valueSuffix}</span>
        <span>Avg: {valuePrefix}{avgVal.toFixed(2)}{valueSuffix}</span>
        <span>Max: {valuePrefix}{maxVal.toFixed(2)}{valueSuffix}</span>
      </div>
    </div>
  );
}

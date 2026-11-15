// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { formatUnits, shortenAddress } from "../math";
import { readFileSync } from "fs";
import { join } from "path";

// Mathematical coordinate engine extraction for deterministic Bun testing
function computeSparklineCoordinates(
  data: Array<{ timestamp: number; value: number }>,
  width = 400,
  height = 96,
  paddingFraction = 0.12
) {
  if (data.length === 0) return { pathD: "", points: [] };
  if (data.length === 1) {
    const y = height / 2;
    return {
      pathD: `M 0,${y.toFixed(2)} L ${width},${y.toFixed(2)}`,
      points: [{ x: width / 2, y, val: data[0].value }],
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const d of data) {
    if (d.value < min) min = d.value;
    if (d.value > max) max = d.value;
  }

  const diff = max - min;
  const range = diff > 1e-6 ? diff : 0.01;
  const bLow = min - range * paddingFraction;
  const bHigh = max + range * paddingFraction;
  const bRange = bHigh - bLow;

  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((d.value - bLow) / bRange) * height;
    return { x, y, val: d.value };
  });

  let pathD = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;

    pathD += ` C ${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }

  return { pathD, points };
}

describe("Analytics UI & Sparkline Engine Suite", () => {
  describe("Mathematical SVG Sparkline Projection", () => {
    it("strictly projects monotonically increasing values into valid descending Y SVG coordinates", () => {
      const data = [
        { timestamp: 100, value: 4.0 },
        { timestamp: 200, value: 5.0 },
        { timestamp: 300, value: 6.0 },
      ];
      const { points, pathD } = computeSparklineCoordinates(data);

      expect(points.length).toBe(3);
      expect(points[0].x).toBe(0);
      expect(points[2].x).toBe(400);

      // In SVG, higher values correspond to lower Y coordinates
      expect(points[0].y).toBeGreaterThan(points[1].y);
      expect(points[1].y).toBeGreaterThan(points[2].y);
      expect(pathD).toStartWith("M 0.00,");
      expect(pathD).not.toContain("NaN");
      expect(pathD).not.toContain("Infinity");
    });

    it("handles identical constant values without division-by-zero or NaN path", () => {
      const data = [
        { timestamp: 100, value: 5.0 },
        { timestamp: 200, value: 5.0 },
        { timestamp: 300, value: 5.0 },
      ];
      const { points, pathD } = computeSparklineCoordinates(data);

      expect(points.length).toBe(3);
      expect(pathD).not.toContain("NaN");
      expect(pathD).not.toContain("Infinity");
      // All Y coordinates should be identical and centered around height/2
      expect(points[0].y).toBeCloseTo(points[1].y, 2);
      expect(points[1].y).toBeCloseTo(points[2].y, 2);
    });

    it("handles single data point gracefully by rendering a centered horizontal line", () => {
      const data = [{ timestamp: 100, value: 5.42 }];
      const { points, pathD } = computeSparklineCoordinates(data, 400, 96);

      expect(points.length).toBe(1);
      expect(points[0].x).toBe(200);
      expect(points[0].y).toBe(48);
      expect(pathD).toBe("M 0,48.00 L 400,48.00");
    });

    it("handles empty data array safely", () => {
      const { points, pathD } = computeSparklineCoordinates([]);
      expect(points.length).toBe(0);
      expect(pathD).toBe("");
    });
  });

  describe("Design System Rules & Conformance Audit", () => {
    it("verifies component source files contain zero raw hex strings (#...)", () => {
      const componentPaths = [
        join(process.cwd(), "src/components/trading/AnalyticsCard.tsx"),
        join(process.cwd(), "src/components/trading/ActivityPanel.tsx"),
        join(process.cwd(), "src/components/trading/SvgSparkline.tsx"),
      ];

      for (const p of componentPaths) {
        const content = readFileSync(p, "utf-8");
        // Look for hex color literals (e.g. #0284c7, #05080c, #fff)
        // Allow anchor/hash references like #trade or #... in url/comments if any, but no color hexes
        const hexColorRegex = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;
        const matches = content.match(hexColorRegex) || [];
        expect(matches.length).toBe(0);
      }
    });

    it("verifies financial amounts are formatted with tabular-mono precision", () => {
      const stroopsAmount = 24850500000n; // 2,485.05 USDC
      const formatted = formatUnits(stroopsAmount, 7, 2);
      expect(formatted).toBe("2485.05");

      const display = `$${Number(formatted).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
      expect(display).toBe("$2,485.05");
    });

    it("verifies address shortening preserves institutional readability", () => {
      const addr = "GAWWVH7D2S4QJMBQHKZPQ4Z2I7E7N6A4QME27";
      const shortened = shortenAddress(addr, 4, 4);
      expect(shortened).toBe("GAWW...ME27");
    });

    it("verifies chart unmount/flicker prevention logic in SvgSparkline and page", () => {
      const sparklineContent = readFileSync(join(process.cwd(), "src/components/trading/SvgSparkline.tsx"), "utf-8");
      expect(sparklineContent).toContain("if (data.length === 0)");
      expect(sparklineContent).not.toContain("loading || data.length === 0");

      const pageContent = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf-8");
      expect(pageContent).toContain("loading={loadingMarket || (isIndexerSyncing && !analytics)}");
    });
  });
});

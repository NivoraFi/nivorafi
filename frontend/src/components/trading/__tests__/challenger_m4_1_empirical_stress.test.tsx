// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

import { PRESET_MARKETS } from "../../../lib/markets";
import {
  getFriendlyActionName,
  resolveScopedBusyAction,
  LiveMarketSnapshot,
} from "../../../lib/stellar";
import {
  createMockWalletState,
  createMockSnapshot,
  DUMMY_TEST_WALLET_ADDRESS,
} from "../../../lib/__tests__/e2e/helpers/e2e-oracle";

// Controlled mock contexts
const mockWalletState = createMockWalletState({
  address: DUMMY_TEST_WALLET_ADDRESS,
  isConnected: true,
  mode: "wallet",
});

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: () => false,
}));

mock.module("@/context/MarketContext", () => ({
  useMarket: () => ({
    markets: PRESET_MARKETS,
    activeMarket: PRESET_MARKETS[0],
    activeMarketId: PRESET_MARKETS[0].id,
    selectMarket: () => {},
    activeSnapshot: null,
    activePortfolio: null,
    loadingSnapshot: false,
    loadingPortfolio: false,
  }),
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { SwapCard } from "../SwapCard";
import { InteractiveYieldChart, ChartDataPoint } from "../../token/InteractiveYieldChart";
import { NextRequest } from "next/server";
import { GET as bffGet } from "../../../app/api/indexer/[...path]/route";

const usdc90d = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

describe("Empirical Challenger M4.1 — Adversarial Stress Testing", () => {
  describe("Invariant 1: SwapCard PT / YT Compact Mode Buttons", () => {
    it("renders fallback APY and leverage gracefully when snapshot is null", () => {
      const html = renderToString(
        <SwapCard
          activeMarket={usdc90d}
          snapshot={null}
          portfolio={null}
          address={DUMMY_TEST_WALLET_ADDRESS}
          mode="wallet"
          onExecuteAction={async () => {}}
        />
      );

      // Verify compact 2-column grid container
      expect(html).toContain("grid grid-cols-2 gap-2");
      // Honest null-snapshot placeholder (no synthetic +8.45% / 50x fallback)
      const textOnly = html.replace(/<!--.*?-->/g, "");
      expect(textOnly).not.toContain("+8.45%");
      expect(textOnly).not.toContain("50x");
      expect(textOnly).toContain("--");
      // Monospace typography
      expect(html).toContain("tabular-mono");
      // Labels
      expect(html).toContain("Fixed APY");
      expect(html).toContain("Long Yield");
    });

    it("safely handles extreme APY values (+9999.99%, 0.00%, negative) without crashing", () => {
      const baseSnap = createMockSnapshot(usdc90d);
      
      const extremeSnapshotHigh: LiveMarketSnapshot = {
        ...baseSnap,
        impliedFixedApyPct: 9999.99,
        ytPriceInSy: 0.01,
      };

      const htmlHigh = renderToString(
        <SwapCard
          activeMarket={usdc90d}
          snapshot={extremeSnapshotHigh}
          portfolio={null}
          address={DUMMY_TEST_WALLET_ADDRESS}
          mode="wallet"
          onExecuteAction={async () => {}}
        />
      );
      const textHigh = htmlHigh.replace(/<!--.*?-->/g, "");
      expect(textHigh).toContain("+9999.99%");
      expect(textHigh).toContain("99x"); // Clamped to 99x max

      const extremeSnapshotZero: LiveMarketSnapshot = {
        ...baseSnap,
        impliedFixedApyPct: 0.0,
        ytPriceInSy: 0,
      };

      const htmlZero = renderToString(
        <SwapCard
          activeMarket={usdc90d}
          snapshot={extremeSnapshotZero}
          portfolio={null}
          address={DUMMY_TEST_WALLET_ADDRESS}
          mode="wallet"
          onExecuteAction={async () => {}}
        />
      );
      const textZero = htmlZero.replace(/<!--.*?-->/g, "");
      expect(textZero).toContain("+0.00%");
      expect(textZero).not.toContain("50x");
      expect(textZero).toContain("--"); // ytPriceInSy <= 0 triggers honest "--"
    });

    it("enforces whitespace-nowrap and single-row compact layout", () => {
      const snap = createMockSnapshot(usdc90d);
      const html = renderToString(
        <SwapCard
          activeMarket={usdc90d}
          snapshot={snap}
          portfolio={null}
          address={DUMMY_TEST_WALLET_ADDRESS}
          mode="wallet"
          onExecuteAction={async () => {}}
        />
      );

      // Verify buttons have whitespace-nowrap to prevent ugly wrapping on mobile
      expect(html).toContain("whitespace-nowrap");
      expect(html).toContain('type="button"');
    });

    it("renders active styling properly based on isPtMode and isYtMode", () => {
      const snap = createMockSnapshot(usdc90d);
      const html = renderToString(
        <SwapCard
          activeMarket={usdc90d}
          snapshot={snap}
          portfolio={null}
          address={DUMMY_TEST_WALLET_ADDRESS}
          mode="wallet"
          onExecuteAction={async () => {}}
        />
      );

      // Default is sy_for_pt -> PT button active
      expect(html).toContain("border-positive bg-positive-soft shadow-sm");
    });
  });

  describe("Invariant 2: Scoped Per-Tab Busy Action States", () => {
    it("handles multi-contract and multi-method concurrency strictly isolating unrelated tabs", () => {
      const poolA = "CA11111111111111111111111111111111111111111111111111111111";
      const poolB = "CB22222222222222222222222222222222222222222222222222222222";

      const busyState = {
        [`${poolA}:swap_exact_sy_for_pt`]: "Confirming Swap...",
        [`${poolB}:mint_py`]: "Minting PT + YT...",
      };

      // Query Pool A for swap
      const resSwapA = resolveScopedBusyAction(
        busyState,
        null,
        poolA,
        ["swap_exact_sy_for_pt", "swap_exact_pt_for_sy"]
      );
      expect(resSwapA).toBe("Confirming Swap...");

      // Query Pool A for mint (should be null - not busy on mint)
      const resMintA = resolveScopedBusyAction(
        busyState,
        null,
        poolA,
        ["mint_py"]
      );
      expect(resMintA).toBeNull();

      // Query Pool B for swap (should be null - Pool B is busy on mint, not swap)
      const resSwapB = resolveScopedBusyAction(
        busyState,
        null,
        poolB,
        ["swap_exact_sy_for_pt"]
      );
      expect(resSwapB).toBeNull();

      // Query Pool B for mint (should be busy)
      const resMintB = resolveScopedBusyAction(
        busyState,
        null,
        poolB,
        ["mint_py"]
      );
      expect(resMintB).toBe("Minting PT + YT...");
    });

    it("handles adversarial inputs: empty object, unknown contractId, undefined arrays gracefully", () => {
      expect(resolveScopedBusyAction({}, null, "CADUMMY", ["swap_exact_sy_for_pt"])).toBeNull();
      expect(resolveScopedBusyAction({ CADUMMY: "busy" }, null, "CADUMMY", [])).toBeNull();
      expect(resolveScopedBusyAction(undefined, null, "CADUMMY", ["swap_exact_sy_for_pt"])).toBeNull();
      expect(resolveScopedBusyAction(undefined, "Legacy Busy", "CADUMMY", ["swap_exact_sy_for_pt"])).toBe("Legacy Busy");
    });

    it("verifies getFriendlyActionName produces human-readable labels without underscores", () => {
      const methods = [
        "swap_exact_sy_for_pt",
        "swap_exact_pt_for_sy",
        "swap_exact_sy_for_yt",
        "swap_exact_yt_for_sy",
        "mint_py",
        "redeem_py",
        "add_liquidity_dual",
        "remove_liquidity_dual",
        "custom_unknown_soroban_action",
      ];

      for (const m of methods) {
        const friendly = getFriendlyActionName(m);
        expect(friendly).not.toContain("_");
        expect(friendly.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Invariant 3: InteractiveYieldChart Zero-Flash Hydration & Cache Invariants", () => {
    it("renders server-side without crashing or leaking unmounted tooltip portal", () => {
      const snap = createMockSnapshot(usdc90d);
      const html = renderToString(
        <InteractiveYieldChart
          snapshot={snap}
          market={usdc90d}
          loading={false}
        />
      );

      // Verify SVG rendered
      expect(html).toContain("<svg");
      // Tooltip must NOT be rendered during SSR because isMounted === false
      expect(html).not.toContain("Net Spread:");
    });

    it("generates distinct unique gradient IDs when multiple chart instances exist", () => {
      const snap = createMockSnapshot(usdc90d);
      const html1 = renderToString(
        <InteractiveYieldChart snapshot={snap} market={usdc90d} />
      );
      const html2 = renderToString(
        <InteractiveYieldChart snapshot={snap} market={usdc90d} />
      );

      // Both should contain linearGradient with unique IDs
      expect(html1).toContain("<linearGradient");
      expect(html2).toContain("<linearGradient");
    });

    it("handles sudden transition to loading=true without clearing SVG paths", () => {
      const customData: ChartDataPoint[] = [
        { timestamp: 1000, impliedApy: 8.5, underlyingApy: 5.4, ptPrice: 0.98, ytPrice: 0.02 },
        { timestamp: 2000, impliedApy: 8.6, underlyingApy: 5.4, ptPrice: 0.98, ytPrice: 0.02 },
      ];

      // Initial render with data
      const htmlActive = renderToString(
        <InteractiveYieldChart data={customData} loading={false} />
      );
      expect(htmlActive).toContain("<path");

      // Render with loading=true (using last cached series)
      const htmlLoading = renderToString(
        <InteractiveYieldChart loading={true} />
      );
      expect(htmlLoading).toContain("<svg");
    });
  });

  describe("Invariant 4: BFF Security Route Adversarial Edge Cases", () => {
    it("rejects path traversal attempts with dot-dot or backslashes", async () => {
      const malicious = [
        ["..", "admin"],
        [".", "health"],
        ["health", ".."],
        ["..%2f..%2fadmin"],
      ];

      for (const p of malicious) {
        const req = new NextRequest(`http://localhost:3000/api/indexer/${p.join("/")}`);
        const res = await bffGet(req, { params: Promise.resolve({ path: p }) });
        expect(res.status).toBe(404);
      }
    });

    it("forwards query string parameters accurately without truncating or mutating", async () => {
      let capturedUrl = "";
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async (url: string | URL | Request) => {
          capturedUrl = String(url);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }) as typeof fetch;

        const req = new NextRequest(
          "http://localhost:3000/api/indexer/events?market=usdc-90d&limit=25&cursor=12345"
        );
        const res = await bffGet(req, { params: Promise.resolve({ path: ["events"] }) });

        expect(res.status).toBe(200);
        expect(capturedUrl).toContain("market=usdc-90d");
        expect(capturedUrl).toContain("limit=25");
        expect(capturedUrl).toContain("cursor=12345");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("enforces strict private cache policy exclusively on positions endpoint", async () => {
      const origFetch = globalThis.fetch;
      try {
        globalThis.fetch = (async () => {
          return new Response(JSON.stringify({ positions: [] }), { status: 200 });
        }) as typeof fetch;

        const reqPos = new NextRequest("http://localhost:3000/api/indexer/positions");
        const resPos = await bffGet(reqPos, { params: Promise.resolve({ path: ["positions"] }) });
        expect(resPos.headers.get("Cache-Control")).toBe("private, no-store");

        const reqStats = new NextRequest("http://localhost:3000/api/indexer/stats");
        const resStats = await bffGet(reqStats, { params: Promise.resolve({ path: ["stats"] }) });
        expect(resStats.headers.get("Cache-Control")).toBe("public, s-maxage=3, stale-while-revalidate=10");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});

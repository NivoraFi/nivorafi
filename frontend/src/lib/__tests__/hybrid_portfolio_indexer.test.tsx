// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { PRESET_MARKETS } from "@/lib/markets";
import type { LiveUserPortfolio } from "@/lib/stellar";
import {
  deserializePortfolioMap,
  mapIndexedPositionsToPortfolios,
  parseStroopsSafe,
  probeIndexerPositionsFast,
  serializePortfolioMap,
} from "@/lib/hybridPortfolio";
import { resolveTokenLogoPath } from "@/components/ui/TokenIcon";

const TEST_USER = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";

describe("Hybrid Indexer-First + Cache + Soroban RPC Portfolio Engine", () => {
  it("parses stroops strings, numbers, and bigints safely without throwing", () => {
    expect(parseStroopsSafe("25000000000")).toBe(25_000_000_000n);
    expect(parseStroopsSafe(10_000_000n)).toBe(10_000_000n);
    expect(parseStroopsSafe(-5n)).toBe(0n);
    expect(parseStroopsSafe("-100")).toBe(0n);
    expect(parseStroopsSafe("")).toBe(0n);
    expect(parseStroopsSafe(null)).toBe(0n);
  });

  it("serializes and deserializes 128-bit BigInt portfolio snapshots with TTL enforcement", () => {
    const sample: Record<string, LiveUserPortfolio> = {
      "usdc-90d": {
        address: TEST_USER,
        accountExists: true,
        xlmBalance: "99.50",
        usdcBalance: "420.25",
        usdcTrustlineExists: true,
        syBalance: 12_345_678n,
        ptBalance: 85_000_000n,
        ytBalance: 85_000_000n,
        lpBalance: 5_000_000n,
        lastIndex: 10_010_000n,
        unclaimedYieldRaw: 250_000n,
        estimatedPendingYieldSy: 250_000n,
      },
    };

    const now = 1_760_000_000_000;
    const raw = serializePortfolioMap(sample, now);
    const restored = deserializePortfolioMap(raw, now + 60_000);

    expect(restored).not.toBeNull();
    expect(restored?.portfolios["usdc-90d"].ptBalance).toBe(85_000_000n);
    expect(restored?.portfolios["usdc-90d"].syBalance).toBe(12_345_678n);
    expect(restored?.portfolios["usdc-90d"].estimatedPendingYieldSy).toBe(250_000n);

    // Expired beyond 24h TTL returns null
    const expired = deserializePortfolioMap(raw, now + 25 * 60 * 60 * 1000);
    expect(expired).toBeNull();
  });

  it("maps SQLite indexer positions into LiveUserPortfolio while preserving cached SY & yield", () => {
    const verified = PRESET_MARKETS.filter((m) => m.isVerifiedTestnet);
    const cachedFallback: Record<string, LiveUserPortfolio> = {
      "usdc-90d": {
        address: TEST_USER,
        accountExists: true,
        xlmBalance: "50.00",
        usdcBalance: "100.00",
        usdcTrustlineExists: true,
        syBalance: 15_000_000n,
        ptBalance: 10_000_000n,
        ytBalance: 10_000_000n,
        lpBalance: 0n,
        lastIndex: 0n,
        unclaimedYieldRaw: 0n,
        estimatedPendingYieldSy: 750_000n,
      },
    };

    const mapped = mapIndexedPositionsToPortfolios(
      TEST_USER,
      [
        {
          marketId: "usdc-90d",
          marketAddress: verified[0].contracts.poolId,
          assetCode: "USDC",
          costBasisStroops: "50000000",
          costBasisUsd: 5.0,
          averageEntryApy: 8.45,
          currentPtBalance: "60000000",
          currentYtBalance: "60000000",
          currentLpBalance: "20000000",
          currentPositionValueUsd: 8.0,
          realizedPnlStroops: "0",
          realizedPnlUsd: 0,
          unrealizedPnlStroops: "0",
          unrealizedPnlUsd: 0,
          netPnlUsd: 0,
          cumulativeClaimedYieldStroops: "0",
          cumulativeClaimedYieldUsd: 0,
          firstTradeTimestamp: 1730000000,
          lastActivityTimestamp: 1730001000,
          totalTradesCount: 2,
        },
      ],
      verified,
      cachedFallback
    );

    expect(mapped["usdc-90d"].ptBalance).toBe(60_000_000n);
    expect(mapped["usdc-90d"].ytBalance).toBe(60_000_000n);
    expect(mapped["usdc-90d"].lpBalance).toBe(20_000_000n);
    // Preserves cached SY and claimable yield until Soroban RPC reconciles
    expect(mapped["usdc-90d"].syBalance).toBe(15_000_000n);
    expect(mapped["usdc-90d"].estimatedPendingYieldSy).toBe(750_000n);
  });

  it("distinguishes reachable SQLite indexer responses from offline/timeout failures", async () => {
    const onlineRes = await probeIndexerPositionsFast({
      userAddress: TEST_USER,
      indexerApiUrl: "http://mock-indexer.local",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            success: true,
            user: TEST_USER,
            count: 1,
            positions: [
              {
                marketId: "usdc-90d",
                marketAddress: "CDUMMYPOOL",
                assetCode: "USDC",
                currentPtBalance: "40000000",
                currentYtBalance: "40000000",
                currentLpBalance: "0",
              },
            ],
            summary: { userAddress: TEST_USER, activePositionsCount: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )) as unknown as typeof fetch,
    });

    expect(onlineRes.reachable).toBe(true);
    expect(onlineRes.response?.count).toBe(1);
    expect(onlineRes.response?.positions[0].currentPtBalance).toBe("40000000");

    const offlineRes = await probeIndexerPositionsFast({
      userAddress: TEST_USER,
      indexerApiUrl: "http://mock-indexer.local",
      fetchImpl: (async () => {
        throw new Error("Connection refused");
      }) as unknown as typeof fetch,
    });

    expect(offlineRes.reachable).toBe(false);
    expect(offlineRes.response).toBeNull();
  });

  it("resolves all Blend Protocol and Stellar token logos cleanly", () => {
    expect(resolveTokenLogoPath("USDC")).toBe("/tokens/usdc.svg");
    expect(resolveTokenLogoPath("XLM")).toBe("/tokens/xlm.svg");
    expect(resolveTokenLogoPath("EURC")).toBe("/tokens/eurc.png");
    expect(resolveTokenLogoPath("BLEND")).toBe("/tokens/blend.svg");
    expect(resolveTokenLogoPath("BLND")).toBe("/tokens/blnd.svg");
    expect(resolveTokenLogoPath("PYUSD")).toBe("/tokens/pyusd.png");
    expect(resolveTokenLogoPath("AQUA")).toBe("/tokens/aqua.png");
    expect(resolveTokenLogoPath("USTRY")).toBe("/tokens/ustry.png");
    expect(resolveTokenLogoPath("CETES")).toBe("/tokens/cetes.png");
    expect(resolveTokenLogoPath("TESOURO")).toBe("/tokens/tesouro.png");
    expect(resolveTokenLogoPath("SolvBTC")).toBe("/tokens/solvbtc.svg");
    expect(resolveTokenLogoPath("xSolvBTC")).toBe("/tokens/xsolvbtc.svg");
  });
});

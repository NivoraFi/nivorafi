// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, mock } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";

// Mock WalletProvider state for predictable component rendering
let mockWalletState = {
  address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27" as string | null,
  mode: "wallet" as "disconnected" | "wallet" | "watch",
  walletId: "freighter" as string | null,
  walletNetworkMismatch: false,
  kitReady: true,
  connecting: false,
  connectWallet: async () => {},
  connectWatchAddress: (_pk: string) => {},
  disconnect: async () => {},
  signTransactionXdr: async (xdr: string) => xdr,
  switchNetwork: async () => {},
};

mock.module("@/context/WalletProvider", () => ({
  useWallet: () => mockWalletState,
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
  isNetworkMismatch: (payload?: { networkPassphrase?: string; network?: string } | null) => {
    if (mockWalletState.walletNetworkMismatch) return true;
    if (!payload) return false;
    const targetPassphrase = "Test SDF Network ; September 2015";
    const targetNet = "testnet";
    if (payload.networkPassphrase && payload.networkPassphrase.trim() !== targetPassphrase) {
      return true;
    }
    if (payload.network && payload.network.trim().toLowerCase() !== targetNet) {
      return true;
    }
    return false;
  },
}));

import { useRolloverQuote, UseRolloverQuoteParams, RolloverQuoteResult } from "@/hooks/useRolloverQuote";
import { PRESET_MARKETS } from "../markets";
import { MarketProvider } from "@/context/MarketContext";

describe("useRolloverQuote Hook Unit Tests", () => {
  const usdcMatured = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
  const usdc30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
  const usdc90D = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;
  const xlm90D = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

  function runHook(params: UseRolloverQuoteParams): RolloverQuoteResult {
    let captured: RolloverQuoteResult | null = null;
    function TestConsumer({ p }: { p: UseRolloverQuoteParams }) {
      captured = useRolloverQuote(p);
      return null;
    }

    renderToString(
      React.createElement(
        MarketProvider,
        null,
        React.createElement(TestConsumer, { p: params })
      )
    );

    return captured!;
  }

  it("returns IDLE status when source or target market is null", () => {
    const quote = runHook({
      sourceMarket: null,
      targetMarket: usdc90D,
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("IDLE");
  });

  it("enforces pre-flight check: SOURCE_NOT_MATURED when source pool is active", () => {
    const quote = runHook({
      sourceMarket: usdc90D, // Active, not matured
      targetMarket: usdc30D,
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("SOURCE_NOT_MATURED");
    expect(quote.errorMessage).toContain("not yet matured");
  });

  it("enforces pre-flight check: TARGET_ALREADY_MATURED when target pool is matured", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: usdcMatured, // Matured
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("TARGET_ALREADY_MATURED");
    expect(quote.errorMessage).toContain("already matured");
  });

  it("enforces pre-flight check: CROSS_ASSET_DISALLOWED when asset codes differ", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: xlm90D, // XLM vs USDC
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("CROSS_ASSET_DISALLOWED");
    expect(quote.errorMessage).toContain("Asset must match");
  });

  it("enforces pre-flight check: IDENTICAL_POOLS when pool addresses match", () => {
    // Clone usdc90D as fake matured market with identical pool address
    const fakeMaturedIdentical = {
      ...usdc90D,
      maturity: 1600000000, // In the past
    };

    const quote = runHook({
      sourceMarket: fakeMaturedIdentical,
      targetMarket: usdc90D,
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("IDENTICAL_POOLS");
    expect(quote.errorMessage).toContain("cannot be identical");
  });

  it("enforces balance validation: INSUFFICIENT_BALANCE when input exceeds balance", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: usdc30D,
      ptAmountInput: "100.0",
      sourcePtBalance: 50_0000000n, // Only 50 PT available
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("INSUFFICIENT_BALANCE");
    expect(quote.errorMessage).toBe("Insufficient balance");
  });

  it("enforces input format validation: INVALID_INPUT for zero or negative amount", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: usdc30D,
      ptAmountInput: "0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
    });

    expect(quote.isValid).toBe(false);
    expect(quote.status).toBe("INVALID_INPUT");
  });

  it("computes accurate quote and builds valid action for roll_to_py (LP mode)", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: usdc30D,
      ptAmountInput: "20.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_py",
      slippageBps: 50, // 0.5%
    });

    expect(quote.isValid).toBe(true);
    expect(quote.status).toBe("READY");
    expect(quote.parsedAmount).toBe(20_0000000n);
    expect(quote.sourcePtBurned).toBe(20_0000000n);
    expect(quote.interimSySettled).toBe(20_0000000n);
    expect(quote.estimatedTargetPt).toBe(20_0000000n);
    expect(quote.estimatedTargetYt).toBe(20_0000000n);
    // 20.0 - 0.5% = 19.9
    expect(quote.minTargetOut).toBe(19_9000000n);
    expect(quote.discountMultiplier).toBe(1.0);

    const action = quote.buildAction("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
    expect(action.type).toBe("rollover_to_py");
    if (action.type === "rollover_to_py") {
      expect(action.ptAmount).toBe(20_0000000n);
      expect(action.minNewShares).toBe(19_9000000n);
      expect(action.sourcePool).toBe(usdcMatured.contracts.poolId);
      expect(action.targetPool).toBe(usdc30D.contracts.poolId);
    }
  });

  it("computes accurate quote and builds valid action for roll_to_pt (Fixed Yield mode)", () => {
    const quote = runHook({
      sourceMarket: usdcMatured,
      targetMarket: usdc30D,
      ptAmountInput: "10.0",
      sourcePtBalance: 50_0000000n,
      mode: "roll_to_pt",
      slippageBps: 50, // 0.5%
    });

    expect(quote.isValid).toBe(true);
    expect(quote.status).toBe("READY");
    expect(quote.parsedAmount).toBe(10_0000000n);
    expect(quote.sourcePtBurned).toBe(10_0000000n);
    expect(quote.interimSySettled).toBe(10_0000000n);
    expect(quote.estimatedTargetPt).toBeGreaterThan(10_0000000n);
    expect(quote.minTargetOut).toBeLessThan(quote.estimatedTargetPt);
    expect(quote.fixedBonusPt).toBe(quote.estimatedTargetPt - 10_0000000n);

    const action = quote.buildAction(
      "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
    );
    expect(action.type).toBe("rollover_to_pt");
    if (action.type === "rollover_to_pt") {
      expect(action.ptAmount).toBe(10_0000000n);
      expect(action.minTargetPt).toBe(quote.minTargetOut);
      expect(action.caller).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(action.receiver).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    }
  });
});

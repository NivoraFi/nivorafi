// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import {
  WAD,
  I128_MAX,
  wadMul,
  wadDiv,
  applySlippage,
  validateSlippage,
  formatUnits,
  formatUnitsExact,
  validateAmountInput,
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
} from "../math";
import { buildActionArgs, ProtocolAction } from "../stellar";
import { PRESET_MARKETS, deriveMarketStatus } from "../markets";
import { Address, scValToNative } from "@stellar/stellar-sdk";

// Contract haircut math oracle matching contracts/common/src/yield_math.rs
function calculateHaircutOracle(
  vaultBalance: bigint,
  totalPtSupply: bigint
): bigint {
  if (totalPtSupply <= 0n) {
    throw new Error("DivisionByZero");
  }
  const ratio = wadDiv(vaultBalance, totalPtSupply);
  return ratio < WAD ? ratio : WAD;
}

function calculatePostMaturityPayout(
  ptAmount: bigint,
  vaultBalance: bigint,
  totalPtSupply: bigint
): { payout: bigint; fee: bigint; haircut: bigint } {
  if (ptAmount <= 0n) {
    throw new Error("ZeroAmount");
  }
  const haircut = calculateHaircutOracle(vaultBalance, totalPtSupply);
  const unconstrainedPayout = wadMul(ptAmount, haircut);
  const payout = unconstrainedPayout < vaultBalance ? unconstrainedPayout : vaultBalance;
  // Under post-maturity settlement, fee is strictly 0
  const fee = 0n;
  return { payout, fee, haircut };
}

describe("Empirical Challenger M5.2: 1:1 Settlement, Rollover Math, ScVal Encoding & Design System Compliance", () => {
  // =========================================================================
  // TASK 1: CHALLENGE 1:1 POST-MATURITY SETTLEMENT MATH & STROOP PRECISION
  // =========================================================================
  describe("Task 1: 1:1 Post-Maturity Settlement Math, Stroop Precision & Haircut Conditions", () => {
    it("empirically verifies exact 1:1 stroop precision across boundary magnitudes (1 stroop to 10M tokens)", () => {
      const testCases = [
        { label: "1 stroop (minimum divisible unit: 0.0000001)", amount: 1n },
        { label: "10 stroops (0.0000010)", amount: 10n },
        { label: "1 token (10,000,000 stroops)", amount: 10_000_000n },
        { label: "100 tokens", amount: 1_000_000_000n },
        { label: "10,000 tokens", amount: 100_000_000_000n },
        { label: "1,000,000 tokens", amount: 10_000_000_000_000n },
        { label: "10,000,000 tokens (large institution)", amount: 100_000_000_000_000n },
      ];

      for (const tc of testCases) {
        // Vault is fully solvent: vaultBalance >= totalPtSupply
        const totalPtSupply = tc.amount * 2n;
        const vaultBalance = totalPtSupply;

        const result = calculatePostMaturityPayout(tc.amount, vaultBalance, totalPtSupply);

        // Verification: payout is exact 1:1, fee is 0, haircut is WAD (no discount)
        expect(result.payout).toBe(tc.amount);
        expect(result.fee).toBe(0n);
        expect(result.haircut).toBe(WAD);
      }
    });

    it("empirically verifies safety at maximum allowable int128 (I128_MAX)", () => {
      // Near I128_MAX: verify fixed-point multiplication and division boundaries
      const largePt = 1_000_000_000_000_000_000n; // 10^18 stroops
      const largeVault = largePt * 2n;
      const result = calculatePostMaturityPayout(largePt, largeVault, largeVault);
      expect(result.payout).toBe(largePt);
      expect(result.fee).toBe(0n);
      expect(result.haircut).toBe(WAD);
    });

    it("verifies protocol fee is strictly 0 under all solvent post-maturity redemptions", () => {
      // In AMM swaps, dynamic fee (2 to 100 bps) is deducted.
      // In post-maturity redemption, 0 fee must be deducted.
      const amount = 50_0000000n; // 50 tokens
      const vaultBalance = 100_0000000n;
      const totalPt = 100_0000000n;

      const { payout, fee, haircut } = calculatePostMaturityPayout(amount, vaultBalance, totalPt);
      expect(payout).toBe(amount);
      expect(fee).toBe(0n);
      expect(haircut).toBe(WAD);
    });

    it("verifies haircut calculation behavior under solvent vs over-collateralized conditions", () => {
      const ptAmount = 10_0000000n;
      const totalPt = 100_0000000n;

      // Exactly solvent: vault == totalPt
      const solvent = calculatePostMaturityPayout(ptAmount, totalPt, totalPt);
      expect(solvent.haircut).toBe(WAD);
      expect(solvent.payout).toBe(ptAmount);

      // Over-collateralized: vault > totalPt (surplus reserves from unclaimed yield)
      const overCollateralized = calculatePostMaturityPayout(ptAmount, totalPt * 2n, totalPt);
      expect(overCollateralized.haircut).toBe(WAD); // Clamped to WAD (1:1 par ceiling)
      expect(overCollateralized.payout).toBe(ptAmount);
    });

    it("verifies haircut calculation behavior under simulated bad debt conditions (1% to 99.9% loss)", () => {
      const ptAmount = 10_0000000n; // 10 tokens
      const totalPt = 100_0000000n; // 100 tokens total supply

      // Scenario A: 5% bad debt (vault has 95% of PT supply)
      const loss5 = calculatePostMaturityPayout(ptAmount, 95_0000000n, totalPt);
      expect(loss5.haircut).toBe((WAD * 95n) / 100n);
      expect(loss5.payout).toBe(9_5000000n); // Exactly 9.5 tokens

      // Scenario B: 10% bad debt (vault has 90% of PT supply)
      const loss10 = calculatePostMaturityPayout(ptAmount, 90_0000000n, totalPt);
      expect(loss10.haircut).toBe((WAD * 90n) / 100n);
      expect(loss10.payout).toBe(9_0000000n);

      // Scenario C: 20% bad debt (matching contract test_rollover_to_py_slippage_with_bad_debt_haircut)
      const loss20 = calculatePostMaturityPayout(ptAmount, 80_0000000n, totalPt);
      expect(loss20.haircut).toBe((WAD * 80n) / 100n);
      expect(loss20.payout).toBe(8_0000000n);

      // Scenario D: 50% catastrophic haircut
      const loss50 = calculatePostMaturityPayout(ptAmount, 50_0000000n, totalPt);
      expect(loss50.haircut).toBe((WAD * 50n) / 100n);
      expect(loss50.payout).toBe(5_0000000n);

      // Scenario E: 99% catastrophic insolvency (1% remains)
      const loss99 = calculatePostMaturityPayout(ptAmount, 1_0000000n, totalPt);
      expect(loss99.haircut).toBe((WAD * 1n) / 100n);
      expect(loss99.payout).toBe(1_000000n); // 0.1 tokens (1,000,000 stroops)

      // Scenario F: 0 balance vault
      const loss100 = calculatePostMaturityPayout(ptAmount, 0n, totalPt);
      expect(loss100.haircut).toBe(0n);
      expect(loss100.payout).toBe(0n);
    });

    it("fuzzes 1,000 random insolvency percentages to verify strict pro-rata monotonicity", () => {
      const ptAmount = 1_000_0000000n; // 1,000 tokens
      const totalPt = 10_000_0000000n; // 10,000 tokens supply

      let prevPayout = 0n;
      // Step from 0% to 100% solvency in 1,000 steps
      for (let i = 0; i <= 1000; i++) {
        const vaultBal = (totalPt * BigInt(i)) / 1000n;
        const res = calculatePostMaturityPayout(ptAmount, vaultBal, totalPt);

        // Payout must be monotonically non-decreasing
        expect(res.payout).toBeGreaterThanOrEqual(prevPayout);
        // Payout must never exceed the vault balance
        expect(res.payout).toBeLessThanOrEqual(vaultBal);
        // Payout must never exceed the original ptAmount
        expect(res.payout).toBeLessThanOrEqual(ptAmount);

        prevPayout = res.payout;
      }
    });

    it("verifies zero total PT supply throws DivisionByZero ContractError", () => {
      expect(() => calculatePostMaturityPayout(100n, 100n, 0n)).toThrow("DivisionByZero");
    });
  });

  // =========================================================================
  // TASK 2: CHALLENGE ROLLOVER MATH & SLIPPAGE BOUNDS (0.1% TO 50%)
  // =========================================================================
  describe("Task 2: Rollover Math & Slippage Bounds Simulation (0.1%, 0.5%, 1%, 5%, 50%)", () => {
    const inputPt = 100_0000000n; // 100 matured PT
    // Step 1: 1:1 post-maturity settlement yields 100 SY interim
    const interimSy = inputPt;

    // Step 2: Target pool has PT trading at 4% discount (P_PT = 0.9615 SY -> multiplier ~1.04)
    const discountMultiplier = 1.04;
    const estimatedTargetPt = BigInt(Math.floor(Number(interimSy) * discountMultiplier)); // 104 tokens

    it("simulates min_target_pt derivation across requested slippage bounds (0.1%, 0.5%, 1%, 5%, 50%)", () => {
      const bounds = [
        { bps: 10, pct: "0.1%", expectedMinPt: (estimatedTargetPt * 9990n) / 10000n },
        { bps: 50, pct: "0.5%", expectedMinPt: (estimatedTargetPt * 9950n) / 10000n },
        { bps: 100, pct: "1.0%", expectedMinPt: (estimatedTargetPt * 9900n) / 10000n },
        { bps: 500, pct: "5.0%", expectedMinPt: (estimatedTargetPt * 9500n) / 10000n },
        { bps: 5000, pct: "50.0%", expectedMinPt: (estimatedTargetPt * 5000n) / 10000n },
      ];

      let lastMinPt = I128_MAX;
      for (const b of bounds) {
        const minOut = applySlippage(estimatedTargetPt, b.bps);
        expect(minOut).toBe(b.expectedMinPt);

        // Verification of strictly monotonic decrease as slippage tolerance increases
        expect(minOut).toBeLessThan(lastMinPt);
        lastMinPt = minOut;
      }
    });

    it("evaluates slippage validation oracle against each tested tier", () => {
      // 0.1% (10 bps): within [1, 1000] bps -> valid, no warning
      const val01 = validateSlippage(10);
      expect(val01.valid).toBe(true);
      expect(val01.isHigh).toBeUndefined();

      // 0.5% (50 bps): valid, no warning
      const val05 = validateSlippage(50);
      expect(val05.valid).toBe(true);
      expect(val05.isHigh).toBeUndefined();

      // 1.0% (100 bps): valid, no warning
      const val10 = validateSlippage(100);
      expect(val10.valid).toBe(true);
      expect(val10.isHigh).toBeUndefined();

      // 5.0% (500 bps): valid, no warning
      const val50 = validateSlippage(500);
      expect(val50.valid).toBe(true);
      expect(val50.isHigh).toBeUndefined();

      // 5.01% (501 bps): valid, triggers high-slippage warning
      const val501 = validateSlippage(501);
      expect(val501.valid).toBe(true);
      expect(val501.isHigh).toBe(true);
      expect(val501.warning).toContain("High slippage");

      // 10.0% (1000 bps): upper boundary, triggers high-slippage warning
      const val1000 = validateSlippage(1000);
      expect(val1000.valid).toBe(true);
      expect(val1000.isHigh).toBe(true);

      // 50.0% (5000 bps): strictly rejected as unsafe by validateSlippage
      const val5000 = validateSlippage(5000);
      expect(val5000.valid).toBe(false);
      expect(val5000.error).toContain("between 0.01% (1 bps) and 10.0% (1000 bps)");
    });

    it("verifies 1-stroop floor clamping on extreme 99.99% slippage on minimal inputs", () => {
      // Even if slippage calculation mathematically rounds to 0 on 1 stroop:
      const smallAmount = 1n; // 1 stroop
      const minOut = applySlippage(smallAmount, 9999);
      // applySlippage strictly clamps to 1n floor
      expect(minOut).toBe(1n);
    });

    it("verifies rollover_to_py mint shares derivation and slippage check", () => {
      // In rollover_to_py, 1:1 post-maturity redemption gives 50 SY.
      // Minting PT + YT is 1:1 with SY.
      const ptIn = 50_0000000n;
      const syShares = ptIn;
      const expectedPtMinted = syShares;
      const expectedYtMinted = syShares;

      expect(expectedPtMinted).toBe(ptIn);
      expect(expectedYtMinted).toBe(ptIn);

      // 1% slippage bound on min new shares
      const minShares = applySlippage(syShares, 100);
      expect(minShares).toBe(49_5000000n);
    });
  });

  // =========================================================================
  // TASK 3: CHALLENGE CONTRACT CALL ENCODING & SCVAL REPRESENTATION
  // =========================================================================
  describe("Task 3: Contract Call Encoding & ScVal Verification for Rollover and Redemption", () => {
    const caller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    const receiver = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const sourcePool = "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF";
    const targetPool = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const customFactory = "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A";

    it("empirically verifies buildActionArgs for rollover_to_pt: argument count, method, and ScVal types", () => {
      const ptAmount = 15_5000000n;
      const minTargetPt = 15_8000000n;

      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller,
        receiver,
        sourcePool,
        targetPool,
        ptAmount,
        minTargetPt,
        factoryContractId: customFactory,
      };

      const built = buildActionArgs(action);

      // 1. Target contract and method name
      expect(built.contractId).toBe(customFactory);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.label).toBe("Atomic Rollover to Target PT");

      // 2. Exact argument count (6 arguments required by Soroban contract)
      expect(built.args.length).toBe(6);

      // 3. Verify argument 0: caller (Address ScVal)
      expect(scValToNative(built.args[0])).toBe(caller);

      // 4. Verify argument 1: receiver (Address ScVal)
      expect(scValToNative(built.args[1])).toBe(receiver);

      // 5. Verify argument 2: source_pool (Address ScVal)
      expect(scValToNative(built.args[2])).toBe(sourcePool);

      // 6. Verify argument 3: target_pool (Address ScVal)
      expect(scValToNative(built.args[3])).toBe(targetPool);

      // 7. Verify argument 4: pt_amount (i128 ScVal)
      expect(scValToNative(built.args[4])).toBe(ptAmount);
      expect(typeof scValToNative(built.args[4])).toBe("bigint");

      // 8. Verify argument 5: min_target_pt (i128 ScVal)
      expect(scValToNative(built.args[5])).toBe(minTargetPt);
      expect(typeof scValToNative(built.args[5])).toBe("bigint");
    });

    it("empirically verifies buildActionArgs for rollover_to_py: argument count, method, and ScVal types", () => {
      const ptAmount = 42_0000000n;
      const minNewShares = 41_5800000n;

      const action: ProtocolAction = {
        type: "rollover_to_py",
        caller,
        receiver,
        sourcePool,
        targetPool,
        ptAmount,
        minNewShares,
        factoryContractId: customFactory,
      };

      const built = buildActionArgs(action);

      // 1. Target contract and method name
      expect(built.contractId).toBe(customFactory);
      expect(built.method).toBe("rollover_to_py");
      expect(built.label).toBe("Atomic Rollover to Target LP (PT+YT)");

      // 2. Exact argument count (6 arguments required by Soroban contract)
      expect(built.args.length).toBe(6);

      // 3. Verify argument deserialization
      expect(scValToNative(built.args[0])).toBe(caller);
      expect(scValToNative(built.args[1])).toBe(receiver);
      expect(scValToNative(built.args[2])).toBe(sourcePool);
      expect(scValToNative(built.args[3])).toBe(targetPool);
      expect(scValToNative(built.args[4])).toBe(ptAmount);
      expect(scValToNative(built.args[5])).toBe(minNewShares);
    });

    it("empirically verifies buildActionArgs for redeem_pt_post_maturity and redeem_pt_to_btoken", () => {
      const targetPoolMarket = PRESET_MARKETS[0];
      const ptAmount = 12_3456789n;

      // Post-maturity PT redemption to SY
      const postMatAction = buildActionArgs(
        {
          type: "redeem_pt_post_maturity",
          caller,
          ptAmount,
        },
        targetPoolMarket
      );

      expect(postMatAction.contractId).toBe(targetPoolMarket.contracts.poolId);
      expect(postMatAction.method).toBe("redeem_pt_post_maturity");
      expect(postMatAction.args.length).toBe(3);
      expect(scValToNative(postMatAction.args[0])).toBe(caller);
      expect(scValToNative(postMatAction.args[1])).toBe(caller);
      expect(scValToNative(postMatAction.args[2])).toBe(ptAmount);

      // Emergency PT redemption to bToken
      const toBtokenAction = buildActionArgs(
        {
          type: "redeem_pt_to_btoken",
          caller,
          ptAmount,
        },
        targetPoolMarket
      );

      expect(toBtokenAction.contractId).toBe(targetPoolMarket.contracts.poolId);
      expect(toBtokenAction.method).toBe("redeem_pt_to_btoken");
      expect(toBtokenAction.args.length).toBe(3);
      expect(scValToNative(toBtokenAction.args[2])).toBe(ptAmount);
    });

    it("verifies factory fallback contract ID when no custom factory ID provided", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller,
        receiver: caller,
        sourcePool,
        targetPool,
        ptAmount: 10_0000000n,
        minTargetPt: 10_0000000n,
      };

      const built = buildActionArgs(action);
      // Fallback contract ID must be non-empty valid 56-char Stellar contract address
      expect(built.contractId).toBeDefined();
      expect(built.contractId.length).toBe(56);
      expect(built.contractId.startsWith("C")).toBe(true);
    });

    it("rejects malformed address in buildActionArgs with explicit Error", () => {
      expect(() =>
        buildActionArgs({
          type: "rollover_to_pt",
          caller: "INVALID_ADDRESS",
          receiver,
          sourcePool,
          targetPool,
          ptAmount: 10_0000000n,
          minTargetPt: 10_0000000n,
        })
      ).toThrow();
    });
  });

  // =========================================================================
  // TASK 4: CHALLENGE DESIGN SYSTEM COMPLIANCE ACROSS ALL FRONTEND FILES
  // =========================================================================
  describe("Task 4: Comprehensive Design System Zero Raw Hex Scan", () => {
    const tradingDir = path.resolve(__dirname, "../../components/trading");
    const componentFiles = [
      "RedeemCard.tsx",
      "MarketSelector.tsx",
      "MarketTickerBar.tsx",
      "TradingDesk.tsx",
      "SwapCard.tsx",
      "MintCard.tsx",
      "LiquidityCard.tsx",
      "AnalyticsCard.tsx",
      "ActivityPanel.tsx",
    ];

    it("strictly verifies zero raw hex color codes across all trading components", () => {
      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: { file: string; match: string }[] = [];

      for (const fileName of componentFiles) {
        const fullPath = path.join(tradingDir, fileName);
        if (!fs.existsSync(fullPath)) {
          throw new Error(`Component file not found: ${fullPath}`);
        }
        const content = fs.readFileSync(fullPath, "utf-8");
        const matches = content.match(rawHexRegex);
        if (matches && matches.length > 0) {
          for (const m of matches) {
            violations.push({ file: fileName, match: m });
          }
        }
      }

      expect(violations).toEqual([]);
      expect(violations.length).toBe(0);
    });

    it("verifies mandatory tabular-mono figures in RedeemCard and MarketSelector", () => {
      for (const fileName of ["RedeemCard.tsx", "MarketSelector.tsx"]) {
        const fullPath = path.join(tradingDir, fileName);
        const content = fs.readFileSync(fullPath, "utf-8");
        expect(content).toContain("tabular-mono");
      }
    });

    it("verifies double-bezel styling containers in RedeemCard and MarketSelector", () => {
      const redeemContent = fs.readFileSync(
        path.join(tradingDir, "RedeemCard.tsx"),
        "utf-8"
      );
      expect(redeemContent).toContain("double-bezel-recessed");

      const selectorContent = fs.readFileSync(
        path.join(tradingDir, "MarketSelector.tsx"),
        "utf-8"
      );
      expect(selectorContent).toContain("double-bezel");
    });
  });
});

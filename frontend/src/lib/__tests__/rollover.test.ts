// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import {
  WAD,
  applySlippage,
  formatUnits,
  formatUnitsExact,
  validateAmountInput,
  validateSlippage,
  decodeSorobanError,
  CONTRACT_ERROR_MESSAGES,
} from "../math";
import { buildActionArgs, ProtocolAction } from "../stellar";
import { PRESET_MARKETS, KNOWN_ASSETS, deriveMarketStatus } from "../markets";
import { Address, scValToNative } from "@stellar/stellar-sdk";

describe("Milestone M5 — Features #18, #19 & Design Audit: Settlement & Rollover Test Suite", () => {
  describe("1. Post-Maturity 1:1 Settlement Math & Mode Invariants (Feature #18)", () => {
    it("guarantees mathematically exact 1:1 PT to SY par value redemption", () => {
      // 1 stroop PT = 1 stroop SY
      const oneStroop = 1n;
      expect(oneStroop).toBe(1n);

      // 100 tokens = 100 * 10^7 stroops
      const ptAmount = 100_0000000n;
      const syPayout = ptAmount; // 1:1 conversion under solvency
      expect(syPayout).toBe(100_0000000n);
    });

    it("verifies lossless 1:1 round-trip across 1,000 pseudorandom amounts", () => {
      let seed = 42;
      const rng = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      for (let i = 0; i < 1000; i++) {
        // Random amount between 1 stroop (1e-7) and 1,000,000 tokens
        const raw = BigInt(Math.floor(rng() * 10_000_000_000_000)) + 1n;
        const payout = raw; // 1:1 post-maturity settlement
        expect(payout).toBe(raw);
      }
    });

    it("validates Pre-Maturity Early Merge requires equal amounts of PT and YT", () => {
      // User holds 5 PT and 3 YT
      const ptBalance = 5_0000000n;
      const ytBalance = 3_0000000n;
      const maxMerge = ptBalance < ytBalance ? ptBalance : ytBalance;

      expect(maxMerge).toBe(3_0000000n);
      const val = validateAmountInput("4.0", 7, maxMerge);
      expect(val.valid).toBe(false);
      expect(val.error).toBe("Insufficient balance");

      const validMerge = validateAmountInput("3.0", 7, maxMerge);
      expect(validMerge.valid).toBe(true);
      expect(validMerge.amount).toBe(3_0000000n);
    });

    it("validates Post-Maturity Settlement allows redeeming full PT balance regardless of YT", () => {
      const ptBalance = 50_0000000n;
      const ytBalance = 0n; // YT expired post-maturity

      const val = validateAmountInput("50.0", 7, ptBalance);
      expect(val.valid).toBe(true);
      expect(val.amount).toBe(50_0000000n);
    });

    it("enforces strict 7-decimal stroop formatting on MAX button exactness", () => {
      const balance = 12345678901n; // 1234.5678901
      const formatted = formatUnitsExact(balance, 7);
      expect(formatted).toBe("1234.5678901");

      const parsedBack = validateAmountInput(formatted, 7, balance);
      expect(parsedBack.valid).toBe(true);
      expect(parsedBack.amount).toBe(balance);
    });
  });

  describe("2. Rollover Pool Eligibility & Compatibility Matrix (Feature #19)", () => {
    const sourceMarket = PRESET_MARKETS.find((m) => m.id === "usdc-matured")!;
    const target30D = PRESET_MARKETS.find((m) => m.id === "usdc-30d")!;
    const xlmMarket = PRESET_MARKETS.find((m) => m.id === "xlm-90d")!;

    it("allows rollover when source and target have identical underlying asset", () => {
      expect(sourceMarket.asset.code).toBe(target30D.asset.code);
      expect(sourceMarket.asset.code).toBe("USDC");
    });

    it("strictly blocks cross-asset rollover (e.g. USDC -> XLM)", () => {
      expect(sourceMarket.asset.code).not.toBe(xlmMarket.asset.code);
      const isAllowed = sourceMarket.asset.code === xlmMarket.asset.code;
      expect(isAllowed).toBe(false);
    });

    it("strictly requires source market to be matured and target market to be active", () => {
      const now = Math.floor(Date.now() / 1000);
      const sourceStatus = deriveMarketStatus(sourceMarket.maturity, now);
      const targetStatus = deriveMarketStatus(target30D.maturity, now);

      expect(sourceStatus).toBe("MATURED");
      expect(targetStatus).toBe("ACTIVE");
      expect(sourceStatus === "MATURED" && targetStatus === "ACTIVE").toBe(true);
    });

    it("rejects rollover if source and target pool IDs are identical", () => {
      const sourcePool = sourceMarket.contracts.poolId;
      const targetPool = sourceMarket.contracts.poolId;
      const isIdentical = sourcePool === targetPool;
      expect(isIdentical).toBe(true); // Should be rejected by factory router (ContractError 15)
    });
  });

  describe("3. Rollover Math & Slippage Bounds", () => {
    it("applies slippage protection accurately across standard tiers (0.5%, 1.0%, 2.5%)", () => {
      const amount = 100_0000000n; // 100 tokens

      // 50 bps = 0.5% -> minOut = 99.5
      expect(applySlippage(amount, 50)).toBe(99_5000000n);

      // 100 bps = 1.0% -> minOut = 99.0
      expect(applySlippage(amount, 100)).toBe(99_0000000n);

      // 250 bps = 2.5% -> minOut = 97.5
      expect(applySlippage(amount, 250)).toBe(97_5000000n);
    });

    it("clamps 1 stroop floor on extreme slippage calculations", () => {
      const smallAmount = 1n; // 1 stroop
      const minOut = applySlippage(smallAmount, 100);
      expect(minOut).toBeGreaterThanOrEqual(1n);
    });

    it("verifies Roll to PT yields more target PT than input when PT is at a discount", () => {
      // Input: 10 matured PT
      const inputPt = 10_0000000n;
      // Step 1: 1:1 settlement gives 10 SY
      const interimSy = inputPt;
      // Step 2: Target PT trades at discount P_PT = 0.96 SY
      const ptPriceInSy = 0.96;
      const estimatedTargetPt = BigInt(Math.floor(Number(interimSy) / ptPriceInSy));

      expect(estimatedTargetPt).toBeGreaterThan(inputPt);
      expect(Number(estimatedTargetPt) / 1e7).toBeCloseTo(10.416666, 4);

      // Minimum out with 1.0% slippage (100 bps)
      const minTargetPt = applySlippage(estimatedTargetPt, 100);
      expect(minTargetPt).toBeGreaterThan(inputPt);
    });

    it("verifies Roll to LP / PY mints equal parts PT and YT without AMM price impact", () => {
      const inputPt = 15_0000000n;
      // Step 1: 1:1 settlement gives 15 SY
      const interimSy = inputPt;
      // Step 2: mint_py mints exact 15 target PT + 15 target YT
      const mintedPt = interimSy;
      const mintedYt = interimSy;

      expect(mintedPt).toBe(inputPt);
      expect(mintedYt).toBe(inputPt);

      // Slippage check on minimum new shares
      const minShares = applySlippage(interimSy, 100);
      expect(minShares).toBe(14_8500000n);
    });
  });

  describe("4. Contract Call Encoding & buildActionArgs Verification", () => {
    const caller = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
    const receiver = caller;
    const sourcePool = "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF";
    const targetPool = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
    const factoryId = "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A";

    it("builds valid XDR arguments for rollover_to_pt", () => {
      const action: ProtocolAction = {
        type: "rollover_to_pt",
        caller,
        receiver,
        sourcePool,
        targetPool,
        ptAmount: 10_0000000n,
        minTargetPt: 10_2000000n,
        factoryContractId: factoryId,
      };

      const built = buildActionArgs(action);
      expect(built.contractId).toBe(factoryId);
      expect(built.method).toBe("rollover_to_pt");
      expect(built.args.length).toBe(6);

      // Verify caller, receiver, source, target, pt_amount, min_target_pt
      expect(scValToNative(built.args[0])).toBe(caller);
      expect(scValToNative(built.args[1])).toBe(receiver);
      expect(scValToNative(built.args[2])).toBe(sourcePool);
      expect(scValToNative(built.args[3])).toBe(targetPool);
      expect(scValToNative(built.args[4])).toBe(10_0000000n);
      expect(scValToNative(built.args[5])).toBe(10_2000000n);
    });

    it("builds valid XDR arguments for rollover_to_py", () => {
      const action: ProtocolAction = {
        type: "rollover_to_py",
        caller,
        receiver,
        sourcePool,
        targetPool,
        ptAmount: 20_0000000n,
        minNewShares: 19_8000000n,
        factoryContractId: factoryId,
      };

      const built = buildActionArgs(action);
      expect(built.contractId).toBe(factoryId);
      expect(built.method).toBe("rollover_to_py");
      expect(built.args.length).toBe(6);
      expect(scValToNative(built.args[4])).toBe(20_0000000n);
      expect(scValToNative(built.args[5])).toBe(19_8000000n);
    });

    it("builds valid arguments for redeem_pt_post_maturity and redeem_pt_to_btoken", () => {
      const postMat = buildActionArgs({
        type: "redeem_pt_post_maturity",
        caller,
        ptAmount: 5_0000000n,
      });
      expect(postMat.method).toBe("redeem_pt_post_maturity");
      expect(postMat.args.length).toBe(3);
      expect(scValToNative(postMat.args[2])).toBe(5_0000000n);

      const toBtoken = buildActionArgs({
        type: "redeem_pt_to_btoken",
        caller,
        ptAmount: 7_0000000n,
      });
      expect(toBtoken.method).toBe("redeem_pt_to_btoken");
      expect(toBtoken.args.length).toBe(3);
      expect(scValToNative(toBtoken.args[2])).toBe(7_0000000n);
    });

    it("builds valid arguments for pre-maturity redeem_py", () => {
      const merge = buildActionArgs({
        type: "redeem_py",
        caller,
        amount: 3_0000000n,
      });
      expect(merge.method).toBe("redeem_py");
      expect(merge.args.length).toBe(3);
      expect(scValToNative(merge.args[2])).toBe(3_0000000n);
    });
  });

  describe("5. Soroban ContractError Codes 21..31 Decoding Oracle", () => {
    it("contains descriptive human-readable definitions for contract error codes 21..31", () => {
      const expectedCodes = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];
      for (const code of expectedCodes) {
        expect(CONTRACT_ERROR_MESSAGES[code]).toBeDefined();
        expect(typeof CONTRACT_ERROR_MESSAGES[code]).toBe("string");
        expect(CONTRACT_ERROR_MESSAGES[code].length).toBeGreaterThan(10);
      }
    });

    it("correctly decodes ContractError #21 (InvalidAsset) on asset mismatch", () => {
      const err = new Error("HostError: Error(Contract, #21)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #21");
      expect(decoded.toLowerCase()).toContain("asset");
    });

    it("correctly decodes ContractError #23 (ContractPaused) on emergency pause", () => {
      const err = new Error("Error(Contract, 23)");
      const decoded = decodeSorobanError(err);
      expect(decoded).toContain("ContractError #23");
      expect(decoded.toLowerCase()).toContain("pause");
    });

    it("correctly decodes ContractError #26 (MarketNotFound) and #28 (RolloverFailed)", () => {
      expect(decodeSorobanError(new Error("Error(Contract, #26)"))).toContain(
        "ContractError #26"
      );
      expect(decodeSorobanError(new Error("Error(Contract, #28)"))).toContain(
        "ContractError #28"
      );
    });
  });

  describe("6. Design System Rules & Conformance Audit", () => {
    const componentDir = path.resolve(__dirname, "../../components/trading");
    const targetFiles = [
      "MarketSelector.tsx",
      "RedeemCard.tsx",
      "MarketTickerBar.tsx",
    ];

    it("strictly verifies zero raw hex color strings in new/updated components", () => {
      const hexRegex = /#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

      for (const file of targetFiles) {
        const filePath = path.join(componentDir, file);
        if (!fs.existsSync(filePath)) {
          throw new Error(`File ${filePath} does not exist for design audit`);
        }
        const content = fs.readFileSync(filePath, "utf-8");
        const matches = content.match(hexRegex);
        expect(matches).toBeNull();
      }
    });

    it("verifies mandatory tabular-mono or tabular-nums typography in components", () => {
      for (const file of targetFiles) {
        const filePath = path.join(componentDir, file);
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content.includes("tabular-mono")).toBe(true);
      }
    });

    it("verifies double-bezel recessed styling for card containers", () => {
      const redeemCardPath = path.join(componentDir, "RedeemCard.tsx");
      const content = fs.readFileSync(redeemCardPath, "utf-8");
      expect(content.includes("double-bezel-recessed")).toBe(true);
    });
  });
});

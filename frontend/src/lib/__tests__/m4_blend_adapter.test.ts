// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { PRESET_MARKETS, MarketDefinition } from "../markets";
import { ENV } from "../env";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import {
  BLEND_CONTRACTS,
  DEFAULT_BLEND_DEPLOYMENTS,
  BLEND_DEPLOYMENTS,
  isValidStellarContractId,
  normalizeNetwork,
  getBlendPoolConfig,
  resolveMarketBlendPool,
  getBlendFallbackRate,
  isRealBlendPool,
  formatBlendRate,
} from "../blend";

describe("Milestone 4: Blend Adapter & Config Implementation", () => {
  // --------------------------------------------------------------------------
  // Suite 1: Design System & Tamper-Proof Code Integrity
  // --------------------------------------------------------------------------
  describe("Suite 1: Design System & Tamper-Proof Code Integrity", () => {
    const LIB_DIR = path.resolve(__dirname, "..");
    const FRONTEND_DIR = path.resolve(LIB_DIR, "..");

    it("strictly verifies zero raw hex color codes across Milestone 4 files", () => {
      const filesToCheck = [
        path.join(LIB_DIR, "blend.ts"),
        path.join(LIB_DIR, "markets.ts"),
        path.join(LIB_DIR, "stellar.ts"),
      ];

      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const violations: string[] = [];

      for (const filePath of filesToCheck) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          const matches = line.match(rawHexRegex);
          if (matches) {
            violations.push(
              `${path.basename(filePath)}:${idx + 1} - Found raw hex: ${matches.join(", ")}`
            );
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("strictly verifies zero raw Unicode emojis across Milestone 4 files", () => {
      const filesToCheck = [
        path.join(LIB_DIR, "blend.ts"),
        path.join(LIB_DIR, "markets.ts"),
        path.join(LIB_DIR, "stellar.ts"),
      ];

      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
      const violations: string[] = [];

      for (const filePath of filesToCheck) {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (emojiRegex.test(line)) {
            violations.push(
              `${path.basename(filePath)}:${idx + 1} - Found emoji character`
            );
          }
        });
      }

      expect(violations).toEqual([]);
    });

    it("strictly verifies tamper-proof SHA-256 integrity of protected indexer files", () => {
      const indexerPath = path.join(LIB_DIR, "indexer.ts");
      const useEventIndexerPath = path.join(
        FRONTEND_DIR,
        "hooks",
        "useEventIndexer.ts"
      );

      expect(fs.existsSync(indexerPath)).toBe(true);
      expect(fs.existsSync(useEventIndexerPath)).toBe(true);

      const indexerSha = crypto
        .createHash("sha256")
        .update(fs.readFileSync(indexerPath))
        .digest("hex");
      const useEventIndexerSha = crypto
        .createHash("sha256")
        .update(fs.readFileSync(useEventIndexerPath))
        .digest("hex");

      expect(indexerSha).toBe(
        "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c"
      );
      expect(useEventIndexerSha).toBe(
        "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c"
      );
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Address Validation & Sanitization Matrix
  // --------------------------------------------------------------------------
  describe("Suite 2: Address Validation & Sanitization Matrix", () => {
    it("validates valid Stellar contract addresses starting with C (56-char base32)", () => {
      expect(isValidStellarContractId(BLEND_CONTRACTS.testnet.pool)).toBe(true);
      expect(isValidStellarContractId(BLEND_CONTRACTS.mainnet.pool)).toBe(true);
      expect(isValidStellarContractId(BLEND_CONTRACTS.mock.pool)).toBe(true);
      expect(
        isValidStellarContractId(
          "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL"
        )
      ).toBe(true);
      expect(
        isValidStellarContractId(
          "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF"
        )
      ).toBe(true);
    });

    it("strictly rejects Stellar account addresses starting with G (valid account, invalid contract)", () => {
      expect(
        isValidStellarContractId(
          "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        )
      ).toBe(false);
    });

    it("strictly rejects secret keys starting with S", () => {
      expect(
        isValidStellarContractId(
          "SDAW52TKG2G62R7K6R46UUG27T2U2L4QFXNUG775XJ63M6H2MFL52K2L"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "SB27Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
    });

    it("strictly rejects invalid length strings", () => {
      // 55 characters
      expect(
        isValidStellarContractId(
          "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK"
        )
      ).toBe(false);
      // 57 characters
      expect(
        isValidStellarContractId(
          "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6A"
        )
      ).toBe(false);
      // Empty string
      expect(isValidStellarContractId("")).toBe(false);
    });

    it("strictly rejects invalid base32 characters and forbidden digits (0, 1, 8, 9)", () => {
      // Digits 0, 1, 8, 9 are not in RFC 4648 Base32 alphabet [A-Z2-7]
      expect(
        isValidStellarContractId(
          "C07Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "C17Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "C87Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "C97Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      // Special characters
      expect(
        isValidStellarContractId(
          "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXV-MYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXV_MYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXV@MYZVP55Q6YIUSIXVHCJXETK6"
        )
      ).toBe(false);
    });

    it("strictly rejects lowercase contract addresses (strict uppercase requirement)", () => {
      expect(
        isValidStellarContractId(
          "ccebvdym3x7to274bcc4ecnml27y5sf4k74s475lmgsoe62ss6i34jtb"
        )
      ).toBe(false);
      expect(
        isValidStellarContractId(
          "cc7q7fz5ylbp3eoh635vyrc4ezdvtxvomyzvp55q6yiusixvhcjxetk6"
        )
      ).toBe(false);
    });

    it("safely handles null, undefined, numbers, and malformed inputs without throwing", () => {
      expect(isValidStellarContractId(null)).toBe(false);
      expect(isValidStellarContractId(undefined)).toBe(false);
      expect(isValidStellarContractId(123456789)).toBe(false);
      expect(isValidStellarContractId({})).toBe(false);
      expect(isValidStellarContractId([])).toBe(false);
      expect(isValidStellarContractId(true)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Network-Specific Resolver Resolution Matrix
  // --------------------------------------------------------------------------
  describe("Suite 3: Network-Specific Resolver Resolution Matrix", () => {
    it("resolves testnet network to real Blend testnet deployment", () => {
      const config = getBlendPoolConfig("testnet");
      expect(config.network).toBe("testnet");
      expect(config.poolId).toBe(BLEND_CONTRACTS.testnet.pool);
      expect(config.isRealBlend).toBe(true);
      expect(config.activePool.poolAddress).toBe(BLEND_CONTRACTS.testnet.pool);
      expect(config.activePool.isMock).toBe(false);
    });

    it("resolves mainnet and public networks to real Blend mainnet deployment", () => {
      const cfgMain = getBlendPoolConfig("mainnet");
      expect(cfgMain.network).toBe("mainnet");
      expect(cfgMain.poolId).toBe(BLEND_CONTRACTS.mainnet.pool);
      expect(cfgMain.isRealBlend).toBe(true);
      expect(cfgMain.activePool.poolAddress).toBe(BLEND_CONTRACTS.mainnet.pool);
      expect(cfgMain.activePool.isMock).toBe(false);

      const cfgPub = getBlendPoolConfig("public");
      expect(cfgPub.network).toBe("mainnet");
      expect(cfgPub.poolId).toBe(BLEND_CONTRACTS.mainnet.pool);
      expect(cfgPub.isRealBlend).toBe(true);
    });

    it("resolves mock and standalone networks to mock Blend pool", () => {
      const cfgMock = getBlendPoolConfig("mock");
      expect(cfgMock.network).toBe("mock");
      expect(cfgMock.poolId).toBe(BLEND_CONTRACTS.mock.pool);
      expect(cfgMock.isRealBlend).toBe(false);
      expect(cfgMock.activePool.isMock).toBe(true);

      const cfgStand = getBlendPoolConfig("standalone");
      expect(cfgStand.network).toBe("mock");
      expect(cfgStand.poolId).toBe(BLEND_CONTRACTS.mock.pool);
      expect(cfgStand.isRealBlend).toBe(false);
    });

    it("handles network string normalization (trimming and case-insensitivity)", () => {
      expect(normalizeNetwork("TESTNET")).toBe("testnet");
      expect(normalizeNetwork("  testnet  ")).toBe("testnet");
      expect(normalizeNetwork("TestNet")).toBe("testnet");
      expect(normalizeNetwork("PUBLIC")).toBe("mainnet");
      expect(normalizeNetwork("  mainnet  ")).toBe("mainnet");
      expect(normalizeNetwork("MainNet")).toBe("mainnet");
      expect(normalizeNetwork("STANDALONE")).toBe("mock");
      expect(normalizeNetwork("  mock  ")).toBe("mock");

      expect(getBlendPoolConfig("TESTNET").poolId).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(getBlendPoolConfig("  mainnet  ").poolId).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
    });

    it("defaults to active environment network when called with no arguments", () => {
      const defaultCfg = getBlendPoolConfig();
      const expectedCfg = getBlendPoolConfig(ENV.network);
      expect(defaultCfg.poolId).toBe(expectedCfg.poolId);
      expect(defaultCfg.network).toBe(expectedCfg.network);
      expect(defaultCfg.isRealBlend).toBe(expectedCfg.isRealBlend);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Fallback Safety & Error Resilience
  // --------------------------------------------------------------------------
  describe("Suite 4: Fallback Safety & Error Resilience", () => {
    it("safely falls back to testnet when unknown network name is supplied", () => {
      const cfgEth = getBlendPoolConfig("ethereum");
      expect(cfgEth.network).toBe("testnet");
      expect(cfgEth.poolId).toBe(BLEND_CONTRACTS.testnet.pool);

      const cfgCustom = getBlendPoolConfig("custom-private-net");
      expect(cfgCustom.network).toBe("testnet");
      expect(cfgCustom.poolId).toBe(BLEND_CONTRACTS.testnet.pool);
    });

    it("handles undefined / null network parameters gracefully", () => {
      const cfgUndef = getBlendPoolConfig(undefined);
      expect(cfgUndef).toBeDefined();
      expect(cfgUndef.network).toBe("testnet");
      expect(isValidStellarContractId(cfgUndef.poolId)).toBe(true);

      const cfgNull = getBlendPoolConfig(null as unknown as string);
      expect(cfgNull).toBeDefined();
      expect(cfgNull.network).toBe("testnet");
      expect(isValidStellarContractId(cfgNull.poolId)).toBe(true);
    });

    it("ensures returned deployment objects are immutable / defensively isolated", () => {
      const cfg1 = getBlendPoolConfig("testnet");
      const originalName = cfg1.activePool.name;

      // Attempt to mutate the returned deployment object
      cfg1.activePool.name = "CORRUPTED_POOL_NAME";
      cfg1.activePool.poolAddress = "C0000000000000000000000000000000000000000000000000000000";

      // Verify that subsequent queries are not corrupted
      const cfg2 = getBlendPoolConfig("testnet");
      expect(cfg2.activePool.name).toBe(originalName);
      expect(cfg2.activePool.poolAddress).toBe(BLEND_CONTRACTS.testnet.pool);
      expect(
        DEFAULT_BLEND_DEPLOYMENTS["testnet-real"].name
      ).toBe(originalName);
    });

    it("respects NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID environment variable override", () => {
      const originalEnv = process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
      const testOverride =
        "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6";

      try {
        process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = testOverride;
        const cfg = getBlendPoolConfig("testnet");
        expect(cfg.poolId).toBe(testOverride);
        expect(cfg.activePool.poolAddress).toBe(testOverride);
      } finally {
        if (originalEnv !== undefined) {
          process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = originalEnv;
        } else {
          delete process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Market Definition & Preset Catalog Integration
  // --------------------------------------------------------------------------
  describe("Suite 5: Market Definition & Preset Catalog Integration", () => {
    it("verifies all PRESET_MARKETS have syntactically valid blendPoolId addresses", () => {
      expect(PRESET_MARKETS.length).toBe(4);
      for (const market of PRESET_MARKETS) {
        expect(isValidStellarContractId(market.contracts.blendPoolId)).toBe(true);
        expect(market.contracts.blendPoolId.length).toBe(56);
      }
    });

    it("verifies resolveMarketBlendPool helper returns correct pool per market and network", () => {
      const usdcMarket = PRESET_MARKETS.find((m) => m.id === "usdc-90d");
      expect(usdcMarket).toBeDefined();

      // Test with market ID string
      expect(resolveMarketBlendPool("usdc-90d", "USDC", "testnet")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(resolveMarketBlendPool("usdc-90d", "USDC", "mainnet")).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(resolveMarketBlendPool("usdc-90d", "USDC", "mock")).toBe(
        BLEND_CONTRACTS.mock.pool
      );

      // Test with market object
      expect(resolveMarketBlendPool(usdcMarket!, "testnet")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(resolveMarketBlendPool(usdcMarket!, "mainnet")).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(resolveMarketBlendPool(usdcMarket!, "mock")).toBe(
        BLEND_CONTRACTS.mock.pool
      );
    });

    it("preserves 100% backward compatibility when no network is passed to resolveMarketBlendPool", () => {
      for (const market of PRESET_MARKETS) {
        const resolved = resolveMarketBlendPool(market);
        expect(resolved).toBe(market.contracts.blendPoolId);
      }
    });

    it("verifies market definitions preserve contract structure across all 4 preset markets", () => {
      const expectedMarketIds = [
        "usdc-90d",
        "usdc-30d",
        "usdc-matured",
        "xlm-90d",
      ];

      for (const id of expectedMarketIds) {
        const market = PRESET_MARKETS.find((m) => m.id === id);
        expect(market).toBeDefined();
        expect(isValidStellarContractId(market!.contracts.poolId)).toBe(true);
        expect(isValidStellarContractId(market!.contracts.syId)).toBe(true);
        expect(isValidStellarContractId(market!.contracts.ptId)).toBe(true);
        expect(isValidStellarContractId(market!.contracts.ytId)).toBe(true);
        expect(isValidStellarContractId(market!.contracts.blendPoolId)).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Interface Parity & Zero Regressions
  // --------------------------------------------------------------------------
  describe("Suite 6: Interface Parity & Zero Regressions", () => {
    it("verifies mock_blend parity: mock pool address matches ENV.contracts.mock_blend", () => {
      expect(BLEND_CONTRACTS.mock.pool).toBe(ENV.contracts.mock_blend);
      expect(DEFAULT_BLEND_DEPLOYMENTS["testnet-mock"].poolAddress).toBe(
        ENV.contracts.mock_blend
      );
      expect(BLEND_DEPLOYMENTS["testnet-mock"].poolAddress).toBe(
        ENV.contracts.mock_blend
      );
    });

    it("verifies blend rate formatting, fallback, and pool classification functions", () => {
      // formatBlendRate
      expect(formatBlendRate(1_000_000_000n)).toBe("1.000000");
      expect(formatBlendRate(1_050_000_000n, 4)).toBe("1.0500");
      expect(formatBlendRate(0n)).toBe("1.000000");
      expect(formatBlendRate(-100n)).toBe("1.000000");
      expect(formatBlendRate(NaN)).toBe("1.000000");
      expect(formatBlendRate(1.1234567, 3)).toBe("1.123");

      // getBlendFallbackRate
      expect(getBlendFallbackRate("USDC")).toBe(1_000_000_000n);
      expect(getBlendFallbackRate("XLM")).toBe(1_000_000_000n);
      expect(getBlendFallbackRate("EURC")).toBe(1_000_000_000n);
      expect(getBlendFallbackRate()).toBe(1_000_000_000n);

      // isRealBlendPool
      expect(isRealBlendPool(BLEND_CONTRACTS.testnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.testnet.poolV2Authoritative)).toBe(
        true
      );
      expect(isRealBlendPool(BLEND_CONTRACTS.mainnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mainnet.poolFixedV2)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mock.pool)).toBe(false);
      expect(isRealBlendPool("INVALID_ADDRESS")).toBe(false);
    });

    it("verifies zero collision with existing tests and strict key count preservation in contracts.ts", () => {
      const contractKeys = Object.keys(STELLAR_PENDLE_CONFIG.contracts);
      expect(contractKeys).toEqual([
        "mock_blend",
        "sy_blend_wrapper",
        "pt_token",
        "yt_token",
        "yield_pool",
      ]);
      expect(contractKeys.length).toBe(5);
    });
  });
});

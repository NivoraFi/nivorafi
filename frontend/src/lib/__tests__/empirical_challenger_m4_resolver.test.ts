// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import { PRESET_MARKETS, MarketDefinition } from "../markets";
import { ENV } from "../env";
import {
  BLEND_CONTRACTS,
  DEFAULT_BLEND_DEPLOYMENTS,
  BLEND_DEPLOYMENTS,
  BlendPoolConfig,
  BlendPoolDeployment,
  isValidStellarContractId,
  normalizeNetwork,
  getBlendPoolConfig,
  resolveMarketBlendPool,
  getBlendFallbackRate,
  isRealBlendPool,
  formatBlendRate,
} from "../blend";

describe("Empirical Challenger M4.2: Resolver, Fallbacks & Immutability Adversarial Suite", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
  });

  afterEach(() => {
    if (ORIGINAL_ENV.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID !== undefined) {
      process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID =
        ORIGINAL_ENV.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
    } else {
      delete process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
    }
  });

  // --------------------------------------------------------------------------
  // Suite 1: Adversarial Network Input Matrix & Normalization Boundary Stress
  // --------------------------------------------------------------------------
  describe("Suite 1: Adversarial Network Input Matrix & Normalization Boundary Stress", () => {
    it("safely normalizes bizarre casing without throwing or failing", () => {
      const casingVariations = [
        { input: "TeStNeT", expected: "testnet" },
        { input: "tEsTnEt", expected: "testnet" },
        { input: "mAiNnEt", expected: "mainnet" },
        { input: "MAINNET", expected: "mainnet" },
        { input: "PuBlIc", expected: "mainnet" },
        { input: "PUBLIC", expected: "mainnet" },
        { input: "sTaNdAlOnE", expected: "mock" },
        { input: "STANDALONE", expected: "mock" },
        { input: "MoCk", expected: "mock" },
        { input: "MOCK", expected: "mock" },
        { input: "LoCaL", expected: "mock" },
        { input: "LOCAL", expected: "mock" },
        { input: "fUtUrEnEt", expected: "futurenet" },
        { input: "FUTURENET", expected: "futurenet" },
      ];

      for (const { input, expected } of casingVariations) {
        expect(normalizeNetwork(input)).toBe(expected as any);
        const config = getBlendPoolConfig(input);
        expect(config.network).toBe(expected as any);
        expect(isValidStellarContractId(config.poolId)).toBe(true);
      }
    });

    it("safely normalizes leading, trailing, and embedded whitespace / control chars", () => {
      const whitespaceInputs = [
        "  testnet  ",
        "\ttestnet\t",
        "\n\rtestnet\r\n",
        "  mainnet  ",
        " \t public \n",
        "   mock   ",
        " standalone\n",
      ];

      for (const input of whitespaceInputs) {
        const normalized = normalizeNetwork(input);
        expect(["testnet", "mainnet", "mock"]).toContain(normalized);
        const config = getBlendPoolConfig(input);
        expect(isValidStellarContractId(config.poolId)).toBe(true);
      }
    });

    it("safely handles alien chains, unknown names, and chaotic strings by falling back to testnet", () => {
      const alienNetworks = [
        "solana",
        "ethereum",
        "arbitrum",
        "polygon",
        "avalanche",
        "optimism",
        "base",
        "bitcoin",
        "cosmos",
        "null",
        "undefined",
        "0",
        "NaN",
        "[object Object]",
        "'; DROP TABLE contracts; --",
        "C".repeat(56),
        "",
        "      ",
      ];

      for (const alien of alienNetworks) {
        const normalized = normalizeNetwork(alien);
        // Alien networks must fallback safely to testnet
        expect(normalized).toBe("testnet");
        const config = getBlendPoolConfig(alien);
        expect(config.network).toBe("testnet");
        expect(config.poolId).toBe(BLEND_CONTRACTS.testnet.pool);
        expect(isValidStellarContractId(config.poolId)).toBe(true);
        expect(config.isRealBlend).toBe(true);
      }
    });

    it("safely handles non-string and falsy types at runtime without throwing exceptions", () => {
      const nonStringInputs = [
        null,
        undefined,
        12345,
        0,
        -1,
        NaN,
        Infinity,
        true,
        false,
        {},
        { network: "mainnet" },
        [],
        ["testnet"],
        () => "mainnet",
      ];

      for (const input of nonStringInputs) {
        // @ts-expect-error adversarial runtime typing
        const normalized = normalizeNetwork(input);
        expect(["testnet", "mainnet", "mock", "futurenet"]).toContain(normalized);
        // @ts-expect-error adversarial runtime typing
        const config = getBlendPoolConfig(input);
        expect(config).toBeDefined();
        expect(isValidStellarContractId(config.poolId)).toBe(true);
      }
    });

    it("verifies explicit useRealBlend boolean flag overrides on testnet", () => {
      const realConfig = getBlendPoolConfig("testnet", { useRealBlend: true });
      expect(realConfig.isRealBlend).toBe(true);
      expect(realConfig.poolId).toBe(BLEND_CONTRACTS.testnet.pool);

      const mockConfig = getBlendPoolConfig("testnet", { useRealBlend: false });
      expect(mockConfig.isRealBlend).toBe(false);
      expect(mockConfig.poolId).toBe(BLEND_CONTRACTS.mock.pool);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 2: Deep Immutability & Memory Defense Stress Test
  // --------------------------------------------------------------------------
  describe("Suite 2: Deep Immutability & Memory Defense Stress Test", () => {
    it("strictly prevents pollution of activePool root properties across subsequent queries", () => {
      const config1 = getBlendPoolConfig("testnet");
      const pristineAddress = config1.activePool.poolAddress;
      const pristineName = config1.activePool.name;
      const pristineId = config1.activePool.id;

      // Maliciously mutate config1
      config1.activePool.poolAddress = "CDISASTER000000000000000000000000000000000000000000000000";
      config1.activePool.name = "CORRUPTED_POOL";
      config1.activePool.id = "corrupted-id";
      config1.poolId = "CDISASTER000000000000000000000000000000000000000000000000";

      // Query again
      const config2 = getBlendPoolConfig("testnet");
      expect(config2.activePool.poolAddress).toBe(pristineAddress);
      expect(config2.activePool.name).toBe(pristineName);
      expect(config2.activePool.id).toBe(pristineId);
      expect(config2.poolId).toBe(pristineAddress);
    });

    it("strictly prevents deep nested pollution of reserve configs across subsequent queries", () => {
      const config1 = getBlendPoolConfig("testnet");
      const pristineUsdcSac = config1.activePool.reserves.USDC.assetAddress;
      const pristineDecimals = config1.activePool.reserves.USDC.decimals;
      const pristineRateWad = config1.activePool.reserves.USDC.initialRateWad;

      // Mutate deep reserve object
      config1.activePool.reserves.USDC.assetAddress = "CMALICIOUS_SAC_9999999999999999999999999999999999999999999";
      config1.activePool.reserves.USDC.decimals = 999;
      config1.activePool.reserves.USDC.initialRateWad = 999_999_999_999n;
      delete (config1.activePool.reserves as any).XLM;

      // Query again
      const config2 = getBlendPoolConfig("testnet");
      expect(config2.activePool.reserves.USDC.assetAddress).toBe(pristineUsdcSac);
      expect(config2.activePool.reserves.USDC.decimals).toBe(pristineDecimals);
      expect(config2.activePool.reserves.USDC.initialRateWad).toBe(pristineRateWad);
      expect(config2.activePool.reserves.XLM).toBeDefined();
    });

    it("strictly isolates deployments dictionary from deletion and mutation", () => {
      const config1 = getBlendPoolConfig("testnet");
      expect(config1.deployments["testnet-real"]).toBeDefined();
      expect(config1.deployments["mainnet-real"]).toBeDefined();

      // Mutate deployments map
      delete (config1.deployments as any)["testnet-real"];
      config1.deployments["mainnet-real"].poolAddress = "CHACKED_MAINNET_ADDRESS_00000000000000000000000000000000";

      // Query again
      const config2 = getBlendPoolConfig("testnet");
      expect(config2.deployments["testnet-real"]).toBeDefined();
      expect(config2.deployments["mainnet-real"].poolAddress).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
    });

    it("verifies global DEFAULT_BLEND_DEPLOYMENTS remains pristine after adversarial attacks", () => {
      expect(DEFAULT_BLEND_DEPLOYMENTS["testnet-real"].poolAddress).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(DEFAULT_BLEND_DEPLOYMENTS["testnet-real"].reserves.USDC.decimals).toBe(7);
      expect(DEFAULT_BLEND_DEPLOYMENTS["mainnet-real"].poolAddress).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(DEFAULT_BLEND_DEPLOYMENTS["testnet-mock"].poolAddress).toBe(
        BLEND_CONTRACTS.mock.pool
      );
    });
  });

  // --------------------------------------------------------------------------
  // Suite 3: Environment Variable & Options Precedence Matrix
  // --------------------------------------------------------------------------
  describe("Suite 3: Environment Variable & Options Precedence Matrix", () => {
    const ENV_OVERRIDE_ADDR =
      "CAJJZSGMMLL2LUGIVYUL5CYUQXCX4RP5432G6HHV5EVJS7BV2HOH4W46";
    const OPTIONS_OVERRIDE_ADDR =
      "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6";

    it("applies NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID when no options override is provided", () => {
      process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = ENV_OVERRIDE_ADDR;

      const config = getBlendPoolConfig("testnet");
      expect(config.poolId).toBe(ENV_OVERRIDE_ADDR);
      expect(config.activePool.poolAddress).toBe(ENV_OVERRIDE_ADDR);
    });

    it("enforces options.poolAddressOverride precedence OVER environment variable", () => {
      process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = ENV_OVERRIDE_ADDR;

      const config = getBlendPoolConfig("testnet", {
        poolAddressOverride: OPTIONS_OVERRIDE_ADDR,
      });

      // options.poolAddressOverride MUST take priority over env var
      expect(config.poolId).toBe(OPTIONS_OVERRIDE_ADDR);
      expect(config.activePool.poolAddress).toBe(OPTIONS_OVERRIDE_ADDR);
    });

    it("falls back to default pool when environment variable is empty string", () => {
      process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = "";

      const config = getBlendPoolConfig("testnet");
      expect(config.poolId).toBe(BLEND_CONTRACTS.testnet.pool);
    });

    it("restores original address immediately when environment variable is removed", () => {
      process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID = ENV_OVERRIDE_ADDR;
      expect(getBlendPoolConfig("testnet").poolId).toBe(ENV_OVERRIDE_ADDR);

      delete process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
      expect(getBlendPoolConfig("testnet").poolId).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
    });
  });

  // --------------------------------------------------------------------------
  // Suite 4: Polymorphic resolveMarketBlendPool Boundary & Malformed Object Stress
  // --------------------------------------------------------------------------
  describe("Suite 4: Polymorphic resolveMarketBlendPool Boundary & Malformed Object Stress", () => {
    const usdcMarket = PRESET_MARKETS.find((m) => m.id === "usdc-90d")!;

    it("resolves market definition object with 0 arguments to market's own blendPoolId", () => {
      for (const market of PRESET_MARKETS) {
        const resolved = resolveMarketBlendPool(market);
        expect(resolved).toBe(market.contracts.blendPoolId);
      }
    });

    it("resolves market definition object with target network override", () => {
      expect(resolveMarketBlendPool(usdcMarket, "testnet")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(resolveMarketBlendPool(usdcMarket, "mainnet")).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(resolveMarketBlendPool(usdcMarket, "mock")).toBe(
        BLEND_CONTRACTS.mock.pool
      );
      // Alien network falls back to testnet real pool
      expect(resolveMarketBlendPool(usdcMarket, "solana")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
    });

    it("resolves market ID string with polymorphic arguments", () => {
      // marketId only (backward compatibility defaults to mock)
      expect(resolveMarketBlendPool("usdc-90d")).toBe(BLEND_CONTRACTS.mock.pool);
      expect(resolveMarketBlendPool("xlm-90d")).toBe(BLEND_CONTRACTS.mock.pool);

      // marketId + network shorthand
      expect(resolveMarketBlendPool("usdc-90d", "testnet")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
      expect(resolveMarketBlendPool("usdc-90d", "mainnet")).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(resolveMarketBlendPool("usdc-90d", "mock")).toBe(
        BLEND_CONTRACTS.mock.pool
      );

      // marketId + assetCode + network
      expect(resolveMarketBlendPool("usdc-90d", "USDC", "mainnet")).toBe(
        BLEND_CONTRACTS.mainnet.pool
      );
      expect(resolveMarketBlendPool("xlm-90d", "XLM", "testnet")).toBe(
        BLEND_CONTRACTS.testnet.pool
      );
    });

    it("handles malformed, partial, and unexpected object inputs without crashing", () => {
      // Null and undefined
      expect(resolveMarketBlendPool(null)).toBe(BLEND_CONTRACTS.mock.pool);
      expect(resolveMarketBlendPool(undefined)).toBe(BLEND_CONTRACTS.mock.pool);

      // Empty object
      expect(resolveMarketBlendPool({})).toBe(BLEND_CONTRACTS.mock.pool);

      // Object without contracts
      expect(resolveMarketBlendPool({ id: "custom-market" })).toBe(
        BLEND_CONTRACTS.mock.pool
      );

      // Object with empty contracts
      expect(resolveMarketBlendPool({ contracts: {} })).toBe(
        BLEND_CONTRACTS.mock.pool
      );

      // Object with contracts but null blendPoolId
      expect(resolveMarketBlendPool({ contracts: { blendPoolId: null } })).toBe(
        BLEND_CONTRACTS.mock.pool
      );

      // Object with custom contracts blendPoolId
      const customPoolId = "CCEBVDYM3X7TO274BCC4ECNML27Y5SF4K74S475LMGSOE62SS6I34JTB";
      expect(
        resolveMarketBlendPool({ contracts: { blendPoolId: customPoolId } })
      ).toBe(customPoolId);

      // Primitive types
      // @ts-expect-error adversarial test
      expect(resolveMarketBlendPool(12345)).toBe(BLEND_CONTRACTS.mock.pool);
      // @ts-expect-error adversarial test
      expect(resolveMarketBlendPool(true)).toBe(BLEND_CONTRACTS.mock.pool);
      // @ts-expect-error adversarial test
      expect(resolveMarketBlendPool([])).toBe(BLEND_CONTRACTS.mock.pool);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 5: Fallback Rates, Rate Formatter, and Real Pool Detector Chaos Testing
  // --------------------------------------------------------------------------
  describe("Suite 5: Fallback Rates, Rate Formatter, and Real Pool Detector Chaos Testing", () => {
    it("returns positive 1.0 (SCALAR_9) fallback rates across all asset codes and edge inputs", () => {
      const knownAssets = ["USDC", "XLM", "EURC", "usdc", "xlm", "eurc"];
      for (const asset of knownAssets) {
        const rate = getBlendFallbackRate(asset);
        expect(rate).toBe(1_000_000_000n);
        expect(rate).toBeGreaterThan(0n);
      }

      const unknownInputs = [
        "SOLANA",
        "BTC",
        "UNKNOWN_ASSET",
        "",
        "   ",
        undefined,
        null as unknown as string,
      ];
      for (const input of unknownInputs) {
        const rate = getBlendFallbackRate(input);
        expect(rate).toBe(1_000_000_000n);
        expect(rate).toBeGreaterThan(0n);
      }
    });

    it("verifies formatBlendRate handles zero, negative, NaN, Infinity, and normal numbers", () => {
      // Normal numbers
      expect(formatBlendRate(1_000_000_000n)).toBe("1.000000");
      expect(formatBlendRate(1_050_000_000n)).toBe("1.050000");
      expect(formatBlendRate(1.05, 4)).toBe("1.0500");

      // Zero & negative inputs (must fall back to 1.000000 rather than collapsing portfolio to 0)
      expect(formatBlendRate(0n)).toBe("1.000000");
      expect(formatBlendRate(-100n)).toBe("1.000000");
      expect(formatBlendRate(0)).toBe("1.000000");
      expect(formatBlendRate(-1.5)).toBe("1.000000");

      // Non-finite numbers
      expect(formatBlendRate(NaN)).toBe("1.000000");
      expect(formatBlendRate(Infinity)).toBe("1.000000");
      expect(formatBlendRate(-Infinity)).toBe("1.000000");
    });

    it("verifies isRealBlendPool strictly identifies real deployments vs mocks and junk", () => {
      // Real pools
      expect(isRealBlendPool(BLEND_CONTRACTS.testnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.testnet.poolV2Authoritative)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mainnet.pool)).toBe(true);
      expect(isRealBlendPool(BLEND_CONTRACTS.mainnet.poolFixedV2)).toBe(true);

      // Mock pool
      expect(isRealBlendPool(BLEND_CONTRACTS.mock.pool)).toBe(false);

      // Random valid contract
      expect(
        isRealBlendPool("CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC")
      ).toBe(false);

      // Invalid / edge inputs
      expect(isRealBlendPool("")).toBe(false);
      // @ts-expect-error adversarial test
      expect(isRealBlendPool(null)).toBe(false);
      // @ts-expect-error adversarial test
      expect(isRealBlendPool(undefined)).toBe(false);
      // @ts-expect-error adversarial test
      expect(isRealBlendPool(12345)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Suite 6: Tamper-Proof Invariant Hash & Design System Purity Verification
  // --------------------------------------------------------------------------
  describe("Suite 6: Tamper-Proof Invariant Hash & Design System Purity Verification", () => {
    const LIB_DIR = path.resolve(__dirname, "..");
    const FRONTEND_DIR = path.resolve(LIB_DIR, "..");

    it("STRICT INVARIANT: indexer.ts remains 100% untouched and matches exact sha256 hash", () => {
      const indexerPath = path.join(LIB_DIR, "indexer.ts");
      expect(fs.existsSync(indexerPath)).toBe(true);
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(indexerPath))
        .digest("hex");
      expect(hash).toBe(
        "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c"
      );
    });

    it("STRICT INVARIANT: useEventIndexer.ts remains 100% untouched and matches exact sha256 hash", () => {
      const hookPath = path.join(FRONTEND_DIR, "hooks", "useEventIndexer.ts");
      expect(fs.existsSync(hookPath)).toBe(true);
      const hash = crypto
        .createHash("sha256")
        .update(fs.readFileSync(hookPath))
        .digest("hex");
      expect(hash).toBe(
        "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c"
      );
    });

    it("verifies zero raw hex color codes and zero emojis across lib/blend.ts", () => {
      const blendPath = path.join(LIB_DIR, "blend.ts");
      expect(fs.existsSync(blendPath)).toBe(true);
      const content = fs.readFileSync(blendPath, "utf-8");

      const rawHexRegex = /#([0-9a-fA-F]{3,8})\b/g;
      const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;

      expect(rawHexRegex.test(content)).toBe(false);
      expect(emojiRegex.test(content)).toBe(false);
    });
  });
});

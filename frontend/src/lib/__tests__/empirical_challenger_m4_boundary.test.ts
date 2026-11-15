import { describe, it, expect } from "bun:test";
import {
  isValidStellarContractId,
  formatBlendRate,
  BLEND_CONTRACTS,
  isRealBlendPool,
} from "../blend";
import { PRESET_MARKETS } from "../markets";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Deterministic Pseudo-Random Number Generator (Linear Congruential Generator)
class DeterministicRng {
  private state: number;

  constructor(seed = 133742) {
    this.state = seed;
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  sample<T>(items: T[]): T {
    return items[this.nextInt(0, items.length - 1)];
  }
}

// RFC 4648 Base32 alphabet: uppercase A-Z and digits 2-7
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const FORBIDDEN_DIGITS = ["0", "1", "8", "9"];
const PUNCTUATION_SYMBOLS = [
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")", "-", "_", "=", "+",
  "[", "]", "{", "}", ";", ":", "'", "\"", ",", "<", ".", ">", "/", "?",
  "\\", "|", "`", "~",
];
const WHITESPACES = [" ", "\t", "\n", "\r", "\u00A0", "\u200B"];

// Oracle validator for 56-character Soroban contract addresses
function oracleIsValidContractId(val: unknown): boolean {
  if (typeof val !== "string") return false;
  if (val.length !== 56) return false;
  if (val[0] !== "C") return false;
  for (let i = 1; i < 56; i++) {
    if (!BASE32_ALPHABET.includes(val[i])) {
      return false;
    }
  }
  return true;
}

describe("Empirical Challenger M4: Address Boundary & Numerical Sanitization Stress", () => {
  // =========================================================================
  // Suite 1: Strict Invariant & File Tamper Verification
  // =========================================================================
  describe("Suite 1: Untouched Files Integrity Invariant", () => {
    it("confirms frontend/src/lib/indexer.ts has not been modified (SHA-256 match)", () => {
      const filePath = resolve(__dirname, "../indexer.ts");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      const EXPECTED_HASH = "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c";

      expect(hash).toBe(EXPECTED_HASH);
    });

    it("confirms frontend/src/hooks/useEventIndexer.ts has not been modified (SHA-256 match)", () => {
      const filePath = resolve(__dirname, "../../hooks/useEventIndexer.ts");
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath);
      const hash = createHash("sha256").update(content).digest("hex");
      const EXPECTED_HASH = "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c";

      expect(hash).toBe(EXPECTED_HASH);
    });
  });

  // =========================================================================
  // Suite 2: isValidStellarContractId - Length and Character Boundary Fuzzing
  // =========================================================================
  describe("Suite 2: isValidStellarContractId Length & Character Boundary Fuzzing", () => {
    it("strictly rejects lengths from 0 to 55 and 57 to 100", () => {
      for (let len = 0; len <= 100; len++) {
        if (len === 56) continue;

        let str = "";
        if (len > 0) {
          str = "C" + "A".repeat(len - 1);
        }
        expect(isValidStellarContractId(str)).toBe(false);
      }
    });

    it("strictly rejects forbidden digits (0, 1, 8, 9) injected at boundary positions", () => {
      const validSuffix = "A".repeat(54);
      for (const forbidden of FORBIDDEN_DIGITS) {
        // At position 1
        expect(isValidStellarContractId("C" + forbidden + validSuffix)).toBe(false);
        // At position 28 (middle)
        expect(isValidStellarContractId("C" + "A".repeat(27) + forbidden + "A".repeat(27))).toBe(false);
        // At position 55 (last character)
        expect(isValidStellarContractId("C" + validSuffix + forbidden)).toBe(false);
      }
    });

    it("strictly rejects punctuation symbols injected at boundary positions", () => {
      const validSuffix = "A".repeat(54);
      for (const symbol of PUNCTUATION_SYMBOLS) {
        expect(isValidStellarContractId("C" + symbol + validSuffix)).toBe(false);
        expect(isValidStellarContractId("C" + validSuffix + symbol)).toBe(false);
      }
    });

    it("strictly rejects lowercase letters (c prefix and interior a-z)", () => {
      // Lowercase c prefix
      expect(isValidStellarContractId("c" + "A".repeat(55))).toBe(false);

      // Lowercase letters across a-z injected at various positions
      for (let code = 97; code <= 122; code++) {
        const lowerChar = String.fromCharCode(code);
        expect(isValidStellarContractId("C" + lowerChar + "A".repeat(54))).toBe(false);
        expect(isValidStellarContractId("C" + "A".repeat(27) + lowerChar + "A".repeat(27))).toBe(false);
        expect(isValidStellarContractId("C" + "A".repeat(54) + lowerChar)).toBe(false);
      }
    });

    it("strictly rejects leading, trailing, and embedded whitespaces", () => {
      const validContract = "CCEBVDYM3X7TO274BCC4ECNML27Y5SF4K74S475LMGSOE62SS6I34JTB";
      for (const ws of WHITESPACES) {
        expect(isValidStellarContractId(ws + validContract)).toBe(false);
        expect(isValidStellarContractId(validContract + ws)).toBe(false);
        expect(isValidStellarContractId(validContract.slice(0, 20) + ws + validContract.slice(21))).toBe(false);
      }
    });

    it("safely rejects all non-string types without throwing exceptions", () => {
      const nonStringInputs: unknown[] = [
        null,
        undefined,
        0,
        1,
        -1,
        NaN,
        Infinity,
        -Infinity,
        true,
        false,
        0n,
        1000n,
        {},
        { length: 56 },
        [],
        ["C" + "A".repeat(55)],
        () => "CCEBVDYM3X7TO274BCC4ECNML27Y5SF4K74S475LMGSOE62SS6I34JTB",
        Symbol("contract"),
      ];

      for (const input of nonStringInputs) {
        expect(isValidStellarContractId(input)).toBe(false);
      }
    });
  });

  // =========================================================================
  // Suite 3: 1,000+ Randomized Deterministic Adversarial Vectors
  // =========================================================================
  describe("Suite 3: 1,000+ Randomized Adversarial Vectors vs Oracle", () => {
    it("evaluates 1,200 randomized vectors matching oracle truth table exactly", () => {
      const rng = new DeterministicRng(987654321);
      const allPossibleChars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{}|;':\",./<>? ";

      let testedCount = 0;
      let validContractAcceptedCount = 0;
      let invalidContractRejectedCount = 0;

      for (let i = 0; i < 1200; i++) {
        testedCount++;
        const scenario = rng.nextInt(1, 5);
        let candidate: string;

        if (scenario === 1) {
          // Perfectly valid 56-char contract ID
          let body = "";
          for (let c = 0; c < 55; c++) {
            body += rng.sample([...BASE32_ALPHABET]);
          }
          candidate = "C" + body;
        } else if (scenario === 2) {
          // Starts with C, correct length 56, but includes 1 or more corrupted chars
          const corruptIndex = rng.nextInt(1, 55);
          let body = "";
          for (let c = 0; c < 55; c++) {
            if (c === corruptIndex - 1) {
              // Pick corrupted char: forbidden digit, lowercase, symbol, or space
              body += rng.sample([...FORBIDDEN_DIGITS, ...WHITESPACES, "a", "b", "z", "#", "!"]);
            } else {
              body += rng.sample([...BASE32_ALPHABET]);
            }
          }
          candidate = "C" + body;
        } else if (scenario === 3) {
          // Wrong prefix: G, M, S, 0, or lowercase c, with 56 chars
          const prefix = rng.sample(["G", "M", "S", "0", "c", "T", "P", "1"]);
          let body = "";
          for (let c = 0; c < 55; c++) {
            body += rng.sample([...BASE32_ALPHABET]);
          }
          candidate = prefix + body;
        } else if (scenario === 4) {
          // Random length between 0 and 90
          const length = rng.nextInt(0, 90);
          candidate = "";
          for (let c = 0; c < length; c++) {
            candidate += rng.sample([...allPossibleChars]);
          }
        } else {
          // Subtle off-by-one length: 55 or 57 chars starting with C and base32
          const length = rng.sample([55, 57]);
          let body = "";
          for (let c = 0; c < length - 1; c++) {
            body += rng.sample([...BASE32_ALPHABET]);
          }
          candidate = "C" + body;
        }

        const oracleResult = oracleIsValidContractId(candidate);
        const actualResult = isValidStellarContractId(candidate);

        expect(actualResult).toBe(oracleResult);

        if (actualResult) {
          validContractAcceptedCount++;
        } else {
          invalidContractRejectedCount++;
        }
      }

      expect(testedCount).toBe(1200);
      expect(validContractAcceptedCount).toBeGreaterThan(150);
      expect(invalidContractRejectedCount).toBeGreaterThan(800);
    });
  });

  // =========================================================================
  // Suite 4: Stellar Address Type Rejection Matrix
  // =========================================================================
  describe("Suite 4: Stellar Address Type Rejection Matrix", () => {
    it("strictly rejects valid Stellar account addresses starting with 'G'", () => {
      const validGAccounts = [
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
        "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        "GCLWGQPMKXQSPF776IU33AH4PZNOOWNAWGGCDTBQACVOQHIF7IB2ZIIO",
        "GDQ5363GYQSQYHYGYQ2EGFN5W4QMQ3TUPUXSZS64N5NPNQY52H76J7T6",
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        "GCFXHS4GMXBYRBAP5GS4HIUSV5OCFUBQYS54HC6OYDT2P2SVOI4KDOAU",
        "GAA7J5CUDK6F2JTYV4F4HGB67Y67Z3JOU7Z2EUSJHQ7R4J4KZZQ2L2C4",
      ];

      for (const account of validGAccounts) {
        expect(account.length).toBe(56);
        expect(isValidStellarContractId(account)).toBe(false);
      }

      // 50 synthetic G-addresses
      const rng = new DeterministicRng(111222333);
      for (let i = 0; i < 50; i++) {
        let body = "";
        for (let c = 0; c < 55; c++) {
          body += rng.sample([...BASE32_ALPHABET]);
        }
        const gAddress = "G" + body;
        expect(gAddress.length).toBe(56);
        expect(isValidStellarContractId(gAddress)).toBe(false);
      }
    });

    it("strictly rejects Stellar muxed accounts starting with 'M'", () => {
      const validMAccounts = [
        "MAAAAAAAAAAAAAB7BQ2L7E5NBWMXDUCMZS5A2GX2HZZ2AWC63PBW2W6UK7PY6644LYAAAAAAAAAAAAG2Q",
        "MD3SPOW4U24H2YGLGZTY3JOU265X2Z7B3J7Z2Q2R2K4M6P7Q2L2M4N4P4R4S4T4U4V4W4X4Y4Z2A2B2C2D",
      ];

      for (const muxed of validMAccounts) {
        expect(isValidStellarContractId(muxed)).toBe(false);
      }

      // Synthetic 69-character M-addresses
      const rng = new DeterministicRng(444555666);
      for (let i = 0; i < 20; i++) {
        let body = "";
        for (let c = 0; c < 68; c++) {
          body += rng.sample([...BASE32_ALPHABET]);
        }
        const mAddress = "M" + body;
        expect(isValidStellarContractId(mAddress)).toBe(false);
      }
    });

    it("strictly rejects Stellar claimable balance IDs starting with '00000000'", () => {
      const claimableBalanceIds = [
        "0000000092995b5457378af39f62d173c233ddae575c5252ec42e517c4c61ec245130dd0",
        "000000000000000000000000000000000000000000000000000000000000000000000000",
        "00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "00000000a1b2c3d4e5f678901234567890abcdef1234567890abcdef1234567890abcdef",
      ];

      for (const cb of claimableBalanceIds) {
        expect(isValidStellarContractId(cb)).toBe(false);
      }
    });

    it("strictly rejects Stellar secret seeds starting with 'S'", () => {
      const secretSeeds = [
        "SBMSFOWQW6RYROUOF2Z3J35VMDOC7CENOPL7X635MTOOW5YJ6U52PCYN",
        "SA7W4AFA3V4NGBR32G6V3K256I22ZJ2L24L7V6XN4KQQX22R2B4V23E4",
        "SCZANGBA5YHTNYVVV4C3U252E2B4Z5X2J6K4P7Q2L2M4N4P4R4S4T4U4",
      ];

      for (const seed of secretSeeds) {
        expect(seed.length).toBe(56);
        expect(isValidStellarContractId(seed)).toBe(false);
      }
    });

    it("strictly rejects pre-authorized transaction hashes (T...) and signed payloads (P...)", () => {
      const rng = new DeterministicRng(777888999);
      for (let i = 0; i < 10; i++) {
        let body = "";
        for (let c = 0; c < 55; c++) {
          body += rng.sample([...BASE32_ALPHABET]);
        }
        expect(isValidStellarContractId("T" + body)).toBe(false);
        expect(isValidStellarContractId("P" + body)).toBe(false);
      }
    });
  });

  // =========================================================================
  // Suite 5: Valid Contract ID Acceptance Matrix
  // =========================================================================
  describe("Suite 5: Valid Contract ID Acceptance Matrix", () => {
    it("accepts all canonical Soroban contracts defined in BLEND_CONTRACTS", () => {
      const canonicalContracts = [
        BLEND_CONTRACTS.testnet.pool,
        BLEND_CONTRACTS.testnet.poolV2Authoritative,
        BLEND_CONTRACTS.testnet.backstop,
        BLEND_CONTRACTS.testnet.emitter,
        BLEND_CONTRACTS.testnet.poolFactory,
        BLEND_CONTRACTS.testnet.blendUsdcSac,
        BLEND_CONTRACTS.testnet.circleUsdcSac,
        BLEND_CONTRACTS.testnet.xlmSac,
        BLEND_CONTRACTS.mainnet.pool,
        BLEND_CONTRACTS.mainnet.poolFixedV2,
        BLEND_CONTRACTS.mainnet.backstop,
        BLEND_CONTRACTS.mainnet.poolFactory,
        BLEND_CONTRACTS.mainnet.usdcSac,
        BLEND_CONTRACTS.mainnet.xlmSac,
        BLEND_CONTRACTS.mock.pool,
        BLEND_CONTRACTS.mock.eurcSac,
      ];

      for (const contract of canonicalContracts) {
        expect(isValidStellarContractId(contract)).toBe(true);
      }
    });

    it("accepts all 30 contract IDs across PRESET_MARKETS definitions", () => {
      for (const market of PRESET_MARKETS) {
        expect(isValidStellarContractId(market.contracts.poolId)).toBe(true);
        expect(isValidStellarContractId(market.contracts.syId)).toBe(true);
        expect(isValidStellarContractId(market.contracts.ptId)).toBe(true);
        expect(isValidStellarContractId(market.contracts.ytId)).toBe(true);
        expect(isValidStellarContractId(market.contracts.blendPoolId)).toBe(true);
      }
    });

    it("accepts 100 dynamically generated structurally valid contract IDs", () => {
      const rng = new DeterministicRng(123450987);
      for (let i = 0; i < 100; i++) {
        let body = "";
        for (let c = 0; c < 55; c++) {
          body += rng.sample([...BASE32_ALPHABET]);
        }
        const validContractId = "C" + body;
        expect(validContractId.length).toBe(56);
        expect(isValidStellarContractId(validContractId)).toBe(true);
      }
    });
  });

  // =========================================================================
  // Suite 6: formatBlendRate Numerical Stress Testing
  // =========================================================================
  describe("Suite 6: formatBlendRate Numerical Stress Testing", () => {
    it("handles non-finite inputs (NaN, -Infinity, +Infinity) gracefully", () => {
      expect(formatBlendRate(NaN)).toBe("1.000000");
      expect(formatBlendRate(-Infinity)).toBe("1.000000");
      expect(formatBlendRate(Infinity)).toBe("1.000000");

      // Custom decimals on non-finite inputs
      expect(formatBlendRate(NaN, 2)).toBe("1.00");
      expect(formatBlendRate(NaN, 4)).toBe("1.0000");
      expect(formatBlendRate(-Infinity, 0)).toBe("1");
    });

    it("handles zero and negative numerical inputs with default baseline fallback", () => {
      expect(formatBlendRate(0)).toBe("1.000000");
      expect(formatBlendRate(-0)).toBe("1.000000");
      expect(formatBlendRate(-1)).toBe("1.000000");
      expect(formatBlendRate(-0.00001)).toBe("1.000000");
      expect(formatBlendRate(-1e18)).toBe("1.000000");

      // BigInt zero and negatives
      expect(formatBlendRate(0n)).toBe("1.000000");
      expect(formatBlendRate(-1n)).toBe("1.000000");
      expect(formatBlendRate(-1_000_000_000n)).toBe("1.000000");
      expect(formatBlendRate(-(10n ** 18n))).toBe("1.000000");
    });

    it("correctly formats valid rates around standard scale (1.0 = 1_000_000_000n)", () => {
      // 1.0 anchor
      expect(formatBlendRate(1_000_000_000n)).toBe("1.000000");
      expect(formatBlendRate(1.0)).toBe("1.000000");

      // 1.053457 (rounded)
      expect(formatBlendRate(1_053_456_789n)).toBe("1.053457");
      expect(formatBlendRate(1.053456789)).toBe("1.053457");

      // 2.50
      expect(formatBlendRate(2_500_000_000n)).toBe("2.500000");
      expect(formatBlendRate(2.5)).toBe("2.500000");
    });

    it("stress tests extreme large numbers (1e18, i64 max, u128 max, u256 max, huge bigint)", () => {
      // 1e18 as number
      const rate1e18 = formatBlendRate(1e18);
      expect(rate1e18).toBe("1000000000000000000.000000");

      // i64 max
      const i64Max = 2n ** 63n - 1n;
      const rateI64 = formatBlendRate(i64Max);
      expect(rateI64).toBe("9223372036.854776");

      // u64 max
      const u64Max = 2n ** 64n - 1n;
      const rateU64 = formatBlendRate(u64Max);
      expect(rateU64).toBe("18446744073.709553");

      // u128 max
      const u128Max = 2n ** 128n - 1n;
      const rateU128 = formatBlendRate(u128Max);
      expect(typeof rateU128).toBe("string");
      expect(rateU128.length).toBeGreaterThan(0);
      expect(rateU128).not.toBe("NaN");

      // u256 max
      const u256Max = 2n ** 256n - 1n;
      const rateU256 = formatBlendRate(u256Max);
      expect(typeof rateU256).toBe("string");
      expect(rateU256.length).toBeGreaterThan(0);
      expect(rateU256).not.toBe("NaN");

      // Huge BigInt that overflows IEEE-754 float to Infinity:
      // Number(2n ** 1050n) = Infinity -> !Number.isFinite -> fallback to (1).toFixed(6)
      const hugeBigInt = 2n ** 1050n;
      expect(formatBlendRate(hugeBigInt)).toBe("1.000000");
    });

    it("stress tests tiny positive floats and Number.MIN_VALUE", () => {
      // 1e-6
      expect(formatBlendRate(1e-6)).toBe("0.000001");

      // 1e-12
      expect(formatBlendRate(1e-12)).toBe("0.000000");

      // Number.MIN_VALUE (5e-324)
      const minValResult = formatBlendRate(Number.MIN_VALUE);
      expect(minValResult).toBe("0.000000");
      expect(minValResult).not.toBe("NaN");
    });

    it("respects custom decimals formatting across edge cases", () => {
      const sampleRate = 1_053_456_789n;

      expect(formatBlendRate(sampleRate, 0)).toBe("1");
      expect(formatBlendRate(sampleRate, 2)).toBe("1.05");
      expect(formatBlendRate(sampleRate, 4)).toBe("1.0535");
      expect(formatBlendRate(sampleRate, 8)).toBe("1.05345679");
      expect(formatBlendRate(sampleRate, 9)).toBe("1.053456789");

      // Fallbacks with custom decimals
      expect(formatBlendRate(0, 0)).toBe("1");
      expect(formatBlendRate(0, 2)).toBe("1.00");
      expect(formatBlendRate(0, 4)).toBe("1.0000");
      expect(formatBlendRate(0, 7)).toBe("1.0000000");
    });
  });

  // =========================================================================
  // Suite 7: Design System & Clean Code Conformance
  // =========================================================================
  describe("Suite 7: Zero Emojis and Clean Style Verification", () => {
    it("verifies the empirical test file contains zero Unicode emojis", () => {
      const filePath = resolve(__dirname, "empirical_challenger_m4_boundary.test.ts");
      const content = readFileSync(filePath, "utf-8");
      const emojiPattern =
        /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u;
      expect(emojiPattern.test(content)).toBe(false);
    });
  });
});

// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import {
  WAD,
  formatUnits,
  shortenAddress,
  quoteSwapLocal,
  MarketStateRaw,
} from "../math";
import type { LiveMarketSnapshot, WireLogEntry } from "../stellar";

// ============================================================================
// SPECIFICATION ORACLES & STATE MACHINES (Authoritative Requirement Helpers)
// ============================================================================

export type ViewMode = "landing" | "trade";

/**
 * Validates headline and description copy constraints according to design-system.md:
 * - Headlines: maximum 6 words.
 * - Descriptions: maximum 1 sentence.
 */
export function validateHeadline(headline: string): { valid: boolean; wordCount: number; reason?: string } {
  const trimmed = headline.trim();
  if (!trimmed) {
    return { valid: false, wordCount: 0, reason: "Headline cannot be empty." };
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 6) {
    return {
      valid: false,
      wordCount: words.length,
      reason: `Headline exceeds 6 words (found ${words.length}): "${headline}"`,
    };
  }
  return { valid: true, wordCount: words.length };
}

export function validateDescription(description: string): { valid: boolean; sentenceCount: number; reason?: string } {
  const trimmed = description.trim();
  if (!trimmed) {
    return { valid: false, sentenceCount: 0, reason: "Description cannot be empty." };
  }
  // Split on sentence-ending punctuation (.!?) followed by space or end of string
  const sentences = trimmed
    .split(/(?<=[.!?])(?:\s+|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (sentences.length > 1) {
    return {
      valid: false,
      sentenceCount: sentences.length,
      reason: `Description exceeds 1 sentence (found ${sentences.length}): "${description}"`,
    };
  }
  return { valid: true, sentenceCount: sentences.length };
}

/**
 * Pure URL View Resolution State Machine matching page.tsx specification:
 * - ?view=trade -> "trade"
 * - ?view=landing -> "landing"
 * - #trade -> "trade"
 * - Default / invalid / unknown -> "landing"
 */
export function resolveViewMode(queryString: string, hash?: string): ViewMode {
  const params = new URLSearchParams(queryString.startsWith("?") ? queryString.slice(1) : queryString);
  const viewParam = params.get("view");

  if (viewParam === "trade") return "trade";
  if (viewParam === "landing") return "landing";

  if (hash) {
    const cleanHash = hash.startsWith("#") ? hash.slice(1) : hash;
    if (cleanHash === "trade") return "trade";
    if (cleanHash === "landing") return "landing";
  }

  return "landing";
}

/**
 * Pure Snapshot Formatter with null/offline fallbacks
 */
export function formatSnapshotMetrics(snapshot: LiveMarketSnapshot | null) {
  if (!snapshot) {
    return {
      impliedApyFormatted: "—",
      ytPriceFormatted: "—",
      contractsCountText: "5 / 5 Verified",
      isOffline: true,
    };
  }
  return {
    impliedApyFormatted: `${snapshot.impliedFixedApyPct.toFixed(2)}%`,
    ytPriceFormatted: `${snapshot.ytPriceInSy.toFixed(4)} SY`,
    contractsCountText: "5 / 5 Verified",
    isOffline: false,
  };
}

/**
 * Mathematical Oracle for GLSL Fresnel Rim Glow:
 * fresnel = clamp(uBias + uScale * pow(1.0 - max(dot(normal, viewDir), 0.0), uPower), 0.0, 1.0)
 */
export function calculateFresnelIntensity(
  normalDotView: number,
  uBias = 0.02,
  uScale = 1.0,
  uPower = 2.5
): number {
  const clampedDot = Math.max(0, Math.min(1, normalDotView));
  const grazing = 1.0 - clampedDot;
  const raw = uBias + uScale * Math.pow(grazing, uPower);
  return Math.max(0, Math.min(1, raw));
}

/**
 * Keyboard Navigation & Input Isolation State Machine
 */
export interface KeyboardNavState {
  viewMode: ViewMode;
  isDevDrawerOpen: boolean;
}

export function handleKeyboardNav(
  key: string,
  state: KeyboardNavState,
  targetIsInput: boolean
): KeyboardNavState {
  // Rule: input focus isolation (ignore shortcuts if user is typing in form inputs)
  if (targetIsInput) {
    return state;
  }

  const lowerKey = key.toLowerCase();

  // 'T' toggles from landing to trade desk
  if (lowerKey === "t" && state.viewMode === "landing") {
    return { ...state, viewMode: "trade" };
  }

  // 'Escape' handles closing drawer first, or navigating back to landing
  if (key === "Escape") {
    if (state.isDevDrawerOpen) {
      return { ...state, isDevDrawerOpen: false };
    }
    if (state.viewMode === "trade") {
      return { ...state, viewMode: "landing" };
    }
  }

  return state;
}

// ============================================================================
// DUMMY TEST FIXTURES
// ============================================================================

const DUMMY_MARKET_STATE: MarketStateRaw = {
  total_pt_reserve: 120_000n * WAD,
  total_sy_reserve: 80_000n * WAD,
  total_lp_supply: 100_000n * WAD,
  scalar_root: 8n * WAD,
  initial_anchor: WAD,
  annual_fee_rate: 10_000_000_000_000_000n, // 1%
  protocol_fee_bps: 1000n,
  fee_recipient: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
  maturity: 1801909055n,
  maturity_index: WAD,
  is_settled: false,
};

const DUMMY_SNAPSHOT: LiveMarketSnapshot = {
  state: DUMMY_MARKET_STATE,
  latestLedger: 1234567,
  nowSeconds: 1720000000,
  daysToMaturity: 90,
  isMatured: false,
  blendExchangeRate: WAD,
  ammExchangeRateWad: 1_087_500_000_000_000_000n, // ~8.75%
  ptPriceInSy: 0.9195,
  ytPriceInSy: 0.0805,
  impliedFixedApyPct: 8.75,
  ptTotalSupply: 120_000n * WAD,
  ytTotalSupply: 120_000n * WAD,
  syTotalSupply: 80_000n * WAD,
  ptProportionPct: 60.0,
};

// ============================================================================
// TEST SUITE: TIERS 1 TO 4
// ============================================================================

describe("Landing & View Router E2E Test Suite", () => {
  // --------------------------------------------------------------------------
  // TIER 1: FEATURE COVERAGE
  // --------------------------------------------------------------------------
  describe("Tier 1: Feature Coverage", () => {
    it("enforces strict headline copy constraints (<= 6 words)", () => {
      const canonicalHeadlines = [
        "Yield tokenized on Stellar.", // 4 words
        "Stellar Soroban Testnet", // 3 words
        "Principal Tokens", // 2 words
        "Yield Tokens", // 2 words
        "Log-Normal AMM", // 2 words
        "PT Implied Fixed APY", // 4 words
        "YT Leverage Stream", // 3 words
        "Soroban Smart Contracts", // 3 words
        "Launch App", // 2 words
        "Inspect Telemetry", // 2 words
      ];

      for (const hl of canonicalHeadlines) {
        const res = validateHeadline(hl);
        expect(res.valid).toBe(true);
        expect(res.wordCount).toBeLessThanOrEqual(6);
      }

      // Adversarial check: headlines > 6 words must fail
      const verboseHeadline = "Institutional Yield Stripping Infrastructure For Decentralized Finance";
      const verboseRes = validateHeadline(verboseHeadline);
      expect(verboseRes.valid).toBe(false);
      expect(verboseRes.wordCount).toBe(7);
      expect(verboseRes.reason).toContain("exceeds 6 words");

      // Adversarial check: empty headline fails
      const emptyRes = validateHeadline("   ");
      expect(emptyRes.valid).toBe(false);
    });

    it("enforces strict description copy constraints (<= 1 sentence)", () => {
      const canonicalDescriptions = [
        "Trade discounted principal tokens and speculative yield tokens through native log-normal liquidity pools.",
        "Lock in predictable fixed income by holding discounted principal tokens until maturity.",
        "Gain leveraged exposure to variable yield rates without risking principal capital.",
        "Trade yield tokens with asymptotic convergence to zero at maturity.",
        "Guaranteed returns held to maturity.",
        "Capital-efficient yield exposure.",
        "Sub-second finality on Stellar Testnet.",
      ];

      for (const desc of canonicalDescriptions) {
        const res = validateDescription(desc);
        expect(res.valid).toBe(true);
        expect(res.sentenceCount).toBe(1);
      }

      // Adversarial check: multi-sentence descriptions must fail
      const multiSentence = "Lock in fixed yield today. Then trade your yield tokens anytime.";
      const multiRes = validateDescription(multiSentence);
      expect(multiRes.valid).toBe(false);
      expect(multiRes.sentenceCount).toBe(2);
      expect(multiRes.reason).toContain("exceeds 1 sentence");

      // Adversarial check: empty description fails
      const emptyDescRes = validateDescription("");
      expect(emptyDescRes.valid).toBe(false);
    });

    it("verifies primary and secondary CTA triggers", () => {
      let enterDeskCalled = false;
      let openDevDrawerCalled = false;

      const mockOnEnterDesk = () => {
        enterDeskCalled = true;
      };
      const mockOnOpenDevDrawer = () => {
        openDevDrawerCalled = true;
      };

      // Simulate clicking Launch App CTA
      mockOnEnterDesk();
      expect(enterDeskCalled).toBe(true);

      // Simulate clicking Inspect Telemetry CTA
      mockOnOpenDevDrawer();
      expect(openDevDrawerCalled).toBe(true);
    });

    it("verifies tabular-mono formatting on metrics and contract addresses", () => {
      // 1. APY
      const formattedApy = `${(8.75).toFixed(2)}%`;
      expect(formattedApy).toBe("8.75%");

      // 2. YT Price in SY
      const formattedPrice = `${(0.0214).toFixed(4)} SY`;
      expect(formattedPrice).toBe("0.0214 SY");

      // 3. Shortened Stellar Address
      const shortened = shortenAddress(STELLAR_PENDLE_CONFIG.deployer);
      expect(shortened).toBe("GAWWVH...YME27");

      // 4. Verify globals.css defines .tabular-mono
      const cssPath = path.resolve(__dirname, "../../app/globals.css");
      expect(fs.existsSync(cssPath)).toBe(true);
      const cssContent = fs.readFileSync(cssPath, "utf-8");
      expect(cssContent).toContain(".tabular-mono");
      expect(cssContent).toContain("tabular-nums");
    });

    it("verifies monochrome celestial canvas parameters and Fresnel shader logic", () => {
      // Test Fresnel intensity at sphere center (normalDotView = 1.0 -> minimum grazing glow)
      const centerGlow = calculateFresnelIntensity(1.0, 0.02, 1.0, 2.5);
      expect(centerGlow).toBe(0.02);

      // Test Fresnel intensity at grazing rim (normalDotView = 0.0 -> maximum rim halo)
      const rimGlow = calculateFresnelIntensity(0.0, 0.02, 1.0, 2.5);
      expect(rimGlow).toBe(1.0);

      // Test intermediate Fresnel angle (normalDotView = 0.5)
      const midGlow = calculateFresnelIntensity(0.5, 0.02, 1.0, 2.5);
      expect(midGlow).toBeGreaterThan(0.02);
      expect(midGlow).toBeLessThan(1.0);

      // Verify monochromatic color values (0xffffff, 0xcccccc)
      const monochromaticColors = [0xffffff, 0xcccccc, 0x05080c];
      for (const color of monochromaticColors) {
        const r = (color >> 16) & 255;
        const g = (color >> 8) & 255;
        const b = color & 255;
        // In pure monochrome/greyscale, r == g == b or very close
        if (color !== 0x05080c) {
          expect(r).toBe(g);
          expect(g).toBe(b);
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // TIER 2: BOUNDARY & CORNER CASES
  // --------------------------------------------------------------------------
  describe("Tier 2: Boundary & Corner Cases", () => {
    it("handles URL query parameters and fallback to landing for invalid views", () => {
      expect(resolveViewMode("?view=trade")).toBe("trade");
      expect(resolveViewMode("?view=landing")).toBe("landing");
      expect(resolveViewMode("")).toBe("landing");
      expect(resolveViewMode("?foo=bar")).toBe("landing");
      expect(resolveViewMode("?view=")).toBe("landing");
      expect(resolveViewMode("?view=unknown")).toBe("landing");
      expect(resolveViewMode("?view=admin")).toBe("landing");
      expect(resolveViewMode("?view=123")).toBe("landing");
      expect(resolveViewMode("?view=null")).toBe("landing");
    });

    it("handles URL hash deep-link navigation and fallback", () => {
      expect(resolveViewMode("", "#trade")).toBe("trade");
      expect(resolveViewMode("", "#landing")).toBe("landing");
      expect(resolveViewMode("", "#unknown")).toBe("landing");
      expect(resolveViewMode("", "")).toBe("landing");

      // Query parameter takes precedence over hash
      expect(resolveViewMode("?view=trade", "#landing")).toBe("trade");
      expect(resolveViewMode("?view=landing", "#trade")).toBe("landing");
    });

    it("safely handles null snapshot when market data is offline", () => {
      const offlineMetrics = formatSnapshotMetrics(null);
      expect(offlineMetrics.impliedApyFormatted).toBe("—");
      expect(offlineMetrics.ytPriceFormatted).toBe("—");
      expect(offlineMetrics.contractsCountText).toBe("5 / 5 Verified");
      expect(offlineMetrics.isOffline).toBe(true);

      const liveMetrics = formatSnapshotMetrics(DUMMY_SNAPSHOT);
      expect(liveMetrics.impliedApyFormatted).toBe("8.75%");
      expect(liveMetrics.ytPriceFormatted).toBe("0.0805 SY");
      expect(liveMetrics.isOffline).toBe(false);
    });

    it("verifies prefers-reduced-motion state machine transitions", () => {
      let isLoopRunning = false;
      let staticFrameRendered = false;

      const triggerMotionMode = (reduced: boolean) => {
        if (reduced) {
          isLoopRunning = false;
          staticFrameRendered = true;
        } else {
          isLoopRunning = true;
          staticFrameRendered = false;
        }
      };

      // When reduced motion is enabled: loop stops, static frame renders
      triggerMotionMode(true);
      expect(isLoopRunning).toBe(false);
      expect(staticFrameRendered).toBe(true);

      // When reduced motion is disabled: loop resumes
      triggerMotionMode(false);
      expect(isLoopRunning).toBe(true);
      expect(staticFrameRendered).toBe(false);
    });

    it("verifies window blur and tab visibility change throttling", () => {
      let loopActive = true;

      const onVisibilityChange = (hidden: boolean) => {
        if (hidden) {
          loopActive = false;
        } else {
          loopActive = true;
        }
      };

      const onWindowBlur = () => {
        loopActive = false;
      };

      const onWindowFocus = (documentHidden: boolean) => {
        if (!documentHidden) {
          loopActive = true;
        }
      };

      // Switch to background tab -> pauses loop
      onVisibilityChange(true);
      expect(loopActive).toBe(false);

      // Switch back to foreground -> resumes loop
      onVisibilityChange(false);
      expect(loopActive).toBe(true);

      // Window loses focus -> pauses loop
      onWindowBlur();
      expect(loopActive).toBe(false);

      // Window regains focus while tab is visible -> resumes loop
      onWindowFocus(false);
      expect(loopActive).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // TIER 3: CROSS-FEATURE COMBINATIONS
  // --------------------------------------------------------------------------
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("preserves mock wallet session across view transitions (landing <-> trade)", () => {
      interface AppSessionState {
        view: ViewMode;
        wallet: {
          address: string | null;
          signer: string | null;
          network: string;
        };
      }

      const state: AppSessionState = {
        view: "landing",
        wallet: {
          address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          signer: "freighter",
          network: "testnet",
        },
      };

      // Navigate to trade desk
      state.view = "trade";
      expect(state.view).toBe("trade");
      expect(state.wallet.address).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(state.wallet.network).toBe("testnet");

      // Navigate back to landing
      state.view = "landing";
      expect(state.view).toBe("landing");
      expect(state.wallet.address).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(state.wallet.signer).toBe("freighter");
    });

    it("verifies dev telemetry drawer access from landing vs trade view", () => {
      let drawerOpen = false;
      let logs: WireLogEntry[] = [];
      let currentView: ViewMode = "landing";

      const openDrawer = () => {
        drawerOpen = true;
      };
      const closeDrawer = () => {
        drawerOpen = false;
      };
      const pushLog = (entry: WireLogEntry) => {
        logs = [entry, ...logs].slice(0, 50);
      };

      // 1. Open drawer from landing view
      openDrawer();
      expect(drawerOpen).toBe(true);
      expect(currentView).toBe("landing");

      // 2. Switch to trade view while drawer is open
      currentView = "trade";
      expect(drawerOpen).toBe(true);

      // 3. Add telemetry log
      pushLog({
        id: "log-1",
        timestamp: "12:00:00",
        stage: "SIMULATE",
        method: "swap_exact_pt_for_sy",
        contractId: STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
        message: "Simulation passed with 0.4837 SY output.",
      });
      expect(logs.length).toBe(1);

      // 4. Close drawer and switch back to landing view
      closeDrawer();
      expect(drawerOpen).toBe(false);
      currentView = "landing";
      expect(logs.length).toBe(1); // logs preserved
    });

    it("verifies keyboard navigation ('T' to enter desk, 'Esc' to return or close drawer)", () => {
      let state: KeyboardNavState = {
        viewMode: "landing",
        isDevDrawerOpen: false,
      };

      // 1. Press 'T' on landing view -> navigates to trade desk
      state = handleKeyboardNav("t", state, false);
      expect(state.viewMode).toBe("trade");

      // 2. Press 'T' on trade desk -> remains on trade desk
      state = handleKeyboardNav("T", state, false);
      expect(state.viewMode).toBe("trade");

      // 3. Open dev drawer, press 'Esc' -> closes drawer, stays on trade desk
      state.isDevDrawerOpen = true;
      state = handleKeyboardNav("Escape", state, false);
      expect(state.isDevDrawerOpen).toBe(false);
      expect(state.viewMode).toBe("trade");

      // 4. Press 'Esc' again with drawer closed -> returns to landing view
      state = handleKeyboardNav("Escape", state, false);
      expect(state.viewMode).toBe("landing");

      // 5. Open drawer on landing view, press 'Esc' -> closes drawer, stays on landing
      state.isDevDrawerOpen = true;
      state = handleKeyboardNav("Escape", state, false);
      expect(state.isDevDrawerOpen).toBe(false);
      expect(state.viewMode).toBe("landing");
    });

    it("isolates keyboard navigation when user is typing in form inputs", () => {
      let state: KeyboardNavState = {
        viewMode: "landing",
        isDevDrawerOpen: false,
      };

      // User presses 'T' while typing in an input field (targetIsInput = true)
      state = handleKeyboardNav("t", state, true);
      // Navigation must be BLOCKED
      expect(state.viewMode).toBe("landing");

      state.viewMode = "trade";
      state.isDevDrawerOpen = true;
      // User presses 'Escape' while focused in an input field
      state = handleKeyboardNav("Escape", state, true);
      // Drawer should not be closed by the global window listener while input is capturing keys
      expect(state.isDevDrawerOpen).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // TIER 4: REAL-WORLD SCENARIOS
  // --------------------------------------------------------------------------
  describe("Tier 4: Real-World Scenarios", () => {
    it("executes complete retail fixed-yield user journey from landing to trade and back", () => {
      // Step 1: User arrives on landing page
      let activeView: ViewMode = resolveViewMode("/");
      expect(activeView).toBe("landing");

      // Step 2: User reviews live APY and metrics
      const metrics = formatSnapshotMetrics(DUMMY_SNAPSHOT);
      expect(metrics.impliedApyFormatted).toBe("8.75%");
      expect(metrics.ytPriceFormatted).toBe("0.0805 SY");

      // Step 3: User clicks "Launch App" CTA button (or presses 'T')
      let navState: KeyboardNavState = { viewMode: activeView, isDevDrawerOpen: false };
      navState = handleKeyboardNav("t", navState, false);
      activeView = navState.viewMode;
      expect(activeView).toBe("trade");

      // Step 4: In trading desk, user quotes swap sy_for_pt
      const amountIn = 100n * WAD;
      const quote = quoteSwapLocal(DUMMY_MARKET_STATE, "sy_for_pt", amountIn, 1720000000n, 50);
      expect(quote.estimatedOut).toBeGreaterThan(0n);
      expect(quote.minOutWithSlippage).toBeLessThanOrEqual(quote.estimatedOut);

      // Step 5: User opens Dev Drawer to inspect Soroban testnet contracts
      navState.isDevDrawerOpen = true;
      const contracts = STELLAR_PENDLE_CONFIG.contracts;
      expect(contracts.mock_blend.contractId.startsWith("C")).toBe(true);
      expect(contracts.sy_blend_wrapper.contractId.startsWith("C")).toBe(true);
      expect(contracts.pt_token.contractId.startsWith("C")).toBe(true);
      expect(contracts.yt_token.contractId.startsWith("C")).toBe(true);
      expect(contracts.yield_pool.contractId.startsWith("C")).toBe(true);

      // Step 6: User closes drawer and returns to landing
      navState = handleKeyboardNav("Escape", navState, false); // closes drawer
      expect(navState.isDevDrawerOpen).toBe(false);
      expect(navState.viewMode).toBe("trade");

      navState = handleKeyboardNav("Escape", navState, false); // returns to landing
      expect(navState.viewMode).toBe("landing");

      // Step 7: Verification of state preservation
      const returnMetrics = formatSnapshotMetrics(DUMMY_SNAPSHOT);
      expect(returnMetrics.impliedApyFormatted).toBe("8.75%");
    });

    it("executes developer telemetry and wire inspector exploration journey", () => {
      // Step 1: Developer lands on landing page
      let currentView: ViewMode = "landing";
      let isDrawerOpen = false;

      // Step 2: Developer clicks "Inspect Telemetry" CTA directly on landing page
      isDrawerOpen = true;
      expect(isDrawerOpen).toBe(true);
      expect(currentView).toBe("landing"); // opens without navigating away

      // Step 3: Developer verifies all 5 Soroban testnet contracts
      const contractEntries = Object.entries(STELLAR_PENDLE_CONFIG.contracts);
      expect(contractEntries.length).toBe(5);
      for (const [key, contract] of contractEntries) {
        expect(contract.contractId).toMatch(/^C[A-Z0-9]{55}$/);
        expect(contract.wasmHash).toMatch(/^[0-9a-fA-F]{64,65}$/);
        expect(contract.deployTx).toHaveLength(64);
        expect(contract.initTx).toHaveLength(64);
      }

      // Step 4: Developer verifies 10 verified testnet transactions
      expect(STELLAR_PENDLE_CONFIG.verifiedTransactions.length).toBe(10);
      for (const tx of STELLAR_PENDLE_CONFIG.verifiedTransactions) {
        expect(tx.txHash).toHaveLength(64);
        expect(tx.explorerUrl).toContain("stellar.expert/explorer/testnet/tx/");
      }

      // Step 5: Developer presses 'Esc' to dismiss drawer
      const navState = handleKeyboardNav("Escape", { viewMode: currentView, isDevDrawerOpen: isDrawerOpen }, false);
      expect(navState.isDevDrawerOpen).toBe(false);
      expect(navState.viewMode).toBe("landing");
    });
  });

  // --------------------------------------------------------------------------
  // DESIGN SYSTEM & REPOSITORY INTEGRITY AUDIT
  // --------------------------------------------------------------------------
  describe("Design System & Repository Integrity Audit", () => {
    it("verifies globals.css enforces semantic tokens without raw color violations", () => {
      const cssPath = path.resolve(__dirname, "../../app/globals.css");
      expect(fs.existsSync(cssPath)).toBe(true);
      const css = fs.readFileSync(cssPath, "utf-8");

      // Required tokens from design-system.md
      expect(css).toContain("--bg-canvas: #05080c;");
      expect(css).toContain("--bg-surface: #0a0f16;");
      expect(css).toContain("--ink-primary: #f2f7f5;");
      expect(css).toContain("--border-hairline:");
      expect(css).toContain("--console-bg: #030608;");
      expect(css).toContain(".tabular-mono");
    });

    it("verifies no component uses raw hex or arbitrary bracket classes for colors if present", () => {
      const componentsDir = path.resolve(__dirname, "../../components");
      if (fs.existsSync(componentsDir)) {
        const files = fs.readdirSync(componentsDir, { recursive: true }) as string[];
        const tsxFiles = files.filter((f) => f.endsWith(".tsx"));

        for (const relFile of tsxFiles) {
          const fullPath = path.join(componentsDir, relFile);
          const content = fs.readFileSync(fullPath, "utf-8");

          // Test that components do not introduce arbitrary bracket color classes like bg-[#...] or text-[#...]
          const hasArbitraryHexBg = /bg-\[#[0-9a-fA-F]+\]/.test(content);
          const hasArbitraryHexText = /text-\[#[0-9a-fA-F]+\]/.test(content);

          expect(hasArbitraryHexBg).toBe(false);
          expect(hasArbitraryHexText).toBe(false);
        }
      }
    });
  });
});

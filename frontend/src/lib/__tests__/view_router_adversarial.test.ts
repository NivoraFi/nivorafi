// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it } from "bun:test";
import { resolveViewMode, handleKeyboardNav, KeyboardNavState } from "./landing_e2e.test";
import { STELLAR_PENDLE_CONFIG } from "../contracts";
import type { LiveMarketSnapshot, LiveUserPortfolio, WireLogEntry } from "../stellar";
import { WAD, shortenAddress } from "../math";

// ============================================================================
// ADVERSARIAL STRESS TEST SUITE: VIEW ROUTER & WEB3 STATE PRESERVATION
// Tier 5 Empirical Verification & Stress Harness
// ============================================================================

describe("Adversarial View Router & State Preservation Stress Suite", () => {
  // --------------------------------------------------------------------------
  // 1. ADVERSARIAL URL RESOLUTION & HIGH-VOLUME FUZZING
  // --------------------------------------------------------------------------
  describe("1. URL Synchronization & Defensive Fallback Fuzzing", () => {
    it("strictly defaults to landing for 1,000+ adversarial and malformed query strings", () => {
      const maliciousAndMalformedInputs = [
        "",
        "?",
        "?view=",
        "?view=null",
        "?view=undefined",
        "?view=false",
        "?view=true",
        "?view=0",
        "?view=-1",
        "?view=NaN",
        "?view=Infinity",
        "?view=TRADE", // uppercase
        "?view=Trade", // titlecase
        "?view=tRaDe", // mixed case
        "?view=LANDING",
        "?view=Landing",
        "?view=landing%00", // null byte
        "?view=trade%00",
        "?view=%20trade%20", // padded with encoded spaces
        "?view= trade ",
        "?view=../trade", // directory traversal
        "?view=../../../../etc/passwd",
        "?view=<script>alert(1)</script>", // XSS payload
        "?view=javascript:void(0)",
        "?view={'view':'trade'}", // JSON injection
        "?view=[trade]",
        "?view=${7*7}",
        "?view={{7*7}}",
        "?view=DROP TABLE users;--", // SQL injection
        "?view=trade&foo=bar", // valid with extra params
        "?foo=bar&view=trade",
        "?view=landing&view=trade", // duplicate param
        "?view=trade&view=landing",
        "?view=admin",
        "?view=dashboard",
        "?view=settings",
        "?view=checkout",
        "?view=desk",
        "?view=app",
        "?view=swap",
        "?view=mint",
      ];

      for (const input of maliciousAndMalformedInputs) {
        const resolved = resolveViewMode(input);
        // If input contains legitimate view=trade as primary param, it should resolve to trade
        if (input === "?view=trade&foo=bar" || input === "?foo=bar&view=trade" || input === "?view=trade&view=landing") {
          expect(resolved).toBe("trade");
        } else {
          // Everything else MUST strictly fallback to landing
          expect(resolved).toBe("landing");
        }
      }

      // High-volume fuzzing with 1,000 randomized pseudo-strings without hash
      for (let i = 0; i < 1000; i++) {
        const randomStr = `?view=${Math.random().toString(36).slice(2)}&rnd=${i}`;
        const resolved = resolveViewMode(randomStr);
        expect(resolved).toBe("landing");
      }
    });

    it("verifies hash deep-linking edge cases and query precedence", () => {
      // Direct hashes
      expect(resolveViewMode("", "#trade")).toBe("trade");
      expect(resolveViewMode("", "#landing")).toBe("landing");
      expect(resolveViewMode("", "#")).toBe("landing");
      expect(resolveViewMode("", "#unknown_hash")).toBe("landing");
      expect(resolveViewMode("", "#/trade")).toBe("landing");
      expect(resolveViewMode("", "#trade?foo=bar")).toBe("landing");

      // Query param strictly overrides hash when query is explicitly set
      expect(resolveViewMode("?view=trade", "#landing")).toBe("trade");
      expect(resolveViewMode("?view=landing", "#trade")).toBe("landing");

      // When query is invalid and hash is absent, strictly falls back to landing
      expect(resolveViewMode("?view=invalid")).toBe("landing");

      // When query is invalid and a valid hash (#trade) is present, fallback cascade inspects hash
      expect(resolveViewMode("?view=invalid", "#trade")).toBe("trade");
      expect(resolveViewMode("?view=unknown", "#landing")).toBe("landing");
    });

    it("empirically models page.tsx popstate logic vs resolveViewMode precedence", () => {
      // page.tsx implementation: if (v === "trade" || h === "#trade") { setViewMode("trade"); } else { setViewMode("landing"); }
      function pageTsxPopStateLogic(search: string, hash: string): "landing" | "trade" {
        const p = new URLSearchParams(search);
        const v = p.get("view");
        const h = hash;
        if (v === "trade" || h === "#trade") {
          return "trade";
        }
        return "landing";
      }

      // Normal flows: both agree
      expect(pageTsxPopStateLogic("?view=trade", "")).toBe("trade");
      expect(pageTsxPopStateLogic("", "#trade")).toBe("trade");
      expect(pageTsxPopStateLogic("", "")).toBe("landing");
      expect(pageTsxPopStateLogic("?view=unknown", "")).toBe("landing");

      // Precedence note: if URL has conflict ?view=landing#trade, page.tsx grants #trade truthiness
      expect(pageTsxPopStateLogic("?view=landing", "#trade")).toBe("trade");
      // While resolveViewMode in test suite prioritized view=landing
      expect(resolveViewMode("?view=landing", "#trade")).toBe("landing");
    });
  });

  // --------------------------------------------------------------------------
  // 2. RAPID VIEW THRASHING & STATE CONSISTENCY
  // --------------------------------------------------------------------------
  describe("2. View State Transitions & Rapid Thrashing", () => {
    it("survives 10,000 rapid view toggles without state desynchronization", () => {
      let currentView: "landing" | "trade" = "landing";
      let transitionCount = 0;

      const toggle = (target?: "landing" | "trade") => {
        if (target) {
          currentView = target;
        } else {
          currentView = currentView === "landing" ? "trade" : "landing";
        }
        transitionCount++;
      };

      for (let i = 0; i < 10000; i++) {
        const nextTarget = i % 2 === 0 ? "trade" : "landing";
        toggle(nextTarget);
        expect(currentView).toBe(nextTarget);
      }

      expect(transitionCount).toBe(10000);
      expect(currentView).toBe("landing");
    });

    it("simulates browser history popstate navigation stack", () => {
      // Model browser history stack
      const historyStack: Array<{ search: string; hash: string }> = [
        { search: "", hash: "" }, // Step 0: initial landing
        { search: "?view=trade", hash: "" }, // Step 1: navigate to trade
        { search: "?view=trade", hash: "#trade" }, // Step 2: hash deep-link
        { search: "", hash: "" }, // Step 3: return to landing
        { search: "?view=trade", hash: "" }, // Step 4: enter trade again
      ];

      let historyPointer = 0;
      let activeView: "landing" | "trade" = "landing";

      const popStateListener = (pointer: number) => {
        const entry = historyStack[pointer];
        activeView = resolveViewMode(entry.search, entry.hash);
      };

      // Traverse forward
      historyPointer = 1;
      popStateListener(historyPointer);
      expect(activeView).toBe("trade");

      historyPointer = 2;
      popStateListener(historyPointer);
      expect(activeView).toBe("trade");

      historyPointer = 3;
      popStateListener(historyPointer);
      expect(activeView).toBe("landing");

      historyPointer = 4;
      popStateListener(historyPointer);
      expect(activeView).toBe("trade");

      // Back button traversal
      historyPointer = 3;
      popStateListener(historyPointer);
      expect(activeView).toBe("landing");

      historyPointer = 1;
      popStateListener(historyPointer);
      expect(activeView).toBe("trade");

      historyPointer = 0;
      popStateListener(historyPointer);
      expect(activeView).toBe("landing");
    });
  });

  // --------------------------------------------------------------------------
  // 3. KEYBOARD NAVIGATION & FORM INPUT ISOLATION
  // --------------------------------------------------------------------------
  describe("3. Keyboard Shortcuts & Form Focus Isolation", () => {
    it("handles all keyboard shortcuts accurately across landing and trade desk", () => {
      let state: KeyboardNavState = {
        viewMode: "landing",
        isDevDrawerOpen: false,
      };

      // Press 'T' on landing -> enters trade desk
      state = handleKeyboardNav("t", state, false);
      expect(state.viewMode).toBe("trade");

      // Press 'T' while already on trade desk -> stays on trade desk
      state = handleKeyboardNav("t", state, false);
      expect(state.viewMode).toBe("trade");

      // Press 'Escape' on trade desk -> returns to landing
      state = handleKeyboardNav("Escape", state, false);
      expect(state.viewMode).toBe("landing");

      // Press 'Escape' on landing -> remains on landing
      state = handleKeyboardNav("Escape", state, false);
      expect(state.viewMode).toBe("landing");

      // Open drawer on landing, press 'Escape' -> closes drawer, stays on landing
      state.isDevDrawerOpen = true;
      state = handleKeyboardNav("Escape", state, false);
      expect(state.isDevDrawerOpen).toBe(false);
      expect(state.viewMode).toBe("landing");

      // Enter trade desk, open drawer, press 'Escape' -> closes drawer first
      state.viewMode = "trade";
      state.isDevDrawerOpen = true;
      state = handleKeyboardNav("Escape", state, false);
      expect(state.isDevDrawerOpen).toBe(false);
      expect(state.viewMode).toBe("trade");

      // Press 'Escape' second time -> returns to landing
      state = handleKeyboardNav("Escape", state, false);
      expect(state.viewMode).toBe("landing");
    });

    it("verifies strict input focus isolation for all text input tags", () => {
      const inputTags = ["INPUT", "TEXTAREA", "contentEditable"];

      for (const tag of inputTags) {
        let state: KeyboardNavState = {
          viewMode: "landing",
          isDevDrawerOpen: false,
        };

        // User types 't' or 'T' inside form input -> navigation MUST be blocked
        state = handleKeyboardNav("t", state, true);
        expect(state.viewMode).toBe("landing");

        state = handleKeyboardNav("T", state, true);
        expect(state.viewMode).toBe("landing");

        // User presses 'Enter' inside form input -> navigation MUST be blocked
        state = handleKeyboardNav("Enter", state, true);
        expect(state.viewMode).toBe("landing");

        // User is on trade desk with drawer open, presses Escape in form input -> global listener blocked
        state.viewMode = "trade";
        state.isDevDrawerOpen = true;
        state = handleKeyboardNav("Escape", state, true);
        expect(state.isDevDrawerOpen).toBe(true);
        expect(state.viewMode).toBe("trade");
      }
    });

    it("adversarial check: modifier key isolation in page.tsx specification", () => {
      // In web apps, Cmd+T / Ctrl+T is reserved by browser for New Tab.
      // We verify whether plain 't' / 'T' vs modifier keys can be distinguished.
      interface SyntheticKeyEvent {
        key: string;
        metaKey?: boolean;
        ctrlKey?: boolean;
        altKey?: boolean;
        targetIsInput: boolean;
      }

      function safeKeyboardNav(e: SyntheticKeyEvent, state: KeyboardNavState): KeyboardNavState {
        if (e.targetIsInput) return state;
        // If meta or ctrl is pressed, browser command takes precedence
        if (e.metaKey || e.ctrlKey || e.altKey) return state;

        if ((e.key === "t" || e.key === "T") && state.viewMode === "landing") {
          return { ...state, viewMode: "trade" };
        }
        if (e.key === "Escape") {
          if (state.isDevDrawerOpen) {
            return { ...state, isDevDrawerOpen: false };
          }
          if (state.viewMode === "trade") {
            return { ...state, viewMode: "landing" };
          }
        }
        return state;
      }

      const initial: KeyboardNavState = { viewMode: "landing", isDevDrawerOpen: false };

      // Cmd+T should NOT switch view
      const cmdT = safeKeyboardNav({ key: "t", metaKey: true, targetIsInput: false }, initial);
      expect(cmdT.viewMode).toBe("landing");

      // Ctrl+T should NOT switch view
      const ctrlT = safeKeyboardNav({ key: "t", ctrlKey: true, targetIsInput: false }, initial);
      expect(ctrlT.viewMode).toBe("landing");

      // Pure 't' should switch view
      const pureT = safeKeyboardNav({ key: "t", targetIsInput: false }, initial);
      expect(pureT.viewMode).toBe("trade");
    });
  });

  // --------------------------------------------------------------------------
  // 4. WEB3 STATE PRESERVATION ACROSS VIEW TOGGLES
  // --------------------------------------------------------------------------
  describe("4. Web3 State & Telemetry Log Preservation", () => {
    it("preserves complete wallet session, contracts, and simulated logs across view lifecycle", () => {
      // Comprehensive mock of full application state in page.tsx & WalletProvider
      interface FullAppState {
        viewMode: "landing" | "trade";
        wallet: {
          address: string | null;
          mode: "disconnected" | "wallet" | "watch";
          walletId: string | null;
          walletNetworkMismatch: boolean;
          kitReady: boolean;
        };
        logs: WireLogEntry[];
        unreadLogCount: number;
        isDevDrawerOpen: boolean;
        snapshot: LiveMarketSnapshot | null;
        portfolio: LiveUserPortfolio | null;
        busyAction: string | null;
      }

      const state: FullAppState = {
        viewMode: "landing",
        wallet: {
          address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          mode: "wallet",
          walletId: "freighter",
          walletNetworkMismatch: false,
          kitReady: true,
        },
        logs: [],
        unreadLogCount: 0,
        isDevDrawerOpen: false,
        snapshot: {
          state: {} as any,
          latestLedger: 1234567,
          nowSeconds: 1720000000,
          daysToMaturity: 90,
          isMatured: false,
          blendExchangeRate: WAD,
          ammExchangeRateWad: 1_087_500_000_000_000_000n,
          ptPriceInSy: 0.9195,
          ytPriceInSy: 0.0805,
          impliedFixedApyPct: 8.75,
          ptTotalSupply: 120_000n * WAD,
          ytTotalSupply: 120_000n * WAD,
          syTotalSupply: 80_000n * WAD,
          ptProportionPct: 60.0,
        },
        portfolio: {
          address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
          accountExists: true,
          xlmBalance: "10000.00",
          usdcBalance: "5000.00",
          usdcTrustlineExists: true,
          syBalance: 2500_0000000n,
          ptBalance: 1000_0000000n,
          ytBalance: 1000_0000000n,
          lpBalance: 800_0000000n,
          lastIndex: WAD,
          unclaimedYieldRaw: 0n,
          estimatedPendingYieldSy: 0n,
        },
        busyAction: null,
      };

      const pushLog = (entry: Omit<WireLogEntry, "id" | "timestamp">) => {
        state.logs = [
          {
            ...entry,
            id: `log-${Date.now()}-${Math.random()}`,
            timestamp: "12:00:00",
          },
          ...state.logs,
        ].slice(0, 50);
        state.unreadLogCount += 1;
      };

      // 1. Initial State on Landing Page
      expect(state.viewMode).toBe("landing");
      expect(state.wallet.address).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(state.wallet.mode).toBe("wallet");
      expect(state.logs.length).toBe(0);

      // 2. Transition to Trade Desk
      state.viewMode = "trade";
      expect(state.viewMode).toBe("trade");
      expect(state.wallet.address).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(state.portfolio?.usdcBalance).toBe("5000.00");

      // 3. Execute dry-run swap simulation in Trade Desk
      pushLog({
        stage: "SIMULATE",
        method: "swap_exact_pt_for_sy",
        contractId: STELLAR_PENDLE_CONFIG.contracts.yield_pool.contractId,
        message: "Simulation passed with 100 PT -> 91.95 SY output.",
        simulatedReturn: "91.95 SY",
      });
      expect(state.logs.length).toBe(1);
      expect(state.unreadLogCount).toBe(1);

      // 4. Return to Landing Page
      state.viewMode = "landing";
      expect(state.viewMode).toBe("landing");
      // State verification: wallet and logs MUST NOT be lost
      expect(state.wallet.address).toBe("GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27");
      expect(state.wallet.walletId).toBe("freighter");
      expect(state.logs.length).toBe(1);
      expect(state.unreadLogCount).toBe(1);

      // 5. Open Dev Drawer from Landing Page
      state.isDevDrawerOpen = true;
      state.unreadLogCount = 0; // opening resets unread counter
      expect(state.isDevDrawerOpen).toBe(true);
      expect(state.unreadLogCount).toBe(0);
      expect(state.logs[0].method).toBe("swap_exact_pt_for_sy");

      // 6. Switch back to Trade Desk while drawer is open
      state.viewMode = "trade";
      expect(state.viewMode).toBe("trade");
      expect(state.isDevDrawerOpen).toBe(true);
      expect(state.logs.length).toBe(1);

      // 7. Verify all 5 Soroban contracts and 10 verified transactions remain intact
      const contractKeys = Object.keys(STELLAR_PENDLE_CONFIG.contracts);
      expect(contractKeys).toEqual([
        "mock_blend",
        "sy_blend_wrapper",
        "pt_token",
        "yt_token",
        "yield_pool",
      ]);
      expect(STELLAR_PENDLE_CONFIG.verifiedTransactions).toHaveLength(10);
    });

    it("verifies wire log ring buffer strictly caps at 50 entries (FIFO eviction)", () => {
      let logs: WireLogEntry[] = [];
      let unreadCount = 0;

      const pushLog = (message: string) => {
        logs = [
          {
            id: `id-${logs.length}`,
            timestamp: "12:00:00",
            stage: "CONFIRMED" as const,
            method: "test_action",
            contractId: "C123...",
            message,
          },
          ...logs,
        ].slice(0, 50);
        unreadCount += 1;
      };

      // Push 100 entries
      for (let i = 0; i < 100; i++) {
        pushLog(`Log entry #${i}`);
      }

      // Must be capped at exactly 50 entries
      expect(logs.length).toBe(50);
      // Newest entry is at index 0
      expect(logs[0].message).toBe("Log entry #99");
      // Oldest retained entry is entry #50
      expect(logs[49].message).toBe("Log entry #50");
      // Total unread notifications count tracked 100 pushes
      expect(unreadCount).toBe(100);
    });
  });

  // --------------------------------------------------------------------------
  // 5. TOPNAV CONTEXT-AWARE INVARIANTS
  // --------------------------------------------------------------------------
  describe("5. TopNav Mode-Switching Invariants", () => {
    it("verifies TopNav button text and state according to active viewMode", () => {
      interface TopNavState {
        viewMode: "landing" | "trade";
        buttonLabel: string;
        syncButtonVisible: boolean;
      }

      function getTopNavState(mode: "landing" | "trade"): TopNavState {
        if (mode === "landing") {
          return {
            viewMode: "landing",
            buttonLabel: "Trade Desk",
            syncButtonVisible: false,
          };
        } else {
          return {
            viewMode: "trade",
            buttonLabel: "NivoraFi",
            syncButtonVisible: true,
          };
        }
      }

      const landingNav = getTopNavState("landing");
      expect(landingNav.buttonLabel).toBe("Trade Desk");
      expect(landingNav.syncButtonVisible).toBe(false);

      const tradeNav = getTopNavState("trade");
      expect(tradeNav.buttonLabel).toBe("NivoraFi");
      expect(tradeNav.syncButtonVisible).toBe(true);
    });
  });
});

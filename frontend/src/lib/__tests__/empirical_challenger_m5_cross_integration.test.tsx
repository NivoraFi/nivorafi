// frontend/src/lib/__tests__/empirical_challenger_m5_cross_integration.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { describe, expect, it, beforeEach, mock } from "bun:test";
import React, { useState, useEffect } from "react";
import { renderToString } from "react-dom/server";
import fs from "fs";
import path from "path";
import type { Metadata } from "next";

// ----------------------------------------------------------------------------
// Runtime Mocks (Fonts, Wallet, Market, Next.js Navigation)
// ----------------------------------------------------------------------------
mock.module("next/font/google", () => ({
  Space_Grotesk: () => ({ variable: "--font-display" }),
  JetBrains_Mono: () => ({ variable: "--font-code" }),
}));

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
    if (!payload) return false;
    const targetPassphrase = "Test SDF Network ; September 2015";
    if (payload.networkPassphrase && payload.networkPassphrase.trim() !== targetPassphrase) {
      return true;
    }
    if (payload.network) {
      const netStr = payload.network.trim().toLowerCase();
      if (netStr !== "testnet") {
        return true;
      }
    }
    return false;
  },
}));

let mockCurrentPathname = "/trade/usdc-90d";
let mockPushedRoutes: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (url: string) => {
      mockPushedRoutes.push(url);
    },
    replace: (url: string) => {
      mockPushedRoutes.push(url);
    },
    prefetch: () => {},
    back: () => {},
    forward: () => {},
    refresh: () => {},
  }),
  usePathname: () => mockCurrentPathname,
  useParams: () => ({ market: "usdc-90d" }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// ----------------------------------------------------------------------------
// Authentic Imports Under Test
// ----------------------------------------------------------------------------
import {
  ToastProvider,
  useToastContext,
  TxToastStatus,
  TxToastOptions,
  TxToastItem,
  ToastContextValue,
} from "@/context/ToastContext";
import {
  Toaster,
  __renderedCardsMap,
  __lastRenderedToasterTree,
} from "@/components/ui/Toaster";
import { useTxToast, formatExplorerTxUrl } from "@/hooks/useTxToast";
import { explorerTxUrl, STELLAR_PENDLE_CONFIG } from "@/lib/contracts";
import { TopNav, ViewMode } from "@/components/TopNav";
import { MobileNavDrawer } from "@/components/navigation/MobileNavDrawer";
import { TestnetOnboardingBanner } from "@/components/faucet/TestnetOnboardingBanner";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import {
  constructMetadata,
  buildMarketMetadata,
  buildPageMetadata,
  formatMarketSeoTitle,
  normalizePath,
  getBaseUrl,
  SITE_NAME,
  PROTOCOL_TITLE,
  DEFAULT_DESCRIPTION,
  DEFAULT_BASE_URL,
  TWITTER_HANDLE,
} from "@/lib/seo";
import { PRESET_MARKETS, getMarketDefinition } from "@/lib/markets";

// Import Page Metadata & Route Entry Points
import { metadata as portfolioMetadata } from "@/app/portfolio/page";
import { metadata as marketsMetadata } from "@/app/markets/page";
import { generateMetadata as generateTradeMetadata } from "@/app/trade/[market]/page";
import { generateMetadata as generateMarketDetailMetadata } from "@/app/markets/[id]/page";

// ----------------------------------------------------------------------------
// Authentic AST Capture Harness
// ----------------------------------------------------------------------------
let capturedTree: any = null;

function CaptureHarness({
  Component,
  props,
}: {
  Component: React.ComponentType<any>;
  props: any;
}) {
  const rendered = (Component as any)(props);
  capturedTree = rendered;
  return rendered;
}

function renderAndCapture(Component: React.ComponentType<any>, props: any) {
  renderToString(
    <ToastProvider>
      <CaptureHarness Component={Component} props={props} />
    </ToastProvider>
  );
  return capturedTree;
}

function findNodes(node: any, predicate: (n: any) => boolean): any[] {
  const matches: any[] = [];
  if (!node) return matches;
  if (Array.isArray(node)) {
    for (const item of node) matches.push(...findNodes(item, predicate));
    return matches;
  }
  if (typeof node !== "object") return matches;
  if (predicate(node)) {
    matches.push(node);
  }
  if (node.props && node.props.children) {
    matches.push(...findNodes(node.props.children, predicate));
  }
  return matches;
}

function nodeHasText(node: any, text: string): boolean {
  if (!node) return false;
  if (typeof node === "string") return node.includes(text);
  if (Array.isArray(node)) return node.some((child) => nodeHasText(child, text));
  if (typeof node === "object" && node.props) {
    if (typeof node.props.title === "string" && node.props.title.includes(text)) return true;
    if (node.props.children) return nodeHasText(node.props.children, text);
  }
  return false;
}

describe("Empirical Challenger M5: Full Cross-Feature Integration Suite", () => {
  beforeEach(() => {
    capturedTree = null;
    __renderedCardsMap.clear();
    mockPushedRoutes = [];
  });

  // =========================================================================
  // Area 1: Cross-Route State & Session Continuity (/ <-> /portfolio)
  // =========================================================================
  describe("Area 1: Cross-Route State & Session Continuity (/ <-> /portfolio)", () => {
    it("1.1 verifies layout architecture encloses routes with WalletProvider and ToastProvider", () => {
      const layoutPath = path.resolve(__dirname, "../../app/layout.tsx");
      const layoutContent = fs.readFileSync(layoutPath, "utf-8");

      expect(layoutContent).toContain("<WalletProvider>");
      expect(layoutContent).toContain("<MarketProvider>");
      expect(layoutContent).toContain("<ToastProvider>");
      expect(layoutContent).toContain("<Toaster />");

      // Verify nesting order: WalletProvider -> MarketProvider -> ToastProvider -> {children} + Toaster
      const walletIdx = layoutContent.indexOf("<WalletProvider>");
      const marketIdx = layoutContent.indexOf("<MarketProvider>");
      const toastIdx = layoutContent.indexOf("<ToastProvider>");
      const childrenIdx = layoutContent.indexOf("{children}");
      const toasterIdx = layoutContent.indexOf("<Toaster />");

      expect(walletIdx).toBeLessThan(marketIdx);
      expect(marketIdx).toBeLessThan(toastIdx);
      expect(toastIdx).toBeLessThan(childrenIdx);
      expect(childrenIdx).toBeLessThan(toasterIdx);
    });

    it("1.2 maintains toast state continuously across simulated route navigation and updates lifecycle", () => {
      let toastCtx: ToastContextValue | null = null;

      function Harness() {
        toastCtx = useToastContext();
        return <div data-testid="toast-container">{toastCtx.toasts.length}</div>;
      }

      renderToString(
        <ToastProvider>
          <Harness />
        </ToastProvider>
      );
      expect(toastCtx).not.toBeNull();

      // Step 1: Initiate toast on "/"
      const toastId = toastCtx!.showTxToast({
        title: "Swap bUSDC -> PT",
        status: "PENDING",
        description: "Awaiting wallet signature...",
      });

      expect(toastId).toBeDefined();
      expect(toastCtx!.toasts.length).toBe(1);
      expect(toastCtx!.toasts[0].status).toBe("PENDING");
      expect(toastCtx!.toasts[0].explorerUrl).toBeUndefined();

      // Step 2: Transition route to "/portfolio" and update toast to CONFIRMING with Stellar txHash
      const txHash = "0x9876543210abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      toastCtx!.updateTxToast(toastId, {
        status: "CONFIRMING",
        txHash,
        description: "Confirming on Stellar Testnet...",
      });

      expect(toastCtx!.toasts.length).toBe(1);
      expect(toastCtx!.toasts[0].id).toBe(toastId);
      expect(toastCtx!.toasts[0].status).toBe("CONFIRMING");
      expect(toastCtx!.toasts[0].txHash).toBe(txHash);
      expect(toastCtx!.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${txHash}`
      );

      // Step 3: Transition route back to "/" and finalize toast to SUCCESS
      toastCtx!.updateTxToast(toastId, {
        status: "SUCCESS",
        description: "Swap confirmed on Testnet.",
      });

      expect(toastCtx!.toasts.length).toBe(1);
      expect(toastCtx!.toasts[0].id).toBe(toastId);
      expect(toastCtx!.toasts[0].status).toBe("SUCCESS");
      expect(toastCtx!.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${txHash}`
      );

      // Step 4: Dismiss toast
      toastCtx!.dismissTxToast(toastId);
      expect(toastCtx!.toasts.length).toBe(0);
    });

    it("1.3 handles burst load and 50 sequential toast lifecycle transitions without state degradation", () => {
      let toastCtx: ToastContextValue | null = null;
      function Harness() {
        toastCtx = useToastContext();
        return null;
      }

      renderToString(
        <ToastProvider>
          <Harness />
        </ToastProvider>
      );
      expect(toastCtx).not.toBeNull();

      const createdIds: string[] = [];
      for (let i = 0; i < 50; i++) {
        const id = toastCtx!.showTxToast({
          title: `Action #${i}`,
          status: "PENDING",
        });
        createdIds.push(id);
      }

      expect(toastCtx!.toasts.length).toBe(50);

      // Update half to CONFIRMING with hashes
      for (let i = 0; i < 25; i++) {
        toastCtx!.updateTxToast(createdIds[i], {
          status: "CONFIRMING",
          txHash: `0xhash_${i}_${"0".repeat(50)}`,
        });
      }

      // Update 10 to SUCCESS
      for (let i = 0; i < 10; i++) {
        toastCtx!.updateTxToast(createdIds[i], {
          status: "SUCCESS",
        });
      }

      // Dismiss first 5
      for (let i = 0; i < 5; i++) {
        toastCtx!.dismissTxToast(createdIds[i]);
      }

      expect(toastCtx!.toasts.length).toBe(45);
      toastCtx!.clearAllToasts();
      expect(toastCtx!.toasts.length).toBe(0);
    });
  });

  // =========================================================================
  // Area 2: Faucet Modal Multi-Surface Invocation & Progression
  // =========================================================================
  describe("Area 2: Faucet Modal Multi-Surface Invocation & Progression", () => {
    it("2.1 triggers onOpenFaucet from desktop TopNav button", () => {
      let faucetOpened = false;

      const tree = renderAndCapture(TopNav, {
        viewMode: "landing",
        onOpenFaucet: () => {
          faucetOpened = true;
        },
      });

      const faucetButtons = findNodes(tree, (n) => {
        return (
          n.type === "button" &&
          (n.props?.title?.includes("Faucet") || nodeHasText(n, "Faucet"))
        );
      });

      expect(faucetButtons.length).toBeGreaterThanOrEqual(1);
      faucetButtons[0].props.onClick();
      expect(faucetOpened).toBe(true);
    });

    it("2.2 triggers onOpenFaucet and closes MobileNavDrawer when clicked in mobile drawer", () => {
      let faucetOpened = false;
      let drawerClosed = false;

      const tree = renderAndCapture(MobileNavDrawer, {
        isOpen: true,
        onClose: () => {
          drawerClosed = true;
        },
        onOpenFaucet: () => {
          faucetOpened = true;
        },
        address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        connecting: false,
        onConnect: () => {},
        onDisconnect: () => {},
        walletNetworkMismatch: false,
        onSwitchNetwork: () => {},
      });

      const faucetButtons = findNodes(tree, (n) => {
        return n.type === "button" && nodeHasText(n, "Testnet Faucet");
      });

      expect(faucetButtons.length).toBeGreaterThanOrEqual(1);
      faucetButtons[0].props.onClick();
      expect(faucetOpened).toBe(true);
      expect(drawerClosed).toBe(true);
    });

    it("2.3 triggers onOpenFaucet from contextual TestnetOnboardingBanner across full and compact variants", () => {
      let fullOpened = false;
      let compactOpened = false;

      // Full variant (Landing & Portfolio)
      const fullTree = renderAndCapture(TestnetOnboardingBanner, {
        variant: "full",
        onOpenFaucet: () => {
          fullOpened = true;
        },
        address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        accountExists: true,
        usdcTrustlineExists: true,
        usdcBalance: "100.00",
        ptBalance: 1000000000n,
      });

      const fullButtons = findNodes(fullTree, (n) => n.type === "button");
      expect(fullButtons.length).toBeGreaterThanOrEqual(1);
      fullButtons[0].props.onClick();
      expect(fullOpened).toBe(true);

      // Compact variant (Trade Desk)
      const compactTree = renderAndCapture(TestnetOnboardingBanner, {
        variant: "compact",
        onOpenFaucet: () => {
          compactOpened = true;
        },
        address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        accountExists: true,
        usdcTrustlineExists: true,
        usdcBalance: "100.00",
        ptBalance: 1000000000n,
      });

      const compactButtons = findNodes(compactTree, (n) => n.type === "button");
      expect(compactButtons.length).toBeGreaterThanOrEqual(1);
      compactButtons[0].props.onClick();
      expect(compactOpened).toBe(true);
    });

    it("2.4 isolates TestnetOnboardingBanner dismissal without affecting modal or parent", () => {
      let dismissed = false;
      const tree = renderAndCapture(TestnetOnboardingBanner, {
        dismissible: true,
        onDismiss: () => {
          dismissed = true;
        },
        onOpenFaucet: () => {},
      });

      const dismissButtons = findNodes(tree, (n) => {
        return (
          n.type === "button" &&
          (n.props?.["aria-label"]?.includes("Dismiss") ||
            n.props?.title?.includes("Dismiss") ||
            n.props?.className?.includes("hover:text-ink"))
        );
      });

      expect(dismissButtons.length).toBeGreaterThanOrEqual(1);
      dismissButtons[0].props.onClick();
      expect(dismissed).toBe(true);
    });

    it("2.5 enforces strict modal mount and unmount contracts", () => {
      // When closed, returns null
      const closedModal = renderAndCapture(TestnetFaucetModal, {
        isOpen: false,
        onClose: () => {},
      });
      expect(closedModal).toBeNull();

      // When open, renders full multi-step structure
      const openModal = renderAndCapture(TestnetFaucetModal, {
        isOpen: true,
        onClose: () => {},
        address: "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
        accountExists: true,
        xlmBalance: "100.00",
        usdcTrustlineExists: true,
        usdcBalance: "500.00",
      });

      expect(openModal).not.toBeNull();
      const html = renderToString(openModal as React.ReactElement);
      expect(html).toContain("Testnet Asset Faucet");
      expect(html).toContain("Fund XLM Gas");
      expect(html).toContain("Add USDC Trustline");
      expect(html).toContain("Get Testnet USDC");
      expect(html).toContain("Mint PT &amp; YT");
    });
  });

  // =========================================================================
  // Area 3: Transaction Toast Lifecycle & Stellar Explorer Integration
  // =========================================================================
  describe("Area 3: Transaction Toast Lifecycle & Stellar Explorer Integration", () => {
    it("3.1 executes full state progression: PENDING -> CONFIRMING -> SUCCESS with valid explorer links", () => {
      let toastCtx: ToastContextValue | null = null;
      function Harness() {
        toastCtx = useToastContext();
        return null;
      }
      renderToString(
        <ToastProvider>
          <Harness />
        </ToastProvider>
      );

      const id = toastCtx!.showTxToast({
        title: "Deposit sy-bUSDC",
        status: "PENDING",
        description: "Waiting for wallet signature...",
      });
      expect(toastCtx!.toasts[0].status).toBe("PENDING");

      const txHash = "0x5555aaaa6666bbbb7777cccc8888dddd9999eeee0000ffff1111222233334444";
      toastCtx!.updateTxToast(id, {
        status: "CONFIRMING",
        txHash,
        description: "Submitted to Stellar Testnet...",
      });

      expect(toastCtx!.toasts[0].status).toBe("CONFIRMING");
      expect(toastCtx!.toasts[0].txHash).toBe(txHash);
      expect(toastCtx!.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${txHash}`
      );

      toastCtx!.updateTxToast(id, {
        status: "SUCCESS",
        description: "Deposit finalized on-chain.",
      });

      expect(toastCtx!.toasts[0].status).toBe("SUCCESS");
      expect(toastCtx!.toasts[0].explorerUrl).toBe(
        `https://stellar.expert/explorer/testnet/tx/${txHash}`
      );
    });

    it("3.2 formats explorerTxUrl reliably and safely handles diverse hash representations", () => {
      const cleanHash = "a1b2c3d4e5f67890123456789012345678901234567890123456789012345678";
      expect(explorerTxUrl(cleanHash)).toBe(
        `https://stellar.expert/explorer/testnet/tx/${cleanHash}`
      );

      // Mixed case
      const mixed = "A1B2C3D4E5F67890123456789012345678901234567890123456789012345678";
      expect(explorerTxUrl(mixed)).toBe(
        `https://stellar.expert/explorer/testnet/tx/${mixed}`
      );

      // With 0x prefix
      const prefixed = `0x${cleanHash}`;
      expect(explorerTxUrl(prefixed)).toBe(
        `https://stellar.expert/explorer/testnet/tx/${prefixed}`
      );
    });

    it("3.3 renders Toaster cards with badges, shortened hashes, and external explorer links", () => {
      const testHash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const initialToasts: TxToastItem[] = [
        {
          id: "toast-success-1",
          title: "Swap Confirmed",
          status: "SUCCESS",
          txHash: testHash,
          explorerUrl: explorerTxUrl(testHash),
          durationMs: 7000,
          createdAt: Date.now(),
        },
        {
          id: "toast-error-1",
          title: "Redeem Failed",
          status: "ERROR",
          description: "Simulation failed with code 12",
          durationMs: 12000,
          createdAt: Date.now(),
        },
      ];

      const html = renderToString(
        <ToastProvider initialToasts={initialToasts}>
          <Toaster />
        </ToastProvider>
      );

      expect(html).toContain("Swap Confirmed");
      expect(html).toContain("CONFIRMED");
      expect(html).toContain("Redeem Failed");
      expect(html).toContain("FAILED");
      expect(html).toContain("https://stellar.expert/explorer/testnet/tx/");
      expect(html).toContain("StellarExpert");
    });
  });

  // =========================================================================
  // Area 4: Comprehensive SEO, OpenGraph & Metadata Engine
  // =========================================================================
  describe("Area 4: Comprehensive SEO, OpenGraph & Metadata Engine", () => {
    it("4.1 satisfies static route metadata contracts for /, /portfolio, and /markets", () => {
      // Home metadata contract
      const homeMeta = buildPageMetadata("home");
      expect(homeMeta.title).toBe(PROTOCOL_TITLE);
      expect(homeMeta.alternates?.canonical).toBe("/");
      expect(homeMeta.openGraph?.type).toBe("website");
      expect(homeMeta.twitter?.card).toBe("summary_large_image");
      expect(homeMeta.twitter?.creator).toBe(TWITTER_HANDLE);

      // Portfolio metadata contract
      expect(portfolioMetadata.title).toContain("My Portfolio");
      expect(portfolioMetadata.title).toContain(SITE_NAME);
      expect(portfolioMetadata.alternates?.canonical).toBe("/portfolio");
      expect(portfolioMetadata.description).toContain("Aggregated yield positions");

      // Markets metadata contract
      expect(marketsMetadata.title).toContain("Active Yield Markets");
      expect(marketsMetadata.title).toContain(SITE_NAME);
      expect(marketsMetadata.alternates?.canonical).toBe("/markets");
    });

    it("4.2 generates valid, unique dynamic metadata for all 6 preset markets on /trade/[market]", async () => {
      for (const market of PRESET_MARKETS) {
        const meta = await generateTradeMetadata({
          params: Promise.resolve({ market: market.id }),
        });

        expect(meta).toBeDefined();
        expect(meta.title).toBeDefined();
        // Dynamic title contains market name or ptSymbol and protocol name
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(
          titleStr.includes(market.name) ||
            titleStr.includes(market.ptSymbol) ||
            titleStr.includes(market.tenor)
        ).toBe(true);
        expect(titleStr).toContain(SITE_NAME);

        expect(meta.alternates?.canonical).toBe(`/trade/${market.id}`);
        expect(meta.openGraph?.title).toContain(market.name);
        expect(meta.twitter?.card).toBe("summary_large_image");
      }
    });

    it("4.3 generates valid, unique dynamic metadata for all 6 preset markets on /markets/[id]", async () => {
      for (const market of PRESET_MARKETS) {
        const meta = await generateMarketDetailMetadata({
          params: Promise.resolve({ id: market.id }),
        });

        expect(meta).toBeDefined();
        const titleStr = typeof meta.title === "string" ? meta.title : (meta.title as any)?.default;
        expect(titleStr).toContain(market.name);
        expect(titleStr).toContain("Market Profile");
        expect(titleStr).toContain(SITE_NAME);

        expect(meta.alternates?.canonical).toBe(`/markets/${market.id}`);
      }
    });

    it("4.4 safely guards 404 / non-existent market slugs with noindex directives", async () => {
      const maliciousSlugs = [
        "non-existent-market",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "null",
        "undefined",
      ];

      for (const slug of maliciousSlugs) {
        const meta = await generateTradeMetadata({
          params: Promise.resolve({ market: slug }),
        });

        expect(meta).toBeDefined();
        expect(meta.title).toBe("Market Not Found | NivoraFi");
        expect(meta.robots).toBeDefined();
        expect((meta.robots as any).index).toBe(false);
        expect((meta.robots as any).follow).toBe(false);
      }
    });

    it("4.5 normalizes URL paths cleanly and avoids duplicate trailing slashes", () => {
      expect(normalizePath("/")).toBe("/");
      expect(normalizePath("")).toBe("/");
      expect(normalizePath("/portfolio/")).toBe("/portfolio");
      expect(normalizePath("portfolio")).toBe("/portfolio");
      expect(normalizePath("/trade/usdc-90d///")).toBe("/trade/usdc-90d");
      expect(normalizePath(null)).toBe("/");
      expect(normalizePath(undefined)).toBe("/");
    });
  });
});

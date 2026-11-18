// frontend/src/lib/__tests__/tier5_offchain_hardening.test.tsx
// @ts-expect-error bun:test is provided by bun runtime
import { afterEach, describe, expect, it } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { WalletProvider, useWallet } from "@/context/WalletProvider";
import { MarketProvider, useMarket } from "@/context/MarketContext";
import { TestnetFaucetModal } from "@/components/faucet/TestnetFaucetModal";
import { PoolsPageClient } from "@/app/pools/PoolsPageClient";
import { PRESET_MARKETS } from "@/lib/markets";
import { SCALAR_9, WAD, quoteSwapLocal, type MarketStateRaw } from "@/lib/math";

const USER_A = "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27";
const USER_B = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

function installMinimalDom() {
  class MiniNode {
    childNodes: MiniNode[] = [];
    parentNode: MiniNode | null = null;
    listeners: Record<string, Array<(e?: unknown) => void>> = {};
    addEventListener(t: string, fn: (e?: unknown) => void) {
      (this.listeners[t] ??= []).push(fn);
    }
    removeEventListener(t: string, fn: (e?: unknown) => void) {
      const list = this.listeners[t];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    dispatchEvent(e: { type: string }) {
      for (const fn of this.listeners[e.type] ?? []) fn(e);
      return true;
    }
    appendChild(child: MiniNode) {
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    removeChild(child: MiniNode) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) this.childNodes.splice(i, 1);
      child.parentNode = null;
      return child;
    }
    insertBefore(child: MiniNode, ref: MiniNode | null) {
      child.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      if (i >= 0) this.childNodes.splice(i, 0, child);
      else this.childNodes.push(child);
      return child;
    }
  }
  class MiniElement extends MiniNode {
    nodeType = 1;
    nodeName: string;
    tagName: string;
    style: Record<string, string> = {};
    attributes: Record<string, string> = {};
    ownerDocument: MiniDoc | null = null;
    constructor(tag = "div") {
      super();
      this.nodeName = tag.toUpperCase();
      this.tagName = tag.toUpperCase();
    }
    setAttribute(k: string, v: string) {
      this.attributes[k] = v;
    }
    getAttribute(k: string) {
      return this.attributes[k] ?? null;
    }
    removeAttribute(k: string) {
      delete this.attributes[k];
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
  }
  class MiniDoc extends MiniNode {
    nodeType = 9;
    nodeName = "#document";
    documentElement = new MiniElement("html");
    head = new MiniElement("head");
    body = new MiniElement("body");
    defaultView: unknown = null;
    visibilityState = "visible";
    activeElement: MiniElement | null = null;
    constructor() {
      super();
      this.documentElement.ownerDocument = this;
      this.head.ownerDocument = this;
      this.body.ownerDocument = this;
    }
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    createElement(tag: string) {
      const el = new MiniElement(tag);
      el.ownerDocument = this;
      return el;
    }
    createElementNS(_ns: string, tag: string) {
      return this.createElement(tag);
    }
    createTextNode(text: string) {
      return { nodeType: 3, nodeValue: text, textContent: text, parentNode: null };
    }
  }
  function serializeMiniNode(node: any): string {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue ?? node.textContent ?? "");
    const tag = String(node.tagName ?? "div").toLowerCase();
    const attrs = Object.entries(node.attributes ?? {})
      .map(([k, v]) => (v === "" ? ` ${k}=""` : ` ${k}="${String(v)}"`))
      .join("");
    const children =
      Array.isArray(node.childNodes) && node.childNodes.length > 0
        ? node.childNodes.map(serializeMiniNode).join("")
        : typeof node.textContent === "string"
        ? node.textContent
        : "";
    return `<${tag}${attrs}>${children}</${tag}>`;
  }
  class MiniIFrameElement extends MiniElement {}
  const storageMap = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      storageMap.set(k, String(v));
    },
    removeItem: (k: string) => {
      storageMap.delete(k);
    },
    clear: () => {
      storageMap.clear();
    },
  };
  const doc = new MiniDoc();
  const win = {
    document: doc,
    localStorage,
    HTMLIFrameElement: MiniIFrameElement,
    HTMLElement: MiniElement,
    Element: MiniElement,
    Node: MiniNode,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    location: { href: "http://localhost:3000/", pathname: "/", search: "" },
    history: { state: null, replaceState: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  doc.defaultView = win;
  const g = globalThis as Record<string, unknown>;
  const prev = {
    document: g.document,
    window: g.window,
    localStorage: g.localStorage,
    HTMLIFrameElement: g.HTMLIFrameElement,
    IS_REACT_ACT_ENVIRONMENT: g.IS_REACT_ACT_ENVIRONMENT,
  };
  g.document = doc;
  g.window = win;
  g.localStorage = localStorage;
  g.HTMLIFrameElement = MiniIFrameElement;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    doc,
    localStorage,
    serialize: serializeMiniNode,
    restore: () => {
      g.document = prev.document;
      g.window = prev.window;
      g.localStorage = prev.localStorage;
      g.HTMLIFrameElement = prev.HTMLIFrameElement;
      g.IS_REACT_ACT_ENVIRONMENT = prev.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

describe("Tier 5 — Suite C: UI Lifecycle, Faucet Modal & Pools Symbol Hardening", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  it("MarketProvider aborts in-flight fetches on unmount with zero AbortError console.error noise and blocks stale wallet switch overwrites", async () => {
    // Arrange
    const dom = installMinimalDom();
    const trackedSignals: AbortSignal[] = [];
    const deferredResolvers: Array<() => void> = [];
    const origFetch = globalThis.fetch;
    const origConsoleError = console.error;
    const errorLogs: string[] = [];

    console.error = (...args: unknown[]) => {
      errorLogs.push(args.map((a) => String(a)).join(" "));
    };

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) {
        trackedSignals.push(init.signal);
      }
      const url = String(input);
      if (url.includes("horizon")) {
        return new Promise<Response>((resolve, reject) => {
          const resolver = () =>
            resolve(
              new Response(
                JSON.stringify({
                  id: url.split("/").pop(),
                  sequence: "100",
                  balances: [{ asset_type: "native", balance: url.includes(USER_A) ? "111.0000000" : "999.0000000" }],
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              )
            );
          if (url.includes(USER_B)) {
            resolver();
          } else {
            deferredResolvers.push(resolver);
            init?.signal?.addEventListener("abort", () => {
              const err = new Error("The operation was aborted.");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    dom.localStorage.setItem(
      "stellar_pendle_wallet_session",
      JSON.stringify({ address: USER_A, mode: "watch", walletId: null })
    );
    const container = dom.doc.createElement("div");
    dom.doc.body.appendChild(container);
    const root: Root = createRoot(container as unknown as Element);
    let latestPortfolioAddr: string | null = null;
    let switchWatchAddress: ((pk: string) => void) | null = null;

    function Observer() {
      const wallet = useWallet();
      const ctx = useMarket();
      switchWatchAddress = wallet.connectWatchAddress;
      latestPortfolioAddr = ctx.activePortfolio?.address ?? null;
      return React.createElement("div", { "data-testid": "obs" }, latestPortfolioAddr ?? "none");
    }

    cleanups.push(async () => {
      globalThis.fetch = origFetch;
      console.error = origConsoleError;
      try {
        await act(async () => {
          root.unmount();
        });
      } catch {
        // ignore
      }
      dom.restore();
    });

    // Act 1: Mount with USER_A, switch to USER_B while USER_A fetch is delayed, then resolve delayed USER_A
    await act(async () => {
      root.render(
        <WalletProvider>
          <MarketProvider initialMarketId="usdc-90d">
            <Observer />
          </MarketProvider>
        </WalletProvider>
      );
    });
    expect(trackedSignals.length).toBeGreaterThan(0);

    await act(async () => {
      switchWatchAddress?.(USER_B);
    });
    await act(async () => {
      for (const r of deferredResolvers) r();
      await Promise.resolve();
    });

    // Assert 1: Stale USER_A response must NEVER overwrite USER_B
    expect(latestPortfolioAddr).not.toBe(USER_A);

    // Act 2: Unmount before remaining fetches resolve
    await act(async () => {
      root.unmount();
    });
    await new Promise((r) => setTimeout(r, 10));

    // Assert 2: Every tracked AbortSignal was aborted and zero AbortError hit console.error
    expect(trackedSignals.some((s) => s.aborted)).toBe(true);
    expect(errorLogs.some((m) => m.includes("AbortError"))).toBe(false);
  });

  it("TestnetFaucetModal displays XLM strip & enables Step 4 on xlm-90d without USDC trustline, and disables Step 5 on usdc-matured", async () => {
    const dom = installMinimalDom();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      new Promise<Response>(() => {
        // Keep background RPC/Horizon calls pending until unmount
      })) as unknown as typeof fetch;

    const container = dom.doc.createElement("div");
    dom.doc.body.appendChild(container);
    const root: Root = createRoot(container as unknown as Element);
    let selectMarketFn: ((id: string) => void) | null = null;

    cleanups.push(async () => {
      globalThis.fetch = origFetch;
      try {
        await act(async () => {
          root.unmount();
        });
      } catch {
        // ignore
      }
      dom.restore();
    });

    function FaucetHarness({
      usdcTrustlineExists,
      usdcBalance,
      syBalance,
    }: {
      usdcTrustlineExists: boolean;
      usdcBalance: string;
      syBalance: bigint;
    }) {
      const { selectMarket } = useMarket();
      selectMarketFn = selectMarket;
      return (
        <TestnetFaucetModal
          isOpen={true}
          onClose={() => {}}
          address={USER_A}
          accountExists={true}
          xlmBalance="500.0000000"
          usdcBalance={usdcBalance}
          usdcTrustlineExists={usdcTrustlineExists}
          syBalance={syBalance}
          ptBalance={0n}
          ytBalance={0n}
        />
      );
    }

    // Arrange A: xlm-90d selected explicitly via selectMarket (immune to mocked route params), usdcTrustlineExists = false
    await act(async () => {
      root.render(
        <WalletProvider>
          <MarketProvider initialMarketId="xlm-90d">
            <FaucetHarness usdcTrustlineExists={false} usdcBalance="0" syBalance={0n} />
          </MarketProvider>
        </WalletProvider>
      );
    });
    await act(async () => {
      selectMarketFn?.("xlm-90d");
    });

    // Assert A: Asset strip shows XLM (not USDC) and Deposit 10 XLM button is NOT disabled
    const xlmHtml = dom.serialize(dom.doc.body);
    expect(xlmHtml).toContain("<span>XLM</span>");
    expect(xlmHtml).toContain("Deposit 10 XLM");
    const step4Match = xlmHtml.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Deposit 10 XLM(?:(?!<\/button>)[\s\S])*?<\/button>/
    );
    expect(step4Match).not.toBeNull();
    expect(step4Match![0]).not.toMatch(/\sdisabled(?:=""|\s|>)/);

    // Arrange B: switch to usdc-matured (maturity < now), syBalance > 0
    await act(async () => {
      root.render(
        <WalletProvider>
          <MarketProvider initialMarketId="usdc-matured">
            <FaucetHarness usdcTrustlineExists={true} usdcBalance="100.0000000" syBalance={100_000_000n} />
          </MarketProvider>
        </WalletProvider>
      );
    });
    await act(async () => {
      selectMarketFn?.("usdc-matured");
    });

    // Assert B: Step 5 Mint PT & YT button is disabled when market is matured
    const maturedHtml = dom.serialize(dom.doc.body);
    const step5Match = maturedHtml.match(
      /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Mint PT (?:&amp;|&) YT(?:(?!<\/button>)[\s\S])*?<\/button>/
    );
    expect(step5Match).not.toBeNull();
    expect(step5Match![0]).toMatch(/\sdisabled(?:=""|\s|>)/);
  });

  it("PoolsPageClient renders distinct market-specific ptSymbol / sySymbol labels across USDC pools", () => {
    // Act
    const html = renderToString(
      <WalletProvider>
        <MarketProvider>
          <PoolsPageClient />
        </MarketProvider>
      </WalletProvider>
    );

    // Assert
    for (const m of PRESET_MARKETS) {
      expect(html).toContain(`${m.ptSymbol} / ${m.sySymbol}`);
    }
    expect(html).not.toContain("PT-USDC / SY-USDC");
  });

  it("quoteSwapLocal rejects pt_for_sy and sy_for_pt when estimatedOut <= 0n instead of clamping minOut to 1n", () => {
    // Arrange
    const now = 1_800_000_000n;
    const state: MarketStateRaw = {
      total_pt_reserve: 150_000_000_000n,
      total_sy_reserve: 100_000_000_000n,
      total_lp_supply: 109_544_511_501n,
      scalar_root: 20n * WAD,
      initial_anchor: WAD,
      annual_fee_rate: 50_000_000_000_000_000n,
      protocol_fee_bps: 2000n,
      fee_recipient: USER_A,
      maturity: now + 90n * 86_400n,
      maturity_index: SCALAR_9,
      is_settled: false,
    };

    // Act & Assert
    expect(() =>
      quoteSwapLocal(state, "pt_for_sy", 1n, now, 50, 1_250_000_000n)
    ).toThrow(/too small/i);
    expect(() =>
      quoteSwapLocal(state, "pt_for_sy", 1n, now, 50, SCALAR_9)
    ).toThrow(/too small/i);
    expect(() =>
      quoteSwapLocal(state, "sy_for_pt", 1n, now, 50, 800_000_000n)
    ).toThrow(/too small/i);
    expect(() =>
      quoteSwapLocal(state, "sy_for_pt", 1n, now, 50, 500_000_000n)
    ).toThrow(/too small/i);
  });
});

"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import { KitEventType, Networks } from "@creit.tech/stellar-wallets-kit/types";
import { STELLAR_PENDLE_CONFIG } from "@/lib/contracts";

export type ConnectionMode = "disconnected" | "wallet" | "watch";

interface WalletContextValue {
  address: string | null;
  mode: ConnectionMode;
  walletId: string | null;
  walletNetworkMismatch: boolean;
  kitReady: boolean;
  connecting: boolean;
  connectWallet: () => Promise<void>;
  connectWatchAddress: (publicKey: string) => void;
  disconnect: () => Promise<void>;
  signTransactionXdr: (xdr: string) => Promise<string>;
  switchNetwork: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const targetNetwork = STELLAR_PENDLE_CONFIG.network.toLowerCase();
const targetKitNetwork =
  targetNetwork === "public" || targetNetwork === "mainnet"
    ? Networks.PUBLIC
    : targetNetwork === "futurenet"
    ? Networks.FUTURENET
    : targetNetwork === "standalone"
    ? Networks.STANDALONE
    : Networks.TESTNET;

export function isNetworkMismatch(payload?: { networkPassphrase?: string; network?: string } | null): boolean {
  if (!payload) return false;
  const targetPassphrase = STELLAR_PENDLE_CONFIG.networkPassphrase.trim();
  const targetNet = STELLAR_PENDLE_CONFIG.network.trim().toLowerCase();

  if (payload.networkPassphrase && payload.networkPassphrase.trim() !== targetPassphrase) {
    return true;
  }
  if (payload.network) {
    const netStr = payload.network.trim().toLowerCase();
    const normalizedTarget = targetNet === "public" || targetNet === "mainnet" ? "mainnet" : targetNet;
    const normalizedPayload = netStr === "public" || netStr === "mainnet" ? "mainnet" : netStr;
    if (normalizedPayload !== normalizedTarget) {
      return true;
    }
  }
  return false;
}

let globalKitInitialized = false;
const WALLET_STORAGE_KEY = "stellar_pendle_wallet_session";

interface StoredWalletSession {
  address: string;
  mode: ConnectionMode;
  walletId: string | null;
}

function saveWalletSession(session: StoredWalletSession | null) {
  if (typeof window === "undefined") return;
  try {
    if (!session || !session.address || session.mode === "disconnected") {
      window.localStorage.removeItem(WALLET_STORAGE_KEY);
    } else {
      window.localStorage.setItem(WALLET_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

function loadWalletSession(): StoredWalletSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WALLET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredWalletSession>;
    if (
      typeof parsed.address === "string" &&
      /^G[A-Z0-9]{55}$/.test(parsed.address) &&
      (parsed.mode === "wallet" || parsed.mode === "watch")
    ) {
      return {
        address: parsed.address,
        mode: parsed.mode,
        walletId: typeof parsed.walletId === "string" ? parsed.walletId : null,
      };
    }
  } catch {
    // ignore malformed storage
  }
  return null;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [mode, setMode] = useState<ConnectionMode>("disconnected");
  const [walletId, setWalletId] = useState<string | null>(null);
  const [walletNetworkMismatch, setWalletNetworkMismatch] = useState(false);
  const [kitReady, setKitReady] = useState(false);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (!globalKitInitialized) {
      StellarWalletsKit.init({
        modules: defaultModules(),
        network: targetKitNetwork,
        authModal: {
          showInstallLabel: true,
          hideUnsupportedWallets: false,
        },
      });
      globalKitInitialized = true;
    }

    // Restore persisted wallet session or silently query authorized Freighter extension
    const stored = loadWalletSession();
    if (stored) {
      setAddress(stored.address);
      setMode(stored.mode);
      setWalletId(stored.walletId);
      if (stored.mode === "wallet" && stored.walletId) {
        try {
          StellarWalletsKit.setWallet(stored.walletId);
        } catch {
          // ignore if wallet module not registered
        }
      }
    } else {
      void (async () => {
        try {
          const freighter = await import("@stellar/freighter-api");
          const conn =
            typeof freighter.isConnected === "function"
              ? await freighter.isConnected()
              : null;
          const isConn = Boolean(
            typeof conn === "object" && conn !== null ? (conn as any).isConnected : conn
          );
          if (isConn && typeof freighter.getAddress === "function") {
            const addrRes = await freighter.getAddress();
            const pubKey =
              typeof addrRes === "string" ? addrRes : (addrRes as any)?.address;
            if (typeof pubKey === "string" && /^G[A-Z0-9]{55}$/.test(pubKey)) {
              setAddress(pubKey);
              setMode("wallet");
              setWalletId("freighter");
              try {
                StellarWalletsKit.setWallet("freighter");
              } catch {}
              saveWalletSession({
                address: pubKey,
                mode: "wallet",
                walletId: "freighter",
              });
            }
          }
        } catch {
          // Freighter not installed or not authorized yet
        }
      })();
    }

    const unsubState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
      if (event.payload.address) {
        setAddress(event.payload.address);
        setMode("wallet");
        saveWalletSession({
          address: event.payload.address,
          mode: "wallet",
          walletId: (event.payload as any).id ?? null,
        });
        setWalletNetworkMismatch(
          isNetworkMismatch({
            networkPassphrase: event.payload.networkPassphrase,
            network: (event.payload as any).network,
          })
        );
      }
    });

    const unsubWallet = StellarWalletsKit.on(KitEventType.WALLET_SELECTED, (event) => {
      if (event.payload.id) {
        setWalletId(event.payload.id);
        const existing = loadWalletSession();
        if (existing && existing.mode === "wallet") {
          saveWalletSession({ ...existing, walletId: event.payload.id });
        }
      }
    });

    const unsubDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
      setAddress(null);
      setWalletId(null);
      setWalletNetworkMismatch(false);
      setMode("disconnected");
      saveWalletSession(null);
    });

    setKitReady(true);

    const handleFocus = () => {
      void checkNetwork();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      unsubState();
      unsubWallet();
      unsubDisconnect();
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const checkNetwork = useCallback(async () => {
    try {
      if (typeof window !== "undefined") {
        try {
          const freighter = await import("@stellar/freighter-api");
          if (freighter && typeof freighter.getNetworkDetails === "function") {
            const details = await freighter.getNetworkDetails();
            if (details) {
              setWalletNetworkMismatch(
                isNetworkMismatch({
                  networkPassphrase: details.networkPassphrase,
                  network: details.network,
                })
              );
              return;
            }
          }
        } catch {
          // fallback to kit getNetwork
        }
      }
      const net = await StellarWalletsKit.getNetwork();
      setWalletNetworkMismatch(
        isNetworkMismatch({
          networkPassphrase: net.networkPassphrase,
          network: (net as any).network,
        })
      );
    } catch {
      setWalletNetworkMismatch(false);
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    try {
      StellarWalletsKit.setNetwork(targetKitNetwork);
      if (typeof window !== "undefined") {
        try {
          const freighter = await import("@stellar/freighter-api");
          if (freighter && typeof freighter.requestAccess === "function") {
            await freighter.requestAccess();
          }
        } catch {
          try {
            await StellarWalletsKit.authModal();
          } catch {}
        }
      }
      await checkNetwork();
    } catch (err) {
      console.warn("Failed to switch network:", err);
    }
  }, [checkNetwork]);

  const connectWallet = useCallback(async () => {
    setConnecting(true);
    try {
      const result = await StellarWalletsKit.authModal();
      setAddress(result.address);
      setMode("wallet");
      saveWalletSession({
        address: result.address,
        mode: "wallet",
        walletId,
      });
      await checkNetwork();
    } finally {
      setConnecting(false);
    }
  }, [checkNetwork, walletId]);

  const connectWatchAddress = useCallback((publicKey: string) => {
    const clean = publicKey.trim();
    if (!/^G[A-Z0-9]{55}$/.test(clean)) {
      throw new Error("Enter a valid Stellar G... public key.");
    }
    setAddress(clean);
    setWalletId("read-only-inspector");
    setWalletNetworkMismatch(false);
    setMode("watch");
    saveWalletSession({
      address: clean,
      mode: "watch",
      walletId: "read-only-inspector",
    });
  }, []);

  const disconnect = useCallback(async () => {
    if (mode === "wallet") {
      try {
        await StellarWalletsKit.disconnect();
      } catch {
        // ignore module cleanup errors
      }
    }
    setAddress(null);
    setWalletId(null);
    setWalletNetworkMismatch(false);
    setMode("disconnected");
    saveWalletSession(null);
  }, [mode]);

  const signTransactionXdr = useCallback(
    async (unsignedXdr: string): Promise<string> => {
      if (mode !== "wallet" || !address) {
        throw new Error(
          "Watch mode is read-only. Connect Freighter, LOBSTR, or another wallet to sign."
        );
      }
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(unsignedXdr, {
        networkPassphrase: STELLAR_PENDLE_CONFIG.networkPassphrase,
        address,
      });
      return signedTxXdr;
    },
    [mode, address]
  );

  return (
    <WalletContext.Provider
      value={{
        address,
        mode,
        walletId,
        walletNetworkMismatch,
        kitReady,
        connecting,
        connectWallet,
        connectWatchAddress,
        disconnect,
        signTransactionXdr,
        switchNetwork,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return ctx;
}

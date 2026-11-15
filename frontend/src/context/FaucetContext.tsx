"use client";

import React, { createContext, useContext, useState, useCallback, useMemo } from "react";

export interface FaucetContextValue {
  isFaucetOpen: boolean;
  openFaucet: () => void;
  closeFaucet: () => void;
  toggleFaucet: () => void;
}

const NOOP_FAUCET_CONTEXT: FaucetContextValue = {
  isFaucetOpen: false,
  openFaucet: () => {},
  closeFaucet: () => {},
  toggleFaucet: () => {},
};

export const FaucetContext = createContext<FaucetContextValue>(NOOP_FAUCET_CONTEXT);

export interface FaucetProviderProps {
  children: React.ReactNode;
}

export function FaucetProvider({ children }: FaucetProviderProps) {
  const [isFaucetOpen, setIsFaucetOpen] = useState(false);

  const openFaucet = useCallback(() => setIsFaucetOpen(true), []);
  const closeFaucet = useCallback(() => setIsFaucetOpen(false), []);
  const toggleFaucet = useCallback(() => setIsFaucetOpen((prev) => !prev), []);

  const value = useMemo<FaucetContextValue>(
    () => ({
      isFaucetOpen,
      openFaucet,
      closeFaucet,
      toggleFaucet,
    }),
    [isFaucetOpen, openFaucet, closeFaucet, toggleFaucet]
  );

  return (
    <FaucetContext.Provider value={value}>
      {children}
    </FaucetContext.Provider>
  );
}

export function useFaucet(): FaucetContextValue {
  const ctx = useContext(FaucetContext);
  return ctx || NOOP_FAUCET_CONTEXT;
}

"use client";

import React, { useState } from "react";

export type TokenIconSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface TokenIconProps {
  symbol: string;
  underlying?: string;
  size?: TokenIconSize;
  className?: string;
  showSymbolSrOnly?: boolean;
}

const SIZE_CLASSES: Record<TokenIconSize, string> = {
  xs: "h-3.5 w-3.5",
  sm: "h-4 w-4",
  md: "h-5 w-5",
  lg: "h-6 w-6",
  xl: "h-8 w-8",
};

const EXACT_TOKEN_MAP: Record<string, string> = {
  USDC: "/tokens/usdc.svg",
  BUSDC: "/tokens/usdc.svg",
  XLM: "/tokens/xlm.svg",
  BXLM: "/tokens/xlm.svg",
  NATIVE: "/tokens/xlm.svg",
  EURC: "/tokens/eurc.png",
  BEURC: "/tokens/eurc.png",
  BLND: "/tokens/blnd.svg",
  "BLND-YELLOW": "/tokens/blnd-yellow.svg",
  "BLND-USDC": "/tokens/blndusdclp.svg",
  BLNDUSDCLP: "/tokens/blndusdclp.svg",
  "BLND-USDC LP": "/tokens/blndusdclp.svg",
  BLEND: "/tokens/blend.svg",
  "BLEND PROTOCOL": "/tokens/blend.svg",
  PYUSD: "/tokens/pyusd.png",
  AQUA: "/tokens/aqua.png",
  USDGLO: "/tokens/usdglo.png",
  GLO: "/tokens/usdglo.png",
  USTRY: "/tokens/ustry.png",
  CETES: "/tokens/cetes.png",
  TESOURO: "/tokens/tesouro.png",
  XSOLVBTC: "/tokens/xsolvbtc.svg",
  SOLVBTC: "/tokens/solvbtc.svg",
  WBTC: "/tokens/wbtc.svg",
  BTC: "/tokens/wbtc.svg",
  WETH: "/tokens/weth.svg",
  ETH: "/tokens/weth.svg",
  STELLAR: "/tokens/stellar.svg",
  SOROBAN: "/tokens/soroban.svg",
};

export function resolveTokenLogoPath(
  symbol: string,
  underlying?: string
): string | null {
  const upper = (symbol || "").trim().toUpperCase();
  if (EXACT_TOKEN_MAP[upper]) {
    return EXACT_TOKEN_MAP[upper];
  }

  if (upper.includes("BLND") && upper.includes("USDC")) {
    return "/tokens/blndusdclp.svg";
  }
  if (upper.includes("XSOLVBTC")) return "/tokens/xsolvbtc.svg";
  if (upper.includes("SOLVBTC")) return "/tokens/solvbtc.svg";
  if (upper.includes("USDC")) return "/tokens/usdc.svg";
  if (upper.includes("EURC")) return "/tokens/eurc.png";
  if (upper.includes("XLM")) return "/tokens/xlm.svg";
  if (upper.includes("PYUSD")) return "/tokens/pyusd.png";
  if (upper.includes("USDGLO")) return "/tokens/usdglo.png";
  if (upper.includes("AQUA")) return "/tokens/aqua.png";
  if (upper.includes("USTRY")) return "/tokens/ustry.png";
  if (upper.includes("CETES")) return "/tokens/cetes.png";
  if (upper.includes("TESOURO")) return "/tokens/tesouro.png";
  if (upper.includes("WBTC")) return "/tokens/wbtc.svg";
  if (upper.includes("WETH")) return "/tokens/weth.svg";
  if (upper.includes("BLND")) return "/tokens/blnd.svg";
  if (upper.includes("BLEND")) return "/tokens/blend.svg";

  if (underlying) {
    return resolveTokenLogoPath(underlying);
  }

  return null;
}

export function TokenIcon({
  symbol,
  underlying,
  size = "md",
  className = "",
  showSymbolSrOnly = false,
}: TokenIconProps) {
  const [failed, setFailed] = useState(false);
  const src = resolveTokenLogoPath(symbol, underlying);
  const sizeClass = SIZE_CLASSES[size];

  if (!src || failed) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full bg-surface-muted border border-hairline font-mono text-xs font-bold text-ink ${sizeClass} ${className}`}
      >
        {showSymbolSrOnly ? (
          <>
            <span aria-hidden="true">{(symbol || "?").slice(0, 3)}</span>
            <span className="sr-only">{symbol}</span>
          </>
        ) : (
          (symbol || "?").slice(0, 3)
        )}
      </span>
    );
  }

  return (
    <span className={`inline-flex shrink-0 items-center justify-center ${sizeClass} ${className}`}>
      <img
        src={src}
        alt={symbol}
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full rounded-full object-contain select-none"
      />
      {showSymbolSrOnly && <span className="sr-only">{symbol}</span>}
    </span>
  );
}

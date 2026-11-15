export type ActivityEventType =
  | "swap"
  | "deposit"
  | "redeem"
  | "mint_py"
  | "redeem_py"
  | "liquidity"
  | "yield_claimed"
  | "rollover";

export interface ActivityItem {
  id: string;
  type: ActivityEventType;
  txHash: string;
  ledger: number;
  timestamp: number; // Unix epoch seconds
  user: string;
  receiver?: string;
  description: string;
  amountIn?: string;
  tokenIn?: string;
  amountOut?: string;
  tokenOut?: string;
  isAdd?: boolean; // For liquidity events
  explorerUrl: string;
}

export type ActivityFilterType = "all" | "swap" | "mint" | "liquidity" | "redeem";

export interface ActivityPanelProps {
  liveFeed: ActivityItem[];
  myHistory: ActivityItem[];
  userAddress: string | null;
  isSyncing?: boolean;
  onRefresh?: () => Promise<void> | void;
  onConnectWallet?: () => void;
  className?: string;
}

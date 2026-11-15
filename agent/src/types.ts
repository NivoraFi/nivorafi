export interface ContractDeploymentInfo {
  contractId: string;
  wasmHash?: string;
  wasmSizeBytes?: number;
  deployTx?: string;
  initTx?: string;
  explorerUrl?: string;
}

export interface DeploymentManifest {
  network: "testnet" | "mainnet";
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  deployer: string;
  deployedAt: string;
  market: {
    name: string;
    symbol: string;
    maturity: number;
    maturityIso: string;
    decimals: number;
    scalarRoot: string;
    initialAnchor: string;
    underlyingAsset: {
      code: string;
      issuer: string;
      sacContractId: string;
    };
  };
  contracts: {
    mock_blend: ContractDeploymentInfo;
    sy_blend_wrapper: ContractDeploymentInfo;
    pt_token: ContractDeploymentInfo;
    yt_token: ContractDeploymentInfo;
    yield_pool: ContractDeploymentInfo;
  };
  verificationTransactions: Record<string, { txHash: string; explorerUrl: string; description: string }>;
}

export interface MarketStateOnChain {
  total_pt_reserve: bigint;
  total_sy_reserve: bigint;
  total_lp_supply: bigint;
  scalar_root: bigint;
  initial_anchor: bigint;
  annual_fee_rate: bigint;
  protocol_fee_bps: bigint;
  fee_recipient: string;
  maturity: bigint;
  maturity_index: bigint;
  is_settled: boolean;
}

export interface MarketSnapshot {
  contractId: string;
  network: string;
  nowSeconds: number;
  maturitySeconds: number;
  daysToMaturity: number;
  isMatured: boolean;
  isSettled: boolean;
  ptReserve: string;
  syReserve: string;
  totalLpSupply: string;
  ptProportion: number;
  blendExchangeRate: string;
  ammExchangeRateWad: string;
  ptPriceInSy: number;
  ytPriceInSy: number;
  impliedFixedApyPct: number;
  ptTotalSupply: string;
  ytTotalSupply: string;
  syTotalSupply: string;
}

export interface UserYieldStateOnChain {
  yt_balance: bigint;
  last_index: bigint;
  unclaimed_yield: bigint;
}

export interface UserPortfolio {
  address: string;
  xlmBalance: string;
  usdcBalance: string;
  usdcTrustlineExists: boolean;
  syBalance: string;
  ptBalance: string;
  ytBalance: string;
  lpBalance: string;
  lastIndex: string;
  unclaimedYieldRaw: string;
  estimatedPendingYieldSy: string;
}

export type SwapDirection = "pt_for_sy" | "sy_for_pt" | "sy_for_yt" | "yt_for_sy";

export interface SwapQuoteResult {
  direction: SwapDirection;
  amountIn: string;
  estimatedOut: string;
  minOutWithSlippage: string;
  feeAmount: string;
  effectiveExchangeRate: number;
  impliedApyAfterPct: number;
  slippageBps: number;
}

export interface PreparedTransactionResult {
  operation: string;
  contractId: string;
  method: string;
  networkPassphrase: string;
  rpcUrl: string;
  unsignedXdr: string;
  simulatedReturnValue: string | null;
  minResourceFeeStroops: string;
  sourceAccount: string;
}

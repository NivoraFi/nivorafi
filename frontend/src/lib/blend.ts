import { ENV } from "./env";

export type BlendNetwork =
  | "testnet"
  | "public"
  | "mainnet"
  | "futurenet"
  | "standalone"
  | "mock"
  | "local";

export type BlendPoolType = "mock" | "real_blend";

export interface BlendReserveConfig {
  assetCode: string;
  assetSymbol: string;
  assetAddress: string;
  decimals: number;
  bRateScalar: bigint; // 1_000_000_000n (SCALAR_9)
  oracleIndex?: number;
  oracleAddress?: string;
  initialRateWad: bigint;
  name: string;
}

export interface BlendPoolDeployment {
  id: string;
  name: string;
  network: BlendNetwork;
  poolType: BlendPoolType;
  poolAddress: string;
  isMock: boolean;
  backstopAddress?: string;
  emitterAddress?: string;
  factoryAddress?: string;
  oracleAddress?: string;
  reserves: Record<string, BlendReserveConfig>;
  status: "active" | "deprecated" | "planned";
  explorerUrl?: string;
}

export interface BlendResolverOptions {
  useRealBlend?: boolean;
  poolAddressOverride?: string;
}

export interface BlendPoolConfig {
  network: BlendNetwork;
  poolId: string;
  isRealBlend: boolean;
  activePool: BlendPoolDeployment;
  deployments: Record<string, BlendPoolDeployment>;
  useRealBlend: boolean;
  resolvePoolAddress: (assetCode?: string) => string;
  resolveReserveConfig: (assetCode: string) => BlendReserveConfig | undefined;
  getFallbackRate: (assetCode?: string) => bigint;
}

export const BLEND_CONTRACTS = {
  testnet: {
    pool: "CCEBVDYM3X7TO274BCC4ECNML27Y5SF4K74S475LMGSOE62SS6I34JTB",
    poolV2Authoritative: "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF",
    backstop: "CBDVWXT433PRVTUNM56C3JREF3HIZHRBA64NB2C3B2UNCKIS65ZYCLZA",
    emitter: "CC3WJVJINN4E3LPMNTWKK7LQZLYDQMZHZA7EZGXATPHHBPKNZRIO3KZ6",
    poolFactory: "CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6",
    blendUsdcSac: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU",
    circleUsdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    xlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  },
  mainnet: {
    pool: "CAJJZSGMMLL2LUGIVYUL5CYUQXCX4RP5432G6HHV5EVJS7BV2HOH4W46",
    poolFixedV2: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    backstop: "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7",
    poolFactory: "CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU",
    usdcSac: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    xlmSac: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  },
  mock: {
    pool: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
    usdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    xlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    eurcSac: "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
  },
} as const;

export const DEFAULT_BLEND_DEPLOYMENTS: Record<string, BlendPoolDeployment> = {
  "testnet-mock": {
    id: "testnet-mock",
    name: "MockBlend Testnet Pool",
    network: "testnet",
    poolType: "mock",
    poolAddress: BLEND_CONTRACTS.mock.pool,
    isMock: true,
    reserves: {
      USDC: {
        assetCode: "USDC",
        assetSymbol: "bUSDC",
        assetAddress: BLEND_CONTRACTS.mock.usdcSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        initialRateWad: 1_000_000_000n,
        name: "Mock Blend USD Coin",
      },
      XLM: {
        assetCode: "XLM",
        assetSymbol: "bXLM",
        assetAddress: BLEND_CONTRACTS.mock.xlmSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        initialRateWad: 1_000_000_000n,
        name: "Mock Blend Stellar Lumens",
      },
      EURC: {
        assetCode: "EURC",
        assetSymbol: "bEURC",
        assetAddress: BLEND_CONTRACTS.mock.eurcSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        initialRateWad: 1_000_000_000n,
        name: "Mock Blend Euro Coin",
      },
    },
    status: "active",
    explorerUrl: "https://stellar.expert/explorer/testnet/contract/" + BLEND_CONTRACTS.mock.pool,
  },
  "testnet-real": {
    id: "testnet-real",
    name: "Real Blend Testnet Pool",
    network: "testnet",
    poolType: "real_blend",
    poolAddress: BLEND_CONTRACTS.testnet.pool,
    isMock: false,
    backstopAddress: BLEND_CONTRACTS.testnet.backstop,
    emitterAddress: BLEND_CONTRACTS.testnet.emitter,
    factoryAddress: BLEND_CONTRACTS.testnet.poolFactory,
    reserves: {
      USDC: {
        assetCode: "USDC",
        assetSymbol: "bUSDC",
        assetAddress: BLEND_CONTRACTS.testnet.blendUsdcSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        oracleIndex: 0,
        initialRateWad: 1_000_000_000n,
        name: "Blend Testnet USD Coin",
      },
      XLM: {
        assetCode: "XLM",
        assetSymbol: "bXLM",
        assetAddress: BLEND_CONTRACTS.testnet.xlmSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        oracleIndex: 1,
        initialRateWad: 1_000_000_000n,
        name: "Blend Testnet Lumens",
      },
    },
    status: "active",
    explorerUrl: "https://stellar.expert/explorer/testnet/contract/" + BLEND_CONTRACTS.testnet.pool,
  },
  "mainnet-real": {
    id: "mainnet-real",
    name: "Real Blend Mainnet Fixed Pool",
    network: "mainnet",
    poolType: "real_blend",
    poolAddress: BLEND_CONTRACTS.mainnet.pool,
    isMock: false,
    backstopAddress: BLEND_CONTRACTS.mainnet.backstop,
    factoryAddress: BLEND_CONTRACTS.mainnet.poolFactory,
    reserves: {
      USDC: {
        assetCode: "USDC",
        assetSymbol: "bUSDC",
        assetAddress: BLEND_CONTRACTS.mainnet.usdcSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        oracleIndex: 0,
        initialRateWad: 1_000_000_000n,
        name: "Circle USD Coin",
      },
      XLM: {
        assetCode: "XLM",
        assetSymbol: "bXLM",
        assetAddress: BLEND_CONTRACTS.mainnet.xlmSac,
        decimals: 7,
        bRateScalar: 1_000_000_000n,
        oracleIndex: 1,
        initialRateWad: 1_000_000_000n,
        name: "Stellar Lumens",
      },
    },
    status: "active",
    explorerUrl: "https://stellar.expert/explorer/public/contract/" + BLEND_CONTRACTS.mainnet.pool,
  },
};

export const BLEND_DEPLOYMENTS = DEFAULT_BLEND_DEPLOYMENTS;

export function isValidStellarContractId(address: unknown): boolean {
  if (typeof address !== "string") return false;
  if (address.length !== 56) return false;
  return /^C[A-Z2-7]{55}$/.test(address);
}

export function normalizeNetwork(networkName?: string): BlendNetwork {
  if (!networkName || typeof networkName !== "string") {
    const fallback = (ENV.network || "testnet").trim().toLowerCase();
    if (fallback === "public" || fallback === "mainnet") return "mainnet";
    if (fallback === "futurenet") return "futurenet";
    if (fallback === "standalone" || fallback === "mock" || fallback === "local") return "mock";
    return "testnet";
  }
  const raw = networkName.trim().toLowerCase();
  if (raw === "public" || raw === "mainnet") return "mainnet";
  if (raw === "futurenet") return "futurenet";
  if (raw === "standalone" || raw === "mock" || raw === "local") return "mock";
  return "testnet";
}

function cloneDeployment(dep: BlendPoolDeployment): BlendPoolDeployment {
  return {
    ...dep,
    reserves: Object.fromEntries(
      Object.entries(dep.reserves).map(([k, v]) => [k, { ...v }])
    ),
  };
}

export function getBlendPoolConfig(
  networkName?: string,
  options?: BlendResolverOptions
): BlendPoolConfig {
  const normalizedNet = normalizeNetwork(networkName);

  let activePoolKey: string;
  if (normalizedNet === "mainnet") {
    activePoolKey = "mainnet-real";
  } else if (normalizedNet === "mock") {
    activePoolKey = "testnet-mock";
  } else {
    // testnet / default
    const explicitlyMock = options?.useRealBlend === false;
    activePoolKey = explicitlyMock ? "testnet-mock" : "testnet-real";
  }

  const baseDeployment = DEFAULT_BLEND_DEPLOYMENTS[activePoolKey] ?? DEFAULT_BLEND_DEPLOYMENTS["testnet-mock"];
  const activePool = cloneDeployment(baseDeployment);

  const envOverride = process.env.NEXT_PUBLIC_BLEND_POOL_CONTRACT_ID;
  const poolOverride = options?.poolAddressOverride || envOverride;

  if (poolOverride && isValidStellarContractId(poolOverride)) {
    activePool.poolAddress = poolOverride;
  } else if (poolOverride) {
    activePool.poolAddress = poolOverride;
  }

  const isReal = activePool.poolType === "real_blend" && !activePool.isMock;
  const poolId = activePool.poolAddress;

  const deploymentsClone: Record<string, BlendPoolDeployment> = Object.fromEntries(
    Object.entries(DEFAULT_BLEND_DEPLOYMENTS).map(([k, v]) => [k, cloneDeployment(v)])
  );

  return {
    network: normalizedNet,
    poolId,
    isRealBlend: isReal,
    activePool,
    deployments: deploymentsClone,
    useRealBlend: isReal,
    resolvePoolAddress: (assetCode?: string) => {
      if (assetCode && activePool.reserves[assetCode.toUpperCase()]) {
        return activePool.poolAddress;
      }
      return activePool.poolAddress;
    },
    resolveReserveConfig: (assetCode: string) => {
      return activePool.reserves[assetCode.toUpperCase()];
    },
    getFallbackRate: (assetCode?: string) => {
      const code = assetCode ? assetCode.toUpperCase() : "USDC";
      const reserve = activePool.reserves[code];
      return reserve ? reserve.initialRateWad : 1_000_000_000n;
    },
  };
}

export function resolveMarketBlendPool(
  marketOrId: any,
  assetCodeOrNetwork?: string,
  network?: string
): string {
  // If called with a MarketDefinition object
  if (marketOrId && typeof marketOrId === "object" && "contracts" in marketOrId) {
    if (!assetCodeOrNetwork) {
      return marketOrId.contracts?.blendPoolId ?? BLEND_CONTRACTS.mock.pool;
    }
    const targetNet = assetCodeOrNetwork;
    const config = getBlendPoolConfig(targetNet);
    return config.resolvePoolAddress(marketOrId.asset?.code);
  }

  // If called with marketId string
  if (typeof marketOrId === "string") {
    if (network) {
      const config = getBlendPoolConfig(network);
      return config.resolvePoolAddress(assetCodeOrNetwork);
    }
    if (assetCodeOrNetwork) {
      const norm = assetCodeOrNetwork.trim().toLowerCase();
      if (norm === "testnet" || norm === "mainnet" || norm === "public" || norm === "mock" || norm === "standalone") {
        const config = getBlendPoolConfig(norm);
        return config.resolvePoolAddress();
      }
    }
    // Backward compatibility default: mock blend pool on testnet
    return BLEND_CONTRACTS.mock.pool;
  }

  return BLEND_CONTRACTS.mock.pool;
}

export function getBlendFallbackRate(assetCode?: string): bigint {
  const config = getBlendPoolConfig();
  return config.getFallbackRate(assetCode);
}

export function isRealBlendPool(poolAddress: string): boolean {
  if (typeof poolAddress !== "string") return false;
  return (
    poolAddress === BLEND_CONTRACTS.testnet.pool ||
    poolAddress === BLEND_CONTRACTS.testnet.poolV2Authoritative ||
    poolAddress === BLEND_CONTRACTS.mainnet.pool ||
    poolAddress === BLEND_CONTRACTS.mainnet.poolFixedV2
  );
}

export function formatBlendRate(bRateRaw: bigint | number, decimals = 6): string {
  const num = typeof bRateRaw === "bigint" ? Number(bRateRaw) / 1e9 : bRateRaw;
  if (!Number.isFinite(num) || num <= 0) return (1).toFixed(decimals);
  return num.toFixed(decimals);
}

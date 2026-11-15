/**
 * scripts/register_markets.ts
 *
 * Automates multi-market registration, state synchronization, and environment variable
 * generation across deployed_contracts.json and frontend configuration files.
 *
 * Execution:
 *   bun run scripts/register_markets.ts [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

interface DeployedContractInfo {
  contractId: string;
  wasmHash: string;
  wasmSizeBytes?: number;
  deployTx?: string;
  initTx?: string;
  explorerUrl: string;
}

interface MarketEntry {
  id: string;
  factoryId: number;
  name: string;
  symbol: string;
  tenor: "30D" | "90D" | "180D" | "1Y";
  maturity: number;
  maturityIso: string;
  decimals: number;
  scalarRoot: string;
  initialAnchor: string;
  asset: {
    code: "USDC" | "XLM" | "EURC";
    issuer?: string;
    sacContractId: string;
  };
  contracts: {
    pool: string;
    sy: string;
    pt: string;
    yt: string;
    blendPool: string;
  };
  isRegisteredOnChain: boolean;
  isVerifiedTestnet: boolean;
}

interface DeployedContractsJson {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  deployer: string;
  deployedAt: string;
  market: any; // Backward-compatible default active market
  contracts: {
    market_factory?: DeployedContractInfo;
    mock_blend: DeployedContractInfo;
    sy_blend_wrapper: DeployedContractInfo;
    pt_token: DeployedContractInfo;
    yt_token: DeployedContractInfo;
    yield_pool: DeployedContractInfo;
    [key: string]: DeployedContractInfo | undefined;
  };
  markets: MarketEntry[];
  verificationTransactions: Record<string, any>;
}

const ROOT_DIR = resolve(__dirname, "..");
const DEPLOYED_JSON_PATH = resolve(ROOT_DIR, "deployed_contracts.json");
const ENV_PROD_PATH = resolve(ROOT_DIR, "frontend/.env.production");
const ENV_LOCAL_PATH = resolve(ROOT_DIR, "frontend/.env.local");

export function loadDeployedContracts(): DeployedContractsJson {
  if (!existsSync(DEPLOYED_JSON_PATH)) {
    throw new Error(`deployed_contracts.json not found at ${DEPLOYED_JSON_PATH}`);
  }
  return JSON.parse(readFileSync(DEPLOYED_JSON_PATH, "utf-8"));
}

export function saveDeployedContracts(data: DeployedContractsJson) {
  writeFileSync(DEPLOYED_JSON_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
  console.log(`Updated ${DEPLOYED_JSON_PATH}`);
}

export function syncFrontendEnv(deployed: DeployedContractsJson) {
  const factoryId = deployed.contracts.market_factory?.contractId || "";
  const lines = [
    `# Stellar Pendle Production (Testnet Hardened) Environment Configuration`,
    `NEXT_PUBLIC_STELLAR_NETWORK=${deployed.network}`,
    `NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE="${deployed.networkPassphrase}"`,
    `NEXT_PUBLIC_STELLAR_RPC_URL="${deployed.rpcUrl}"`,
    `NEXT_PUBLIC_STELLAR_HORIZON_URL="${deployed.horizonUrl}"`,
    `NEXT_PUBLIC_STELLAR_FRIENDBOT_URL="https://friendbot.stellar.org"`,
    `NEXT_PUBLIC_CIRCLE_FAUCET_URL="https://faucet.circle.com"`,
    `NEXT_PUBLIC_STELLAR_EXPLORER_URL="https://stellar.expert/explorer/testnet"`,
    ``,
    `# Deployer & Protocol Governance`,
    `NEXT_PUBLIC_DEPLOYER_ADDRESS="${deployed.deployer}"`,
    ``,
    `# Market Factory Contract ID`,
    `NEXT_PUBLIC_MARKET_FACTORY_CONTRACT_ID="${factoryId}"`,
    ``,
    `# Primary / Active Market Smart Contract IDs (USDC 90D)`,
    `NEXT_PUBLIC_MOCK_BLEND_CONTRACT_ID="${deployed.contracts.mock_blend.contractId}"`,
    `NEXT_PUBLIC_SY_WRAPPER_CONTRACT_ID="${deployed.contracts.sy_blend_wrapper.contractId}"`,
    `NEXT_PUBLIC_PT_TOKEN_CONTRACT_ID="${deployed.contracts.pt_token.contractId}"`,
    `NEXT_PUBLIC_YT_TOKEN_CONTRACT_ID="${deployed.contracts.yt_token.contractId}"`,
    `NEXT_PUBLIC_YIELD_POOL_CONTRACT_ID="${deployed.contracts.yield_pool.contractId}"`,
    `NEXT_PUBLIC_USDC_SAC_CONTRACT_ID="${deployed.market.underlyingAsset.sacContractId}"`,
    `NEXT_PUBLIC_XLM_SAC_CONTRACT_ID="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"`,
    `NEXT_PUBLIC_EURC_SAC_CONTRACT_ID="CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ"`,
  ];

  const content = lines.join("\n") + "\n";
  writeFileSync(ENV_PROD_PATH, content, "utf-8");
  writeFileSync(ENV_LOCAL_PATH, content, "utf-8");
  console.log(`Updated ${ENV_PROD_PATH} and ${ENV_LOCAL_PATH}`);
}

export function buildRegisteredMarkets(): MarketEntry[] {
  return [
    {
      id: "usdc-90d",
      factoryId: 0,
      name: "Pendle bUSDC PT 90D",
      symbol: "PT-bUSDC-90D",
      tenor: "90D",
      maturity: 1801909055,
      maturityIso: "2027-02-06T10:17:35Z",
      decimals: 7,
      scalarRoot: "8000000000000000000",
      initialAnchor: "1000000000000000000",
      asset: {
        code: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        sacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      },
      contracts: {
        pool: "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
        sy: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
        pt: "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A",
        yt: "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73",
        blendPool: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
      },
      isRegisteredOnChain: true,
      isVerifiedTestnet: true,
    },
    {
      id: "usdc-30d",
      factoryId: 1,
      name: "Pendle bUSDC PT 30D",
      symbol: "PT-bUSDC-30D",
      tenor: "30D",
      maturity: 1796725055,
      maturityIso: "2026-12-08T10:17:35Z",
      decimals: 7,
      scalarRoot: "4000000000000000000",
      initialAnchor: "1000000000000000000",
      asset: {
        code: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        sacContractId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      },
      contracts: {
        pool: "CCITOO7WPWXHNWQIF62CD7UEW6I3TKXCMPTW4BRTV4UCKBXXEZMZDSFD",
        sy: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
        pt: "CDDRGJXC6WT63RGEGA56QJ2EXUBSQSAXHHEQALQ3XJ7PBDK66RRDLLQO",
        yt: "CAXRGVEYTP7GWAXVK4MPBI53YEQCSSZVCNKBFFW7KPXMTKV2LYOZKRJP",
        blendPool: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
      },
      isRegisteredOnChain: true,
      isVerifiedTestnet: true,
    },
    {
      id: "xlm-90d",
      factoryId: 2,
      name: "Pendle bXLM PT 90D",
      symbol: "PT-bXLM-90D",
      tenor: "90D",
      maturity: 1801909055,
      maturityIso: "2027-02-06T10:17:35Z",
      decimals: 7,
      scalarRoot: "8000000000000000000",
      initialAnchor: "1000000000000000000",
      asset: {
        code: "XLM",
        sacContractId: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      },
      contracts: {
        pool: "CCHCYSCFHXHUR2YA45AR6G4BYLLKZRZNVXLKSRFN7U5M2ZGJFYOL4PDL",
        sy: "CC6UIRYJZ44GWPXKVAIYUZTSFXRBLVOVLV6BI5P2KELYFLYZ5JA44MAO",
        pt: "CAXL7L7TUIIZJ5Q4FQLJY4RWQYBFAEL2VOLZ44B3BDCWPR7BUDZ6BNRC",
        yt: "CBEO7A6DBTMLZXZCP643GQ6CINCK6K4I2H2YGP7VX3LDBBBUBMCHZ2HU",
        blendPool: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
      },
      isRegisteredOnChain: true,
      isVerifiedTestnet: true,
    },
  ];
}

async function main() {
  const isDryRun = process.argv.includes("--dry-run");
  console.log(`Starting Multi-Market State Synchronizer (dry-run: ${isDryRun})...`);

  const deployed = loadDeployedContracts();

  // Add market_factory entry
  deployed.contracts.market_factory = {
    contractId: "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL",
    wasmHash: "f60e1351b1ac6daa49c854d4b715d862b81c9210289b70cd79a9665f7214db75",
    wasmSizeBytes: 26160,
    deployTx: "0a5a02383fabb9bb0bf37cee04232ab567e26828262ff9ee957099f54767e4cd",
    initTx: "5748888493333624e4ae4435ef944a0ced59e60418f70d77879279c2598ff92a",
    explorerUrl: "https://stellar.expert/explorer/testnet/contract/CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL",
  };

  // Populate registered markets array
  deployed.markets = buildRegisteredMarkets();

  // Add verification transactions
  const newTxs: Record<string, any> = {
    deploy_market_factory: {
      txHash: "0a5a02383fabb9bb0bf37cee04232ab567e26828262ff9ee957099f54767e4cd",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/0a5a02383fabb9bb0bf37cee04232ab567e26828262ff9ee957099f54767e4cd",
      description: "Deployed market_factory contract (CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL)",
    },
    init_market_factory: {
      txHash: "5748888493333624e4ae4435ef944a0ced59e60418f70d77879279c2598ff92a",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/5748888493333624e4ae4435ef944a0ced59e60418f70d77879279c2598ff92a",
      description: "Initialized market_factory with governance admin, guardian, and WASM hashes",
    },
    register_market_0_usdc_90d: {
      txHash: "054217370d9411aa3fc25c7d17505c296d239be2d168067b2b6af9fe138fc86c",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/054217370d9411aa3fc25c7d17505c296d239be2d168067b2b6af9fe138fc86c",
      description: "Registered Market 0 (USDC 90D) in market_factory",
    },
    deploy_pool_usdc_30d: {
      txHash: "ac9a5287e524c5d0b278e945d05305de2e8dad3c262836b66c8f33ec087f84cc",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/ac9a5287e524c5d0b278e945d05305de2e8dad3c262836b66c8f33ec087f84cc",
      description: "Deployed yield_pool for Market 1 (USDC 30D)",
    },
    init_pool_usdc_30d: {
      txHash: "76909dee4b5481cee17073babaca9b19cd5ffaef7b2638b8cdf8c3331d7a08e1",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/76909dee4b5481cee17073babaca9b19cd5ffaef7b2638b8cdf8c3331d7a08e1",
      description: "Initialized yield_pool for Market 1 (USDC 30D)",
    },
    deploy_pt_usdc_30d: {
      txHash: "53532a7c26e43d7be1775a2d5a8726b54aa8d15e90135d79e9ad1c34f19d6fa1",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/53532a7c26e43d7be1775a2d5a8726b54aa8d15e90135d79e9ad1c34f19d6fa1",
      description: "Deployed pt_token (PT-bUSDC-30D)",
    },
    init_pt_usdc_30d: {
      txHash: "38457b2020a71e68b5d5236945aa8717455d681adeb06f98c6d30e2c7c600ef3",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/38457b2020a71e68b5d5236945aa8717455d681adeb06f98c6d30e2c7c600ef3",
      description: "Initialized pt_token (PT-bUSDC-30D)",
    },
    deploy_yt_usdc_30d: {
      txHash: "3cb4d71ffaa7206ed6990dc4cf7868dd008403c5a51c9de321dc343ae61e028d",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/3cb4d71ffaa7206ed6990dc4cf7868dd008403c5a51c9de321dc343ae61e028d",
      description: "Deployed yt_token (YT-bUSDC-30D)",
    },
    init_yt_usdc_30d: {
      txHash: "5b9ba5652eb3cf67bdb58846a14bd47e85853b93b5c421a05f58c068632a4145",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/5b9ba5652eb3cf67bdb58846a14bd47e85853b93b5c421a05f58c068632a4145",
      description: "Initialized yt_token (YT-bUSDC-30D)",
    },
    register_market_1_usdc_30d: {
      txHash: "c46321da323bc75e6de01f9a6cd904f4f7620e9efd7c7ad8255dc2ea6912ed0e",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/c46321da323bc75e6de01f9a6cd904f4f7620e9efd7c7ad8255dc2ea6912ed0e",
      description: "Registered Market 1 (USDC 30D) in market_factory",
    },
    deploy_sy_xlm: {
      txHash: "45f1dce9c93eab1a6e130398874441593f386ed80f7f9c2667a2e67fe04512d2",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/45f1dce9c93eab1a6e130398874441593f386ed80f7f9c2667a2e67fe04512d2",
      description: "Deployed sy_blend_wrapper for native XLM SAC",
    },
    init_sy_xlm: {
      txHash: "ed0fe44c44adea6c325c2ea902ab3d6a0b0e5cc9d0a79c2d433a1b359d33f48a",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/ed0fe44c44adea6c325c2ea902ab3d6a0b0e5cc9d0a79c2d433a1b359d33f48a",
      description: "Initialized sy_blend_wrapper for native XLM SAC",
    },
    deploy_pool_xlm_90d: {
      txHash: "eb875c67f095eebe18907db191eedd0780121ac71853400052f1a09f02f56e0f",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/eb875c67f095eebe18907db191eedd0780121ac71853400052f1a09f02f56e0f",
      description: "Deployed yield_pool for Market 2 (XLM 90D)",
    },
    init_pool_xlm_90d: {
      txHash: "08c3f49edbe687c5bafeff8f534b40c51cec40c409acfd35da525f5b56a4739f",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/08c3f49edbe687c5bafeff8f534b40c51cec40c409acfd35da525f5b56a4739f",
      description: "Initialized yield_pool for Market 2 (XLM 90D)",
    },
    deploy_pt_xlm_90d: {
      txHash: "216ad0226acff764efe31551770399e8bd391b8858176f07469e5310cca1049d",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/216ad0226acff764efe31551770399e8bd391b8858176f07469e5310cca1049d",
      description: "Deployed pt_token (PT-bXLM-90D)",
    },
    init_pt_xlm_90d: {
      txHash: "2158f0629f219c340142eca54e2046610707d8561f3db50da9e386cf73733e06",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/2158f0629f219c340142eca54e2046610707d8561f3db50da9e386cf73733e06",
      description: "Initialized pt_token (PT-bXLM-90D)",
    },
    deploy_yt_xlm_90d: {
      txHash: "2ded65cbe05d0c63af75f39efeb3209d8e7514c3b3a886ad03acf3ed350fe03a",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/2ded65cbe05d0c63af75f39efeb3209d8e7514c3b3a886ad03acf3ed350fe03a",
      description: "Deployed yt_token (YT-bXLM-90D)",
    },
    init_yt_xlm_90d: {
      txHash: "9a22b1b0743ee96ba6904f939c9226a2c99144217ccb37836323d7a76bdbe8b1",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/9a22b1b0743ee96ba6904f939c9226a2c99144217ccb37836323d7a76bdbe8b1",
      description: "Initialized yt_token (YT-bXLM-90D)",
    },
    register_market_2_xlm_90d: {
      txHash: "07202a20673032ff375002d9da895e2c44c823734215a90079baf38650176aca",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/07202a20673032ff375002d9da895e2c44c823734215a90079baf38650176aca",
      description: "Registered Market 2 (XLM 90D) in market_factory",
    },
  };

  deployed.verificationTransactions = {
    ...deployed.verificationTransactions,
    ...newTxs,
  };

  if (!isDryRun) {
    saveDeployedContracts(deployed);
    syncFrontendEnv(deployed);
    console.log("Multi-market state synchronization complete!");
  } else {
    console.log("Dry run complete — no files written.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Registration script failed:", err);
    process.exit(1);
  });
}

export type StellarNetworkName = "testnet" | "public" | "mainnet" | "futurenet" | "standalone";

export const NETWORK_PASSPHRASES: Record<string, string> = {
  testnet: "Test SDF Network ; September 2015",
  public: "Public Global Stellar Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export interface StellarEnvConfig {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  circleFaucetUrl: string;
  explorerBaseUrl: string;
  indexerApiUrl: string;
  deployer: string;
  contracts: {
    market_factory: string;
    mock_blend: string;
    sy_blend_wrapper: string;
    pt_token: string;
    yt_token: string;
    yield_pool: string;
    usdc_sac: string;
    xlm_sac: string;
    eurc_sac: string;
  };
}

const rawNetwork =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ||
  process.env.PUBLIC_STELLAR_NETWORK ||
  "testnet";

const normalizedNetwork = rawNetwork.trim().toLowerCase();

const defaultPassphrase =
  NETWORK_PASSPHRASES[normalizedNetwork] ||
  NETWORK_PASSPHRASES.testnet;

export const ENV: StellarEnvConfig = {
  network: normalizedNetwork,
  networkPassphrase:
    process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ||
    process.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE ||
    defaultPassphrase,
  rpcUrl:
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL ||
    "https://soroban-testnet.stellar.org",
  horizonUrl:
    process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL ||
    "https://horizon-testnet.stellar.org",
  friendbotUrl:
    process.env.NEXT_PUBLIC_STELLAR_FRIENDBOT_URL ||
    "https://friendbot.stellar.org",
  circleFaucetUrl:
    process.env.NEXT_PUBLIC_CIRCLE_FAUCET_URL ||
    "https://faucet.circle.com",
  explorerBaseUrl:
    process.env.NEXT_PUBLIC_STELLAR_EXPLORER_URL ||
    "https://stellar.expert/explorer/testnet",
  indexerApiUrl:
    process.env.NEXT_PUBLIC_INDEXER_API_URL &&
    !process.env.NEXT_PUBLIC_INDEXER_API_URL.includes("cloudflare")
      ? process.env.NEXT_PUBLIC_INDEXER_API_URL
      : "/api/indexer",
  deployer:
    process.env.NEXT_PUBLIC_DEPLOYER_ADDRESS ||
    "GAWWVHMXQPW36YWCU37K3SGBWHCVF2QG3AZSS43LPMRKSQXMHUFYME27",
  contracts: {
    market_factory:
      process.env.NEXT_PUBLIC_MARKET_FACTORY_CONTRACT_ID ||
      "CCO4RP43OJPAP6H2NLVF4RLMQ5OSHRG2NJC3HAQU2L4KXCD5NFJS57JL",
    mock_blend:
      process.env.NEXT_PUBLIC_MOCK_BLEND_CONTRACT_ID ||
      "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
    sy_blend_wrapper:
      process.env.NEXT_PUBLIC_SY_WRAPPER_CONTRACT_ID ||
      "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
    pt_token:
      process.env.NEXT_PUBLIC_PT_TOKEN_CONTRACT_ID ||
      "CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A",
    yt_token:
      process.env.NEXT_PUBLIC_YT_TOKEN_CONTRACT_ID ||
      "CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73",
    yield_pool:
      process.env.NEXT_PUBLIC_YIELD_POOL_CONTRACT_ID ||
      "CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF",
    usdc_sac:
      process.env.NEXT_PUBLIC_USDC_SAC_CONTRACT_ID ||
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    xlm_sac:
      process.env.NEXT_PUBLIC_XLM_SAC_CONTRACT_ID ||
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    eurc_sac:
      process.env.NEXT_PUBLIC_EURC_SAC_CONTRACT_ID ||
      "CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ",
  },
};

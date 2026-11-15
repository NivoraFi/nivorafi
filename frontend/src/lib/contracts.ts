import { ENV, NETWORK_PASSPHRASES } from "./env";

export interface VerifiedTxEntry {
  key: string;
  label: string;
  txHash: string;
  explorerUrl: string;
  summary: string;
}

export { NETWORK_PASSPHRASES };

export const STELLAR_PENDLE_CONFIG = {
  network: ENV.network,
  networkPassphrase: ENV.networkPassphrase,
  rpcUrl: ENV.rpcUrl,
  horizonUrl: ENV.horizonUrl,
  friendbotUrl: ENV.friendbotUrl,
  circleFaucetUrl: ENV.circleFaucetUrl,
  explorerBaseUrl: ENV.explorerBaseUrl,
  indexerApiUrl: ENV.indexerApiUrl,
  deployer: ENV.deployer,
  market: {
    name: "Pendle bUSDC PT 90D",
    symbol: "PT-bUSDC-90D",
    ytSymbol: "YT-bUSDC-90D",
    sySymbol: "sy-bUSDC",
    lpSymbol: "LP-PT-SY",
    maturity: 1801909055,
    maturityIso: "2027-02-06T10:17:35Z",
    decimals: 7,
    scalarRoot: "8000000000000000000",
    initialAnchor: "1000000000000000000",
    underlyingAsset: {
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      sacContractId: ENV.contracts.usdc_sac,
    },
  },
  market_factory: {
    contractId: ENV.contracts.market_factory,
    label: "Market Factory & Rollover Router",
    wasmHash: "f60e1351b1ac6daa49c854d4b715d862b81c9210289b70cd79a9665f7214db75",
    deployTx: "0a5a02383fabb9bb0bf37cee04232ab567e26828262ff9ee957099f54767e4cd",
    initTx: "5748888493333624e4ae4435ef944a0ced59e60418f70d77879279c2598ff92a",
  },
  contracts: {
    mock_blend: {
      contractId: ENV.contracts.mock_blend,
      label: "MockBlend Pool (bUSDC)",
      wasmHash: "3e898f421dc49c11be2d26f865d98516841c7f08145eae7165e859109d80f393",
      deployTx: "dd68d7ee1c595fcd6d1fd1ec021518f3f8dd7078b21e4050b40a3d7319a1c5e0",
      initTx: "c8ca52f1132a7002cac713012334d5c37585b2e1b0c130f5a9fbae5351bf2b8e",
    },
    sy_blend_wrapper: {
      contractId: ENV.contracts.sy_blend_wrapper,
      label: "SY Blend Wrapper (sy-bUSDC)",
      wasmHash: "b138fe4e9fc311d48496d261f1c20c2f48a02fecd147296010871bf71a8c7098",
      deployTx: "1278ce43d9121eced5c5788b55640a6694703dbacad46af5c25b1685bc65ec2e",
      initTx: "c67fb2878488e9cdb54a460a1f33de151a921b725d8d2253bc506f890d73d23d",
    },
    pt_token: {
      contractId: ENV.contracts.pt_token,
      label: "Principal Token (PT-bUSDC-90D)",
      wasmHash: "0708e820c6879d998a16ece4def695a2ac43fe3c949c9e1a46c0358a13395390",
      deployTx: "92ac5881e987c602757c22a8196116af25fe9f43aae28f441a4ad7487c846fc0",
      initTx: "b8510f9623acd3b6cdcae01f34dd18c01bcfdca1736e1818096d12a4880a1fac",
    },
    yt_token: {
      contractId: ENV.contracts.yt_token,
      label: "Yield Token (YT-bUSDC-90D)",
      wasmHash: "e54c906ec411940b827eae2492b0408980d05684e23a9c7514abb459dceee7f1",
      deployTx: "4c9112a5d5ba15e8eaa1b51d1b0a357428099f7557c34029f9ecb95c7e2b2af6",
      initTx: "3fd8f7961ece3e6e1f780ee4b70fb53bd01240fb9ed99c566966c631ac5f349b",
    },
    yield_pool: {
      contractId: ENV.contracts.yield_pool,
      label: "YieldPool Router & AMM",
      wasmHash: "fee1bd24bf05ed8deb9d82603469e8e6dc6b542000ecd9cb8b80c97b47357e2f4",
      deployTx: "fcd2b51c77d39dc9d423317c3c57873a431501e0144b62be3e059dc61657c9f9",
      initTx: "7536d0bcb83d0932c039a3e0ce3ac99ab5a36b7e88eb151f4ddfac1938fcaea2",
    },
  },
  verifiedTransactions: [
    {
      key: "deposit_sy",
      label: "Deposit 13.0 USDC -> sy-bUSDC",
      txHash: "2a6a3ac22bfd07dc6c237878cc42f20515b076880be0be7649d23d7b99424dde",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/2a6a3ac22bfd07dc6c237878cc42f20515b076880be0be7649d23d7b99424dde",
      summary: "Minted 13.0000 sy-bUSDC",
    },
    {
      key: "mint_py",
      label: "Mint 9.0 PT + 9.0 YT",
      txHash: "f8f53f7678faced39155be2f859bf692d9731095287cf68207fa1795eac1be35",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/f8f53f7678faced39155be2f859bf692d9731095287cf68207fa1795eac1be35",
      summary: "Stripped 9.0 SY into PT+YT",
    },
    {
      key: "add_liquidity",
      label: "Seed Pool (8.0 PT + 4.0 SY)",
      txHash: "7e64f4ff743852f770069eecad46600f688eadb1e0e102bf83a7af20450be53b",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/7e64f4ff743852f770069eecad46600f688eadb1e0e102bf83a7af20450be53b",
      summary: "Minted 5.6567 LP shares",
    },
    {
      key: "swap_pt_for_sy",
      label: "Swap 0.5 PT -> SY",
      txHash: "b63f85994ca756e0f0a8f8550a9106748a16f40bbebd8645429478b4b1d68dca",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/b63f85994ca756e0f0a8f8550a9106748a16f40bbebd8645429478b4b1d68dca",
      summary: "Received 0.4837 SY",
    },
    {
      key: "swap_sy_for_pt",
      label: "Swap 0.2 SY -> PT",
      txHash: "f203ac746e86a732c8f05893f1dd36caeb6ba45882f0e55baf7c44543a4a6d77",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/f203ac746e86a732c8f05893f1dd36caeb6ba45882f0e55baf7c44543a4a6d77",
      summary: "Locked 0.2030 PT",
    },
    {
      key: "swap_sy_for_yt",
      label: "Flash Swap 0.02 SY -> YT",
      txHash: "5518e99688da2890dc4a849b080b086143a7ee4f177b87210096467bc55a0d48",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/5518e99688da2890dc4a849b080b086143a7ee4f177b87210096467bc55a0d48",
      summary: "Leveraged 0.7355 YT minted",
    },
    {
      key: "redeem_py",
      label: "Early Unwind 0.2 PT+YT",
      txHash: "7be486ad4cef8b9c92e0d8ee676dc6b03638f08a9ea3ae296c61a26f2bc5b2cb",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/7be486ad4cef8b9c92e0d8ee676dc6b03638f08a9ea3ae296c61a26f2bc5b2cb",
      summary: "Merged back into 0.2000 SY",
    },
    {
      key: "redeem_sy",
      label: "Redeem 0.2 SY -> USDC",
      txHash: "98df889092d1f46e9e230a220e3d639d62512542cff31bc9b13b12f7e03a1e7e",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/98df889092d1f46e9e230a220e3d639d62512542cff31bc9b13b12f7e03a1e7e",
      summary: "Withdrew 0.2000 USDC",
    },
    {
      key: "set_b_rate",
      label: "Accrue Blend Index (1.001)",
      txHash: "61a1bf4182f176ce2cfdf9d331eeba40bc88e24b1533475e39cee090ad97b328",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/61a1bf4182f176ce2cfdf9d331eeba40bc88e24b1533475e39cee090ad97b328",
      summary: "+0.1% reserve index accrued",
    },
    {
      key: "claim_yield",
      label: "Claim Accrued YT Yield",
      txHash: "b9c52f274bddd0e20ed8c36876171cb544aa2f4180aa2612521e5a2225ceeefc",
      explorerUrl: "https://stellar.expert/explorer/testnet/tx/b9c52f274bddd0e20ed8c36876171cb544aa2f4180aa2612521e5a2225ceeefc",
      summary: "Harvested 0.0095 sy-bUSDC",
    },
  ] satisfies VerifiedTxEntry[],
};

export function explorerContractUrl(contractId: string): string {
  return `${STELLAR_PENDLE_CONFIG.explorerBaseUrl}/contract/${contractId}`;
}

export function explorerTxUrl(txHash: string): string {
  return `${STELLAR_PENDLE_CONFIG.explorerBaseUrl}/tx/${txHash}`;
}

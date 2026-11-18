use crate::interfaces::MarketKey;
use soroban_sdk::{contracttype, Address};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    // === Instance Storage (Global Configs & State) ===
    Admin,
    Initialized,
    Maturity,
    UnderlyingAsset,
    BlendPool,
    SlenderPool,
    SToken,
    SyContract,
    PtContract,
    YtContract,
    Market,
    ScalarRoot,
    InitialAnchor,
    AnnualFeeRate,
    ProtocolFeeBps,
    FeeRecipient,
    MaturityIndex,
    LastKnownIndex,
    IsSettled,
    TotalSupply,
    TotalPtReserve,
    TotalSyReserve,
    PtPrincipalReserve,
    YtYieldReserve,
    GlobalAccruedYield,
    TotalYieldWeight,
    TotalLpSupply,
    Decimals,
    Name,
    Symbol,

    // === Blend Protocol & Dynamic Compounding Engine ===
    AnnualRate,
    LastAccrualTime,
    ReserveData(Address),

    // === Enterprise Governance (M2 preparation) ===
    PendingAdmin,
    Guardian,
    IsPaused,

    // === Market Factory Keys ===
    MarketCount,
    PtWasmHash,
    YtWasmHash,
    PoolWasmHash,
    SyWasmHash,
    MarketById(u32),
    MarketByKey(MarketKey),
    MarketByPool(Address),
    MarketData(Address),
    SyByAsset(Address),
    WhitelistedCreator(Address),

    // === Persistent Storage (User Positions & Balances) ===
    Balance(Address),
    UserYieldState(Address),

    // === Temporary Storage (Ephemeral Caches & Guards) ===
    Allowance(AllowanceKey),
    FlashLoanGuard,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceValue {
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserYieldState {
    pub yt_balance: i128,
    pub last_index: i128,
    pub unclaimed_yield: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketState {
    pub total_pt_reserve: i128,
    pub total_sy_reserve: i128,
    pub total_lp_supply: i128,
    pub scalar_root: i128,
    pub initial_anchor: i128,
    pub annual_fee_rate: i128,
    pub protocol_fee_bps: i128,
    pub fee_recipient: Address,
    pub maturity: u64,
    pub maturity_index: i128,
    pub is_settled: bool,
}

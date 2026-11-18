use crate::errors::ContractError;
use crate::storage_keys::{MarketState, UserYieldState};
use soroban_sdk::{contractclient, contracttype, Address, BytesN, Env, String, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Positions {
    pub liabilities: i128,
    pub collateral: i128,
    pub supply: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveData {
    pub b_rate: i128,
    pub d_rate: i128,
    pub last_time: u64,
    pub supply_apr: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

pub const REQUEST_TYPE_SUPPLY: u32 = 0;
pub const REQUEST_TYPE_WITHDRAW: u32 = 1;
pub const REQUEST_TYPE_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_TYPE_WITHDRAW_COLLATERAL: u32 = 3;
pub const REQUEST_TYPE_BORROW: u32 = 4;
pub const REQUEST_TYPE_REPAY: u32 = 5;

#[contractclient(name = "BlendPoolClient")]
pub trait BlendPoolTrait {
    fn initialize(env: Env, admin: Address, asset: Address, initial_rate: i128);
    fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Positions;
    fn get_b_rate(env: Env) -> i128;
    fn set_b_rate(env: Env, new_rate: i128);
    fn get_reserve(env: Env, asset: Address) -> ReserveData;
    fn get_positions(env: Env, account: Address) -> Positions;
    fn accrue(env: Env) -> i128;
    fn get_collateral(env: Env, account: Address) -> i128;
    fn transfer_collateral(env: Env, from: Address, to: Address, amount: i128);
    fn set_annual_rate(env: Env, new_rate: i128);
    fn get_annual_rate(env: Env) -> i128;
}

pub use BlendPoolTrait as MockBlendTrait;
pub type MockBlendClient<'a> = BlendPoolClient<'a>;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlenderReserveData {
    pub liquidity_index: i128,
    pub last_time: u64,
    pub supply_apr: i128,
}

#[contractclient(name = "SlenderPoolClient")]
pub trait SlenderPoolTrait {
    fn initialize(env: Env, admin: Address, asset: Address, initial_rate: i128);
    fn deposit(env: Env, from: Address, to: Address, asset: Address, amount: i128) -> i128;
    fn withdraw(env: Env, from: Address, to: Address, asset: Address, amount: i128) -> i128;
    fn get_liquidity_index(env: Env) -> i128;
    fn set_liquidity_index(env: Env, new_rate: i128);
    fn get_reserve(env: Env, asset: Address) -> SlenderReserveData;
    fn accrue(env: Env) -> i128;
    fn set_annual_rate(env: Env, new_rate: i128);
    fn get_annual_rate(env: Env) -> i128;
    fn s_token(env: Env) -> Address;
}

#[contractclient(name = "StandardizedYieldClient")]
pub trait StandardizedYieldTrait {
    fn initialize(env: Env, admin: Address, underlying_asset: Address, blend_pool: Address);
    fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        underlying_asset: Address,
        blend_pool: Address,
    );
    fn deposit(env: Env, caller: Address, receiver: Address, amount: i128) -> i128;
    fn redeem(env: Env, caller: Address, receiver: Address, shares: i128) -> i128;
    fn redeem_to_btoken(env: Env, caller: Address, receiver: Address, shares: i128) -> i128;
    fn exchange_rate(env: Env) -> i128;
    fn asset(env: Env) -> Address;
    fn blend_pool(env: Env) -> Address;
    fn total_shares(env: Env) -> i128;

    // SEP-41 Fungible Token Interface
    fn balance(env: Env, id: Address) -> i128;
    fn transfer(env: Env, from: Address, to: Address, amount: i128);
    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128);
    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32);
    fn allowance(env: Env, from: Address, spender: Address) -> i128;
    fn burn(env: Env, from: Address, amount: i128);
    fn total_supply(env: Env) -> i128;
    fn burn_from(env: Env, spender: Address, from: Address, amount: i128);
    fn decimals(env: Env) -> u32;
    fn name(env: Env) -> String;
    fn symbol(env: Env) -> String;

    // Enterprise Governance & Pause
    fn propose_admin(env: Env, caller: Address, new_admin: Address);
    fn accept_admin(env: Env, caller: Address);
    fn get_admin(env: Env) -> Address;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address);
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>);
}

#[contractclient(name = "PrivilegedTokenClient")]
#[allow(clippy::too_many_arguments)]
pub trait PrivilegedTokenTrait {
    fn initialize(
        env: Env,
        admin: Address,
        market: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    );
    fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        market: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    );
    fn mint(env: Env, to: Address, amount: i128);
    fn burn(env: Env, from: Address, amount: i128);
    fn total_supply(env: Env) -> i128;

    // Yield claiming & querying for YT
    fn claim_user_yield(env: Env, user: Address) -> i128;
    fn get_user_yield_state(env: Env, user: Address) -> UserYieldState;

    // SEP-41 Fungible Token Interface
    fn balance(env: Env, id: Address) -> i128;
    fn transfer(env: Env, from: Address, to: Address, amount: i128);
    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128);
    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32);
    fn allowance(env: Env, from: Address, spender: Address) -> i128;
    fn burn_from(env: Env, spender: Address, from: Address, amount: i128);
    fn decimals(env: Env) -> u32;
    fn name(env: Env) -> String;
    fn symbol(env: Env) -> String;
    fn maturity(env: Env) -> u64;

    // Enterprise Governance & Pause
    fn propose_admin(env: Env, caller: Address, new_admin: Address);
    fn accept_admin(env: Env, caller: Address);
    fn get_admin(env: Env) -> Address;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address);
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>);
}

#[contractclient(name = "YieldTokenClient")]
#[allow(clippy::too_many_arguments)]
pub trait YieldTokenTrait {
    fn initialize(
        env: Env,
        admin: Address,
        market: Address,
        sy_contract: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    );
    fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        market: Address,
        sy_contract: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    );
    fn mint(env: Env, to: Address, amount: i128);
    fn burn(env: Env, from: Address, amount: i128);
    fn total_supply(env: Env) -> i128;
    fn claim_user_yield(env: Env, user: Address) -> i128;
    fn settle_maturity(env: Env, maturity_index: i128) -> i128;
    fn get_py_index(env: Env) -> i128;
    fn get_total_unclaimed_yield(env: Env) -> i128;
    fn get_user_yield_state(env: Env, user: Address) -> UserYieldState;
    fn balance(env: Env, id: Address) -> i128;
    fn transfer(env: Env, from: Address, to: Address, amount: i128);
    fn transfer_from(env: Env, spender: Address, from: Address, to: Address, amount: i128);
    fn approve(env: Env, from: Address, spender: Address, amount: i128, expiration_ledger: u32);
    fn allowance(env: Env, from: Address, spender: Address) -> i128;
    fn burn_from(env: Env, spender: Address, from: Address, amount: i128);
    fn decimals(env: Env) -> u32;
    fn name(env: Env) -> String;
    fn symbol(env: Env) -> String;
    fn maturity(env: Env) -> u64;

    fn propose_admin(env: Env, caller: Address, new_admin: Address);
    fn accept_admin(env: Env, caller: Address);
    fn get_admin(env: Env) -> Address;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address);
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>);
}

#[contractclient(name = "YieldMarketClient")]
#[allow(clippy::too_many_arguments)]
pub trait YieldMarketTrait {
    fn initialize(
        env: Env,
        admin: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    );
    fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    );
    fn mint_py(
        env: Env,
        caller: Address,
        receiver: Address,
        amount: i128,
        deadline: u64,
    ) -> (i128, i128);
    fn redeem_py(env: Env, caller: Address, receiver: Address, amount: i128) -> i128;
    fn redeem_pt_post_maturity(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
    ) -> i128;
    fn redeem_pt_to_btoken(env: Env, caller: Address, receiver: Address, pt_amount: i128) -> i128;
    fn claim_yield(env: Env, user: Address, receiver: Address) -> i128;
    fn settle_maturity(env: Env) -> i128;
    fn set_fee_recipient(env: Env, admin: Address, new_recipient: Address);
    fn total_supply(env: Env) -> i128;
    fn get_market_state(env: Env) -> MarketState;

    // AMM entrypoints
    fn swap_exact_pt_for_sy(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_in: i128,
        min_sy_out: i128,
        deadline: u64,
    ) -> (i128, i128);
    fn swap_exact_sy_for_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_pt_out: i128,
        deadline: u64,
    ) -> (i128, i128);
    fn swap_exact_sy_for_yt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_yt_out: i128,
        deadline: u64,
    ) -> (i128, i128);
    fn swap_exact_yt_for_sy(
        env: Env,
        caller: Address,
        receiver: Address,
        yt_in: i128,
        min_sy_out: i128,
        deadline: u64,
    ) -> (i128, i128);
    fn add_liquidity(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
        sy_amount: i128,
        min_lp_out: i128,
    ) -> i128;
    fn remove_liquidity(
        env: Env,
        caller: Address,
        receiver: Address,
        lp_amount: i128,
        min_pt_out: i128,
        min_sy_out: i128,
    ) -> (i128, i128);
    fn get_exchange_rate(env: Env) -> i128;
    fn get_reserves(env: Env) -> (i128, i128);
    fn get_py_reserves(env: Env) -> (i128, i128);

    // Enterprise Governance & Pause
    fn propose_admin(env: Env, caller: Address, new_admin: Address);
    fn accept_admin(env: Env, caller: Address);
    fn get_admin(env: Env) -> Address;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address);
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>);
}

#[contractclient(name = "GovernanceClient")]
pub trait GovernanceTrait {
    fn propose_admin(env: Env, caller: Address, new_admin: Address);
    fn accept_admin(env: Env, caller: Address);
    fn get_admin(env: Env) -> Address;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address);
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address);
    fn unpause(env: Env, caller: Address);
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>);
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketKey {
    pub asset: Address,
    pub maturity: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketMetadata {
    pub id: u32,
    pub asset: Address,
    pub maturity: u64,
    pub sy: Address,
    pub pt: Address,
    pub yt: Address,
    pub pool: Address,
    pub scalar_root: i128,
    pub initial_anchor: i128,
    pub created_at: u64,
    pub is_active: bool,
}

#[contractclient(name = "MarketFactoryClient")]
#[allow(clippy::too_many_arguments)]
pub trait MarketFactoryTrait {
    // === Initialization & WASM Hash Management ===
    fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        pt_wasm: BytesN<32>,
        yt_wasm: BytesN<32>,
        pool_wasm: BytesN<32>,
        sy_wasm: BytesN<32>,
    ) -> Result<(), ContractError>;
    fn set_wasm_hashes(
        env: Env,
        caller: Address,
        pt_wasm: Option<BytesN<32>>,
        yt_wasm: Option<BytesN<32>>,
        pool_wasm: Option<BytesN<32>>,
        sy_wasm: Option<BytesN<32>>,
    ) -> Result<(), ContractError>;
    fn get_wasm_hashes(
        env: Env,
    ) -> Result<(BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>), ContractError>;
    fn set_sy_for_asset(
        env: Env,
        caller: Address,
        asset: Address,
        sy: Address,
    ) -> Result<(), ContractError>;
    fn get_sy_for_asset(env: Env, asset: Address) -> Option<Address>;
    fn set_creator_whitelist(
        env: Env,
        caller: Address,
        creator: Address,
        allowed: bool,
    ) -> Result<(), ContractError>;
    fn is_whitelisted_creator(env: Env, creator: Address) -> bool;

    // === Market Creation & Registration ===
    fn create_market(
        env: Env,
        caller: Address,
        asset: Address,
        blend_pool: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<MarketMetadata, ContractError>;
    fn register_market(
        env: Env,
        caller: Address,
        pool: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        asset: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<MarketMetadata, ContractError>;

    // === Queries & Indexing ===
    fn get_market(env: Env, id: u32) -> Result<MarketMetadata, ContractError>;
    fn get_market_by_asset_maturity(
        env: Env,
        asset: Address,
        maturity: u64,
    ) -> Option<MarketMetadata>;
    fn get_market_by_pool(env: Env, pool: Address) -> Option<MarketMetadata>;
    fn list_markets(env: Env, start_index: u32, limit: u32) -> Vec<MarketMetadata>;
    fn market_count(env: Env) -> u32;

    // === Atomic Rollover Routers ===
    fn rollover_to_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        source_pool: Address,
        target_pool: Address,
        pt_amount: i128,
        min_target_pt: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError>;
    fn rollover_to_py(
        env: Env,
        caller: Address,
        receiver: Address,
        source_pool: Address,
        target_pool: Address,
        pt_amount: i128,
        min_new_shares: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError>;

    // === Single-Tx Zap-In Routers ===
    fn zap_in_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_pt_out: i128,
        deadline: u64,
    ) -> Result<i128, ContractError>;
    fn zap_in_yt(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_yt_out: i128,
        deadline: u64,
    ) -> Result<i128, ContractError>;
    fn zap_in_lp(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_lp_out: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError>;

    // === Enterprise Governance & Pause Guardian ===
    fn propose_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), ContractError>;
    fn accept_admin(env: Env, caller: Address) -> Result<(), ContractError>;
    fn get_admin(env: Env) -> Result<Address, ContractError>;
    fn get_pending_admin(env: Env) -> Option<Address>;
    fn set_guardian(env: Env, caller: Address, new_guardian: Address) -> Result<(), ContractError>;
    fn get_guardian(env: Env) -> Option<Address>;
    fn pause(env: Env, caller: Address) -> Result<(), ContractError>;
    fn unpause(env: Env, caller: Address) -> Result<(), ContractError>;
    fn is_paused(env: Env) -> bool;
    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>;
}

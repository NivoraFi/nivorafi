#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::MarketFactoryClient;
use market_factory::MarketFactory;
use mock_blend::{MockBlend, MockBlendClient};
use mock_slender::{MockSlender, MockSlenderClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{
    contract, contractimpl, symbol_short, token, Address, BytesN, Env, IntoVal, String, Symbol,
};
use sy_blend_wrapper::{StandardizedYield as SyBlend, StandardizedYieldClient as SyBlendClient};
use sy_slender_wrapper::{StandardizedYieldSlender, StandardizedYieldSlenderClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

const KEY_SYM: Symbol = symbol_short!("SYM");
const KEY_DEC: Symbol = symbol_short!("DEC");

#[contract]
pub struct MockMetaAsset;

#[contractimpl]
impl MockMetaAsset {
    pub fn init(env: Env, sym: String, dec: u32) {
        env.storage().instance().set(&KEY_SYM, &sym);
        env.storage().instance().set(&KEY_DEC, &dec);
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&KEY_SYM)
            .unwrap_or_else(|| String::from_str(&env, "ASSET"))
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&KEY_DEC).unwrap_or(7)
    }
}

struct SlenderProtocolFixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    user1: Address,
    user2: Address,
    usdc_admin: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    slender_client: MockSlenderClient<'a>,
    sy_client: StandardizedYieldSlenderClient<'a>,
    pt_client: PrincipalTokenClient<'a>,
    yt_client: YieldTokenClient<'a>,
    pool_client: YieldPoolClient<'a>,
    maturity: u64,
}

fn setup_slender_protocol<'a>() -> SlenderProtocolFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc.address());

    let slender_id = env.register(MockSlender, ());
    let slender_client = MockSlenderClient::new(&env, &slender_id);
    slender_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    let sy_id = env.register(StandardizedYieldSlender, ());
    let sy_client = StandardizedYieldSlenderClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &slender_id, &slender_id);

    let maturity = env.ledger().timestamp() + 180 * 86_400;
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    pt_client.initialize(
        &admin,
        &pool_id,
        &String::from_str(&env, "PT USDC 180D"),
        &String::from_str(&env, "PT-USDC-180D"),
        &7u32,
        &maturity,
    );

    let yt_id = env.register(YieldToken, ());
    let yt_client = YieldTokenClient::new(&env, &yt_id);
    yt_client.initialize(
        &admin,
        &pool_id,
        &sy_id,
        &String::from_str(&env, "YT USDC 180D"),
        &String::from_str(&env, "YT-USDC-180D"),
        &7u32,
        &maturity,
    );

    pool_client.initialize(
        &admin,
        &sy_id,
        &pt_id,
        &yt_id,
        &maturity,
        &(20 * WAD),
        &WAD,
    );

    SlenderProtocolFixture {
        env,
        admin,
        guardian,
        user1,
        user2,
        usdc_admin,
        usdc_client,
        slender_client,
        sy_client,
        pt_client,
        yt_client,
        pool_client,
        maturity,
    }
}

// =============================================================================
// Group 1: mock_slender Lifecycle, Organic Accrual & Illiquidity Rollback
// =============================================================================

#[test]
fn test_mock_slender_init_guards_and_organic_accrual_monotonicity() {
    let f = setup_slender_protocol();
    let attacker = Address::generate(&f.env);

    // Re-init rejected with AlreadyInitialized (#2) even for attacker
    assert_eq!(
        f.slender_client
            .try_initialize(&attacker, &f.usdc_client.address, &SCALAR_9),
        Err(Ok(ContractError::AlreadyInitialized))
    );

    // Zero / negative initial rate rejected on fresh instance
    let fresh_id = f.env.register(MockSlender, ());
    let fresh = MockSlenderClient::new(&f.env, &fresh_id);
    assert_eq!(
        fresh.try_initialize(&f.admin, &f.usdc_client.address, &0),
        Err(Ok(ContractError::ZeroAmount))
    );
    assert_eq!(
        fresh.try_initialize(&f.admin, &f.usdc_client.address, &-5),
        Err(Ok(ContractError::ZeroAmount))
    );

    // Organic APR compounding: 10% APR over 365 days -> 1.1e9
    f.slender_client.set_annual_rate(&(WAD / 10));
    let t0 = f.env.ledger().timestamp();

    // Multi-step small increments remain strictly monotonic vs single-shot
    let mut prev = f.slender_client.get_liquidity_index();
    for step in 1..=10u64 {
        f.env.ledger().set_timestamp(t0 + step * 3_153_600); // 1/10 year each
        let cur = f.slender_client.accrue();
        assert!(cur > prev);
        prev = cur;
    }
    // Compounded 10x(1% per 0.1y) = (1.01)^10 * 1e9 = 1_104_622_125..=1_104_622_130
    assert!((1_104_622_120..=1_104_622_130).contains(&prev));

    // Verify single-shot 1-year linear accrual on fresh instance equals exact 1.10e9
    fresh.initialize(&f.admin, &f.usdc_client.address, &SCALAR_9);
    fresh.set_annual_rate(&(WAD / 10));
    let tf0 = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(tf0 + 31_536_000);
    assert_eq!(fresh.get_liquidity_index(), 1_100_000_000);
}

#[test]
fn test_mock_slender_illiquid_withdrawal_atomic_rollback() {
    let f = setup_slender_protocol();
    let amount = 500_000_000i128;
    f.usdc_admin.mint(&f.user1, &amount);

    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    assert_eq!(f.sy_client.balance(&f.user1), amount);
    assert_eq!(f.slender_client.balance(&f.sy_client.address), amount);

    // Bump rate to 1.50 WITHOUT funding extra USDC to mock_slender -> illiquid
    f.slender_client.set_liquidity_index(&1_500_000_000);
    let res = f.sy_client.try_redeem(&f.user1, &f.user1, &amount);
    assert!(res.is_err());

    // State rolled back atomically
    assert_eq!(f.sy_client.balance(&f.user1), amount);
    assert_eq!(f.sy_client.total_shares(), amount);
    assert_eq!(f.slender_client.balance(&f.sy_client.address), amount);
    assert_eq!(f.usdc_client.balance(&f.user1), 0);
}

// =============================================================================
// Group 2: sy_slender_wrapper Vault, Metadata, SEP-41, Config & Governance
// =============================================================================

#[test]
fn test_sy_slender_metadata_and_rates_and_micro_deposit_rounding() {
    let f = setup_slender_protocol();

    // Dynamic metadata for USDC, EURC, native XLM
    let meta_usdc = f.env.register(MockMetaAsset, ());
    MockMetaAssetClient::new(&f.env, &meta_usdc).init(&String::from_str(&f.env, "USDC"), &7);
    let sy_usdc = StandardizedYieldSlenderClient::new(
        &f.env,
        &f.env.register(StandardizedYieldSlender, ()),
    );
    sy_usdc.initialize(&f.admin, &meta_usdc, &f.slender_client.address, &f.slender_client.address);
    assert_eq!(
        sy_usdc.name(),
        String::from_str(&f.env, "Standardized Yield Slender USDC")
    );
    assert_eq!(sy_usdc.symbol(), String::from_str(&f.env, "sy-sUSDC"));
    assert_eq!(sy_usdc.decimals(), 7);

    let meta_eurc = f.env.register(MockMetaAsset, ());
    MockMetaAssetClient::new(&f.env, &meta_eurc).init(&String::from_str(&f.env, "EURC"), &6);
    let sy_eurc = StandardizedYieldSlenderClient::new(
        &f.env,
        &f.env.register(StandardizedYieldSlender, ()),
    );
    sy_eurc.initialize(&f.admin, &meta_eurc, &f.slender_client.address, &f.slender_client.address);
    assert_eq!(
        sy_eurc.name(),
        String::from_str(&f.env, "Standardized Yield Slender EURC")
    );
    assert_eq!(sy_eurc.symbol(), String::from_str(&f.env, "sy-sEURC"));
    assert_eq!(sy_eurc.decimals(), 6);

    let meta_xlm = f.env.register(MockMetaAsset, ());
    MockMetaAssetClient::new(&f.env, &meta_xlm).init(&String::from_str(&f.env, "native"), &7);
    let sy_xlm = StandardizedYieldSlenderClient::new(
        &f.env,
        &f.env.register(StandardizedYieldSlender, ()),
    );
    sy_xlm.initialize(&f.admin, &meta_xlm, &f.slender_client.address, &f.slender_client.address);
    assert_eq!(
        sy_xlm.name(),
        String::from_str(&f.env, "Standardized Yield Slender XLM")
    );
    assert_eq!(sy_xlm.symbol(), String::from_str(&f.env, "sy-sXLM"));

    // Deposit/redeem at 1.0, 1.15, and 0.80 rates
    f.usdc_admin.mint(&f.user1, &2_000_000_000);
    let s1 = f.sy_client.deposit(&f.user1, &f.user1, &1_000_000_000);
    assert_eq!(s1, 1_000_000_000);

    f.slender_client.set_liquidity_index(&1_150_000_000);
    f.usdc_admin.mint(&f.user2, &1_150_000_000);
    let s2 = f.sy_client.deposit(&f.user2, &f.user2, &1_150_000_000);
    assert_eq!(s2, 1_000_000_000);

    // Micro-deposit rounding to 0 shares -> ZeroAmount (#4)
    f.slender_client.set_liquidity_index(&2_000_000_000);
    assert_eq!(
        f.sy_client.try_deposit(&f.user1, &f.user1, &1),
        Err(Ok(ContractError::ZeroAmount))
    );

    // Sub-1.0 rate (0.80): 800 USDC -> 1000 SY shares -> redeem 1000 shares -> 800 USDC
    f.slender_client.set_liquidity_index(&800_000_000);
    let s3 = f.sy_client.deposit(&f.user1, &f.user1, &800_000_000);
    assert_eq!(s3, 1_000_000_000);
    let out3 = f.sy_client.redeem(&f.user1, &f.user1, &1_000_000_000);
    assert_eq!(out3, 800_000_000);

    // Over-redeem -> InsufficientBalance (#5)
    assert_eq!(
        f.sy_client
            .try_redeem(&f.user1, &f.user1, &(f.sy_client.balance(&f.user1) + 1)),
        Err(Ok(ContractError::InsufficientBalance))
    );
}

#[test]
fn test_sy_slender_sep41_redeem_to_btoken_and_governance_matrix() {
    let f = setup_slender_protocol();
    f.usdc_admin.mint(&f.user1, &1_000_000_000);
    f.sy_client.deposit(&f.user1, &f.user1, &1_000_000_000);

    // Self-transfer must not inflate balance or total supply
    f.sy_client.transfer(&f.user1, &f.user1, &500_000_000);
    assert_eq!(f.sy_client.balance(&f.user1), 1_000_000_000);
    assert_eq!(f.sy_client.total_shares(), 1_000_000_000);
    assert_eq!(f.sy_client.total_supply(), 1_000_000_000);

    // Approve + transfer_from + burn_from
    let spender = Address::generate(&f.env);
    f.sy_client
        .approve(&f.user1, &spender, &400_000_000, &10_000);
    f.sy_client
        .transfer_from(&spender, &f.user1, &f.user2, &250_000_000);
    f.sy_client.burn_from(&spender, &f.user1, &150_000_000);
    assert_eq!(f.sy_client.allowance(&f.user1, &spender), 0);
    assert_eq!(f.sy_client.balance(&f.user1), 600_000_000);
    assert_eq!(f.sy_client.balance(&f.user2), 250_000_000);
    assert_eq!(f.sy_client.total_shares(), 850_000_000);

    // redeem_to_btoken transfers sUSDC receipt tokens and preserves total_shares == total_supply
    let receiver = Address::generate(&f.env);
    let s_out = f
        .sy_client
        .redeem_to_btoken(&f.user2, &receiver, &250_000_000);
    assert_eq!(s_out, 250_000_000);
    assert_eq!(f.slender_client.balance(&receiver), 250_000_000);
    assert_eq!(f.sy_client.total_shares(), 600_000_000);
    assert_eq!(f.sy_client.total_supply(), 600_000_000);

    // Governance: guardian pause matrix + 2-step admin + pool/sToken config auth
    f.sy_client.set_guardian(&f.admin, &f.guardian);
    f.sy_client.pause(&f.guardian);
    assert!(f.sy_client.is_paused());

    assert_eq!(
        f.sy_client.try_deposit(&f.user1, &f.user1, &100_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client.try_redeem(&f.user1, &f.user1, &100_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client
            .try_redeem_to_btoken(&f.user1, &receiver, &100_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client.try_transfer(&f.user1, &f.user2, &100_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client.try_burn(&f.user1, &100_000),
        Err(Ok(ContractError::ContractPaused))
    );
    // Reads succeed while paused
    assert_eq!(f.sy_client.exchange_rate(), SCALAR_9);
    assert_eq!(f.sy_client.balance(&f.user1), 600_000_000);

    // Guardian cannot unpause, admin can
    assert_eq!(
        f.sy_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
    f.sy_client.unpause(&f.admin);
    assert!(!f.sy_client.is_paused());

    // Admin pool/sToken setters reject guardian/stranger
    let new_pool = Address::generate(&f.env);
    assert_eq!(
        f.sy_client.try_set_slender_pool(&f.guardian, &new_pool),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_set_s_token(&f.user1, &new_pool),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2-step admin rotation
    let new_admin = Address::generate(&f.env);
    f.sy_client.propose_admin(&f.admin, &new_admin);
    assert_eq!(f.sy_client.get_pending_admin(), Some(new_admin.clone()));
    f.sy_client.accept_admin(&new_admin);
    assert_eq!(f.sy_client.get_admin(), new_admin);
    f.sy_client.set_slender_pool(&new_admin, &new_pool);
    assert_eq!(f.sy_client.slender_pool(), new_pool);
}

// =============================================================================
// Group 3: Full yield_pool + pt_token + yt_token + sy_slender_wrapper Lifecycle
// =============================================================================

#[test]
fn test_slender_yield_pool_full_lifecycle_reserves_and_maturity() {
    let f = setup_slender_protocol();
    let dl = f.maturity;

    // Seed LP liquidity
    let lp_usdc = 220_000_000_000i128;
    f.usdc_admin.mint(&f.admin, &lp_usdc);
    f.sy_client.deposit(&f.admin, &f.admin, &lp_usdc);
    f.pool_client
        .mint_py(&f.admin, &f.admin, &120_000_000_000, &dl);
    f.pool_client
        .add_liquidity(&f.admin, &f.admin, &120_000_000_000, &100_000_000_000, &1);

    // Deadline guard (#10)
    let now = f.env.ledger().timestamp();
    if now > 0 {
        assert_eq!(
            f.pool_client
                .try_mint_py(&f.user1, &f.user1, &1000, &(now - 1)),
            Err(Ok(ContractError::DeadlineExpired))
        );
    }

    // User1 deposits and executes all 4 swap directions
    f.usdc_admin.mint(&f.user1, &50_000_000_000);
    f.sy_client.deposit(&f.user1, &f.user1, &50_000_000_000);

    let (pt_bought, _) = f
        .pool_client
        .swap_exact_sy_for_pt(&f.user1, &f.user1, &5_000_000_000, &1, &dl);
    assert!(pt_bought > 0);

    let (sy_from_pt, _) = f
        .pool_client
        .swap_exact_pt_for_sy(&f.user1, &f.user1, &(pt_bought / 2), &1, &dl);
    assert!(sy_from_pt > 0);

    let (yt_bought, _) = f
        .pool_client
        .swap_exact_sy_for_yt(&f.user1, &f.user1, &3_000_000_000, &1, &dl);
    assert!(yt_bought > 0);

    let (sy_from_yt, _) = f
        .pool_client
        .swap_exact_yt_for_sy(&f.user1, &f.user1, &(yt_bought / 3), &1, &dl);
    assert!(sy_from_yt > 0);

    // Rate accrual via organic APR -> YT transfer checkpoint -> yield claim
    f.slender_client.set_annual_rate(&(WAD / 5)); // 20% APR
    f.env.ledger().set_timestamp(now + 90 * 86_400);
    let accrued_rate = f.slender_client.accrue();
    assert!(accrued_rate > SCALAR_9);

    let u1_yt = f.yt_client.balance(&f.user1);
    f.yt_client.transfer(&f.user1, &f.user2, &(u1_yt / 2));

    let claimed_u1 = f.pool_client.claim_yield(&f.user1, &f.user1);
    let claimed_u2 = f.pool_client.claim_yield(&f.user2, &f.user2);
    assert!(claimed_u1 > 0);
    assert_eq!(claimed_u2, 0); // user2 just received YT at current index

    // Advance past maturity -> settle_maturity pins MaturityIndex -> redeem PT
    f.env.ledger().set_timestamp(f.maturity + 10_000);
    let settled_idx = f.pool_client.settle_maturity();
    assert!(settled_idx >= accrued_rate);

    // Further post-maturity Slender rate growth does NOT inflate MaturityIndex
    f.slender_client
        .set_liquidity_index(&(settled_idx + 200_000_000));
    assert_eq!(f.yt_client.get_py_index(), settled_idx);

    let pt_bal = f.pt_client.balance(&f.user1);
    let sy_redeemed = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &pt_bal);
    assert!(sy_redeemed > 0);

    // Conservation check: pool SY balance covers remaining reserves
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert!(f.sy_client.balance(&f.pool_client.address) >= sy_res);
    assert!(pt_res >= 0);
}

#[test]
fn test_slender_bad_debt_haircut_and_100pct_utilization_emergency_exit() {
    let f = setup_slender_protocol();
    let dl = f.maturity;

    let amount = 10_000_000_000i128;
    f.usdc_admin.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount, &dl);

    // Simulate 20% SY bad debt inside pool -> post-maturity PT gets 80% haircut payout
    f.sy_client.burn(&f.pool_client.address, &2_000_000_000);
    f.env.ledger().set_timestamp(f.maturity + 100);
    let payout_sy = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &5_000_000_000);
    assert_eq!(payout_sy, 4_000_000_000);

    // Simulate 100% Slender utilization (drain USDC from mock_slender so sy.redeem would fail),
    // yet redeem_pt_to_btoken succeeds by delivering sUSDC receipt tokens!
    let pool_usdc = f.usdc_client.balance(&f.slender_client.address);
    f.usdc_client.transfer(
        &f.slender_client.address,
        Address::generate(&f.env),
        &pool_usdc,
    );
    assert_eq!(f.usdc_client.balance(&f.slender_client.address), 0);

    // Normal sy_client.redeem fails because mock_slender has 0 USDC
    assert!(f
        .sy_client
        .try_redeem(&f.user1, &f.user1, &payout_sy)
        .is_err());

    // Emergency exit via redeem_pt_to_btoken transfers sUSDC receipt tokens directly!
    let receiver = Address::generate(&f.env);
    let s_tokens_out = f
        .pool_client
        .redeem_pt_to_btoken(&f.user1, &receiver, &5_000_000_000);
    assert_eq!(s_tokens_out, 4_000_000_000);
    assert_eq!(f.slender_client.balance(&receiver), 4_000_000_000);
}

// =============================================================================
// Group 4: market_factory Multi-SY Coexistence & Cross-Adapter Rollover
// =============================================================================

#[test]
fn test_factory_multi_sy_coexistence_and_cross_adapter_rollover_errors_and_scoped_auth() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc.address());

    // Deploy Blend + sy_blend_wrapper (USDC 30D)
    let blend_id = env.register(MockBlend, ());
    let blend = MockBlendClient::new(&env, &blend_id);
    blend.initialize(&admin, &usdc.address(), &SCALAR_9);
    let sy_blend_id = env.register(SyBlend, ());
    let sy_blend = SyBlendClient::new(&env, &sy_blend_id);
    sy_blend.initialize(&admin, &usdc.address(), &blend_id);

    // Deploy Slender + sy_slender_wrapper (USDC 60D)
    let slender_id = env.register(MockSlender, ());
    let slender = MockSlenderClient::new(&env, &slender_id);
    slender.initialize(&admin, &usdc.address(), &SCALAR_9);
    let sy_slender_id = env.register(StandardizedYieldSlender, ());
    let sy_slender = StandardizedYieldSlenderClient::new(&env, &sy_slender_id);
    sy_slender.initialize(&admin, &usdc.address(), &slender_id, &slender_id);

    // Factory
    let factory_id = env.register(MarketFactory, ());
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(
        &admin,
        &guardian,
        &BytesN::from_array(&env, &[1u8; 32]),
        &BytesN::from_array(&env, &[2u8; 32]),
        &BytesN::from_array(&env, &[3u8; 32]),
        &BytesN::from_array(&env, &[4u8; 32]),
    );

    let t0 = env.ledger().timestamp();
    let mat_30 = t0 + 30 * 86_400;
    let mat_60 = t0 + 60 * 86_400;

    let pool_b = env.register(YieldPool, ());
    let pt_b = env.register(PrincipalToken, ());
    let yt_b = env.register(YieldToken, ());
    PrincipalTokenClient::new(&env, &pt_b).initialize(
        &admin,
        &pool_b,
        &String::from_str(&env, "PT bUSDC 30D"),
        &String::from_str(&env, "PT-bUSDC-30D"),
        &7,
        &mat_30,
    );
    YieldTokenClient::new(&env, &yt_b).initialize(
        &admin,
        &pool_b,
        &sy_blend_id,
        &String::from_str(&env, "YT bUSDC 30D"),
        &String::from_str(&env, "YT-bUSDC-30D"),
        &7,
        &mat_30,
    );
    let pool_b_client = YieldPoolClient::new(&env, &pool_b);
    pool_b_client.initialize(&admin, &sy_blend_id, &pt_b, &yt_b, &mat_30, &(20 * WAD), &WAD);
    factory.register_market(
        &admin,
        &pool_b,
        &sy_blend_id,
        &pt_b,
        &yt_b,
        &usdc.address(),
        &mat_30,
        &(20 * WAD),
        &WAD,
    );

    let pool_s = env.register(YieldPool, ());
    let pt_s = env.register(PrincipalToken, ());
    let yt_s = env.register(YieldToken, ());
    PrincipalTokenClient::new(&env, &pt_s).initialize(
        &admin,
        &pool_s,
        &String::from_str(&env, "PT sUSDC 60D"),
        &String::from_str(&env, "PT-sUSDC-60D"),
        &7,
        &mat_60,
    );
    YieldTokenClient::new(&env, &yt_s).initialize(
        &admin,
        &pool_s,
        &sy_slender_id,
        &String::from_str(&env, "YT sUSDC 60D"),
        &String::from_str(&env, "YT-sUSDC-60D"),
        &7,
        &mat_60,
    );
    let pool_s_client = YieldPoolClient::new(&env, &pool_s);
    pool_s_client.initialize(
        &admin,
        &sy_slender_id,
        &pt_s,
        &yt_s,
        &mat_60,
        &(20 * WAD),
        &WAD,
    );

    // Non-admin register_market rejected (#3 Unauthorized)
    assert_eq!(
        factory.try_register_market(
            &user,
            &pool_s,
            &sy_slender_id,
            &pt_s,
            &yt_s,
            &usdc.address(),
            &mat_60,
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin registers Slender market on distinct maturity; SyByAsset remains sy_blend_id
    factory.register_market(
        &admin,
        &pool_s,
        &sy_slender_id,
        &pt_s,
        &yt_s,
        &usdc.address(),
        &mat_60,
        &(20 * WAD),
        &WAD,
    );
    assert_eq!(factory.market_count(), 2);
    assert_eq!(factory.get_sy_for_asset(&usdc.address()), Some(sy_blend_id.clone()));
    assert_eq!(
        factory.get_market_by_pool(&pool_s).unwrap().sy,
        sy_slender_id
    );

    // Duplicate (usdc, mat_60) rejected (#25 MarketAlreadyExists)
    assert_eq!(
        factory.try_register_market(
            &admin,
            &Address::generate(&env),
            &sy_slender_id,
            &pt_s,
            &yt_s,
            &usdc.address(),
            &mat_60,
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::MarketAlreadyExists))
    );

    // Seed Slender target pool & user Blend 30D PT
    usdc_admin.mint(&admin, &6_000_000_000);
    sy_slender.deposit(&admin, &admin, &6_000_000_000);
    pool_s_client.mint_py(&admin, &admin, &3_000_000_000, &mat_60);
    pool_s_client.add_liquidity(&admin, &admin, &3_000_000_000, &2_000_000_000, &1);

    let pt_amt = 120_000_000i128;
    usdc_admin.mint(&user, &pt_amt);
    sy_blend.deposit(&user, &user, &pt_amt);
    pool_b_client.mint_py(&user, &user, &pt_amt, &mat_30);

    // Unequal rates: Blend 1.20, Slender 1.05
    blend.set_b_rate(&1_200_000_000);
    slender.set_liquidity_index(&1_050_000_000);

    env.ledger().set_timestamp(mat_30 + 100);
    let now2 = env.ledger().timestamp();

    // DeadlineExpired (#10)
    assert_eq!(
        factory.try_rollover_to_pt(&user, &receiver, &pool_b, &pool_s, &pt_amt, &1, &(now2 - 1)),
        Err(Ok(ContractError::DeadlineExpired))
    );

    // Simulate 100% Blend utilization (illiquid source pool) -> atomic rollback, user retains PT
    let blend_usdc = usdc_client.balance(&blend_id);
    let temp_drain = Address::generate(&env);
    usdc_client.transfer(&blend_id, &temp_drain, &blend_usdc);
    assert!(factory
        .try_rollover_to_pt(&user, &receiver, &pool_b, &pool_s, &pt_amt, &1, &(now2 + 100))
        .is_err());
    assert_eq!(PrincipalTokenClient::new(&env, &pt_b).balance(&user), pt_amt);

    // Restore Blend liquidity -> slippage guard (#9) -> then success with scoped MockAuth
    usdc_client.transfer(&temp_drain, &blend_id, &blend_usdc);
    assert_eq!(
        factory.try_rollover_to_pt(
            &user,
            &receiver,
            &pool_b,
            &pool_s,
            &pt_amt,
            &1_000_000_000,
            &(now2 + 100),
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    let dl = now2 + 100;
    let sub_redeem = MockAuthInvoke {
        contract: &pool_b,
        fn_name: "redeem_pt_post_maturity",
        args: (user.clone(), factory_id.clone(), pt_amt).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &user,
        invoke: &MockAuthInvoke {
            contract: &factory_id,
            fn_name: "rollover_to_pt",
            args: (
                user.clone(),
                receiver.clone(),
                pool_b.clone(),
                pool_s.clone(),
                pt_amt,
                1i128,
                dl,
            )
                .into_val(&env),
            sub_invokes: &[sub_redeem],
        },
    }]);

    env.cost_estimate().disable_resource_limits();
    let (target_sy, pt_out) =
        factory.rollover_to_pt(&user, &receiver, &pool_b, &pool_s, &pt_amt, &1, &dl);
    assert_eq!(target_sy, 114_285_714);
    assert!(pt_out > 0);
    assert_eq!(PrincipalTokenClient::new(&env, &pt_s).balance(&receiver), pt_out);
    assert_eq!(usdc_client.balance(&factory_id), 0);
    assert_eq!(sy_blend.balance(&factory_id), 0);
    assert_eq!(sy_slender.balance(&factory_id), 0);
}

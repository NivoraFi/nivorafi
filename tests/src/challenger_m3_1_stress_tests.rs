#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::{
    MarketFactoryClient, MockBlendClient, PrivilegedTokenClient, StandardizedYieldClient,
    YieldMarketClient, YieldTokenClient,
};
use market_factory::MarketFactory;
use mock_blend::MockBlend;
use pt_token::PrincipalToken;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, BytesN, Env, String};
use sy_blend_wrapper::StandardizedYield;
use yield_pool::YieldPool;
use yt_token::YieldToken;

#[allow(dead_code)]
struct ChallengerM3Fixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    user1: Address,
    user2: Address,
    user3: Address,
    receiver: Address,
    attacker: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    xlm_admin_client: token::StellarAssetClient<'a>,
    xlm_client: token::Client<'a>,
    blend_client: MockBlendClient<'a>,
    sy_usdc_client: StandardizedYieldClient<'a>,
    sy_xlm_client: StandardizedYieldClient<'a>,
    factory_client: MarketFactoryClient<'a>,
    pool_30d: Address,
    pool_90d: Address,
    pool_180d: Address,
    pool_360d: Address,
    pt_30d: Address,
    pt_90d: Address,
    pt_180d: Address,
    pt_360d: Address,
    yt_30d: Address,
    yt_90d: Address,
    yt_180d: Address,
    yt_360d: Address,
    pool_xlm_90d: Address,
    maturity_30d: u64,
    maturity_90d: u64,
    maturity_180d: u64,
    maturity_360d: u64,
}

fn setup_challenger_m3_fixture<'a>() -> ChallengerM3Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let user3 = Address::generate(&env);
    let receiver = Address::generate(&env);
    let attacker = Address::generate(&env);

    // USDC Asset
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // XLM Asset
    let xlm = env.register_stellar_asset_contract_v2(token_admin);
    let xlm_client = token::Client::new(&env, &xlm.address());
    let xlm_admin_client = token::StellarAssetClient::new(&env, &xlm.address());

    // Mock Blend
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    // Canonical SY USDC
    let sy_usdc_id = env.register(StandardizedYield, ());
    let sy_usdc_client = StandardizedYieldClient::new(&env, &sy_usdc_id);
    sy_usdc_client.initialize(&admin, &usdc.address(), &blend_id);

    // Canonical SY XLM
    let sy_xlm_id = env.register(StandardizedYield, ());
    let sy_xlm_client = StandardizedYieldClient::new(&env, &sy_xlm_id);
    sy_xlm_client.initialize(&admin, &xlm.address(), &blend_id);

    // Factory
    let pt_wasm = BytesN::from_array(&env, &[1u8; 32]);
    let yt_wasm = BytesN::from_array(&env, &[2u8; 32]);
    let pool_wasm = BytesN::from_array(&env, &[3u8; 32]);
    let sy_wasm = BytesN::from_array(&env, &[4u8; 32]);

    let factory_id = env.register(MarketFactory, ());
    let factory_client = MarketFactoryClient::new(&env, &factory_id);
    factory_client.initialize(&admin, &guardian, &pt_wasm, &yt_wasm, &pool_wasm, &sy_wasm);

    let now = env.ledger().timestamp();
    let maturity_30d = now + 30 * 86400;
    let maturity_90d = now + 90 * 86400;
    let maturity_180d = now + 180 * 86400;
    let maturity_360d = now + 360 * 86400;

    let deploy_pool = |maturity: u64, name_suffix: &str| -> (Address, Address, Address) {
        let pool = env.register(YieldPool, ());
        let pt = env.register(PrincipalToken, ());
        let yt = env.register(YieldToken, ());

        let pt_client = PrivilegedTokenClient::new(&env, &pt);
        pt_client.initialize(
            &admin,
            &pool,
            &String::from_str(&env, "Pendle PT"),
            &String::from_str(&env, name_suffix),
            &7u32,
            &maturity,
        );

        let yt_client = YieldTokenClient::new(&env, &yt);
        yt_client.initialize(
            &admin,
            &pool,
            &sy_usdc_id,
            &String::from_str(&env, "Pendle YT"),
            &String::from_str(&env, name_suffix),
            &7u32,
            &maturity,
        );

        let pool_client = YieldMarketClient::new(&env, &pool);
        pool_client.initialize(&admin, &sy_usdc_id, &pt, &yt, &maturity, &(20 * WAD), &WAD);

        (pool, pt, yt)
    };

    let (pool_30d, pt_30d, yt_30d) = deploy_pool(maturity_30d, "30D");
    let (pool_90d, pt_90d, yt_90d) = deploy_pool(maturity_90d, "90D");
    let (pool_180d, pt_180d, yt_180d) = deploy_pool(maturity_180d, "180D");
    let (pool_360d, pt_360d, yt_360d) = deploy_pool(maturity_360d, "360D");

    factory_client.register_market(
        &admin,
        &pool_30d,
        &sy_usdc_id,
        &pt_30d,
        &yt_30d,
        &usdc.address(),
        &maturity_30d,
        &(20 * WAD),
        &WAD,
    );

    factory_client.register_market(
        &admin,
        &pool_90d,
        &sy_usdc_id,
        &pt_90d,
        &yt_90d,
        &usdc.address(),
        &maturity_90d,
        &(20 * WAD),
        &WAD,
    );

    factory_client.register_market(
        &admin,
        &pool_180d,
        &sy_usdc_id,
        &pt_180d,
        &yt_180d,
        &usdc.address(),
        &maturity_180d,
        &(20 * WAD),
        &WAD,
    );

    factory_client.register_market(
        &admin,
        &pool_360d,
        &sy_usdc_id,
        &pt_360d,
        &yt_360d,
        &usdc.address(),
        &maturity_360d,
        &(20 * WAD),
        &WAD,
    );

    // XLM pool for cross-asset isolation tests
    let pool_xlm_90d = env.register(YieldPool, ());
    let pt_xlm_90d = env.register(PrincipalToken, ());
    let yt_xlm_90d = env.register(YieldToken, ());

    let pt_xlm_client = PrivilegedTokenClient::new(&env, &pt_xlm_90d);
    pt_xlm_client.initialize(
        &admin,
        &pool_xlm_90d,
        &String::from_str(&env, "Pendle PT XLM"),
        &String::from_str(&env, "PT-XLM-90D"),
        &7u32,
        &maturity_90d,
    );

    let yt_xlm_client = YieldTokenClient::new(&env, &yt_xlm_90d);
    yt_xlm_client.initialize(
        &admin,
        &pool_xlm_90d,
        &sy_xlm_id,
        &String::from_str(&env, "Pendle YT XLM"),
        &String::from_str(&env, "YT-XLM-90D"),
        &7u32,
        &maturity_90d,
    );

    let pool_xlm_client = YieldMarketClient::new(&env, &pool_xlm_90d);
    pool_xlm_client.initialize(
        &admin,
        &sy_xlm_id,
        &pt_xlm_90d,
        &yt_xlm_90d,
        &maturity_90d,
        &(20 * WAD),
        &WAD,
    );

    factory_client.register_market(
        &admin,
        &pool_xlm_90d,
        &sy_xlm_id,
        &pt_xlm_90d,
        &yt_xlm_90d,
        &xlm.address(),
        &maturity_90d,
        &(20 * WAD),
        &WAD,
    );

    ChallengerM3Fixture {
        env,
        admin,
        guardian,
        user1,
        user2,
        user3,
        receiver,
        attacker,
        usdc_admin_client,
        usdc_client,
        xlm_admin_client,
        xlm_client,
        blend_client,
        sy_usdc_client,
        sy_xlm_client,
        factory_client,
        pool_30d,
        pool_90d,
        pool_180d,
        pool_360d,
        pt_30d,
        pt_90d,
        pt_180d,
        pt_360d,
        yt_30d,
        yt_90d,
        yt_180d,
        yt_360d,
        pool_xlm_90d,
        maturity_30d,
        maturity_90d,
        maturity_180d,
        maturity_360d,
    }
}

// =============================================================================
// 1. MATHEMATICAL SOLVENCY & VARIED HAIRCUT RATES (0%, 10%, 25%, 50%, 99%, 100%)
// =============================================================================

#[test]
fn test_stress_haircut_0_percent_full_solvency_rollover_pt_and_py() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128; // 100 USDC

    // 1. User deposits into 30D pool
    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 2. LP provides liquidity in 90D pool
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Advance past 30D maturity (day 35)
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Haircut is 0% (vault has 100% of PT supply)
    // Rollover 50 USDC to PT, 50 USDC to PY
    let pt_client_30d = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_client_90d = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_client_90d = YieldTokenClient::new(&f.env, &f.yt_90d);

    // Rollover to PT (50 USDC)
    let (sy_payout_pt, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &50_000_000,
        &1,
    );
    assert_eq!(sy_payout_pt, 50_000_000);
    assert!(pt_out > 0);
    assert_eq!(pt_client_90d.balance(&f.user1), pt_out);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);

    // Rollover to PY (remaining 50 USDC)
    let (sy_payout_py, py_out) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &50_000_000,
        &50_000_000,
    );
    assert_eq!(sy_payout_py, 50_000_000);
    assert_eq!(py_out, 50_000_000);
    assert_eq!(yt_client_90d.balance(&f.user1), 50_000_000);
    assert_eq!(pt_client_30d.balance(&f.user1), 0);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_haircut_10_percent_proportional_propagation() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 10% bad debt: burn 10,000,000 SY from 30D pool vault
    f.sy_usdc_client.burn(&f.pool_30d, &10_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 90_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Slippage violation test for rollover_to_py: min_new_shares 90_000_001 must fail
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &90_000_001,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    // Exact slippage 90_000_000 must succeed
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &90_000_000,
    );
    assert_eq!(sy_payout, 90_000_000);
    assert_eq!(py_minted, 90_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_haircut_25_percent_proportional_propagation() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 25% bad debt: burn 25,000,000 SY from 30D pool vault
    f.sy_usdc_client.burn(&f.pool_30d, &25_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 75_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 25% haircut means 75% recovery
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &75_000_001,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &75_000_000,
    );
    assert_eq!(sy_payout, 75_000_000);
    assert_eq!(py_minted, 75_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_haircut_50_percent_severe_bad_debt() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 50% bad debt: burn 50,000,000 SY from 30D pool vault
    f.sy_usdc_client.burn(&f.pool_30d, &50_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 50_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &50_000_001,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &50_000_000,
    );
    assert_eq!(sy_payout, 50_000_000);
    assert_eq!(py_minted, 50_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_haircut_99_percent_extreme_haircut() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 99% bad debt: burn 99,000,000 SY from 30D pool vault, leaving only 1,000,000 SY
    f.sy_usdc_client.burn(&f.pool_30d, &99_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 1_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Only 1% (1,000,000 SY) remains
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1_000_001,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1_000_000,
    );
    assert_eq!(sy_payout, 1_000_000);
    assert_eq!(py_minted, 1_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_haircut_100_percent_total_vault_drain_atomic_reversion() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // 100% bad debt: burn entire 100,000,000 SY from vault
    f.sy_usdc_client.burn(&f.pool_30d, &user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 0);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Both rollover_to_pt and rollover_to_py must reject with ZeroAmount
    let res_py = f.factory_client.try_rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res_py, Err(Ok(ContractError::ZeroAmount)));

    let res_pt = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res_pt, Err(Ok(ContractError::ZeroAmount)));

    // ATOMIC ROLLBACK: User still possesses all 100M 30D PT tokens!
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// =============================================================================
// 2. MULTI-USER PROPORTIONALITY & ORDER-INVARIANCE UNDER BAD DEBT
// =============================================================================

#[test]
fn test_stress_multi_user_haircut_order_invariance() {
    let f = setup_challenger_m3_fixture();
    let amount_user1 = 60_000_000i128; // 60%
    let amount_user2 = 40_000_000i128; // 40%
    let total_amount = amount_user1 + amount_user2; // 100 USDC

    // User1 deposits 60 USDC, User2 deposits 40 USDC in 30D
    f.usdc_admin_client.mint(&f.user1, &amount_user1);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &amount_user1);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &amount_user1);

    f.usdc_admin_client.mint(&f.user2, &amount_user2);
    f.sy_usdc_client.deposit(&f.user2, &f.user2, &amount_user2);
    pool_30d_client.mint_py(&f.user2, &f.user2, &amount_user2);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.total_supply(), total_amount);

    // 30% bad debt: 30 USDC destroyed, 70 USDC remains in vault
    f.sy_usdc_client.burn(&f.pool_30d, &30_000_000);
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 70_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User1 rolls over first (60M PT * 0.7 = 42M SY payout)
    let (payout1, py1) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &amount_user1,
        &42_000_000,
    );
    assert_eq!(payout1, 42_000_000);
    assert_eq!(py1, 42_000_000);

    // Check intermediate state: vault balance is 70M - 42M = 28M SY; remaining PT supply = 40M
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 28_000_000);
    assert_eq!(pt_30d_client.total_supply(), amount_user2);

    // User2 rolls over second: 28M / 40M = exactly 70% haircut maintained!
    let (payout2, py2) = f.factory_client.rollover_to_py(
        &f.user2,
        &f.user2,
        &f.pool_30d,
        &f.pool_90d,
        &amount_user2,
        &28_000_000,
    );
    assert_eq!(payout2, 28_000_000);
    assert_eq!(py2, 28_000_000);

    // Exact depletion & zero residual balances
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), 0);
    assert_eq!(pt_30d_client.total_supply(), 0);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// =============================================================================
// 3. ATOMIC ROLLBACK & STATE NON-MUTATION MATRIX
// =============================================================================

#[test]
fn test_stress_atomic_rollback_on_pt_slippage_violation() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Provision 90D liquidity
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let initial_user_pt = 100_000_000i128;
    let initial_pool30_sy = f.sy_usdc_client.balance(&f.pool_30d);
    let initial_pool90_sy = f.sy_usdc_client.balance(&f.pool_90d);

    // Request impossible PT amount (e.g., 1,000,000,000 PT)
    let impossible_min = 1_000_000_000_000i128;
    let res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &impossible_min,
    );
    assert_eq!(res, Err(Ok(ContractError::SlippageExceeded)));

    // STRICT INVARIANTS:
    // 1. User PT 30D balance is completely untouched
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), initial_user_pt);

    // 2. Target 90D PT balance is zero
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

    // 3. Pool 30D SY balance is untouched
    assert_eq!(f.sy_usdc_client.balance(&f.pool_30d), initial_pool30_sy);

    // 4. Pool 90D SY balance is untouched
    assert_eq!(f.sy_usdc_client.balance(&f.pool_90d), initial_pool90_sy);

    // 5. Factory router SY balance is strictly zero
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_atomic_rollback_on_insufficient_pt_balance() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 50_000_000i128; // User only has 50 USDC PT

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User attempts to rollover 100 USDC PT (more than balance)
    let res = f.factory_client.try_rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &100_000_000,
        &1,
    );
    assert_eq!(res, Err(Ok(ContractError::InsufficientBalance)));

    // User's balance remains 50M
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_atomic_rollback_on_premature_source_maturity() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Time is still BEFORE 30D maturity
    let res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res, Err(Ok(ContractError::MarketNotYetMatured)));

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_atomic_rollback_on_expired_target_maturity() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Fast-forward beyond 90D maturity
    f.env.ledger().set_timestamp(f.maturity_90d + 10 * 86400);

    // Rolling over to an already-matured target pool must fail
    let res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res, Err(Ok(ContractError::MarketAlreadyMatured)));

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_atomic_rollback_on_identical_source_and_target() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_30d,
        &user_amount,
        &1,
    );
    assert_eq!(res, Err(Ok(ContractError::IdenticalAddresses)));
}

#[test]
fn test_stress_atomic_rollback_on_unregistered_markets() {
    let f = setup_challenger_m3_fixture();
    let fake_pool = Address::generate(&f.env);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let res1 = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &fake_pool,
        &f.pool_90d,
        &100_000,
        &1,
    );
    assert_eq!(res1, Err(Ok(ContractError::MarketNotFound)));

    let res2 = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &fake_pool,
        &100_000,
        &1,
    );
    assert_eq!(res2, Err(Ok(ContractError::MarketNotFound)));
}

#[test]
fn test_stress_atomic_rollback_on_zero_and_negative_amounts() {
    let f = setup_challenger_m3_fixture();
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &0, &1,),
        Err(Ok(ContractError::ZeroAmount))
    );

    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &-100,
            &1,
        ),
        Err(Ok(ContractError::ZeroAmount))
    );

    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &100,
            &-1,
        ),
        Err(Ok(ContractError::ZeroAmount))
    );

    assert_eq!(
        f.factory_client
            .try_rollover_to_py(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &0, &1,),
        Err(Ok(ContractError::ZeroAmount))
    );

    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &100,
            &-1,
        ),
        Err(Ok(ContractError::ZeroAmount))
    );
}

// =============================================================================
// 4. CONSECUTIVE FOUR-STAGE CASCADING ROLLOVERS (30D -> 90D -> 180D -> 360D)
// =============================================================================

#[test]
fn test_stress_consecutive_four_stage_rollovers_30d_90d_180d_360d() {
    let f = setup_challenger_m3_fixture();
    let initial_amount = 100_000_000i128; // 100 USDC

    // 1. User deposits into 30D pool
    f.usdc_admin_client.mint(&f.user1, &initial_amount);
    f.sy_usdc_client
        .deposit(&f.user1, &f.user1, &initial_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &initial_amount);

    // 2. Provision liquidity in 90D, 180D, 360D pools
    let lp_seed = 30_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);

    let seed_pool = |pool_addr: &Address| {
        let pool_c = YieldMarketClient::new(&f.env, pool_addr);
        pool_c.mint_py(&f.admin, &f.admin, &4_000_000_000);
        pool_c.add_liquidity(&f.admin, &f.admin, &4_000_000_000, &3_000_000_000, &1);
    };
    seed_pool(&f.pool_90d);
    seed_pool(&f.pool_180d);
    seed_pool(&f.pool_360d);

    let pt_30d_c = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_90d_c = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let pt_180d_c = PrivilegedTokenClient::new(&f.env, &f.pt_180d);
    let pt_360d_c = PrivilegedTokenClient::new(&f.env, &f.pt_360d);
    let yt_360d_c = YieldTokenClient::new(&f.env, &f.yt_360d);

    // STAGE 1: Day 35 -> 30D matures -> rollover to 90D PT
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let (sy1, pt_90d_amt) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &initial_amount,
        &1,
    );
    assert_eq!(sy1, initial_amount);
    assert!(pt_90d_amt > 0);
    assert_eq!(pt_30d_c.balance(&f.user1), 0);
    assert_eq!(pt_90d_c.balance(&f.user1), pt_90d_amt);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);

    // STAGE 2: Day 95 -> 90D matures -> rollover to 180D PT
    f.env.ledger().set_timestamp(f.maturity_90d + 5 * 86400);
    let (sy2, pt_180d_amt) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_90d,
        &f.pool_180d,
        &pt_90d_amt,
        &1,
    );
    assert_eq!(sy2, pt_90d_amt);
    assert!(pt_180d_amt > 0);
    assert_eq!(pt_90d_c.balance(&f.user1), 0);
    assert_eq!(pt_180d_c.balance(&f.user1), pt_180d_amt);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);

    // STAGE 3: Day 185 -> 180D matures -> rollover to 360D PY (minting PT + YT)
    f.env.ledger().set_timestamp(f.maturity_180d + 5 * 86400);
    let (sy3, py_360d_amt) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_180d,
        &f.pool_360d,
        &pt_180d_amt,
        &pt_180d_amt,
    );
    assert_eq!(sy3, pt_180d_amt);
    assert_eq!(py_360d_amt, pt_180d_amt);
    assert_eq!(pt_180d_c.balance(&f.user1), 0);
    assert_eq!(pt_360d_c.balance(&f.user1), py_360d_amt);
    assert_eq!(yt_360d_c.balance(&f.user1), py_360d_amt);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);

    // STAGE 4: Day 365 -> 360D matures -> direct redemption of final PT
    f.env.ledger().set_timestamp(f.maturity_360d + 5 * 86400);
    let pool_360d_c = YieldMarketClient::new(&f.env, &f.pool_360d);
    let final_sy = pool_360d_c.redeem_pt_post_maturity(&f.user1, &f.user1, &py_360d_amt);
    assert_eq!(final_sy, py_360d_amt);
    assert_eq!(pt_360d_c.balance(&f.user1), 0);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// =============================================================================
// 5. RECEIVER REDIRECTION & SEPARATION OF CALLER AND RECEIVER
// =============================================================================

#[test]
fn test_stress_rollover_with_third_party_receiver() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User1 rolls over to PT, designating 'receiver' as beneficiary
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);

    let (sy_payout, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.receiver,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );

    assert_eq!(sy_payout, user_amount);
    assert!(pt_out > 0);

    // User1's 30D PT burned, User1 receives 0 90D PT
    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

    // Designated receiver receives all 90D PT
    assert_eq!(pt_90d_client.balance(&f.receiver), pt_out);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_rollover_to_py_with_third_party_receiver() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_90d_client = YieldTokenClient::new(&f.env, &f.yt_90d);

    // User1 rolls over to PY with third-party receiver
    let (sy_payout, py_out) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.receiver,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &user_amount,
    );

    assert_eq!(sy_payout, user_amount);
    assert_eq!(py_out, user_amount);

    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);
    assert_eq!(yt_90d_client.balance(&f.user1), 0);

    // Receiver got PT + YT
    assert_eq!(pt_90d_client.balance(&f.receiver), user_amount);
    assert_eq!(yt_90d_client.balance(&f.receiver), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// =============================================================================
// 6. STRAY TOKEN SWEEP & ZERO RESIDUAL INVARIANT
// =============================================================================

#[test]
fn test_stress_factory_stray_token_sweep_to_receiver() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Simulate accidental transfer of 777_777 SY directly to factory router
    let stray_sy = 777_777i128;
    f.usdc_admin_client.mint(&f.admin, &stray_sy);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &stray_sy);
    f.sy_usdc_client
        .transfer(&f.admin, &f.factory_client.address, &stray_sy);
    assert_eq!(
        f.sy_usdc_client.balance(&f.factory_client.address),
        stray_sy
    );

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Initial receiver SY balance is 0
    assert_eq!(f.sy_usdc_client.balance(&f.receiver), 0);

    // User executes rollover_to_py with receiver
    let (_sy, _py) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.receiver,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &user_amount,
    );

    // Residual SY was swept to receiver, leaving factory with 0
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
    assert_eq!(f.sy_usdc_client.balance(&f.receiver), stray_sy);
}

// =============================================================================
// 7. PAUSE GUARDIAN AND ACCESS CONTROL MATRIX
// =============================================================================

#[test]
fn test_stress_pause_guardian_rollover_rejection_and_atomic_resume() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Guardian pauses factory
    f.factory_client.pause(&f.guardian);
    assert!(f.factory_client.is_paused());

    // Both rollovers reject with ContractPaused
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // Admin unpauses
    f.factory_client.unpause(&f.admin);
    assert!(!f.factory_client.is_paused());

    // Rollover immediately succeeds
    let (sy, py) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &user_amount,
    );
    assert_eq!(sy, user_amount);
    assert_eq!(py, user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}


// =============================================================================
// 8. EXACT 1-STROOP SLIPPAGE BOUNDARIES & AMM CAPACITY LIMITS
// =============================================================================

#[test]
fn test_stress_exact_1_stroop_slippage_precision_rollover_to_pt() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 1. Dry-run query: what would exact_sy_for_pt produce?
    // Using min_target_pt = 1 to find out actual pt_out
    // First test that min_target_pt = 500M fails
    let fail_res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &500_000_000,
    );
    assert_eq!(fail_res, Err(Ok(ContractError::SlippageExceeded)));

    // User's balance was completely protected
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);

    // Now execute with min_target_pt = 1
    let (sy_payout, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
    );
    assert_eq!(sy_payout, user_amount);
    assert!(pt_out > 0);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_rollover_target_pool_amm_proportion_rejection_and_atomic_rollback() {
    let f = setup_challenger_m3_fixture();

    // Pool 90D initialized with small liquidity
    let lp_seed = 200_000_000i128; // Only 200 USDC
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &100_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &100_000_000, &80_000_000, &1);

    // User has a massive 50,000 USDC position in 30D pool
    let massive_user_amount = 50_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &massive_user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &massive_user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &massive_user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Attempting to swap 50,000 USDC into a pool with 100 USDC liquidity must fail due to
    // insufficient liquidity / proportion boundaries in target AMM
    let res = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &massive_user_amount,
        &1,
    );
    assert!(res.is_err(), "Massive swap beyond AMM capacity must fail");

    // ATOMIC ROLLBACK: User's 50,000 USDC PT is 100% preserved!
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), massive_user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_cross_asset_rollover_isolation_atomic_rollback() {
    let f = setup_challenger_m3_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Rollover from USDC to XLM pool must reject with InvalidAsset
    let res_pt = f.factory_client.try_rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_xlm_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res_pt, Err(Ok(ContractError::InvalidAsset)));

    let res_py = f.factory_client.try_rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_xlm_90d,
        &user_amount,
        &1,
    );
    assert_eq!(res_py, Err(Ok(ContractError::InvalidAsset)));

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_stress_unauthorized_attacker_cannot_rollover_victim_tokens() {
    let f = setup_challenger_m3_fixture();
    let victim_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &victim_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &victim_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &victim_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Attacker calls rollover_to_pt with attacker as caller, trying to burn victim's tokens or get target PT
    let res = f.factory_client.try_rollover_to_pt(
        &f.attacker,
        &f.attacker,
        &f.pool_30d,
        &f.pool_90d,
        &victim_amount,
        &1,
    );
    assert_eq!(res, Err(Ok(ContractError::InsufficientBalance)));

    // Victim's PT balance remains untouched
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), victim_amount);
    assert_eq!(pt_30d_client.balance(&f.attacker), 0);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

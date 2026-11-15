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
struct MultiMarketFixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    user1: Address,
    user2: Address,
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
    pt_30d: Address,
    pt_90d: Address,
    pt_180d: Address,
    yt_30d: Address,
    yt_90d: Address,
    yt_180d: Address,
    pool_xlm_90d: Address,
    maturity_30d: u64,
    maturity_90d: u64,
    maturity_180d: u64,
}

fn setup_multi_market_fixture<'a>() -> MultiMarketFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    // Tokens: USDC and XLM
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    let xlm = env.register_stellar_asset_contract_v2(token_admin);
    let xlm_client = token::Client::new(&env, &xlm.address());
    let xlm_admin_client = token::StellarAssetClient::new(&env, &xlm.address());

    // Mock Blend
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    // Canonical SY for USDC
    let sy_usdc_id = env.register(StandardizedYield, ());
    let sy_usdc_client = StandardizedYieldClient::new(&env, &sy_usdc_id);
    sy_usdc_client.initialize(&admin, &usdc.address(), &blend_id);

    // Canonical SY for XLM
    let sy_xlm_id = env.register(StandardizedYield, ());
    let sy_xlm_client = StandardizedYieldClient::new(&env, &sy_xlm_id);
    sy_xlm_client.initialize(&admin, &xlm.address(), &blend_id);

    // Market Factory
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

    // Helper to deploy a pool
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

    // Register USDC pools in factory
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

    // Deploy an XLM 90D pool for cross-asset tests
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

    MultiMarketFixture {
        env,
        admin,
        guardian,
        user1,
        user2,
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
        pt_30d,
        pt_90d,
        pt_180d,
        yt_30d,
        yt_90d,
        yt_180d,
        pool_xlm_90d,
        maturity_30d,
        maturity_90d,
        maturity_180d,
    }
}

// 1. Multi-Market Deployment & Registry Invariants
#[test]
fn test_multi_market_deployment_and_registry_invariants() {
    let f = setup_multi_market_fixture();

    assert_eq!(f.factory_client.market_count(), 4);

    // Verify all 3 USDC markets share the canonical SY vault
    let m0 = f.factory_client.get_market(&0);
    let m1 = f.factory_client.get_market(&1);
    let m2 = f.factory_client.get_market(&2);
    let m3 = f.factory_client.get_market(&3);

    assert_eq!(m0.asset, f.usdc_client.address);
    assert_eq!(m1.asset, f.usdc_client.address);
    assert_eq!(m2.asset, f.usdc_client.address);

    assert_eq!(m0.sy, f.sy_usdc_client.address);
    assert_eq!(m1.sy, f.sy_usdc_client.address);
    assert_eq!(m2.sy, f.sy_usdc_client.address);

    // Market 3 is XLM
    assert_eq!(m3.asset, f.xlm_client.address);
    assert_eq!(m3.sy, f.sy_xlm_client.address);

    // Dual indexing lookups
    let by_key = f
        .factory_client
        .get_market_by_asset_maturity(&f.usdc_client.address, &f.maturity_90d);
    assert_eq!(by_key, Some(m1.clone()));

    let by_pool = f.factory_client.get_market_by_pool(&f.pool_180d);
    assert_eq!(by_pool, Some(m2));

    // Gas-bounded pagination
    let page = f.factory_client.list_markets(&0, &10);
    assert_eq!(page.len(), 4);
    assert_eq!(page.get(0).unwrap().id, 0);
    assert_eq!(page.get(1).unwrap().id, 1);
    assert_eq!(page.get(2).unwrap().id, 2);
    assert_eq!(page.get(3).unwrap().id, 3);
}

// 2. End-to-End Lifecycle: Mint, Trade, Mature & Rollover
#[test]
fn test_end_to_end_lifecycle_mint_trade_mature_rollover() {
    let f = setup_multi_market_fixture();
    let user_amount = 100_000_000i128; // 100 USDC

    // 1. User deposits USDC into SY, mints 100 30D PT + YT
    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);

    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);

    // 2. LP provisions liquidity in 90D pool (positive yield: 3,000 PT + 2,000 SY)
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Advance time past 30D maturity (day 35)
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 4. Rollover 30D PT into 90D PT via factory
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

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
    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), pt_out);

    // Invariant: zero residual SY in factory
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// 3. Consecutive Cascading Rollovers (30D -> 90D -> 180D)
#[test]
fn test_consecutive_cascading_rollovers() {
    let f = setup_multi_market_fixture();
    let initial_amount = 100_000_000i128;

    // 1. User deposits into 30D pool
    f.usdc_admin_client.mint(&f.user1, &initial_amount);
    f.sy_usdc_client
        .deposit(&f.user1, &f.user1, &initial_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &initial_amount);

    // 2. Provision liquidity in 90D and 180D pools
    let lp_seed = 12_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    let pool_180d_client = YieldMarketClient::new(&f.env, &f.pool_180d);
    pool_180d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_180d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Roll 1: Day 35, 30D matures -> roll into 90D PT
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let (_sy1, pt_90d_amount) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &initial_amount,
        &1,
    );
    assert!(pt_90d_amount > 0);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let pt_180d_client = PrivilegedTokenClient::new(&f.env, &f.pt_180d);

    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), pt_90d_amount);
    assert_eq!(pt_180d_client.balance(&f.user1), 0);

    // 4. Roll 2: Day 95, 90D matures -> roll into 180D PT
    f.env.ledger().set_timestamp(f.maturity_90d + 5 * 86400);

    let (_sy2, pt_180d_amount) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_90d,
        &f.pool_180d,
        &pt_90d_amount,
        &1,
    );
    assert!(pt_180d_amount > 0);

    assert_eq!(pt_90d_client.balance(&f.user1), 0);
    assert_eq!(pt_180d_client.balance(&f.user1), pt_180d_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// 4. Atomic Rollback on Slippage Violation
#[test]
fn test_atomic_rollback_on_target_pool_failure() {
    let f = setup_multi_market_fixture();
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

    // Unrealistic slippage bound triggers SlippageExceeded
    let unreasonable_min = 500_000_000_000i128;
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &unreasonable_min,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    // Invariant: User still owns full 30D PT, nothing lost
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

// 5. Bad Debt Haircut Proportional Rollover Allocation
#[test]
fn test_bad_debt_proportional_haircut_rollover() {
    let f = setup_multi_market_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Simulate 20% bad debt in 30D pool vault
    f.sy_usdc_client.burn(&f.pool_30d, &20_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User rolls over into 90D PY with 80% recovery limit
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &80_000_000,
    );

    assert_eq!(sy_payout, 80_000_000);
    assert_eq!(py_minted, 80_000_000);

    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_90d_client = YieldTokenClient::new(&f.env, &f.yt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 80_000_000);
    assert_eq!(yt_90d_client.balance(&f.user1), 80_000_000);
}

// 6. Cross-Asset Isolation and Rejection
#[test]
fn test_cross_asset_isolation_and_rejection() {
    let f = setup_multi_market_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Attempting rollover from USDC pool to XLM pool fails with InvalidAsset
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_xlm_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::InvalidAsset))
    );
}

// 7. Factory Governance Emergency Pause Matrix
#[test]
fn test_factory_governance_emergency_pause_matrix() {
    let f = setup_multi_market_fixture();

    // Guardian pauses factory
    f.factory_client.pause(&f.guardian);
    assert!(f.factory_client.is_paused());

    // State mutations fail with ContractPaused
    let dummy_addr = Address::generate(&f.env);
    assert_eq!(
        f.factory_client.try_register_market(
            &f.admin,
            &dummy_addr,
            &f.sy_usdc_client.address,
            &f.pt_30d,
            &f.yt_30d,
            &f.usdc_client.address,
            &(f.env.ledger().timestamp() + 500 * 86400),
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1,),
        Err(Ok(ContractError::ContractPaused))
    );

    assert_eq!(
        f.factory_client
            .try_rollover_to_py(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1,),
        Err(Ok(ContractError::ContractPaused))
    );

    // Read queries continue to succeed cleanly
    assert_eq!(f.factory_client.market_count(), 4);
    assert!(f.factory_client.get_market(&0).is_active);
    assert_eq!(f.factory_client.list_markets(&0, &10).len(), 4);

    // Admin unpauses
    f.factory_client.unpause(&f.admin);
    assert!(!f.factory_client.is_paused());
}

// 8. Rollover to PY Zero Residual Invariant
#[test]
fn test_rollover_to_py_zero_residual_invariant() {
    let f = setup_multi_market_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &user_amount,
    );

    assert_eq!(sy_payout, user_amount);
    assert_eq!(py_minted, user_amount);

    // Factory balance must be strictly zero
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

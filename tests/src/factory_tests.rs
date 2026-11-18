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
    let dl1 = f.env.ledger().timestamp() + 3600;
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);

    // 2. LP provisions liquidity in 90D pool (positive yield: 3,000 PT + 2,000 SY)
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Advance time past 30D maturity (day 35)
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 4. Rollover 30D PT into 90D PT via factory
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

    let dl2 = f.env.ledger().timestamp() + 3600;
    let (sy_payout, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
        &dl2,
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
    let dl1 = f.env.ledger().timestamp() + 3600;
    pool_30d_client.mint_py(&f.user1, &f.user1, &initial_amount, &dl1);

    // 2. Provision liquidity in 90D and 180D pools
    let lp_seed = 12_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    let pool_180d_client = YieldMarketClient::new(&f.env, &f.pool_180d);
    pool_180d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_180d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Roll 1: Day 35, 30D matures -> roll into 90D PT
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    let (_sy1, pt_90d_amount) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &initial_amount,
        &1,
        &dl2,
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
    let dl3 = f.env.ledger().timestamp() + 3600;

    let (_sy2, pt_180d_amount) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_90d,
        &f.pool_180d,
        &pt_90d_amount,
        &1,
        &dl3,
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
    let dl1 = f.env.ledger().timestamp() + 3600;
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_usdc_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

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
            &dl2,
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
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Simulate 20% bad debt in 30D pool vault
    f.sy_usdc_client.burn(&f.pool_30d, &20_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    // User rolls over into 90D PY with 80% recovery limit
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &80_000_000,
        &dl2,
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
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    // Attempting rollover from USDC pool to XLM pool fails with InvalidAsset
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_xlm_90d,
            &user_amount,
            &1,
            &dl2,
        ),
        Err(Ok(ContractError::InvalidAsset))
    );
}

// 7. Factory Governance Emergency Pause Matrix
#[test]
fn test_factory_governance_emergency_pause_matrix() {
    let f = setup_multi_market_fixture();
    let dl = f.env.ledger().timestamp() + 3600;

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
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1, &dl),
        Err(Ok(ContractError::ContractPaused))
    );

    assert_eq!(
        f.factory_client
            .try_rollover_to_py(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1, &dl),
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
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_usdc_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &user_amount,
        &dl2,
    );

    assert_eq!(sy_payout, user_amount);
    assert_eq!(py_minted, user_amount);

    // Factory balance must be strictly zero
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

mod r1_f1_f2_f5_factory_tests {
    use common::errors::ContractError;
    use common::fixed_point::{SCALAR_9, WAD};
    use common::interfaces::{
        MarketFactoryClient, MockBlendClient, PrivilegedTokenClient, StandardizedYieldClient,
        YieldMarketClient, YieldTokenClient,
    };
    use market_factory::{MarketFactory, MarketFactoryClient as ConcreteFactoryClient};
    use mock_blend::MockBlend;
    use pt_token::PrincipalToken;
    use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{
        contract, contractimpl, symbol_short, token, Address, BytesN, Env, IntoVal, String, Symbol,
        Val, Vec,
    };
    use sy_blend_wrapper::StandardizedYield;
    use yield_pool::{YieldPool, YieldPoolClient};
    use yt_token::YieldToken;

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

        pub fn name(env: Env) -> String {
            Self::symbol(env)
        }
    }

    #[test]
    fn test_f1_creator_whitelist_auth_and_pre_mutation_validation() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(10_000);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let creator = Address::generate(&env);
        let stranger = Address::generate(&env);

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

        let asset = Address::generate(&env);
        let blend_pool = Address::generate(&env);
        let mat = 10_000 + 30 * 86400;

        // 1. Non-admin cannot modify whitelist
        assert_eq!(
            factory.try_set_creator_whitelist(&stranger, &creator, &true),
            Err(Ok(ContractError::Unauthorized))
        );
        assert!(!factory.is_whitelisted_creator(&creator));

        // 2. Unauthorized caller cannot call create_market & no state is mutated
        assert_eq!(
            factory.try_create_market(&stranger, &asset, &blend_pool, &mat, &(20 * WAD), &WAD),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(factory.market_count(), 0);
        assert_eq!(factory.get_sy_for_asset(&asset), None);

        // 3. Admin grants & revokes whitelist
        factory.set_creator_whitelist(&admin, &creator, &true);
        assert!(factory.is_whitelisted_creator(&creator));

        // 4. Pre-mutation validations for whitelisted creator
        assert_eq!(
            factory.try_create_market(&creator, &asset, &asset, &mat, &(20 * WAD), &WAD),
            Err(Ok(ContractError::IdenticalAddresses))
        );
        assert_eq!(
            factory.try_create_market(&creator, &asset, &blend_pool, &10_000, &(20 * WAD), &WAD),
            Err(Ok(ContractError::InvalidMaturity))
        );
        assert!(factory
            .try_create_market(&creator, &asset, &blend_pool, &mat, &0, &WAD)
            .is_err());
        assert!(factory
            .try_create_market(&creator, &asset, &blend_pool, &mat, &(20 * WAD), &0)
            .is_err());
        assert_eq!(factory.market_count(), 0);
        assert_eq!(factory.get_sy_for_asset(&asset), None);

        // Revoking removes access
        factory.set_creator_whitelist(&admin, &creator, &false);
        assert!(!factory.is_whitelisted_creator(&creator));
        assert_eq!(
            factory.try_create_market(&creator, &asset, &blend_pool, &mat, &(20 * WAD), &WAD),
            Err(Ok(ContractError::Unauthorized))
        );
    }

    #[test]
    fn test_f1_f2_real_wasm_create_market_scoped_auth_and_dynamic_metadata() {
        let env = Env::default();
        env.ledger().set_timestamp(1_700_000_000);

        let pt_bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/pt_token.wasm"
        ))
        .expect("pt_token.wasm missing — run stellar contract build --profile release first");
        let yt_bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/yt_token.wasm"
        ))
        .expect("yt_token.wasm missing");
        let pool_bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/yield_pool.wasm"
        ))
        .expect("yield_pool.wasm missing");
        let sy_bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/sy_blend_wrapper.wasm"
        ))
        .expect("sy_blend_wrapper.wasm missing");

        let pt_hash = env.deployer().upload_contract_wasm(pt_bytes.as_slice());
        let yt_hash = env.deployer().upload_contract_wasm(yt_bytes.as_slice());
        let pool_hash = env.deployer().upload_contract_wasm(pool_bytes.as_slice());
        let sy_hash = env.deployer().upload_contract_wasm(sy_bytes.as_slice());

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let creator = Address::generate(&env);

        let factory_id = env.register(MarketFactory, ());
        let factory = ConcreteFactoryClient::new(&env, &factory_id);

        env.mock_all_auths();
        factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);
        factory.set_creator_whitelist(&admin, &creator, &true);

        // Underlying #1: USDC (7 decimals)
        let usdc_id = env.register(MockMetaAsset, ());
        MockMetaAssetClient::new(&env, &usdc_id).init(&String::from_str(&env, "USDC"), &7);
        let blend_usdc = env.register(MockBlend, ());
        MockBlendClient::new(&env, &blend_usdc).initialize(&admin, &usdc_id, &SCALAR_9);

        // Underlying #2: native XLM (7 decimals)
        let xlm_id = env.register(MockMetaAsset, ());
        MockMetaAssetClient::new(&env, &xlm_id).init(&String::from_str(&env, "native"), &7);
        let blend_xlm = env.register(MockBlend, ());
        MockBlendClient::new(&env, &blend_xlm).initialize(&admin, &xlm_id, &SCALAR_9);

        let now = env.ledger().timestamp();
        let mat_30d = now + 30 * 86400;
        let mat_60d = now + 60 * 86400;

        // Clear mock_all_auths and supply SCOPED auth ONLY for non-admin creator on factory::create_market!
        let args_usdc: Vec<Val> = (
            creator.clone(),
            usdc_id.clone(),
            blend_usdc.clone(),
            mat_30d,
            20 * WAD,
            WAD,
        )
            .into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &factory_id,
                fn_name: "create_market",
                args: args_usdc,
                sub_invokes: &[],
            },
        }]);

        let m_usdc = factory.create_market(
            &creator,
            &usdc_id,
            &blend_usdc,
            &mat_30d,
            &(20 * WAD),
            &WAD,
        );
        let sy_usdc_id = factory.get_sy_for_asset(&usdc_id).unwrap();

        // Check F1: all deployed sub-contracts belong to factory's `admin` (NOT `creator`)
        let sy_usdc = StandardizedYieldClient::new(&env, &sy_usdc_id);
        let pt_usdc = PrivilegedTokenClient::new(&env, &m_usdc.pt);
        let yt_usdc = YieldTokenClient::new(&env, &m_usdc.yt);
        let pool_usdc = YieldMarketClient::new(&env, &m_usdc.pool);
        let pool_usdc_lp = YieldPoolClient::new(&env, &m_usdc.pool);

        assert_eq!(sy_usdc.get_admin(), admin);
        assert_eq!(pt_usdc.get_admin(), admin);
        assert_eq!(yt_usdc.get_admin(), admin);
        assert_eq!(pool_usdc.get_admin(), admin);
        assert_eq!(pool_usdc.get_market_state().fee_recipient, admin);

        // Check F2 dynamic metadata for USDC 30D
        assert_eq!(
            sy_usdc.name(),
            String::from_str(&env, "Standardized Yield Blend USDC")
        );
        assert_eq!(sy_usdc.symbol(), String::from_str(&env, "sy-bUSDC"));
        assert_eq!(sy_usdc.decimals(), 7);

        assert_eq!(pt_usdc.name(), String::from_str(&env, "PT USDC 30D"));
        assert_eq!(pt_usdc.symbol(), String::from_str(&env, "PT-USDC-30D"));
        assert_eq!(pt_usdc.decimals(), 7);

        assert_eq!(yt_usdc.name(), String::from_str(&env, "YT USDC 30D"));
        assert_eq!(yt_usdc.symbol(), String::from_str(&env, "YT-USDC-30D"));
        assert_eq!(yt_usdc.decimals(), 7);

        assert_eq!(
            pool_usdc_lp.name(),
            String::from_str(&env, "NivoraFi LP USDC")
        );
        assert_eq!(pool_usdc_lp.symbol(), String::from_str(&env, "LP-USDC"));
        assert_eq!(pool_usdc_lp.decimals(), 7);

        // Deploy 2nd market ("native" -> XLM, 60D) with creator scoped auth
        let args_xlm: Vec<Val> = (
            creator.clone(),
            xlm_id.clone(),
            blend_xlm.clone(),
            mat_60d,
            20 * WAD,
            WAD,
        )
            .into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &creator,
            invoke: &MockAuthInvoke {
                contract: &factory_id,
                fn_name: "create_market",
                args: args_xlm,
                sub_invokes: &[],
            },
        }]);
        let m_xlm = factory.create_market(
            &creator,
            &xlm_id,
            &blend_xlm,
            &mat_60d,
            &(20 * WAD),
            &WAD,
        );
        let sy_xlm_id = factory.get_sy_for_asset(&xlm_id).unwrap();

        let sy_xlm = StandardizedYieldClient::new(&env, &sy_xlm_id);
        let pt_xlm = PrivilegedTokenClient::new(&env, &m_xlm.pt);
        let yt_xlm = YieldTokenClient::new(&env, &m_xlm.yt);
        let pool_xlm_lp = YieldPoolClient::new(&env, &m_xlm.pool);

        assert_eq!(
            sy_xlm.name(),
            String::from_str(&env, "Standardized Yield Blend XLM")
        );
        assert_eq!(sy_xlm.symbol(), String::from_str(&env, "sy-bXLM"));
        assert_eq!(pt_xlm.name(), String::from_str(&env, "PT XLM 60D"));
        assert_eq!(pt_xlm.symbol(), String::from_str(&env, "PT-XLM-60D"));
        assert_eq!(yt_xlm.name(), String::from_str(&env, "YT XLM 60D"));
        assert_eq!(yt_xlm.symbol(), String::from_str(&env, "YT-XLM-60D"));
        assert_eq!(pool_xlm_lp.name(), String::from_str(&env, "NivoraFi LP XLM"));
        assert_eq!(pool_xlm_lp.symbol(), String::from_str(&env, "LP-XLM"));
    }

    #[test]
    fn test_f5_rollover_deadlines_and_boundary() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(10_000);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let lp_user = Address::generate(&env);
        let user = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(token_admin);
        let usdc_admin = token::StellarAssetClient::new(&env, &usdc.address());

        let blend_id = env.register(MockBlend, ());
        MockBlendClient::new(&env, &blend_id).initialize(&admin, &usdc.address(), &SCALAR_9);

        let sy_id = env.register(StandardizedYield, ());
        let sy_client = StandardizedYieldClient::new(&env, &sy_id);
        sy_client.initialize(&admin, &usdc.address(), &blend_id);

        let mat_30d = 10_000 + 30 * 86400;
        let mat_90d = 10_000 + 90 * 86400;

        let setup_pool = |mat: u64| -> (Address, Address, Address) {
            let pool = env.register(YieldPool, ());
            let pt = env.register(PrincipalToken, ());
            let yt = env.register(YieldToken, ());
            PrivilegedTokenClient::new(&env, &pt).initialize(
                &admin,
                &pool,
                &String::from_str(&env, "PT"),
                &String::from_str(&env, "PT"),
                &7,
                &mat,
            );
            YieldTokenClient::new(&env, &yt).initialize(
                &admin,
                &pool,
                &sy_id,
                &String::from_str(&env, "YT"),
                &String::from_str(&env, "YT"),
                &7,
                &mat,
            );
            YieldMarketClient::new(&env, &pool).initialize(
                &admin,
                &sy_id,
                &pt,
                &yt,
                &mat,
                &(20 * WAD),
                &WAD,
            );
            (pool, pt, yt)
        };

        let (pool_30d, pt_30d, yt_30d) = setup_pool(mat_30d);
        let (pool_90d, pt_90d, yt_90d) = setup_pool(mat_90d);

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
        factory.register_market(
            &admin,
            &pool_30d,
            &sy_id,
            &pt_30d,
            &yt_30d,
            &usdc.address(),
            &mat_30d,
            &(20 * WAD),
            &WAD,
        );
        factory.register_market(
            &admin,
            &pool_90d,
            &sy_id,
            &pt_90d,
            &yt_90d,
            &usdc.address(),
            &mat_90d,
            &(20 * WAD),
            &WAD,
        );

        let pool_30_c = YieldMarketClient::new(&env, &pool_30d);
        let pool_90_c = YieldMarketClient::new(&env, &pool_90d);
        let pt_30_c = PrivilegedTokenClient::new(&env, &pt_30d);
        let pt_90_c = PrivilegedTokenClient::new(&env, &pt_90d);
        let yt_90_c = YieldTokenClient::new(&env, &yt_90d);

        // Seed 90d LP liquidity with PT > SY (300B PT, 150B SY) so rollover_to_pt swap keeps PT >= SY
        usdc_admin.mint(&lp_user, &450_000_000_000);
        sy_client.deposit(&lp_user, &lp_user, &450_000_000_000);
        pool_90_c.mint_py(&lp_user, &lp_user, &300_000_000_000, &mat_90d);
        pool_90_c.add_liquidity(
            &lp_user,
            &lp_user,
            &300_000_000_000,
            &150_000_000_000,
            &1,
        );

        // User holds PT in 30d pool
        let user_amt = 20_000_000_000i128;
        usdc_admin.mint(&user, &user_amt);
        sy_client.deposit(&user, &user, &user_amt);
        pool_30_c.mint_py(&user, &user, &user_amt, &mat_30d);

        // Advance past 30d maturity
        env.ledger().set_timestamp(mat_30d + 10);
        let now = env.ledger().timestamp();
        let expired_dl = now - 1;
        let half = user_amt / 2;

        // Expired deadlines must fail with DeadlineExpired and zero PT burned
        assert_eq!(
            factory.try_rollover_to_pt(&user, &user, &pool_30d, &pool_90d, &half, &1, &expired_dl),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(
            factory.try_rollover_to_py(&user, &user, &pool_30d, &pool_90d, &half, &1, &expired_dl),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(pt_30_c.balance(&user), user_amt);

        // Exact boundary timestamp == deadline succeeds for both rollover_to_pt and rollover_to_py
        let (sy_redeemed_pt, out_pt) =
            factory.rollover_to_pt(&user, &user, &pool_30d, &pool_90d, &half, &1, &now);
        assert_eq!(sy_redeemed_pt, half);
        assert!(out_pt > 0);
        assert_eq!(pt_90_c.balance(&user), out_pt);

        let (sy_redeemed_py, py_minted) =
            factory.rollover_to_py(&user, &user, &pool_30d, &pool_90d, &half, &1, &now);
        assert_eq!(sy_redeemed_py, half);
        assert!(py_minted > 0);
        assert_eq!(yt_90_c.balance(&user), py_minted);
        assert_eq!(pt_90_c.balance(&user), out_pt + py_minted);
        assert_eq!(pt_30_c.balance(&user), 0);
    }
}

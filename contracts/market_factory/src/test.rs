use super::*;
use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::{
    MarketFactoryClient, MockBlendClient, PrivilegedTokenClient, StandardizedYieldClient,
    YieldMarketClient, YieldTokenClient,
};
use mock_blend::MockBlend;
use pt_token::PrincipalToken;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, BytesN, Env, String};
use sy_blend_wrapper::StandardizedYield;
use yield_pool::YieldPool;
use yt_token::YieldToken;

#[allow(dead_code)]
struct FactoryFixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    user1: Address,
    user2: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    blend_client: MockBlendClient<'a>,
    sy_client: StandardizedYieldClient<'a>,
    factory_client: MarketFactoryClient<'a>,
    pool_30d: Address,
    pool_90d: Address,
    pt_30d: Address,
    pt_90d: Address,
    yt_30d: Address,
    yt_90d: Address,
    maturity_30d: u64,
    maturity_90d: u64,
}

fn setup_factory_fixture<'a>() -> FactoryFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // 1. Mock Blend Pool
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    // 2. Canonical SY Blend Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    // 3. Market Factory
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

    // 4. Deploy 30D Pool
    let pool_30d = env.register(YieldPool, ());
    let pt_30d = env.register(PrincipalToken, ());
    let yt_30d = env.register(YieldToken, ());

    let pt_30d_client = PrivilegedTokenClient::new(&env, &pt_30d);
    pt_30d_client.initialize(
        &admin,
        &pool_30d,
        &String::from_str(&env, "Pendle PT 30D"),
        &String::from_str(&env, "PT-30D"),
        &7u32,
        &maturity_30d,
    );

    let yt_30d_client = YieldTokenClient::new(&env, &yt_30d);
    yt_30d_client.initialize(
        &admin,
        &pool_30d,
        &sy_id,
        &String::from_str(&env, "Pendle YT 30D"),
        &String::from_str(&env, "YT-30D"),
        &7u32,
        &maturity_30d,
    );

    let pool_30d_client = YieldMarketClient::new(&env, &pool_30d);
    pool_30d_client.initialize(
        &admin,
        &sy_id,
        &pt_30d,
        &yt_30d,
        &maturity_30d,
        &(20 * WAD),
        &WAD,
    );

    // 5. Deploy 90D Pool
    let pool_90d = env.register(YieldPool, ());
    let pt_90d = env.register(PrincipalToken, ());
    let yt_90d = env.register(YieldToken, ());

    let pt_90d_client = PrivilegedTokenClient::new(&env, &pt_90d);
    pt_90d_client.initialize(
        &admin,
        &pool_90d,
        &String::from_str(&env, "Pendle PT 90D"),
        &String::from_str(&env, "PT-90D"),
        &7u32,
        &maturity_90d,
    );

    let yt_90d_client = YieldTokenClient::new(&env, &yt_90d);
    yt_90d_client.initialize(
        &admin,
        &pool_90d,
        &sy_id,
        &String::from_str(&env, "Pendle YT 90D"),
        &String::from_str(&env, "YT-90D"),
        &7u32,
        &maturity_90d,
    );

    let pool_90d_client = YieldMarketClient::new(&env, &pool_90d);
    pool_90d_client.initialize(
        &admin,
        &sy_id,
        &pt_90d,
        &yt_90d,
        &maturity_90d,
        &(20 * WAD),
        &WAD,
    );

    // 6. Register both markets in factory
    factory_client.register_market(
        &admin,
        &pool_30d,
        &sy_id,
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
        &sy_id,
        &pt_90d,
        &yt_90d,
        &usdc.address(),
        &maturity_90d,
        &(20 * WAD),
        &WAD,
    );

    FactoryFixture {
        env,
        admin,
        guardian,
        user1,
        user2,
        usdc_admin_client,
        usdc_client,
        blend_client,
        sy_client,
        factory_client,
        pool_30d,
        pool_90d,
        pt_30d,
        pt_90d,
        yt_30d,
        yt_90d,
        maturity_30d,
        maturity_90d,
    }
}

// =============================================================================
// Unit Tests: Factory Initialization & State
// =============================================================================

#[test]
fn test_factory_initialize_and_metadata() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);

    let pt_wasm = BytesN::from_array(&env, &[10u8; 32]);
    let yt_wasm = BytesN::from_array(&env, &[20u8; 32]);
    let pool_wasm = BytesN::from_array(&env, &[30u8; 32]);
    let sy_wasm = BytesN::from_array(&env, &[40u8; 32]);

    let factory_id = env.register(MarketFactory, ());
    let client = MarketFactoryClient::new(&env, &factory_id);

    client.initialize(&admin, &guardian, &pt_wasm, &yt_wasm, &pool_wasm, &sy_wasm);

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_guardian(), Some(guardian.clone()));
    assert_eq!(client.get_pending_admin(), None);
    assert!(!client.is_paused());
    assert_eq!(client.market_count(), 0);

    let (pt, yt, pool, sy) = client.get_wasm_hashes();
    assert_eq!(pt, pt_wasm);
    assert_eq!(yt, yt_wasm);
    assert_eq!(pool, pool_wasm);
    assert_eq!(sy, sy_wasm);

    // Double initialization must fail
    assert_eq!(
        client.try_initialize(&admin, &guardian, &pt_wasm, &yt_wasm, &pool_wasm, &sy_wasm),
        Err(Ok(ContractError::AlreadyInitialized))
    );
}

#[test]
fn test_factory_initialize_zero_hash_rejection() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let zero = BytesN::from_array(&env, &[0u8; 32]);
    let valid = BytesN::from_array(&env, &[1u8; 32]);

    let factory_id = env.register(MarketFactory, ());
    let client = MarketFactoryClient::new(&env, &factory_id);

    assert_eq!(
        client.try_initialize(&admin, &guardian, &zero, &valid, &valid, &valid),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        client.try_initialize(&admin, &guardian, &valid, &zero, &valid, &valid),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        client.try_initialize(&admin, &guardian, &valid, &valid, &zero, &valid),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        client.try_initialize(&admin, &guardian, &valid, &valid, &valid, &zero),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

// =============================================================================
// Unit Tests: Governance & Access Control
// =============================================================================

#[test]
fn test_factory_two_step_admin_lifecycle() {
    let f = setup_factory_fixture();
    let new_admin = Address::generate(&f.env);

    // 1. Non-admin propose fails
    assert_eq!(
        f.factory_client.try_propose_admin(&f.user1, &new_admin),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Admin proposes self fails
    assert_eq!(
        f.factory_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );

    // 3. Admin proposes new_admin
    f.factory_client.propose_admin(&f.admin, &new_admin);
    assert_eq!(
        f.factory_client.get_pending_admin(),
        Some(new_admin.clone())
    );
    assert_eq!(f.factory_client.get_admin(), f.admin);

    // 4. Stranger accept fails
    assert_eq!(
        f.factory_client.try_accept_admin(&f.user1),
        Err(Ok(ContractError::Unauthorized))
    );

    // 5. Designated new_admin accepts
    f.factory_client.accept_admin(&new_admin);
    assert_eq!(f.factory_client.get_admin(), new_admin);
    assert_eq!(f.factory_client.get_pending_admin(), None);

    // 6. Former admin can no longer propose
    assert_eq!(
        f.factory_client.try_propose_admin(&f.admin, &f.user1),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_factory_guardian_pause_and_admin_unpause() {
    let f = setup_factory_fixture();

    assert!(!f.factory_client.is_paused());

    // Guardian triggers pause
    f.factory_client.pause(&f.guardian);
    assert!(f.factory_client.is_paused());

    // Redundant pause fails
    assert_eq!(
        f.factory_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused))
    );

    // Guardian cannot unpause
    assert_eq!(
        f.factory_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin unpauses
    f.factory_client.unpause(&f.admin);
    assert!(!f.factory_client.is_paused());

    // Redundant unpause fails
    assert_eq!(
        f.factory_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );

    // Admin can also pause
    f.factory_client.pause(&f.admin);
    assert!(f.factory_client.is_paused());
    f.factory_client.unpause(&f.admin);
}

#[test]
fn test_factory_guardian_rotation() {
    let f = setup_factory_fixture();
    let new_guardian = Address::generate(&f.env);

    // Non-admin cannot set guardian
    assert_eq!(
        f.factory_client.try_set_guardian(&f.user1, &new_guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin sets new guardian
    f.factory_client.set_guardian(&f.admin, &new_guardian);
    assert_eq!(f.factory_client.get_guardian(), Some(new_guardian.clone()));

    // Old guardian cannot pause
    assert_eq!(
        f.factory_client.try_pause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // New guardian can pause
    f.factory_client.pause(&new_guardian);
    assert!(f.factory_client.is_paused());
    f.factory_client.unpause(&f.admin);
}

#[test]
fn test_factory_upgrade_access_control() {
    let f = setup_factory_fixture();
    let zero = BytesN::from_array(&f.env, &[0u8; 32]);
    let valid = BytesN::from_array(&f.env, &[55u8; 32]);

    // Non-admin upgrade fails
    assert_eq!(
        f.factory_client.try_upgrade(&f.user1, &valid),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin zero hash upgrade fails
    assert_eq!(
        f.factory_client.try_upgrade(&f.admin, &zero),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

// =============================================================================
// Unit Tests: Registry Queries & Dual Indexing
// =============================================================================

#[test]
fn test_register_market_success_and_query_indexes() {
    let f = setup_factory_fixture();

    assert_eq!(f.factory_client.market_count(), 2);

    let m0 = f.factory_client.get_market(&0);
    assert_eq!(m0.id, 0);
    assert_eq!(m0.pool, f.pool_30d);
    assert_eq!(m0.pt, f.pt_30d);
    assert_eq!(m0.yt, f.yt_30d);
    assert_eq!(m0.maturity, f.maturity_30d);
    assert!(m0.is_active);

    let m1 = f.factory_client.get_market(&1);
    assert_eq!(m1.id, 1);
    assert_eq!(m1.pool, f.pool_90d);
    assert_eq!(m1.pt, f.pt_90d);
    assert_eq!(m1.yt, f.yt_90d);
    assert_eq!(m1.maturity, f.maturity_90d);

    // Lookup by asset and maturity
    let by_key = f
        .factory_client
        .get_market_by_asset_maturity(&f.usdc_client.address, &f.maturity_30d);
    assert_eq!(by_key, Some(m0.clone()));

    // Lookup by pool
    let by_pool = f.factory_client.get_market_by_pool(&f.pool_90d);
    assert_eq!(by_pool, Some(m1));

    // Lookup unknown pool
    let unknown = Address::generate(&f.env);
    assert_eq!(f.factory_client.get_market_by_pool(&unknown), None);

    // Out-of-bounds market ID
    assert_eq!(
        f.factory_client.try_get_market(&99),
        Err(Ok(ContractError::MarketNotFound))
    );
}

#[test]
fn test_register_market_duplicate_rejected() {
    let f = setup_factory_fixture();

    // Re-registering existing asset + maturity fails with MarketAlreadyExists
    let dummy_pool = Address::generate(&f.env);
    assert_eq!(
        f.factory_client.try_register_market(
            &f.admin,
            &dummy_pool,
            &f.sy_client.address,
            &f.pt_30d,
            &f.yt_30d,
            &f.usdc_client.address,
            &f.maturity_30d,
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::MarketAlreadyExists))
    );

    // Re-registering existing pool address fails with MarketAlreadyExists
    assert_eq!(
        f.factory_client.try_register_market(
            &f.admin,
            &f.pool_30d,
            &f.sy_client.address,
            &f.pt_30d,
            &f.yt_30d,
            &f.usdc_client.address,
            &(f.env.ledger().timestamp() + 500 * 86400),
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::MarketAlreadyExists))
    );
}

#[test]
fn test_register_market_unauthorized_rejected() {
    let f = setup_factory_fixture();
    let pool = Address::generate(&f.env);

    assert_eq!(
        f.factory_client.try_register_market(
            &f.user1,
            &pool,
            &f.sy_client.address,
            &f.pt_30d,
            &f.yt_30d,
            &f.usdc_client.address,
            &(f.env.ledger().timestamp() + 500 * 86400),
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_list_markets_pagination_and_bounds() {
    let f = setup_factory_fixture();

    // Query from 0 with limit 1
    let p1 = f.factory_client.list_markets(&0, &1);
    assert_eq!(p1.len(), 1);
    assert_eq!(p1.get(0).unwrap().id, 0);

    // Query from 1 with limit 1
    let p2 = f.factory_client.list_markets(&1, &1);
    assert_eq!(p2.len(), 1);
    assert_eq!(p2.get(0).unwrap().id, 1);

    // Query from 0 with limit 10 (returns all 2)
    let p_all = f.factory_client.list_markets(&0, &10);
    assert_eq!(p_all.len(), 2);

    // Query beyond count
    let p_empty = f.factory_client.list_markets(&5, &10);
    assert_eq!(p_empty.len(), 0);

    // Limit clamped <= 50
    let p_clamped = f.factory_client.list_markets(&0, &1000);
    assert_eq!(p_clamped.len(), 2);
}

#[test]
fn test_set_and_get_wasm_hashes() {
    let f = setup_factory_fixture();
    let new_pt = BytesN::from_array(&f.env, &[11u8; 32]);

    // Non-admin fails
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.user1, &Some(new_pt.clone()), &None, &None, &None,),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin updates pt_wasm
    f.factory_client
        .set_wasm_hashes(&f.admin, &Some(new_pt.clone()), &None, &None, &None);
    let (pt, _yt, _pool, _sy) = f.factory_client.get_wasm_hashes();
    assert_eq!(pt, new_pt);

    // Zero hash update fails
    let zero = BytesN::from_array(&f.env, &[0u8; 32]);
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &Some(zero), &None, &None, &None,),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

#[test]
fn test_set_and_get_sy_for_asset() {
    let f = setup_factory_fixture();
    let dummy_asset = Address::generate(&f.env);
    let dummy_sy = Address::generate(&f.env);

    assert_eq!(f.factory_client.get_sy_for_asset(&dummy_asset), None);

    // Non-admin fails
    assert_eq!(
        f.factory_client
            .try_set_sy_for_asset(&f.user1, &dummy_asset, &dummy_sy),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin sets canonical SY
    f.factory_client
        .set_sy_for_asset(&f.admin, &dummy_asset, &dummy_sy);
    assert_eq!(
        f.factory_client.get_sy_for_asset(&dummy_asset),
        Some(dummy_sy)
    );
}

// =============================================================================
// Unit Tests: Atomic Rollover Routers
// =============================================================================

#[test]
fn test_rollover_to_pt_happy_path() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000i128; // 100 USDC

    // 1. User1 deposits 100 USDC into SY, mints 100 30D PT + YT
    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);

    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    let dl1 = f.env.ledger().timestamp() + 3600;
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);

    // 2. Provision liquidity in 90D target pool with positive implied yield (PT > SY)
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Advance ledger time past 30D maturity (day 35)
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 4. Execute atomic rollover from 30D pool to 90D pool
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

    let dl2 = f.env.ledger().timestamp() + 3600;
    let (sy_received, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
        &dl2,
    );

    assert_eq!(sy_received, user_amount);
    assert!(pt_out > 0);
    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), pt_out);

    // Zero residual SY in factory router
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_rollover_to_pt_slippage_rejection() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    let dl1 = f.env.ledger().timestamp() + 3600;
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Provision liquidity in 90D target pool with positive implied yield
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Unrealistically high slippage bound reverts with SlippageExceeded
    let unreasonable_min_pt = 100_000_000_000i128;
    let dl2 = f.env.ledger().timestamp() + 3600;
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &unreasonable_min_pt,
            &dl2,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    // State is preserved
    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
}

#[test]
fn test_rollover_to_pt_unmatured_source_rejection() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000i128;
    let dl = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl);

    // Still before 30D maturity
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
            &dl,
        ),
        Err(Ok(ContractError::MarketNotYetMatured))
    );
}

#[test]
fn test_rollover_to_pt_matured_target_rejection() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000i128;
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Advance time past BOTH 30D and 90D maturity
    f.env.ledger().set_timestamp(f.maturity_90d + 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
            &dl2,
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
}

#[test]
fn test_rollover_to_pt_identical_pools_rejection() {
    let f = setup_factory_fixture();
    let dl = f.env.ledger().timestamp() + 3600;

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_30d, &100, &1, &dl),
        Err(Ok(ContractError::IdenticalAddresses))
    );
}

#[test]
fn test_rollover_to_pt_paused_factory_rejection() {
    let f = setup_factory_fixture();
    let dl = f.env.ledger().timestamp() + 3600;
    f.factory_client.pause(&f.guardian);

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1, &dl),
        Err(Ok(ContractError::ContractPaused))
    );
}

#[test]
fn test_rollover_to_py_happy_path() {
    let f = setup_factory_fixture();
    let user_amount = 1_000_000_000i128;
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Advance time past 30D maturity
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_90d_client = YieldTokenClient::new(&f.env, &f.yt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);
    assert_eq!(yt_90d_client.balance(&f.user1), 0);

    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
        &dl2,
    );

    assert_eq!(sy_payout, user_amount);
    assert_eq!(py_minted, user_amount);
    assert_eq!(pt_90d_client.balance(&f.user1), user_amount);
    assert_eq!(yt_90d_client.balance(&f.user1), user_amount);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), 0);

    // Zero residual SY in factory router
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_rollover_to_py_slippage_with_bad_debt_haircut() {
    let f = setup_factory_fixture();
    let user_amount = 1_000_000_000i128;
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Simulate 20% bad debt in 30D pool vault
    f.sy_client.burn(&f.pool_30d, &200_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    // User expects at least 900 SY shares -> fails with SlippageExceeded (only 800 available)
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &900_000_000,
            &dl2,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );

    // With realistic threshold (<= 800), rollover succeeds
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &800_000_000,
        &dl2,
    );
    assert_eq!(sy_payout, 800_000_000);
    assert_eq!(py_minted, 800_000_000);
}

#[test]
fn test_rollover_zero_amount_rejection() {
    let f = setup_factory_fixture();
    let dl = f.env.ledger().timestamp() + 3600;

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &0, &1, &dl),
        Err(Ok(ContractError::ZeroAmount))
    );

    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &-100,
            &1,
            &dl,
        ),
        Err(Ok(ContractError::ZeroAmount))
    );
}

#[test]
fn test_rollover_to_py_at_high_b_rate_1_25_slippage_checks_minted_shares() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000_000i128;
    let dl1 = f.env.ledger().timestamp() + 3600;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount, &dl1);

    // Accrue b_rate to 1.25 before maturity
    f.blend_client.set_b_rate(&1_250_000_000);
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_90d_client = YieldTokenClient::new(&f.env, &f.yt_90d);

    // min_new_shares = 100B + 1 -> reverts atomically because minted_pt == 100B
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &(user_amount + 1),
            &dl2,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);
    assert_eq!(yt_90d_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);

    // min_new_shares = 95B -> succeeds even though sy_payout = 80B < 95B because minted_pt = 100B >= 95B
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &95_000_000_000,
        &dl2,
    );
    assert_eq!(sy_payout, 80_000_000_000);
    assert_eq!(py_minted, user_amount);
    assert_eq!(pt_30d_client.balance(&f.user1), 0);
    assert_eq!(pt_90d_client.balance(&f.user1), user_amount);
    assert_eq!(yt_90d_client.balance(&f.user1), user_amount);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_rollover_to_py_at_sub_one_b_rate_0_80_protects_minted_shares() {
    let f = setup_factory_fixture();
    let dl1 = f.env.ledger().timestamp() + 3600;

    // Set initial b_rate = 0.80 -> 80B USDC = 100B SY -> mints 80B PT + 80B YT
    f.blend_client.set_b_rate(&800_000_000);
    let usdc_in = 80_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &usdc_in);
    let sy_in = f.sy_client.deposit(&f.user1, &f.user1, &usdc_in);
    assert_eq!(sy_in, 100_000_000_000);

    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    let (pt_30, _yt_30) = pool_30d_client.mint_py(&f.user1, &f.user1, &sy_in, &dl1);
    assert_eq!(pt_30, 80_000_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_90d_client = YieldTokenClient::new(&f.env, &f.yt_90d);

    // min_new_shares = 90B -> MUST revert because minted_pt = 80B < 90B (even though sy_payout = 100B >= 90B)
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &pt_30,
            &90_000_000_000,
            &dl2,
        ),
        Err(Ok(ContractError::SlippageExceeded))
    );
    assert_eq!(pt_90d_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);

    // min_new_shares = 80B -> succeeds
    let (sy_payout, py_minted) = f.factory_client.rollover_to_py(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &pt_30,
        &80_000_000_000,
        &dl2,
    );
    assert_eq!(sy_payout, 100_000_000_000);
    assert_eq!(py_minted, 80_000_000_000);
    assert_eq!(pt_90d_client.balance(&f.user1), 80_000_000_000);
    assert_eq!(yt_90d_client.balance(&f.user1), 80_000_000_000);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
}

#[test]
fn test_cross_adapter_rollover_blend_and_slender_unequal_rates_and_scoped_auth() {
    use mock_slender::{MockSlender, MockSlenderClient};
    use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
    use sy_slender_wrapper::{StandardizedYieldSlender, StandardizedYieldSlenderClient};

    let f = setup_factory_fixture();
    let receiver = Address::generate(&f.env);

    // Deploy MockSlender + sy_slender_wrapper + 60D Slender market
    let slender_id = f.env.register(MockSlender, ());
    let slender_client = MockSlenderClient::new(&f.env, &slender_id);
    slender_client.initialize(&f.admin, &f.usdc_client.address, &SCALAR_9);

    let sy_slender_id = f.env.register(StandardizedYieldSlender, ());
    let sy_slender_client = StandardizedYieldSlenderClient::new(&f.env, &sy_slender_id);
    sy_slender_client.initialize(&f.admin, &f.usdc_client.address, &slender_id, &slender_id);

    let maturity_60d = f.env.ledger().timestamp() + 60 * 86400;
    let pool_sl = f.env.register(YieldPool, ());
    let pt_sl = f.env.register(PrincipalToken, ());
    let yt_sl = f.env.register(YieldToken, ());

    PrivilegedTokenClient::new(&f.env, &pt_sl).initialize(
        &f.admin,
        &pool_sl,
        &String::from_str(&f.env, "PT USDC 60D"),
        &String::from_str(&f.env, "PT-USDC-60D"),
        &7u32,
        &maturity_60d,
    );
    YieldTokenClient::new(&f.env, &yt_sl).initialize(
        &f.admin,
        &pool_sl,
        &sy_slender_id,
        &String::from_str(&f.env, "YT USDC 60D"),
        &String::from_str(&f.env, "YT-USDC-60D"),
        &7u32,
        &maturity_60d,
    );
    let pool_sl_client = YieldMarketClient::new(&f.env, &pool_sl);
    pool_sl_client.initialize(
        &f.admin,
        &sy_slender_id,
        &pt_sl,
        &yt_sl,
        &maturity_60d,
        &(20 * WAD),
        &WAD,
    );
    f.factory_client.register_market(
        &f.admin,
        &pool_sl,
        &sy_slender_id,
        &pt_sl,
        &yt_sl,
        &f.usdc_client.address,
        &maturity_60d,
        &(20 * WAD),
        &WAD,
    );

    // Seed Slender 60D pool liquidity and mint Blend 30D PT for user1
    let dl1 = f.env.ledger().timestamp() + 3600;
    f.usdc_admin_client.mint(&f.admin, &6_000_000_000);
    sy_slender_client.deposit(&f.admin, &f.admin, &6_000_000_000);
    pool_sl_client.mint_py(&f.admin, &f.admin, &3_000_000_000, &dl1);
    pool_sl_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    let pt_in = 120_000_000i128; // 12 USDC
    f.usdc_admin_client.mint(&f.user1, &pt_in);
    f.sy_client.deposit(&f.user1, &f.user1, &pt_in);
    YieldMarketClient::new(&f.env, &f.pool_30d).mint_py(&f.user1, &f.user1, &pt_in, &dl1);

    // Unequal rates: Blend = 1.20 (fund Blend interest), Slender = 1.05
    f.blend_client.set_b_rate(&1_200_000_000);
    f.usdc_admin_client.mint(&f.blend_client.address, &24_000_000);
    slender_client.set_liquidity_index(&1_050_000_000);

    // Advance past 30D Blend maturity (before 60D Slender maturity)
    f.env.ledger().set_timestamp(f.maturity_30d + 86400);
    let dl2 = f.env.ledger().timestamp() + 3600;

    // Run Blend -> Slender rollover_to_pt under SCOPED MockAuth (proving authorize_as_current_contract)
    let sub_redeem = MockAuthInvoke {
        contract: &f.pool_30d,
        fn_name: "redeem_pt_post_maturity",
        args: (
            f.user1.clone(),
            f.factory_client.address.clone(),
            pt_in,
        )
            .into_val(&f.env),
        sub_invokes: &[],
    };
    f.env.mock_auths(&[MockAuth {
        address: &f.user1,
        invoke: &MockAuthInvoke {
            contract: &f.factory_client.address,
            fn_name: "rollover_to_pt",
            args: (
                f.user1.clone(),
                receiver.clone(),
                f.pool_30d.clone(),
                pool_sl.clone(),
                pt_in,
                1i128,
                dl2,
            )
                .into_val(&f.env),
            sub_invokes: &[sub_redeem],
        },
    }]);

    // Measure exact single-tx cross-adapter rollover CPU/memory cost
    f.env.cost_estimate().disable_resource_limits();
    let (target_sy_out, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &receiver,
        &f.pool_30d,
        &pool_sl,
        &pt_in,
        &1,
        &dl2,
    );
    let cpu_pt = f.env.cost_estimate().budget().cpu_instruction_cost();
    let mem_pt = f.env.cost_estimate().budget().memory_bytes_cost();
    assert!(
        cpu_pt < 50_000_000 && mem_pt < 20_000_000,
        "cpu={cpu_pt} mem={mem_pt}"
    );
    // 120M pt_in at Blend 1.20 -> 100M sy-bUSDC -> 120M USDC -> floor(120M * 1e9 / 1.05e9) = 114,285,714 sy-sUSDC
    assert_eq!(target_sy_out, 114_285_714);
    assert!(pt_out > 0);
    assert_eq!(PrivilegedTokenClient::new(&f.env, &pt_sl).balance(&receiver), pt_out);
    assert_eq!(f.usdc_client.balance(&f.factory_client.address), 0);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
    assert_eq!(sy_slender_client.balance(&f.factory_client.address), 0);

    // Reverse direction: Slender 60D -> Blend 90D rollover_to_py
    f.env.mock_all_auths();
    let sl_py_in = 105_000_000i128; // 10.5 USDC
    f.usdc_admin_client.mint(&f.user2, &sl_py_in);
    let dl_sl = f.env.ledger().timestamp() + 3600;
    let sy_sl_deposited = sy_slender_client.deposit(&f.user2, &f.user2, &sl_py_in);
    let (pt_sl_minted, _) = pool_sl_client.mint_py(&f.user2, &f.user2, &sy_sl_deposited, &dl_sl);

    // Advance past 60D Slender maturity (before 90D Blend maturity)
    f.env.ledger().set_timestamp(maturity_60d + 86400);
    let dl3 = f.env.ledger().timestamp() + 3600;
    f.env.cost_estimate().disable_resource_limits();
    let (blend_sy_out, blend_py_out) = f.factory_client.rollover_to_py(
        &f.user2,
        &receiver,
        &pool_sl,
        &f.pool_90d,
        &pt_sl_minted,
        &(pt_sl_minted - 5),
        &dl3,
    );
    assert!(blend_sy_out > 0);
    assert!(blend_py_out >= pt_sl_minted - 5);
    assert_eq!(f.usdc_client.balance(&f.factory_client.address), 0);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);
    assert_eq!(sy_slender_client.balance(&f.factory_client.address), 0);
}

// =============================================================================
// Unit Tests: R4 / F10 Single-Tx Zap-In Router
// =============================================================================

#[test]
fn test_zap_in_pt_yt_lp_happy_path_distinct_receiver_and_events() {
    use soroban_sdk::testutils::Events as _;

    let f = setup_factory_fixture();
    let dl = f.env.ledger().timestamp() + 3600;
    let receiver = Address::generate(&f.env);

    // Seed 90D pool: 120B PT + 100B SY
    let seed_usdc = 220_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &seed_usdc);
    f.sy_client.deposit(&f.admin, &f.admin, &seed_usdc);
    let pool_90 = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90.mint_py(&f.admin, &f.admin, &120_000_000_000, &dl);
    pool_90.add_liquidity(&f.admin, &f.admin, &120_000_000_000, &100_000_000_000, &1);

    let pt_c = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    let yt_c = YieldTokenClient::new(&f.env, &f.yt_90d);
    let zap_amt = 100_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &(zap_amt * 3));

    // 1. zap_in_pt
    let pt_out = f
        .factory_client
        .zap_in_pt(&f.user1, &receiver, &f.pool_90d, &zap_amt, &1, &dl);
    assert!(!f.env.events().all().events().is_empty());
    assert!(pt_out > 0);
    assert_eq!(pt_c.balance(&receiver), pt_out);
    assert_eq!(yt_c.balance(&receiver), 0);

    // 2. zap_in_yt
    let yt_out = f
        .factory_client
        .zap_in_yt(&f.user1, &receiver, &f.pool_90d, &zap_amt, &1, &dl);
    assert!(!f.env.events().all().events().is_empty());
    assert!(yt_out > 0);
    assert_eq!(pt_c.balance(&receiver), pt_out);
    assert_eq!(yt_c.balance(&receiver), yt_out);

    // 3. zap_in_lp (seeded pool MUST NOT touch receiver's PT or YT balances)
    let (lp_out, residual_sy) = f
        .factory_client
        .zap_in_lp(&f.user1, &receiver, &f.pool_90d, &zap_amt, &1, &dl);
    assert!(!f.env.events().all().events().is_empty());
    assert!(lp_out > 0);
    assert!(residual_sy >= 0);
    assert_eq!(pt_c.balance(&receiver), pt_out);
    assert_eq!(yt_c.balance(&receiver), yt_out);
    assert!(pool_90.total_supply() > lp_out);
    assert_eq!(
        token::Client::new(&f.env, &f.pool_90d).balance(&receiver),
        lp_out
    );
    assert_eq!(f.sy_client.balance(&receiver), residual_sy);
    assert_eq!(f.usdc_client.balance(&f.user1), 0);

    // Zero factory dust across all 5 tokens
    let factory_addr = f.factory_client.address.clone();
    assert_eq!(f.usdc_client.balance(&factory_addr), 0);
    assert_eq!(f.sy_client.balance(&factory_addr), 0);
    assert_eq!(pt_c.balance(&factory_addr), 0);
    assert_eq!(yt_c.balance(&factory_addr), 0);
    assert_eq!(token::Client::new(&f.env, &f.pool_90d).balance(&factory_addr), 0);
}

#[test]
fn test_zap_in_empty_pool_and_error_boundaries() {
    let f = setup_factory_fixture();
    f.env.cost_estimate().disable_resource_limits();
    let now = f.env.ledger().timestamp();
    let dl = now + 3600;

    // 1. Empty 30D pool supports zap_in_lp via mint_py + add_liquidity + YT sweep
    let init_lp_amt = 2_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &init_lp_amt);
    let (lp_empty, res_empty) = f.factory_client.zap_in_lp(
        &f.user2,
        &f.user2,
        &f.pool_30d,
        &init_lp_amt,
        &0,
        &dl,
    );
    assert!(lp_empty > 0);
    assert_eq!(res_empty, 0);
    assert_eq!(YieldTokenClient::new(&f.env, &f.yt_30d).balance(&f.user2), init_lp_amt / 2);
    assert_eq!(PrivilegedTokenClient::new(&f.env, &f.pt_30d).balance(&f.user2), 0);
    assert_eq!(f.sy_client.balance(&f.factory_client.address), 0);

    // Seed 90D pool for boundary checks
    f.usdc_admin_client.mint(&f.admin, &22_000_000_000);
    f.sy_client.deposit(&f.admin, &f.admin, &22_000_000_000);
    let pool_90 = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90.mint_py(&f.admin, &f.admin, &12_000_000_000, &dl);
    pool_90.add_liquidity(&f.admin, &f.admin, &12_000_000_000, &10_000_000_000, &1);

    let amt = 10_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &(amt * 4));

    // 2. Zero / negative underlying_amount and negative min_out -> #4 ZeroAmount
    for bad_amt in [0i128, -50i128] {
        assert_eq!(
            f.factory_client
                .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &bad_amt, &0, &dl),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            f.factory_client
                .try_zap_in_yt(&f.user1, &f.user1, &f.pool_90d, &bad_amt, &0, &dl),
            Err(Ok(ContractError::ZeroAmount))
        );
        assert_eq!(
            f.factory_client
                .try_zap_in_lp(&f.user1, &f.user1, &f.pool_90d, &bad_amt, &0, &dl),
            Err(Ok(ContractError::ZeroAmount))
        );
    }
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &-1, &dl),
        Err(Ok(ContractError::ZeroAmount))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_yt(&f.user1, &f.user1, &f.pool_90d, &amt, &-1, &dl),
        Err(Ok(ContractError::ZeroAmount))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_lp(&f.user1, &f.user1, &f.pool_90d, &amt, &-1, &dl),
        Err(Ok(ContractError::ZeroAmount))
    );

    // 3. Unknown pool -> #26 MarketNotFound
    let fake_pool = Address::generate(&f.env);
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &fake_pool, &amt, &0, &dl),
        Err(Ok(ContractError::MarketNotFound))
    );

    // 4. Deadline expired (now - 1) -> #10 DeadlineExpired; now == deadline succeeds
    let expired_dl = now.saturating_sub(1);
    f.env.ledger().set_timestamp(1000);
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &999),
        Err(Ok(ContractError::DeadlineExpired))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_yt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &999),
        Err(Ok(ContractError::DeadlineExpired))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_lp(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &999),
        Err(Ok(ContractError::DeadlineExpired))
    );
    let _ = expired_dl;
    assert!(f
        .factory_client
        .zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &1000)
        > 0);

    // 5. SlippageExceeded -> #9
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &(amt * 10), &2000),
        Err(Ok(ContractError::SlippageExceeded))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_lp(&f.user1, &f.user1, &f.pool_90d, &amt, &(amt * 10), &2000),
        Err(Ok(ContractError::SlippageExceeded))
    );

    // 6. Paused factory -> #23 ContractPaused
    f.factory_client.pause(&f.guardian);
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &2000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_yt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &2000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_lp(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &2000),
        Err(Ok(ContractError::ContractPaused))
    );
    f.factory_client.unpause(&f.admin);

    // 7. Reentrancy guard -> #17 ReentrancyLocked
    f.env.as_contract(&f.factory_client.address, || {
        f.env
            .storage()
            .temporary()
            .set(&DataKey::FlashLoanGuard, &true);
    });
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &f.user1, &f.pool_90d, &amt, &0, &2000),
        Err(Ok(ContractError::ReentrancyLocked))
    );
    f.env.as_contract(&f.factory_client.address, || {
        f.env.storage().temporary().remove(&DataKey::FlashLoanGuard);
    });

    // 8. Matured pool (now == maturity) -> #7 MarketAlreadyMatured
    f.env.ledger().set_timestamp(f.maturity_90d);
    assert_eq!(
        f.factory_client.try_zap_in_pt(
            &f.user1,
            &f.user1,
            &f.pool_90d,
            &amt,
            &0,
            &(f.maturity_90d + 60)
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
    assert_eq!(
        f.factory_client.try_zap_in_yt(
            &f.user1,
            &f.user1,
            &f.pool_90d,
            &amt,
            &0,
            &(f.maturity_90d + 60)
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
    assert_eq!(
        f.factory_client.try_zap_in_lp(
            &f.user1,
            &f.user1,
            &f.pool_90d,
            &amt,
            &0,
            &(f.maturity_90d + 60)
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
}

#[test]
fn test_tier5_bug_a3_zap_in_and_rollover_reject_receiver_eq_factory() {
    let f = setup_factory_fixture();
    f.env.cost_estimate().disable_resource_limits();
    let now = f.env.ledger().timestamp();
    let dl = now + 3600;
    let factory_addr = f.factory_client.address.clone();

    // Seed 90D pool
    f.usdc_admin_client.mint(&f.admin, &22_000_000_000);
    f.sy_client.deposit(&f.admin, &f.admin, &22_000_000_000);
    let pool_90 = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90.mint_py(&f.admin, &f.admin, &12_000_000_000, &dl);
    pool_90.add_liquidity(&f.admin, &f.admin, &12_000_000_000, &10_000_000_000, &1);

    // Give user1 USDC + 30D PT for rollover test
    let amt = 100_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &amt);
    let pool_30 = YieldMarketClient::new(&f.env, &f.pool_30d);
    f.usdc_admin_client.mint(&f.user1, &amt);
    f.sy_client.deposit(&f.user1, &f.user1, &amt);
    pool_30.mint_py(&f.user1, &f.user1, &amt, &dl);

    // Zap-In entrypoints must reject receiver == factory with #15 IdenticalAddresses
    assert_eq!(
        f.factory_client
            .try_zap_in_pt(&f.user1, &factory_addr, &f.pool_90d, &amt, &0, &dl),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_yt(&f.user1, &factory_addr, &f.pool_90d, &amt, &0, &dl),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        f.factory_client
            .try_zap_in_lp(&f.user1, &factory_addr, &f.pool_90d, &amt, &0, &dl),
        Err(Ok(ContractError::IdenticalAddresses))
    );

    // Advance past 30D maturity (while 90D still active) and verify rollover_* reject receiver == factory
    f.env.ledger().set_timestamp(f.maturity_30d + 10);
    let dl_roll = f.maturity_30d + 3600;
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &factory_addr,
            &f.pool_30d,
            &f.pool_90d,
            &amt,
            &0,
            &dl_roll,
        ),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &factory_addr,
            &f.pool_30d,
            &f.pool_90d,
            &amt,
            &0,
            &dl_roll,
        ),
        Err(Ok(ContractError::IdenticalAddresses))
    );

    // Factory holds zero balances and user1's USDC/PT were untouched
    assert_eq!(f.usdc_client.balance(&f.user1), amt);
    assert_eq!(
        PrivilegedTokenClient::new(&f.env, &f.pt_30d).balance(&f.user1),
        amt
    );
    assert_eq!(f.usdc_client.balance(&factory_addr), 0);
    assert_eq!(f.sy_client.balance(&factory_addr), 0);
}

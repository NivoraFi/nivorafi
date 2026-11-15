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
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user1), user_amount);

    // 2. Provision liquidity in 90D target pool with positive implied yield (PT > SY)
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_client.deposit(&f.admin, &f.admin, &lp_seed);

    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    // 3. Advance ledger time past 30D maturity (day 35)
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // 4. Execute atomic rollover from 30D pool to 90D pool
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user1), 0);

    let (sy_received, pt_out) = f.factory_client.rollover_to_pt(
        &f.user1,
        &f.user1,
        &f.pool_30d,
        &f.pool_90d,
        &user_amount,
        &1,
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
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Provision liquidity in 90D target pool with positive implied yield
    let lp_seed = 6_000_000_000i128;
    f.usdc_admin_client.mint(&f.admin, &lp_seed);
    f.sy_client.deposit(&f.admin, &f.admin, &lp_seed);
    let pool_90d_client = YieldMarketClient::new(&f.env, &f.pool_90d);
    pool_90d_client.mint_py(&f.admin, &f.admin, &3_000_000_000);
    pool_90d_client.add_liquidity(&f.admin, &f.admin, &3_000_000_000, &2_000_000_000, &1);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // Unrealistically high slippage bound reverts with SlippageExceeded
    let unreasonable_min_pt = 100_000_000_000i128;
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &unreasonable_min_pt,
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

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Still before 30D maturity
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketNotYetMatured))
    );
}

#[test]
fn test_rollover_to_pt_matured_target_rejection() {
    let f = setup_factory_fixture();
    let user_amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Advance time past BOTH 30D and 90D maturity
    f.env.ledger().set_timestamp(f.maturity_90d + 86400);

    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
}

#[test]
fn test_rollover_to_pt_identical_pools_rejection() {
    let f = setup_factory_fixture();

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_30d, &100, &1,),
        Err(Ok(ContractError::IdenticalAddresses))
    );
}

#[test]
fn test_rollover_to_pt_paused_factory_rejection() {
    let f = setup_factory_fixture();
    f.factory_client.pause(&f.guardian);

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &100, &1,),
        Err(Ok(ContractError::ContractPaused))
    );
}

#[test]
fn test_rollover_to_py_happy_path() {
    let f = setup_factory_fixture();
    let user_amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Advance time past 30D maturity
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

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

    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user1, &f.user1, &user_amount);

    // Simulate 20% bad debt in 30D pool vault
    f.sy_client.burn(&f.pool_30d, &200_000_000);

    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User expects at least 900 SY shares -> fails with SlippageExceeded (only 800 available)
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user1,
            &f.user1,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &900_000_000,
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
    );
    assert_eq!(sy_payout, 800_000_000);
    assert_eq!(py_minted, 800_000_000);
}

#[test]
fn test_rollover_zero_amount_rejection() {
    let f = setup_factory_fixture();

    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user1, &f.user1, &f.pool_30d, &f.pool_90d, &0, &1,),
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
        ),
        Err(Ok(ContractError::ZeroAmount))
    );
}

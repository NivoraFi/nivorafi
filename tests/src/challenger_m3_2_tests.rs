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
struct ChallengerM32Fixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    attacker: Address,
    user: Address,
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
    pt_30d: Address,
    pt_90d: Address,
    yt_30d: Address,
    yt_90d: Address,
    maturity_30d: u64,
    maturity_90d: u64,
}

fn setup_m32_fixture<'a>() -> ChallengerM32Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let attacker = Address::generate(&env);
    let user = Address::generate(&env);

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

    // Canonical SY for USDC & XLM
    let sy_usdc_id = env.register(StandardizedYield, ());
    let sy_usdc_client = StandardizedYieldClient::new(&env, &sy_usdc_id);
    sy_usdc_client.initialize(&admin, &usdc.address(), &blend_id);

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

    // Helper to deploy and register a pool
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

    ChallengerM32Fixture {
        env,
        admin,
        guardian,
        attacker,
        user,
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
        pt_30d,
        pt_90d,
        yt_30d,
        yt_90d,
        maturity_30d,
        maturity_90d,
    }
}

// =============================================================================
// CHALLENGE AREA 1: Gas Limits, Pagination Clamping & Boundary Exploits
// =============================================================================

#[test]
fn test_adversarial_pagination_clamping_and_zero_limit() {
    let f = setup_m32_fixture();

    // Baseline: 2 registered markets
    assert_eq!(f.factory_client.market_count(), 2);

    // 1. limit = 0 returns empty vector without panic
    let p_zero = f.factory_client.list_markets(&0, &0);
    assert_eq!(p_zero.len(), 0);

    // 2. start_index == count (2) returns empty vector
    let p_at_count = f.factory_client.list_markets(&2, &10);
    assert_eq!(p_at_count.len(), 0);

    // 3. start_index > count (10 > 2) returns empty vector
    let p_beyond_count = f.factory_client.list_markets(&10, &10);
    assert_eq!(p_beyond_count.len(), 0);

    // 4. start_index = u32::MAX returns empty vector without underflow/panic
    let p_max_start = f.factory_client.list_markets(&u32::MAX, &50);
    assert_eq!(p_max_start.len(), 0);

    // 5. start_index = u32::MAX - 10, limit = 50 returns empty vector without overflow
    let p_near_max = f.factory_client.list_markets(&(u32::MAX - 10), &50);
    assert_eq!(p_near_max.len(), 0);

    // 6. limit > 50 is clamped to 50 items max
    let p_clamped = f.factory_client.list_markets(&0, &1_000_000);
    assert_eq!(p_clamped.len(), 2);
}

#[test]
fn test_adversarial_high_count_gas_bounded_pagination() {
    let f = setup_m32_fixture();
    let now = f.env.ledger().timestamp();

    // Register 58 additional markets to reach exactly 60 markets
    // All maturities start past 100 days to avoid collision with 30D and 90D baseline markets
    for i in 2..60u32 {
        let dummy_pool = Address::generate(&f.env);
        let dummy_pt = Address::generate(&f.env);
        let dummy_yt = Address::generate(&f.env);
        let maturity = now + 100 * 86400 + (i as u64) * 86400;

        f.factory_client.register_market(
            &f.admin,
            &dummy_pool,
            &f.sy_usdc_client.address,
            &dummy_pt,
            &dummy_yt,
            &f.usdc_client.address,
            &maturity,
            &(20 * WAD),
            &WAD,
        );
    }

    assert_eq!(f.factory_client.market_count(), 60);

    // Page 0: Request limit 100 -> clamped to 50. Must return exactly 50 markets (IDs 0..50).
    let page0 = f.factory_client.list_markets(&0, &100);
    assert_eq!(page0.len(), 50);
    for idx in 0..50u32 {
        assert_eq!(page0.get(idx).unwrap().id, idx);
    }

    // Page 1: Request from index 50 with limit 50 -> returns remaining 10 markets (IDs 50..60).
    let page1 = f.factory_client.list_markets(&50, &50);
    assert_eq!(page1.len(), 10);
    for idx in 0..10u32 {
        assert_eq!(page1.get(idx).unwrap().id, 50 + idx);
    }

    // Page 2: Request from index 60 -> returns 0 items.
    let page2 = f.factory_client.list_markets(&60, &50);
    assert_eq!(page2.len(), 0);

    // Mid-stream slicing: start at index 45 with limit 10 -> returns exactly 10 markets (IDs 45..55).
    let mid_page = f.factory_client.list_markets(&45, &10);
    assert_eq!(mid_page.len(), 10);
    assert_eq!(mid_page.get(0).unwrap().id, 45);
    assert_eq!(mid_page.get(9).unwrap().id, 54);

    // Dual indexing lookups remain consistent across all 60 markets
    for id in 0..60u32 {
        let meta = f.factory_client.get_market(&id);
        assert_eq!(meta.id, id);
        let by_pool = f.factory_client.get_market_by_pool(&meta.pool);
        assert_eq!(by_pool, Some(meta.clone()));
        let by_key = f
            .factory_client
            .get_market_by_asset_maturity(&meta.asset, &meta.maturity);
        assert_eq!(by_key, Some(meta));
    }
}

// =============================================================================
// CHALLENGE AREA 2: Access Control, Authorization Trees & Governance Attacks
// =============================================================================

#[test]
fn test_adversarial_two_step_admin_transfer_exploit_paths() {
    let f = setup_m32_fixture();
    let honest_nominee = Address::generate(&f.env);
    let malicious_nominee = Address::generate(&f.env);

    // 1. Attacker attempts to propose admin: reverts with Unauthorized
    assert_eq!(
        f.factory_client
            .try_propose_admin(&f.attacker, &malicious_nominee),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Guardian attempts to propose admin: reverts with Unauthorized (guardian is not admin)
    assert_eq!(
        f.factory_client
            .try_propose_admin(&f.guardian, &malicious_nominee),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Admin attempts to propose self: reverts with InvalidAdmin
    assert_eq!(
        f.factory_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );

    // 4. Admin proposes honest_nominee
    f.factory_client.propose_admin(&f.admin, &honest_nominee);
    assert_eq!(
        f.factory_client.get_pending_admin(),
        Some(honest_nominee.clone())
    );
    assert_eq!(f.factory_client.get_admin(), f.admin);

    // 5. Attacker attempts to accept admin: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // 6. Current admin attempts to accept admin: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_accept_admin(&f.admin),
        Err(Ok(ContractError::Unauthorized))
    );

    // 7. Admin overwrites pending admin with malicious_nominee then switches back to honest_nominee
    f.factory_client.propose_admin(&f.admin, &malicious_nominee);
    assert_eq!(
        f.factory_client.get_pending_admin(),
        Some(malicious_nominee.clone())
    );

    // honest_nominee can no longer accept (pending admin was replaced)
    assert_eq!(
        f.factory_client.try_accept_admin(&honest_nominee),
        Err(Ok(ContractError::Unauthorized))
    );

    f.factory_client.propose_admin(&f.admin, &honest_nominee);

    // 8. Designated honest_nominee accepts
    f.factory_client.accept_admin(&honest_nominee);
    assert_eq!(f.factory_client.get_admin(), honest_nominee);
    assert_eq!(f.factory_client.get_pending_admin(), None);

    // 9. Former admin can no longer propose admin or configure hashes
    assert_eq!(
        f.factory_client.try_propose_admin(&f.admin, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &None, &None, &None, &None),
        Err(Ok(ContractError::Unauthorized))
    );

    // 10. Calling accept_admin when pending admin is None reverts with NoPendingAdmin
    assert_eq!(
        f.factory_client.try_accept_admin(&honest_nominee),
        Err(Ok(ContractError::NoPendingAdmin))
    );
}

#[test]
fn test_adversarial_guardian_access_control_and_unpause_privilege_separation() {
    let f = setup_m32_fixture();
    let rogue_guardian = Address::generate(&f.env);

    // 1. Attacker attempts to set guardian: reverts with Unauthorized
    assert_eq!(
        f.factory_client
            .try_set_guardian(&f.attacker, &rogue_guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Current guardian attempts to set guardian: reverts with Unauthorized (admin only)
    assert_eq!(
        f.factory_client
            .try_set_guardian(&f.guardian, &rogue_guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Attacker attempts to pause: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_pause(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // 4. Guardian pauses factory
    f.factory_client.pause(&f.guardian);
    assert!(f.factory_client.is_paused());

    // 5. Guardian attempts redundant pause: reverts with ContractPaused
    assert_eq!(
        f.factory_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused))
    );

    // 6. CRITICAL SECURITY CHECK: Guardian MUST NOT have privilege to unpause!
    // Unpausing is strictly restricted to Admin to prevent a compromised guardian key
    // from overriding administrative incident response.
    assert_eq!(
        f.factory_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // 7. Attacker attempts unpause: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_unpause(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // 8. Admin unpauses factory
    f.factory_client.unpause(&f.admin);
    assert!(!f.factory_client.is_paused());

    // 9. Admin attempts redundant unpause: reverts with ContractNotPaused
    assert_eq!(
        f.factory_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );

    // 10. Admin also has emergency pause capability
    f.factory_client.pause(&f.admin);
    assert!(f.factory_client.is_paused());
    f.factory_client.unpause(&f.admin);
}

#[test]
fn test_adversarial_upgrade_access_control_and_zero_hash_rejection() {
    let f = setup_m32_fixture();
    let zero_hash = BytesN::from_array(&f.env, &[0u8; 32]);
    let valid_hash = BytesN::from_array(&f.env, &[77u8; 32]);

    // 1. Attacker attempts upgrade: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_upgrade(&f.attacker, &valid_hash),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Guardian attempts upgrade: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_upgrade(&f.guardian, &valid_hash),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Admin attempts upgrade with 32 zero bytes: reverts with InvalidWasmHash
    assert_eq!(
        f.factory_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

#[test]
fn test_adversarial_wasm_hashes_and_sy_configuration_tamper_paths() {
    let f = setup_m32_fixture();
    let zero = BytesN::from_array(&f.env, &[0u8; 32]);
    let valid = BytesN::from_array(&f.env, &[99u8; 32]);

    // 1. Attacker attempts to update WASM hashes: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_set_wasm_hashes(
            &f.attacker,
            &Some(valid.clone()),
            &None,
            &None,
            &None
        ),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Guardian attempts to update WASM hashes: reverts with Unauthorized
    assert_eq!(
        f.factory_client.try_set_wasm_hashes(
            &f.guardian,
            &Some(valid.clone()),
            &None,
            &None,
            &None
        ),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Admin attempts to set zero hash across each individual slot: all revert with InvalidWasmHash
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &Some(zero.clone()), &None, &None, &None),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &None, &Some(zero.clone()), &None, &None),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &None, &None, &Some(zero.clone()), &None),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.factory_client
            .try_set_wasm_hashes(&f.admin, &None, &None, &None, &Some(zero)),
        Err(Ok(ContractError::InvalidWasmHash))
    );

    // 4. Attacker attempts to hijack canonical SY for asset: reverts with Unauthorized
    let fake_sy = Address::generate(&f.env);
    assert_eq!(
        f.factory_client
            .try_set_sy_for_asset(&f.attacker, &f.usdc_client.address, &fake_sy),
        Err(Ok(ContractError::Unauthorized))
    );

    // 5. Guardian attempts to configure SY for asset: reverts with Unauthorized
    assert_eq!(
        f.factory_client
            .try_set_sy_for_asset(&f.guardian, &f.usdc_client.address, &fake_sy),
        Err(Ok(ContractError::Unauthorized))
    );

    // 6. Attacker attempts to register a market: reverts with Unauthorized
    let dummy_addr = Address::generate(&f.env);
    assert_eq!(
        f.factory_client.try_register_market(
            &f.attacker,
            &dummy_addr,
            &dummy_addr,
            &dummy_addr,
            &dummy_addr,
            &f.usdc_client.address,
            &(f.env.ledger().timestamp() + 500 * 86400),
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::Unauthorized))
    );
}

// =============================================================================
// CHALLENGE AREA 3: Emergency Pause Gating (Mutations Rejected vs Reads Allowed)
// =============================================================================

#[test]
fn test_adversarial_pause_gating_complete_mutation_freeze_and_read_availability() {
    let f = setup_m32_fixture();

    // Trigger pause via Guardian
    f.factory_client.pause(&f.guardian);
    assert!(f.factory_client.is_paused());

    let dummy_addr = Address::generate(&f.env);
    let future_maturity = f.env.ledger().timestamp() + 200 * 86400;

    // --- MUTATIONS: ALL MUST REVERT WITH ContractPaused ---

    // 1. register_market
    assert_eq!(
        f.factory_client.try_register_market(
            &f.admin,
            &dummy_addr,
            &f.sy_usdc_client.address,
            &f.pt_30d,
            &f.yt_30d,
            &f.usdc_client.address,
            &future_maturity,
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // 2. create_market
    assert_eq!(
        f.factory_client.try_create_market(
            &f.user,
            &f.usdc_client.address,
            &dummy_addr,
            &future_maturity,
            &(20 * WAD),
            &WAD,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // 3. rollover_to_pt
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_90d,
            &100_000_000,
            &1,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // 4. rollover_to_py
    assert_eq!(
        f.factory_client.try_rollover_to_py(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_90d,
            &100_000_000,
            &1,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // --- READ QUERIES: ALL MUST SUCCEED CLEANLY ---

    assert_eq!(f.factory_client.market_count(), 2);
    assert!(f.factory_client.get_market(&0).is_active);
    assert!(f.factory_client.get_market(&1).is_active);
    assert_eq!(f.factory_client.list_markets(&0, &10).len(), 2);

    let by_key = f
        .factory_client
        .get_market_by_asset_maturity(&f.usdc_client.address, &f.maturity_30d);
    assert!(by_key.is_some());

    let by_pool = f.factory_client.get_market_by_pool(&f.pool_90d);
    assert!(by_pool.is_some());

    let (pt, yt, pool, sy) = f.factory_client.get_wasm_hashes();
    assert_ne!(pt.to_array(), [0u8; 32]);
    assert_ne!(yt.to_array(), [0u8; 32]);
    assert_ne!(pool.to_array(), [0u8; 32]);
    assert_ne!(sy.to_array(), [0u8; 32]);

    assert_eq!(
        f.factory_client.get_sy_for_asset(&f.usdc_client.address),
        Some(f.sy_usdc_client.address.clone())
    );
    assert_eq!(f.factory_client.get_admin(), f.admin);
    assert_eq!(f.factory_client.get_guardian(), Some(f.guardian.clone()));
    assert_eq!(f.factory_client.get_pending_admin(), None);
    assert!(f.factory_client.is_paused());

    // --- RESUME OPERATIONS: Admin unpauses ---
    f.factory_client.unpause(&f.admin);
    assert!(!f.factory_client.is_paused());

    // State mutations succeed again
    let new_pool = Address::generate(&f.env);
    let new_pt = Address::generate(&f.env);
    let new_yt = Address::generate(&f.env);
    let reg_result = f.factory_client.register_market(
        &f.admin,
        &new_pool,
        &f.sy_usdc_client.address,
        &new_pt,
        &new_yt,
        &f.usdc_client.address,
        &future_maturity,
        &(20 * WAD),
        &WAD,
    );
    assert_eq!(reg_result.id, 2);
    assert_eq!(f.factory_client.market_count(), 3);
}

// =============================================================================
// CHALLENGE AREA 4: Cross-Contract Authorization & Rollover Invariants
// =============================================================================

#[test]
fn test_adversarial_rollover_authorization_and_sanity_rejections() {
    let f = setup_m32_fixture();
    let dummy_pool = Address::generate(&f.env);
    let user_amount = 50_000_000i128;

    // 1. Unregistered source pool reverts with MarketNotFound
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &dummy_pool,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketNotFound))
    );

    // 2. Unregistered target pool reverts with MarketNotFound
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &dummy_pool,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketNotFound))
    );

    // 3. Zero or negative pt_amount reverts with ZeroAmount
    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user, &f.user, &f.pool_30d, &f.pool_90d, &0, &1,),
        Err(Ok(ContractError::ZeroAmount))
    );
    assert_eq!(
        f.factory_client
            .try_rollover_to_pt(&f.user, &f.user, &f.pool_30d, &f.pool_90d, &-1000, &1,),
        Err(Ok(ContractError::ZeroAmount))
    );

    // 4. Negative min_target_pt reverts with ZeroAmount
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &-1,
        ),
        Err(Ok(ContractError::ZeroAmount))
    );

    // 5. Identical source and target pool reverts with IdenticalAddresses
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_30d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::IdenticalAddresses))
    );

    // 6. Source not yet matured reverts with MarketNotYetMatured
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketNotYetMatured))
    );

    // 7. Advance time past both 30D and 90D -> Target already matured reverts with MarketAlreadyMatured
    f.env.ledger().set_timestamp(f.maturity_90d + 100);
    assert_eq!(
        f.factory_client.try_rollover_to_pt(
            &f.user,
            &f.user,
            &f.pool_30d,
            &f.pool_90d,
            &user_amount,
            &1,
        ),
        Err(Ok(ContractError::MarketAlreadyMatured))
    );
}

#[test]
fn test_adversarial_100_market_high_scale_pagination() {
    let f = setup_m32_fixture();
    let now = f.env.ledger().timestamp();

    // Scale up to 100 total markets
    for i in 2..100u32 {
        let dummy_pool = Address::generate(&f.env);
        let dummy_pt = Address::generate(&f.env);
        let dummy_yt = Address::generate(&f.env);
        let maturity = now + 100 * 86400 + (i as u64) * 86400;

        f.factory_client.register_market(
            &f.admin,
            &dummy_pool,
            &f.sy_usdc_client.address,
            &dummy_pt,
            &dummy_yt,
            &f.usdc_client.address,
            &maturity,
            &(20 * WAD),
            &WAD,
        );
    }

    assert_eq!(f.factory_client.market_count(), 100);

    // Page 0 (0..50)
    let page0 = f.factory_client.list_markets(&0, &50);
    assert_eq!(page0.len(), 50);
    assert_eq!(page0.get(0).unwrap().id, 0);
    assert_eq!(page0.get(49).unwrap().id, 49);

    // Page 1 (50..100)
    let page1 = f.factory_client.list_markets(&50, &50);
    assert_eq!(page1.len(), 50);
    assert_eq!(page1.get(0).unwrap().id, 50);
    assert_eq!(page1.get(49).unwrap().id, 99);

    // Page 2 (100..) -> Empty
    let page2 = f.factory_client.list_markets(&100, &50);
    assert_eq!(page2.len(), 0);

    // Boundary check at very end: index 99 with limit 10 -> exactly 1 item
    let last_item = f.factory_client.list_markets(&99, &10);
    assert_eq!(last_item.len(), 1);
    assert_eq!(last_item.get(0).unwrap().id, 99);

    // Beyond end
    let past_end = f.factory_client.list_markets(&101, &50);
    assert_eq!(past_end.len(), 0);
}

#[test]
fn test_adversarial_atomic_rollback_on_insufficient_pt_balance() {
    let f = setup_m32_fixture();
    let initial_user_balance = 50_000_000i128; // 50 USDC

    // User mints 50 30D PT + YT
    f.usdc_admin_client.mint(&f.user, &initial_user_balance);
    f.sy_usdc_client
        .deposit(&f.user, &f.user, &initial_user_balance);
    let pool_30d_client = YieldMarketClient::new(&f.env, &f.pool_30d);
    pool_30d_client.mint_py(&f.user, &f.user, &initial_user_balance);

    let pt_30d_client = PrivilegedTokenClient::new(&f.env, &f.pt_30d);
    assert_eq!(pt_30d_client.balance(&f.user), initial_user_balance);

    // Advance time past 30D maturity
    f.env.ledger().set_timestamp(f.maturity_30d + 5 * 86400);

    // User attempts to rollover 100_000_000 PT (has only 50_000_000)
    let excessive_amount = 100_000_000i128;
    let res = f.factory_client.try_rollover_to_pt(
        &f.user,
        &f.user,
        &f.pool_30d,
        &f.pool_90d,
        &excessive_amount,
        &1,
    );

    // Must fail due to insufficient PT in source pool
    assert!(res.is_err());

    // Invariant verification:
    // 1. User's 30D PT balance is completely untouched
    assert_eq!(pt_30d_client.balance(&f.user), initial_user_balance);

    // 2. User has 0 target 90D PT
    let pt_90d_client = PrivilegedTokenClient::new(&f.env, &f.pt_90d);
    assert_eq!(pt_90d_client.balance(&f.user), 0);

    // 3. Factory router has strictly 0 residual SY balance
    assert_eq!(f.sy_usdc_client.balance(&f.factory_client.address), 0);
}

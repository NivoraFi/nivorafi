#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, BytesN, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct StressProtocolFixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    prospective_admin: Address,
    rogue_attacker: Address,
    user1: Address,
    user2: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    blend_client: MockBlendClient<'a>,
    sy_client: StandardizedYieldClient<'a>,
    pt_client: PrincipalTokenClient<'a>,
    yt_client: YieldTokenClient<'a>,
    pool_client: YieldPoolClient<'a>,
    maturity: u64,
}

fn setup_stress_fixture<'a>() -> StressProtocolFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let prospective_admin = Address::generate(&env);
    let rogue_attacker = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // 1. Mock Blend Pool
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    // 2. SY Blend Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180 days

    // 3. Yield Pool Core
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

    // 4. PT Token
    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    pt_client.initialize(
        &admin,
        &pool_id,
        &String::from_str(&env, "Pendle PT 180D"),
        &String::from_str(&env, "PT-180D"),
        &7u32,
        &maturity,
    );

    // 5. YT Token
    let yt_id = env.register(YieldToken, ());
    let yt_client = YieldTokenClient::new(&env, &yt_id);
    yt_client.initialize(
        &admin,
        &pool_id,
        &sy_id,
        &String::from_str(&env, "Pendle YT 180D"),
        &String::from_str(&env, "YT-180D"),
        &7u32,
        &maturity,
    );

    // 6. Pool Initialization
    let scalar_root = 20 * WAD;
    let initial_anchor = WAD;
    pool_client.initialize(
        &admin,
        &sy_id,
        &pt_id,
        &yt_id,
        &maturity,
        &scalar_root,
        &initial_anchor,
    );

    // Configure guardian on all 4 contracts
    pool_client.set_guardian(&admin, &guardian);
    sy_client.set_guardian(&admin, &guardian);
    pt_client.set_guardian(&admin, &guardian);
    yt_client.set_guardian(&admin, &guardian);

    StressProtocolFixture {
        env,
        admin,
        guardian,
        prospective_admin,
        rogue_attacker,
        user1,
        user2,
        usdc_admin_client,
        usdc_client,
        blend_client,
        sy_client,
        pt_client,
        yt_client,
        pool_client,
        maturity,
    }
}

// =============================================================================
// Test 1: Adversarial Non-Guardian Pause Verification Matrix Across 4 Contracts
// =============================================================================

#[test]
fn test_stress_unauthorized_pause_matrix_all_contracts() {
    let f = setup_stress_fixture();

    let unauthorized_callers = [&f.rogue_attacker, &f.user1, &f.user2, &f.prospective_admin];

    for caller in unauthorized_callers.iter() {
        // Yield Pool
        assert_eq!(
            f.pool_client.try_pause(caller),
            Err(Ok(ContractError::Unauthorized)),
            "Yield pool allowed non-guardian to pause!"
        );
        assert!(!f.pool_client.is_paused());

        // SY Blend Wrapper
        assert_eq!(
            f.sy_client.try_pause(caller),
            Err(Ok(ContractError::Unauthorized)),
            "SY wrapper allowed non-guardian to pause!"
        );
        assert!(!f.sy_client.is_paused());

        // PT Token
        assert_eq!(
            f.pt_client.try_pause(caller),
            Err(Ok(ContractError::Unauthorized)),
            "PT token allowed non-guardian to pause!"
        );
        assert!(!f.pt_client.is_paused());

        // YT Token
        assert_eq!(
            f.yt_client.try_pause(caller),
            Err(Ok(ContractError::Unauthorized)),
            "YT token allowed non-guardian to pause!"
        );
        assert!(!f.yt_client.is_paused());
    }
}

// =============================================================================
// Test 2: Strict Guardian Unpause Invalidation & Admin Authority
// =============================================================================

#[test]
fn test_stress_guardian_unpause_strictly_forbidden_across_all_contracts() {
    let f = setup_stress_fixture();

    // Guardian pauses all 4 contracts
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    assert!(f.pool_client.is_paused());
    assert!(f.sy_client.is_paused());
    assert!(f.pt_client.is_paused());
    assert!(f.yt_client.is_paused());

    // Guardian ATTEMPTS to unpause -> MUST BE REJECTED WITH Unauthorized
    assert_eq!(
        f.pool_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized)),
        "CRITICAL VULNERABILITY: Guardian was able to unpause yield_pool!"
    );
    assert_eq!(
        f.sy_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized)),
        "CRITICAL VULNERABILITY: Guardian was able to unpause sy_blend_wrapper!"
    );
    assert_eq!(
        f.pt_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized)),
        "CRITICAL VULNERABILITY: Guardian was able to unpause pt_token!"
    );
    assert_eq!(
        f.yt_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized)),
        "CRITICAL VULNERABILITY: Guardian was able to unpause yt_token!"
    );

    // Other unauthorized callers also rejected
    let others = [&f.rogue_attacker, &f.user1, &f.prospective_admin];
    for caller in others.iter() {
        assert_eq!(
            f.pool_client.try_unpause(caller),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(
            f.sy_client.try_unpause(caller),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(
            f.pt_client.try_unpause(caller),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(
            f.yt_client.try_unpause(caller),
            Err(Ok(ContractError::Unauthorized))
        );
    }

    // Contracts MUST remain paused
    assert!(f.pool_client.is_paused());
    assert!(f.sy_client.is_paused());
    assert!(f.pt_client.is_paused());
    assert!(f.yt_client.is_paused());

    // Admin unpauses cleanly
    f.pool_client.unpause(&f.admin);
    f.sy_client.unpause(&f.admin);
    f.pt_client.unpause(&f.admin);
    f.yt_client.unpause(&f.admin);

    assert!(!f.pool_client.is_paused());
    assert!(!f.sy_client.is_paused());
    assert!(!f.pt_client.is_paused());
    assert!(!f.yt_client.is_paused());

    // Calling unpause again when already unpaused returns ContractNotPaused
    assert_eq!(
        f.pool_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );
    assert_eq!(
        f.sy_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );
    assert_eq!(
        f.pt_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );
    assert_eq!(
        f.yt_client.try_unpause(&f.admin),
        Err(Ok(ContractError::ContractNotPaused))
    );
}

// =============================================================================
// Test 3: Exhaustive State-Mutating Entrypoint Gating Under Paused State
// =============================================================================

#[test]
fn test_stress_all_state_mutating_entrypoints_gated_under_pause() {
    let f = setup_stress_fixture();

    // 1. Seed protocol with active liquidity and user balances while unpaused
    let seed_amount = 5_000_000_000i128; // 5,000 USDC
    f.usdc_admin_client.mint(&f.user1, &seed_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_000_000_000, &1_000_000_000, &1);

    // Also approve allowances for transfer_from / burn_from tests
    f.pool_client
        .approve(&f.user1, &f.user2, &100_000_000, &100_000);
    f.sy_client
        .approve(&f.user1, &f.user2, &100_000_000, &100_000);
    f.pt_client
        .approve(&f.user1, &f.user2, &100_000_000, &100_000);
    f.yt_client
        .approve(&f.user1, &f.user2, &100_000_000, &100_000);

    // 2. Pause all 4 contracts via Guardian
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    // =========================================================================
    // Contract A: yield_pool (15 mutating entrypoints + 1 redundant pause)
    // =========================================================================
    assert_eq!(
        f.pool_client
            .try_mint_py(&f.user1, &f.user1, &10_000, &f.maturity),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::mint_py not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_redeem_py(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::redeem_py not gated by pause!"
    );
    assert_eq!(
        f.pool_client
            .try_redeem_pt_post_maturity(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::redeem_pt_post_maturity not gated by pause!"
    );
    assert_eq!(
        f.pool_client
            .try_redeem_pt_to_btoken(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::redeem_pt_to_btoken not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_claim_yield(&f.user1, &f.user1),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::claim_yield not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_swap_exact_pt_for_sy(
            &f.user1,
            &f.user1,
            &10_000,
            &1,
            &f.maturity,
        ),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::swap_exact_pt_for_sy not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_swap_exact_sy_for_pt(
            &f.user1,
            &f.user1,
            &10_000,
            &1,
            &f.maturity,
        ),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::swap_exact_sy_for_pt not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_swap_exact_sy_for_yt(
            &f.user1,
            &f.user1,
            &10_000,
            &1,
            &f.maturity,
        ),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::swap_exact_sy_for_yt not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_swap_exact_yt_for_sy(
            &f.user1,
            &f.user1,
            &10_000,
            &1,
            &f.maturity,
        ),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::swap_exact_yt_for_sy not gated by pause!"
    );
    assert_eq!(
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &10_000, &10_000, &1),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::add_liquidity not gated by pause!"
    );
    assert_eq!(
        f.pool_client
            .try_remove_liquidity(&f.user1, &f.user1, &10_000, &1, &1),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::remove_liquidity not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_burn(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::burn not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::burn_from not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_transfer(&f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::transfer not gated by pause!"
    );
    assert_eq!(
        f.pool_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::transfer_from not gated by pause!"
    );
    assert_eq!(
        f.pool_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused)),
        "yield_pool::pause allowed redundant pause!"
    );

    // =========================================================================
    // Contract B: sy_blend_wrapper (7 mutating entrypoints + 1 redundant pause)
    // =========================================================================
    assert_eq!(
        f.sy_client.try_deposit(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::deposit not gated by pause!"
    );
    assert_eq!(
        f.sy_client.try_redeem(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::redeem not gated by pause!"
    );
    assert_eq!(
        f.sy_client
            .try_redeem_to_btoken(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::redeem_to_btoken not gated by pause!"
    );
    assert_eq!(
        f.sy_client.try_transfer(&f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::transfer not gated by pause!"
    );
    assert_eq!(
        f.sy_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::transfer_from not gated by pause!"
    );
    assert_eq!(
        f.sy_client.try_burn(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::burn not gated by pause!"
    );
    assert_eq!(
        f.sy_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::burn_from not gated by pause!"
    );
    assert_eq!(
        f.sy_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused)),
        "sy_blend_wrapper::pause allowed redundant pause!"
    );

    // =========================================================================
    // Contract C: pt_token (5 mutating entrypoints + 1 redundant pause)
    // =========================================================================
    assert_eq!(
        f.pt_client.try_mint(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::mint not gated by pause!"
    );
    assert_eq!(
        f.pt_client.try_burn(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::burn not gated by pause!"
    );
    assert_eq!(
        f.pt_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::burn_from not gated by pause!"
    );
    assert_eq!(
        f.pt_client.try_transfer(&f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::transfer not gated by pause!"
    );
    assert_eq!(
        f.pt_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::transfer_from not gated by pause!"
    );
    assert_eq!(
        f.pt_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused)),
        "pt_token::pause allowed redundant pause!"
    );

    // =========================================================================
    // Contract D: yt_token (6 mutating entrypoints + 1 redundant pause)
    // =========================================================================
    assert_eq!(
        f.yt_client.try_mint(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::mint not gated by pause!"
    );
    assert_eq!(
        f.yt_client.try_burn(&f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::burn not gated by pause!"
    );
    assert_eq!(
        f.yt_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::burn_from not gated by pause!"
    );
    assert_eq!(
        f.yt_client.try_claim_user_yield(&f.user1),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::claim_user_yield not gated by pause!"
    );
    assert_eq!(
        f.yt_client.try_transfer(&f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::transfer not gated by pause!"
    );
    assert_eq!(
        f.yt_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::transfer_from not gated by pause!"
    );
    assert_eq!(
        f.yt_client.try_pause(&f.guardian),
        Err(Ok(ContractError::ContractPaused)),
        "yt_token::pause allowed redundant pause!"
    );
}

// =============================================================================
// Test 4: Exhaustive Query / Read-Only Entrypoint Verification Under Paused State
// =============================================================================

#[test]
fn test_stress_all_queries_succeed_under_pause() {
    let f = setup_stress_fixture();

    // Seed state first
    let seed_amount = 2_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &500_000_000, &500_000_000, &1);
    f.pool_client
        .approve(&f.user1, &f.user2, &50_000_000, &50_000);
    f.sy_client
        .approve(&f.user1, &f.user2, &50_000_000, &50_000);
    f.pt_client
        .approve(&f.user1, &f.user2, &50_000_000, &50_000);
    f.yt_client
        .approve(&f.user1, &f.user2, &50_000_000, &50_000);

    // Pause all 4 contracts
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    // 1. yield_pool queries
    let state = f.pool_client.get_market_state();
    assert!(state.total_lp_supply > 0);
    assert!(state.total_pt_reserve > 0);
    assert!(state.total_sy_reserve > 0);
    assert!(f.pool_client.get_exchange_rate() > 0);
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert!(pt_res > 0 && sy_res > 0);
    assert!(f.pool_client.total_supply() > 0);
    assert!(f.pool_client.balance(&f.user1) > 0);
    assert_eq!(f.pool_client.allowance(&f.user1, &f.user2), 50_000_000);
    assert_eq!(f.pool_client.decimals(), 7);
    assert_eq!(
        f.pool_client.name(),
        String::from_str(&f.env, "NivoraFi LP aaa")
    );
    assert_eq!(f.pool_client.symbol(), String::from_str(&f.env, "LP-aaa"));
    assert!(f.pool_client.is_paused());
    assert_eq!(f.pool_client.get_admin(), f.admin);
    assert_eq!(f.pool_client.get_pending_admin(), None);
    assert_eq!(f.pool_client.get_guardian(), Some(f.guardian.clone()));

    // 2. sy_blend_wrapper queries
    assert_eq!(f.sy_client.exchange_rate(), SCALAR_9);
    assert!(f.sy_client.total_shares() > 0);
    assert!(f.sy_client.total_supply() > 0);
    assert!(f.sy_client.balance(&f.user1) > 0);
    assert_eq!(f.sy_client.allowance(&f.user1, &f.user2), 50_000_000);
    assert_eq!(f.sy_client.decimals(), 7);
    assert_eq!(
        f.sy_client.name(),
        String::from_str(&f.env, "Standardized Yield Blend aaa")
    );
    assert_eq!(f.sy_client.symbol(), String::from_str(&f.env, "sy-baaa"));
    assert!(f.sy_client.is_paused());
    assert_eq!(f.sy_client.get_admin(), f.admin);
    assert_eq!(f.sy_client.get_pending_admin(), None);
    assert_eq!(f.sy_client.get_guardian(), Some(f.guardian.clone()));

    // 3. pt_token queries
    assert!(f.pt_client.total_supply() > 0);
    assert!(f.pt_client.balance(&f.user1) > 0);
    assert_eq!(f.pt_client.allowance(&f.user1, &f.user2), 50_000_000);
    assert_eq!(f.pt_client.decimals(), 7);
    assert_eq!(f.pt_client.maturity(), f.maturity);
    assert_eq!(
        f.pt_client.name(),
        String::from_str(&f.env, "Pendle PT 180D")
    );
    assert_eq!(f.pt_client.symbol(), String::from_str(&f.env, "PT-180D"));
    assert!(f.pt_client.is_paused());
    assert_eq!(f.pt_client.get_admin(), f.admin);
    assert_eq!(f.pt_client.get_pending_admin(), None);
    assert_eq!(f.pt_client.get_guardian(), Some(f.guardian.clone()));

    // 4. yt_token queries
    assert!(f.yt_client.total_supply() > 0);
    assert!(f.yt_client.balance(&f.user1) > 0);
    assert_eq!(f.yt_client.allowance(&f.user1, &f.user2), 50_000_000);
    assert_eq!(f.yt_client.decimals(), 7);
    assert_eq!(f.yt_client.maturity(), f.maturity);
    assert_eq!(
        f.yt_client.name(),
        String::from_str(&f.env, "Pendle YT 180D")
    );
    assert_eq!(f.yt_client.symbol(), String::from_str(&f.env, "YT-180D"));
    let u1_yt = f.yt_client.get_user_yield_state(&f.user1);
    assert!(u1_yt.yt_balance > 0);
    assert!(f.yt_client.is_paused());
    assert_eq!(f.yt_client.get_admin(), f.admin);
    assert_eq!(f.yt_client.get_pending_admin(), None);
    assert_eq!(f.yt_client.get_guardian(), Some(f.guardian.clone()));
}

// =============================================================================
// Test 5: Upgrade Authorization Matrix Across 4 Contracts
// =============================================================================

#[test]
fn test_stress_upgrade_authorization_across_all_contracts() {
    let f = setup_stress_fixture();
    let dummy_hash = BytesN::from_array(&f.env, &[0xAA; 32]);

    let unauthorized_callers = [
        &f.rogue_attacker,
        &f.guardian,
        &f.user1,
        &f.prospective_admin,
    ];

    for caller in unauthorized_callers.iter() {
        assert_eq!(
            f.pool_client.try_upgrade(caller, &dummy_hash),
            Err(Ok(ContractError::Unauthorized)),
            "yield_pool allowed non-admin upgrade!"
        );
        assert_eq!(
            f.sy_client.try_upgrade(caller, &dummy_hash),
            Err(Ok(ContractError::Unauthorized)),
            "sy_blend_wrapper allowed non-admin upgrade!"
        );
        assert_eq!(
            f.pt_client.try_upgrade(caller, &dummy_hash),
            Err(Ok(ContractError::Unauthorized)),
            "pt_token allowed non-admin upgrade!"
        );
        assert_eq!(
            f.yt_client.try_upgrade(caller, &dummy_hash),
            Err(Ok(ContractError::Unauthorized)),
            "yt_token allowed non-admin upgrade!"
        );
    }
}

// =============================================================================
// Test 6: Zero-Hash Upgrade Rejection Boundary Testing Across 4 Contracts
// =============================================================================

#[test]
fn test_stress_upgrade_zero_hash_rejection_all_contracts() {
    let f = setup_stress_fixture();
    let zero_hash = BytesN::from_array(&f.env, &[0u8; 32]);

    assert_eq!(
        f.pool_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash)),
        "yield_pool accepted 32 zero bytes for upgrade hash!"
    );
    assert_eq!(
        f.sy_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash)),
        "sy_blend_wrapper accepted 32 zero bytes for upgrade hash!"
    );
    assert_eq!(
        f.pt_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash)),
        "pt_token accepted 32 zero bytes for upgrade hash!"
    );
    assert_eq!(
        f.yt_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash)),
        "yt_token accepted 32 zero bytes for upgrade hash!"
    );

    // Verify boundary: a hash with 31 zeros and 1 non-zero byte passes zero-hash validation
    let mut nearly_zero = [0u8; 32];
    nearly_zero[31] = 1;
    let non_zero_hash = BytesN::from_array(&f.env, &nearly_zero);

    // Should NOT return InvalidWasmHash (it reaches deployer which fails because hash is not in storage)
    let res = f.pool_client.try_upgrade(&f.admin, &non_zero_hash);
    assert_ne!(
        res,
        Err(Ok(ContractError::InvalidWasmHash)),
        "Non-zero hash was incorrectly flagged as zero hash!"
    );
    assert_ne!(
        res,
        Err(Ok(ContractError::Unauthorized)),
        "Admin was incorrectly marked unauthorized!"
    );
}

// =============================================================================
// Test 7: Rapid Pause / Unpause Churn and Temporal Resilience
// =============================================================================

#[test]
fn test_stress_pause_unpause_churn_rapid_cycles() {
    let f = setup_stress_fixture();

    let seed = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed);
    f.sy_client.deposit(&f.user1, &f.user1, &seed);

    // Cycle 25 consecutive times between Guardian pause and Admin unpause
    for _cycle in 0..25 {
        // 1. Guardian pauses
        f.pool_client.pause(&f.guardian);
        assert!(f.pool_client.is_paused());

        // Gated operation must fail
        assert_eq!(
            f.pool_client
                .try_mint_py(&f.user1, &f.user1, &1000, &f.maturity),
            Err(Ok(ContractError::ContractPaused))
        );

        // 2. Admin unpauses
        f.pool_client.unpause(&f.admin);
        assert!(!f.pool_client.is_paused());

        // Gated operation must now succeed
        let (pt, yt) = f
            .pool_client
            .mint_py(&f.user1, &f.user1, &10_000, &f.maturity);
        assert_eq!(pt, 10_000);
        assert_eq!(yt, 10_000);

        // Advance ledger sequence and time slightly
        f.env.ledger().with_mut(|li| {
            li.timestamp += 3600; // 1 hour
            li.sequence_number += 720;
        });
    }

    // Verify final state is healthy and total minted PT/YT matches
    assert_eq!(f.pt_client.total_supply(), 25 * 10_000);
    assert_eq!(f.yt_client.total_supply(), 25 * 10_000);
}

// =============================================================================
// Test 8: Governance Lifecycle During Emergency Pause
// =============================================================================

#[test]
fn test_stress_admin_and_guardian_rotation_while_contract_is_paused() {
    let f = setup_stress_fixture();

    // 1. Guardian pauses all contracts
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    assert!(f.pool_client.is_paused());

    // 2. Admin proposes prospective_admin while contracts are PAUSED
    f.pool_client.propose_admin(&f.admin, &f.prospective_admin);
    assert_eq!(
        f.pool_client.get_pending_admin(),
        Some(f.prospective_admin.clone())
    );

    // Prospective admin accepts while paused
    f.pool_client.accept_admin(&f.prospective_admin);
    assert_eq!(f.pool_client.get_admin(), f.prospective_admin);
    assert_eq!(f.pool_client.get_pending_admin(), None);

    // 3. Old admin attempts to unpause -> REJECTED (no longer admin)
    assert_eq!(
        f.pool_client.try_unpause(&f.admin),
        Err(Ok(ContractError::Unauthorized)),
        "Old admin was able to unpause after transferring admin rights!"
    );

    // 4. New admin rotates guardian while paused
    let new_guardian = Address::generate(&f.env);
    f.pool_client
        .set_guardian(&f.prospective_admin, &new_guardian);
    assert_eq!(f.pool_client.get_guardian(), Some(new_guardian.clone()));

    // 5. New admin unpauses cleanly
    f.pool_client.unpause(&f.prospective_admin);
    assert!(!f.pool_client.is_paused());

    // 6. Old guardian attempts to pause again -> REJECTED (no longer guardian)
    assert_eq!(
        f.pool_client.try_pause(&f.guardian),
        Err(Ok(ContractError::Unauthorized)),
        "Old guardian was able to pause after guardian rotation!"
    );

    // 7. New guardian pauses cleanly
    f.pool_client.pause(&new_guardian);
    assert!(f.pool_client.is_paused());
}

// =============================================================================
// Test 9: Adversarial Audit of Approve and Post-Maturity Settlement Under Pause
// =============================================================================

#[test]
fn test_stress_approve_and_settle_maturity_behavior_during_pause() {
    let f = setup_stress_fixture();

    // Seed user balances
    let seed = 2_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed);
    f.sy_client.deposit(&f.user1, &f.user1, &seed);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_000_000_000, &f.maturity);

    // Pause all contracts
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    // A. Verify approve behavior:
    // Consistent with OpenZeppelin ERC20Pausable standard, approve modifies allowance metadata
    let allow_amt = 500_000_000i128;
    f.pool_client
        .approve(&f.user1, &f.user2, &allow_amt, &100_000);
    f.sy_client
        .approve(&f.user1, &f.user2, &allow_amt, &100_000);
    f.pt_client
        .approve(&f.user1, &f.user2, &allow_amt, &100_000);
    f.yt_client
        .approve(&f.user1, &f.user2, &allow_amt, &100_000);

    assert_eq!(f.pool_client.allowance(&f.user1, &f.user2), allow_amt);
    assert_eq!(f.sy_client.allowance(&f.user1, &f.user2), allow_amt);
    assert_eq!(f.pt_client.allowance(&f.user1, &f.user2), allow_amt);
    assert_eq!(f.yt_client.allowance(&f.user1, &f.user2), allow_amt);

    // CRITICAL SECURITY INVARIANT:
    // Even though allowance was set, can the approved spender spend or drain funds while paused?
    // ABSOLUTELY NOT! Every transfer_from and burn_from MUST revert with ContractPaused!
    assert_eq!(
        f.pool_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.pt_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.yt_client
            .try_transfer_from(&f.user2, &f.user1, &f.user2, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );

    assert_eq!(
        f.pool_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.sy_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.pt_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.yt_client.try_burn_from(&f.user2, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused))
    );

    // B. Advance past maturity while paused
    f.env.ledger().with_mut(|li| {
        li.timestamp = f.maturity + 1000;
        li.sequence_number += 10_000;
    });

    // settle_maturity can be queried/computed
    let settled_rate = f.pool_client.settle_maturity();
    assert!(settled_rate > 0);

    // But post-maturity redemption MUST STILL BE REVERTED while paused!
    assert_eq!(
        f.pool_client
            .try_redeem_pt_post_maturity(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "Post-maturity redemption succeeded while contract was paused!"
    );
    assert_eq!(
        f.pool_client
            .try_redeem_pt_to_btoken(&f.user1, &f.user1, &10_000),
        Err(Ok(ContractError::ContractPaused)),
        "Post-maturity redemption to btoken succeeded while contract was paused!"
    );

    // Unpause by Admin: now redemption succeeds
    f.pool_client.unpause(&f.admin);
    f.sy_client.unpause(&f.admin);
    f.pt_client.unpause(&f.admin);
    f.yt_client.unpause(&f.admin);

    let redeemed = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &10_000);
    assert!(redeemed > 0);
}

// =============================================================================
// Test 10: Organic Dynamic Yield Accrual Conservation Across Extended Pause
// =============================================================================

#[test]
fn test_stress_yield_accrual_conservation_under_extended_pause() {
    let f = setup_stress_fixture();

    // Set 10% annual APR on mock blend
    f.blend_client.set_annual_rate(&(WAD / 10));

    // Seed user positions
    let amount = 10_000_000_000i128; // 10,000 USDC
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    // Pause all contracts
    f.pool_client.pause(&f.guardian);
    f.sy_client.pause(&f.guardian);
    f.pt_client.pause(&f.guardian);
    f.yt_client.pause(&f.guardian);

    // Fast-forward 60 days while paused
    f.env.ledger().with_mut(|li| {
        li.timestamp += 60 * 86400;
        li.sequence_number += 60 * 17280;
    });

    // Mock blend accrues organic interest
    f.blend_client.accrue();

    // Yield claim must be blocked during pause
    assert_eq!(
        f.pool_client.try_claim_yield(&f.user1, &f.user1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.yt_client.try_claim_user_yield(&f.user1),
        Err(Ok(ContractError::ContractPaused))
    );

    // Unpause contracts
    f.pool_client.unpause(&f.admin);
    f.sy_client.unpause(&f.admin);
    f.pt_client.unpause(&f.admin);
    f.yt_client.unpause(&f.admin);

    // Claim yield now that unpaused: all 60 days of yield are preserved and claimed!
    let claimed = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(
        claimed > 0,
        "No yield was accrued or claimed after unpause!"
    );

    // Expected 60 days yield on 10,000 at 10% APR is roughly ~164 tokens
    // 10,000 * 0.10 * 60 / 365 = ~164.38
    // With 7 decimals: ~164_000_000
    assert!(
        (150_000_000..=175_000_000).contains(&claimed),
        "Yield claim amount {} out of expected ~164_000_000 range",
        claimed
    );
}

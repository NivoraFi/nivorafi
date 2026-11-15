#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::GovernanceClient;
use common::storage_keys::DataKey;
use common::ttl::{
    bump_allowance_ttl, calculate_bump_threshold, calculate_bump_to, DEFAULT_BUMP_TO,
    MAX_NETWORK_TTL, MIN_BUMP_THRESHOLD,
};
use common::yield_math::{calculate_tau_wad, check_market_proportion, get_exchange_rate};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, BytesN, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient, MINIMUM_LIQUIDITY};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct HardeningFixture<'a> {
    env: Env,
    admin: Address,
    user1: Address,
    user2: Address,
    attacker: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    blend_client: MockBlendClient<'a>,
    sy_client: StandardizedYieldClient<'a>,
    pt_client: PrincipalTokenClient<'a>,
    yt_client: YieldTokenClient<'a>,
    pool_client: YieldPoolClient<'a>,
    maturity: u64,
}

fn setup_hardening<'a>() -> HardeningFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let attacker = Address::generate(&env);

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

    HardeningFixture {
        env,
        admin,
        user1,
        user2,
        attacker,
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

#[allow(dead_code)]
struct GovernanceHardeningFixture<'a> {
    base: HardeningFixture<'a>,
    guardian: Address,
    prospective_admin: Address,
    rogue_attacker: Address,
    alternate_user: Address,
}

fn setup_governance_fixture<'a>() -> GovernanceHardeningFixture<'a> {
    let base = setup_hardening();
    let guardian = Address::generate(&base.env);
    let prospective_admin = Address::generate(&base.env);
    let rogue_attacker = Address::generate(&base.env);
    let alternate_user = Address::generate(&base.env);

    // Configure guardian across all contracts
    base.pool_client.set_guardian(&base.admin, &guardian);
    base.sy_client.set_guardian(&base.admin, &guardian);
    base.pt_client.set_guardian(&base.admin, &guardian);
    base.yt_client.set_guardian(&base.admin, &guardian);

    GovernanceHardeningFixture {
        base,
        guardian,
        prospective_admin,
        rogue_attacker,
        alternate_user,
    }
}

// =============================================================================
// 1. REENTRANCY LOCK EXHAUSTIVE REJECTION TEST
// =============================================================================

#[test]
fn test_security_all_11_reentrancy_guards_active() {
    let f = setup_hardening();

    // Seed pool with initial liquidity
    let seed_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // Fund user2 for operations
    let user2_fund = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_fund);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_fund);
    f.pool_client.mint_py(&f.user2, &f.user2, &100_000_000);

    // Now engage the reentrancy lock (FlashLoanGuard in temporary storage)
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().set(&guard_key, &true);
    });

    // 1. mint_py must reject
    let err_mint = f.pool_client.try_mint_py(&f.user2, &f.user2, &10_000);
    assert_eq!(err_mint, Err(Ok(ContractError::ReentrancyLocked)));

    // 2. redeem_py must reject
    let err_redeem_py = f.pool_client.try_redeem_py(&f.user2, &f.user2, &10_000);
    assert_eq!(err_redeem_py, Err(Ok(ContractError::ReentrancyLocked)));

    // 3. redeem_pt_post_maturity must reject
    let err_redeem_post = f
        .pool_client
        .try_redeem_pt_post_maturity(&f.user2, &f.user2, &10_000);
    assert_eq!(err_redeem_post, Err(Ok(ContractError::ReentrancyLocked)));

    // 4. redeem_pt_to_btoken must reject
    let err_redeem_btok = f
        .pool_client
        .try_redeem_pt_to_btoken(&f.user2, &f.user2, &10_000);
    assert_eq!(err_redeem_btok, Err(Ok(ContractError::ReentrancyLocked)));

    // 5. claim_yield must reject
    let err_claim = f.pool_client.try_claim_yield(&f.user2, &f.user2);
    assert_eq!(err_claim, Err(Ok(ContractError::ReentrancyLocked)));

    // 6. swap_exact_pt_for_sy must reject
    let err_swap_pt_sy = f
        .pool_client
        .try_swap_exact_pt_for_sy(&f.user2, &f.user2, &10_000, &1);
    assert_eq!(err_swap_pt_sy, Err(Ok(ContractError::ReentrancyLocked)));

    // 7. swap_exact_sy_for_pt must reject
    let err_swap_sy_pt = f
        .pool_client
        .try_swap_exact_sy_for_pt(&f.user2, &f.user2, &10_000, &1);
    assert_eq!(err_swap_sy_pt, Err(Ok(ContractError::ReentrancyLocked)));

    // 8. swap_exact_sy_for_yt must reject
    let err_swap_sy_yt = f
        .pool_client
        .try_swap_exact_sy_for_yt(&f.user2, &f.user2, &10_000, &1);
    assert_eq!(err_swap_sy_yt, Err(Ok(ContractError::ReentrancyLocked)));

    // 9. swap_exact_yt_for_sy must reject
    let err_swap_yt_sy = f
        .pool_client
        .try_swap_exact_yt_for_sy(&f.user2, &f.user2, &10_000, &1);
    assert_eq!(err_swap_yt_sy, Err(Ok(ContractError::ReentrancyLocked)));

    // 10. add_liquidity must reject
    let err_add_liq = f
        .pool_client
        .try_add_liquidity(&f.user2, &f.user2, &10_000, &10_000, &1);
    assert_eq!(err_add_liq, Err(Ok(ContractError::ReentrancyLocked)));

    // 11. remove_liquidity must reject
    let err_rem_liq = f
        .pool_client
        .try_remove_liquidity(&f.user2, &f.user2, &10_000, &1, &1);
    assert_eq!(err_rem_liq, Err(Ok(ContractError::ReentrancyLocked)));

    // Release reentrancy guard
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().remove(&guard_key);
    });

    // Now all operations succeed cleanly
    let (pt, yt) = f.pool_client.mint_py(&f.user2, &f.user2, &10_000);
    assert_eq!(pt, 10_000);
    assert_eq!(yt, 10_000);
}

// =============================================================================
// 2. AUTHORIZATION ENFORCEMENT & REJECTION TESTS
// =============================================================================

#[test]
fn test_security_unauthorized_fee_recipient_rejection() {
    let f = setup_hardening();

    // Attacker cannot change fee recipient (pretending to be admin or passing attacker address)
    let err = f
        .pool_client
        .try_set_fee_recipient(&f.attacker, &f.attacker);
    assert_eq!(err, Err(Ok(ContractError::Unauthorized)));

    // Genuine admin succeeds
    let new_recip = Address::generate(&f.env);
    f.pool_client.set_fee_recipient(&f.admin, &new_recip);
    let state = f.pool_client.get_market_state();
    assert_eq!(state.fee_recipient, new_recip);
}

#[test]
fn test_security_auth_invocation_recordings() {
    let f = setup_hardening();
    let amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);

    // 1. mint_py must record user1's auth
    f.pool_client.mint_py(&f.user1, &f.user1, &10_000_000);
    let auths = f.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == f.user1));

    // 2. pt_token transfer must record from's auth
    f.pt_client.transfer(&f.user1, &f.user2, &1_000_000);
    let auths = f.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == f.user1));

    // 3. sy_blend_wrapper transfer must record from's auth
    f.sy_client.transfer(&f.user1, &f.user2, &1_000_000);
    let auths = f.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == f.user1));

    // 4. yt_token transfer must record from's auth
    f.yt_client.transfer(&f.user1, &f.user2, &1_000_000);
    let auths = f.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == f.user1));

    // 5. mock_blend set_b_rate must record admin's auth
    f.blend_client.set_b_rate(&1_080_000_000);
    let auths = f.env.auths();
    assert!(auths.iter().any(|(addr, _)| *addr == f.admin));
}

#[test]
fn test_security_privileged_market_auth_on_pt_and_yt() {
    let f = setup_hardening();
    let user = Address::generate(&f.env);

    // PT mint demands market authorization
    f.pt_client.mint(&user, &1000);
    let auths_mint = f.env.auths();
    assert_eq!(auths_mint.len(), 1);
    assert_eq!(
        auths_mint[0].0, f.pool_client.address,
        "PT mint must require market address authorization!"
    );

    // PT burn demands market authorization
    f.pt_client.burn(&user, &500);
    let auths_burn = f.env.auths();
    assert_eq!(auths_burn.len(), 1);
    assert_eq!(
        auths_burn[0].0, f.pool_client.address,
        "PT burn must require market address authorization!"
    );

    // YT mint demands market authorization
    f.yt_client.mint(&user, &1000);
    let auths_yt_mint = f.env.auths();
    assert_eq!(auths_yt_mint.len(), 1);
    assert_eq!(
        auths_yt_mint[0].0, f.pool_client.address,
        "YT mint must require market address authorization!"
    );

    // YT burn demands market authorization
    f.yt_client.burn(&user, &500);
    let auths_yt_burn = f.env.auths();
    assert_eq!(auths_yt_burn.len(), 1);
    assert_eq!(
        auths_yt_burn[0].0, f.pool_client.address,
        "YT burn must require market address authorization!"
    );

    // YT claim_user_yield demands market authorization
    f.yt_client.claim_user_yield(&user);
    let auths_yt_claim = f.env.auths();
    assert_eq!(auths_yt_claim.len(), 1);
    assert_eq!(
        auths_yt_claim[0].0, f.pool_client.address,
        "YT claim_user_yield must require market address authorization!"
    );
}

#[test]
fn test_security_unauthorized_call_fails_without_auth() {
    let env = Env::default();
    // Do NOT call env.mock_all_auths()
    let admin = Address::generate(&env);
    let market = Address::generate(&env);
    let maturity = env.ledger().timestamp() + 180 * 86400;

    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    // Since admin auth was required by initialize() but not provided, try_initialize fails
    let res = pt_client.try_initialize(
        &admin,
        &market,
        &String::from_str(&env, "PT"),
        &String::from_str(&env, "PT"),
        &7u32,
        &maturity,
    );
    assert!(
        res.is_err(),
        "Calling initialize without admin authorization must fail!"
    );
}

// =============================================================================
// 3. STORAGE TTL BOUNDARY EXTENSION VERIFICATION TEST
// =============================================================================

#[test]
fn test_security_storage_ttl_boundary_extensions() {
    let now = 1_000_000_000u64;

    // Case 1: Past maturity -> clamp to DEFAULT_BUMP_TO (120 days)
    assert_eq!(calculate_bump_to(now, now - 1), DEFAULT_BUMP_TO);
    assert_eq!(calculate_bump_to(now, now), DEFAULT_BUMP_TO);

    // Case 2: Maturity = 0 (perpetual contracts like mock_blend, sy_blend_wrapper)
    assert_eq!(calculate_bump_to(now, 0), DEFAULT_BUMP_TO);

    // Case 3: Maturity 1 second into the future
    // remaining = 1s, ledgers = 0, + buffer 30d (518,400) = 518,400 < 120d (2,073,600) -> clamped to DEFAULT_BUMP_TO
    assert_eq!(calculate_bump_to(now, now + 1), DEFAULT_BUMP_TO);

    // Case 4: Maturity 90 days into future
    // 90 days ledgers + 30 days buffer = 120 days -> DEFAULT_BUMP_TO
    let mat_90d = now + 90 * 86400;
    assert_eq!(calculate_bump_to(now, mat_90d), DEFAULT_BUMP_TO);

    // Case 5: Maturity 150 days into future
    // 150 days ledgers + 30 days buffer = 180 days -> MAX_NETWORK_TTL
    let mat_150d = now + 150 * 86400;
    assert_eq!(calculate_bump_to(now, mat_150d), MAX_NETWORK_TTL);

    // Case 6: Maturity 365 days into future -> clamped to MAX_NETWORK_TTL
    let mat_365d = now + 365 * 86400;
    assert_eq!(calculate_bump_to(now, mat_365d), MAX_NETWORK_TTL);

    // Case 7: Threshold calculation
    // Bump to 120 days -> threshold is 120 / 4 = 30 days = MIN_BUMP_THRESHOLD
    let thresh_120 = calculate_bump_threshold(DEFAULT_BUMP_TO);
    assert_eq!(thresh_120, MIN_BUMP_THRESHOLD);

    // Bump to 180 days -> threshold is 180 / 4 = 45 days (777,600 ledgers)
    let thresh_180 = calculate_bump_threshold(MAX_NETWORK_TTL);
    assert_eq!(thresh_180, 777_600);
    assert!(thresh_180 >= MIN_BUMP_THRESHOLD);

    // Case 8: Temporary storage allowance TTL bumping inside contract context
    let f = setup_hardening();
    f.env.as_contract(&f.pool_client.address, || {
        let key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().set(&key, &true);
        let current_seq = f.env.ledger().sequence();

        // Expired or past expiration ledger -> no-op, does not panic
        bump_allowance_ttl(&f.env, &key, current_seq);
        bump_allowance_ttl(&f.env, &key, current_seq.saturating_sub(10));

        // Future expiration ledger -> runs cleanly
        bump_allowance_ttl(&f.env, &key, current_seq + 10_000);
    });
}

// =============================================================================
// 4. AMM PROPORTION BOUNDS [0.04, 0.96] ENFORCEMENT & REJECTION
// =============================================================================

#[test]
fn test_security_amm_proportion_boundaries_and_rejection() {
    let f = setup_hardening();

    // Math level bounds check
    // 1. Lower bound 4%:
    // 40,000 / (40,000 + 960,000) = 40,000 / 1,000,000 = 4% = MIN_MARKET_PROPORTION
    assert!(check_market_proportion(40_000 * WAD, 960_000 * WAD).is_ok());

    // 39,999 / 1,000,000 < 4% -> Err(ProportionOutOfBounds)
    assert_eq!(
        check_market_proportion(39_999 * WAD, 960_001 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );

    // 2. Upper bound 96%:
    // 960,000 / (960,000 + 40,000) = 960,000 / 1,000,000 = 96% = MAX_MARKET_PROPORTION
    assert!(check_market_proportion(960_000 * WAD, 40_000 * WAD).is_ok());

    // 960,001 / 1,000,000 > 96% -> Err(ProportionOutOfBounds)
    assert_eq!(
        check_market_proportion(960_001 * WAD, 39_999 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );

    // 3. Non-positive reserves reject
    assert_eq!(
        check_market_proportion(0, 100 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );
    assert_eq!(
        check_market_proportion(100 * WAD, 0),
        Err(ContractError::ProportionOutOfBounds)
    );
    assert_eq!(
        check_market_proportion(-10, 100 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );

    // Contract level bounds check on initial liquidity provision
    let fund = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &fund);
    f.sy_client.deposit(&f.user1, &f.user1, &fund);
    f.pool_client.mint_py(&f.user1, &f.user1, &2_000_000_000);

    // Initial liquidity with out-of-bounds proportion (< 4%)
    // 10,000 PT and 1,000,000 SY -> proportion = ~0.99% < 4%
    let err_out_of_bounds_low = f
        .pool_client
        .try_add_liquidity(&f.user1, &f.user1, &10_000, &1_000_000, &1);
    assert_eq!(
        err_out_of_bounds_low,
        Err(Ok(ContractError::ProportionOutOfBounds))
    );

    // Initial liquidity with out-of-bounds proportion (> 96%)
    // 1,000,000 PT and 10,000 SY -> proportion = ~99.01% > 96%
    let err_out_of_bounds_high = f
        .pool_client
        .try_add_liquidity(&f.user1, &f.user1, &1_000_000, &10_000, &1);
    assert_eq!(
        err_out_of_bounds_high,
        Err(Ok(ContractError::ProportionOutOfBounds))
    );

    // Valid initial liquidity (55% PT, 45% SY) succeeds
    let valid_lp =
        f.pool_client
            .add_liquidity(&f.user1, &f.user1, &1_100_000_000, &900_000_000, &1);
    assert!(valid_lp > 0);
}

// =============================================================================
// 5. LP SHARE MATH INVARIANTS & DEAD SHARES PROTECTION
// =============================================================================

#[test]
fn test_security_lp_dead_shares_and_dilution_invariants() {
    let f = setup_hardening();

    let fund = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &fund);
    f.sy_client.deposit(&f.user1, &f.user1, &fund);
    f.pool_client.mint_py(&f.user1, &f.user1, &2_000_000_000);

    // 1. Initial deposit smaller than MINIMUM_LIQUIDITY (1000 stroops) must revert with ZeroAmount
    let too_small = f.pool_client.try_add_liquidity(
        &f.user1, &f.user1, &500, // sqrt(500 * 500) = 500 <= 1000
        &500, &1,
    );
    assert_eq!(too_small, Err(Ok(ContractError::ZeroAmount)));

    // 2. Normal initial deposit locks 1000 dead shares
    let pt_init = 1_000_000_000i128;
    let sy_init = 1_000_000_000i128;
    // Expected shares: sqrt(10^9 * 10^9) - 1000 = 10^9 - 1000
    let expected_lp = pt_init - MINIMUM_LIQUIDITY;
    let lp1 = f
        .pool_client
        .add_liquidity(&f.user1, &f.user1, &pt_init, &sy_init, &1);
    assert_eq!(lp1, expected_lp);
    assert_eq!(f.pool_client.total_supply(), pt_init);
    assert_eq!(f.pool_client.balance(&f.user1), expected_lp);

    // 3. Subsequent balanced deposit gets exact proportional LP shares
    f.usdc_admin_client.mint(&f.user2, &fund);
    f.sy_client.deposit(&f.user2, &f.user2, &fund);
    f.pool_client.mint_py(&f.user2, &f.user2, &1_000_000_000);

    let pt_sub = 500_000_000i128;
    let sy_sub = 500_000_000i128;
    let lp2 = f
        .pool_client
        .add_liquidity(&f.user2, &f.user2, &pt_sub, &sy_sub, &1);
    // (500M * 1000M) / 1000M = 500M shares
    assert_eq!(lp2, 500_000_000);
    assert_eq!(f.pool_client.total_supply(), 1_500_000_000);

    // 4. Subsequent imbalanced deposit gets min(pt_share, sy_share)
    // Deposit 200M PT and 100M SY -> pool will credit 100M shares, preventing inflation attacks
    let lp_imbalanced =
        f.pool_client
            .add_liquidity(&f.user2, &f.user2, &200_000_000, &100_000_000, &1);
    // min(200M * 1500M / 1500M, 100M * 1500M / 1500M) = min(200M, 100M) = 100M
    assert_eq!(lp_imbalanced, 100_000_000);

    // 5. Total withdrawal leaves dead shares in pool
    let u1_bal = f.pool_client.balance(&f.user1);
    let (pt_out1, sy_out1) = f
        .pool_client
        .remove_liquidity(&f.user1, &f.user1, &u1_bal, &1, &1);
    assert!(pt_out1 > 0);
    assert!(sy_out1 > 0);
    assert_eq!(f.pool_client.balance(&f.user1), 0);

    let u2_bal = f.pool_client.balance(&f.user2);
    let (pt_out2, sy_out2) = f
        .pool_client
        .remove_liquidity(&f.user2, &f.user2, &u2_bal, &1, &1);
    assert!(pt_out2 > 0);
    assert!(sy_out2 > 0);
    assert_eq!(f.pool_client.balance(&f.user2), 0);

    // Remaining total supply is EXACTLY the 1000 dead shares locked forever
    assert_eq!(f.pool_client.total_supply(), MINIMUM_LIQUIDITY);
    let (rem_pt, rem_sy) = f.pool_client.get_reserves();
    assert!(rem_pt >= MINIMUM_LIQUIDITY);
    assert!(rem_sy >= MINIMUM_LIQUIDITY);
}

// =============================================================================
// 6. NEGATIVE YIELD FLOOR (E >= 1.0 WAD) TRANSCENDENTAL INVARIANTS
// =============================================================================

#[test]
fn test_security_negative_yield_floor_and_transcendental_invariants() {
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;
    let tau_wad = calculate_tau_wad(0, 180 * 86400);

    // 1. Equal reserves -> E = 1.0 WAD exactly
    let e_equal = get_exchange_rate(
        1_000_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    )
    .unwrap();
    assert_eq!(e_equal, WAD);

    // 2. Discounted PT (x > y) -> E > 1.0 WAD (valid yield)
    let e_positive = get_exchange_rate(
        1_200_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    )
    .unwrap();
    assert!(e_positive > WAD);

    // 3. Premium PT (x < y) -> E < 1.0 WAD -> NegativeYieldNotSupported
    let e_negative = get_exchange_rate(
        900_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    );
    assert_eq!(e_negative, Err(ContractError::NegativeYieldNotSupported));

    // 4. Exact maturity tau = 0 -> E = 1.0 WAD unconditionally
    let e_mat =
        get_exchange_rate(900_000 * WAD, 1_000_000 * WAD, 0, scalar_root, rate_anchor).unwrap();
    assert_eq!(e_mat, WAD);

    // 5. Post maturity tau = 0 -> E = 1.0 WAD unconditionally
    let tau_post = calculate_tau_wad(100, 50); // now > maturity
    assert_eq!(tau_post, 0);
    let e_post = get_exchange_rate(
        500_000 * WAD,
        1_000_000 * WAD,
        tau_post,
        scalar_root,
        rate_anchor,
    )
    .unwrap();
    assert_eq!(e_post, WAD);
}

// =============================================================================
// 7. TWO-STEP ADMIN HANDSHAKE TEST SUITE
// =============================================================================

#[test]
fn test_governance_two_step_admin_propose_unauthorized() {
    let f = setup_governance_fixture();

    // Attacker cannot propose admin on pool
    let err_pool = f
        .base
        .pool_client
        .try_propose_admin(&f.rogue_attacker, &f.prospective_admin);
    assert_eq!(err_pool, Err(Ok(ContractError::Unauthorized)));

    // Attacker cannot propose admin on sy
    let err_sy = f
        .base
        .sy_client
        .try_propose_admin(&f.rogue_attacker, &f.prospective_admin);
    assert_eq!(err_sy, Err(Ok(ContractError::Unauthorized)));

    // Attacker cannot propose admin on pt
    let err_pt = f
        .base
        .pt_client
        .try_propose_admin(&f.rogue_attacker, &f.prospective_admin);
    assert_eq!(err_pt, Err(Ok(ContractError::Unauthorized)));

    // Attacker cannot propose admin on yt
    let err_yt = f
        .base
        .yt_client
        .try_propose_admin(&f.rogue_attacker, &f.prospective_admin);
    assert_eq!(err_yt, Err(Ok(ContractError::Unauthorized)));

    assert_eq!(f.base.pool_client.get_admin(), f.base.admin);
    assert_eq!(f.base.pool_client.get_pending_admin(), None);
}

#[test]
fn test_governance_two_step_admin_propose_self_rejected() {
    let f = setup_governance_fixture();
    let err = f
        .base
        .pool_client
        .try_propose_admin(&f.base.admin, &f.base.admin);
    assert_eq!(err, Err(Ok(ContractError::InvalidAdmin)));
}

#[test]
fn test_governance_two_step_admin_accept_no_pending_rejected() {
    let f = setup_governance_fixture();
    let err = f.base.pool_client.try_accept_admin(&f.prospective_admin);
    assert_eq!(err, Err(Ok(ContractError::NoPendingAdmin)));
}

#[test]
fn test_governance_two_step_admin_accept_unauthorized_caller_rejected() {
    let f = setup_governance_fixture();
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.prospective_admin);
    assert_eq!(
        f.base.pool_client.get_pending_admin(),
        Some(f.prospective_admin.clone())
    );

    // Attacker cannot accept
    let err_attacker = f.base.pool_client.try_accept_admin(&f.rogue_attacker);
    assert_eq!(err_attacker, Err(Ok(ContractError::Unauthorized)));

    // Old admin cannot accept
    let err_old_admin = f.base.pool_client.try_accept_admin(&f.base.admin);
    assert_eq!(err_old_admin, Err(Ok(ContractError::Unauthorized)));

    assert_eq!(f.base.pool_client.get_admin(), f.base.admin);
}

#[test]
fn test_governance_two_step_admin_accept_authorized_and_old_admin_revoked() {
    let f = setup_governance_fixture();
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.prospective_admin);
    f.base.pool_client.accept_admin(&f.prospective_admin);

    assert_eq!(f.base.pool_client.get_admin(), f.prospective_admin);
    assert_eq!(f.base.pool_client.get_pending_admin(), None);

    // Old admin is completely stripped of authority
    let dummy_hash = BytesN::from_array(&f.base.env, &[0x11; 32]);
    assert_eq!(
        f.base
            .pool_client
            .try_propose_admin(&f.base.admin, &f.alternate_user),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_set_guardian(&f.base.admin, &f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.pool_client.try_unpause(&f.base.admin),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.pool_client.try_upgrade(&f.base.admin, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_set_fee_recipient(&f.base.admin, &f.alternate_user),
        Err(Ok(ContractError::Unauthorized))
    );

    // New admin has full authority
    f.base
        .pool_client
        .set_fee_recipient(&f.prospective_admin, &f.alternate_user);
    assert_eq!(
        f.base.pool_client.get_market_state().fee_recipient,
        f.alternate_user
    );
}

#[test]
fn test_governance_two_step_admin_propose_overwrite_cancels_previous() {
    let f = setup_governance_fixture();
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.prospective_admin);
    assert_eq!(
        f.base.pool_client.get_pending_admin(),
        Some(f.prospective_admin.clone())
    );

    // Admin overwrites proposal with alternate user
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.alternate_user);
    assert_eq!(
        f.base.pool_client.get_pending_admin(),
        Some(f.alternate_user.clone())
    );

    // Prospective admin is now rejected
    assert_eq!(
        f.base.pool_client.try_accept_admin(&f.prospective_admin),
        Err(Ok(ContractError::Unauthorized))
    );

    // Alternate user accepts and becomes admin
    f.base.pool_client.accept_admin(&f.alternate_user);
    assert_eq!(f.base.pool_client.get_admin(), f.alternate_user);
    assert_eq!(f.base.pool_client.get_pending_admin(), None);
}

#[test]
fn test_governance_two_step_admin_cross_contract_uniformity() {
    let f = setup_governance_fixture();
    let new_admin = f.prospective_admin.clone();

    // Pool
    f.base.pool_client.propose_admin(&f.base.admin, &new_admin);
    f.base.pool_client.accept_admin(&new_admin);
    assert_eq!(f.base.pool_client.get_admin(), new_admin);

    // SY
    f.base.sy_client.propose_admin(&f.base.admin, &new_admin);
    f.base.sy_client.accept_admin(&new_admin);
    assert_eq!(f.base.sy_client.get_admin(), new_admin);

    // PT
    f.base.pt_client.propose_admin(&f.base.admin, &new_admin);
    f.base.pt_client.accept_admin(&new_admin);
    assert_eq!(f.base.pt_client.get_admin(), new_admin);

    // YT
    f.base.yt_client.propose_admin(&f.base.admin, &new_admin);
    f.base.yt_client.accept_admin(&new_admin);
    assert_eq!(f.base.yt_client.get_admin(), new_admin);
}

// =============================================================================
// 8. EMERGENCY PAUSE & UNPAUSE TEST SUITE
// =============================================================================

#[test]
fn test_governance_pause_guardian_configuration_and_rotation() {
    let f = setup_governance_fixture();

    // Non-admin cannot set guardian
    let err = f
        .base
        .pool_client
        .try_set_guardian(&f.rogue_attacker, &f.alternate_user);
    assert_eq!(err, Err(Ok(ContractError::Unauthorized)));

    // Admin rotates guardian
    f.base
        .pool_client
        .set_guardian(&f.base.admin, &f.alternate_user);
    assert_eq!(
        f.base.pool_client.get_guardian(),
        Some(f.alternate_user.clone())
    );

    // Old guardian cannot pause
    assert_eq!(
        f.base.pool_client.try_pause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // New guardian can pause
    f.base.pool_client.pause(&f.alternate_user);
    assert!(f.base.pool_client.is_paused());
}

#[test]
fn test_governance_pause_unauthorized_non_guardian_rejected() {
    let f = setup_governance_fixture();
    let err = f.base.pool_client.try_pause(&f.rogue_attacker);
    assert_eq!(err, Err(Ok(ContractError::Unauthorized)));
    assert!(!f.base.pool_client.is_paused());
}

#[test]
fn test_governance_pause_by_guardian_and_duplicate_rejected() {
    let f = setup_governance_fixture();
    f.base.pool_client.pause(&f.guardian);
    assert!(f.base.pool_client.is_paused());

    // Duplicate pause reverts
    let err = f.base.pool_client.try_pause(&f.guardian);
    assert_eq!(err, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn test_governance_pause_by_admin() {
    let f = setup_governance_fixture();
    f.base.pool_client.pause(&f.base.admin);
    assert!(f.base.pool_client.is_paused());
}

#[test]
fn test_governance_unpause_guardian_rejected_strictly_admin_only() {
    let f = setup_governance_fixture();
    f.base.pool_client.pause(&f.guardian);
    assert!(f.base.pool_client.is_paused());

    // Guardian CANNOT unpause
    let err_guardian = f.base.pool_client.try_unpause(&f.guardian);
    assert_eq!(err_guardian, Err(Ok(ContractError::Unauthorized)));

    // Attacker CANNOT unpause
    let err_attacker = f.base.pool_client.try_unpause(&f.rogue_attacker);
    assert_eq!(err_attacker, Err(Ok(ContractError::Unauthorized)));

    assert!(f.base.pool_client.is_paused());
}

#[test]
fn test_governance_unpause_by_admin_and_duplicate_rejected() {
    let f = setup_governance_fixture();
    f.base.pool_client.pause(&f.guardian);

    // Admin unpauses
    f.base.pool_client.unpause(&f.base.admin);
    assert!(!f.base.pool_client.is_paused());

    // Duplicate unpause reverts
    let err = f.base.pool_client.try_unpause(&f.base.admin);
    assert_eq!(err, Err(Ok(ContractError::ContractNotPaused)));
}

#[test]
fn test_governance_pause_state_changing_methods_fail_yield_pool() {
    let f = setup_governance_fixture();

    // Seed pool liquidity first
    let seed = 2_000_000_000i128;
    f.base.usdc_admin_client.mint(&f.base.user1, &seed);
    f.base
        .sy_client
        .deposit(&f.base.user1, &f.base.user1, &seed);
    f.base
        .pool_client
        .mint_py(&f.base.user1, &f.base.user1, &1_000_000_000);
    f.base.pool_client.add_liquidity(
        &f.base.user1,
        &f.base.user1,
        &1_000_000_000,
        &1_000_000_000,
        &1,
    );

    // Pause yield pool
    f.base.pool_client.pause(&f.guardian);

    // Verify all state-mutating entrypoints revert with ContractPaused
    assert_eq!(
        f.base
            .pool_client
            .try_mint_py(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_redeem_py(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_swap_exact_pt_for_sy(&f.base.user1, &f.base.user1, &1000, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_swap_exact_sy_for_pt(&f.base.user1, &f.base.user1, &1000, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_swap_exact_sy_for_yt(&f.base.user1, &f.base.user1, &1000, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_swap_exact_yt_for_sy(&f.base.user1, &f.base.user1, &1000, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_add_liquidity(&f.base.user1, &f.base.user1, &1000, &1000, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_remove_liquidity(&f.base.user1, &f.base.user1, &1000, &1, &1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_redeem_pt_post_maturity(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_redeem_pt_to_btoken(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_claim_yield(&f.base.user1, &f.base.user1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_transfer(&f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_transfer_from(&f.base.user1, &f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base.pool_client.try_burn(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_burn_from(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );

    // Read-only queries must succeed
    assert!(f.base.pool_client.get_market_state().total_lp_supply > 0);
    assert!(f.base.pool_client.get_exchange_rate() > 0);
    assert!(f.base.pool_client.total_supply() > 0);
    assert_eq!(f.base.pool_client.decimals(), 7);
}

#[test]
fn test_governance_pause_state_changing_methods_fail_sy_wrapper() {
    let f = setup_governance_fixture();
    f.base.sy_client.pause(&f.guardian);

    assert_eq!(
        f.base
            .sy_client
            .try_deposit(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .sy_client
            .try_redeem(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .sy_client
            .try_redeem_to_btoken(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .sy_client
            .try_transfer(&f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .sy_client
            .try_transfer_from(&f.base.user1, &f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base.sy_client.try_burn(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .sy_client
            .try_burn_from(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );

    // Read-only queries succeed
    assert!(f.base.sy_client.exchange_rate() > 0);
    assert_eq!(f.base.sy_client.decimals(), 7);
}

#[test]
fn test_governance_pause_state_changing_methods_fail_pt_and_yt() {
    let f = setup_governance_fixture();
    f.base.pt_client.pause(&f.guardian);
    f.base.yt_client.pause(&f.guardian);

    // PT mutations reject
    assert_eq!(
        f.base.pt_client.try_mint(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base.pt_client.try_burn(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pt_client
            .try_burn_from(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pt_client
            .try_transfer(&f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .pt_client
            .try_transfer_from(&f.base.user1, &f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );

    // YT mutations reject
    assert_eq!(
        f.base.yt_client.try_mint(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base.yt_client.try_burn(&f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .yt_client
            .try_burn_from(&f.base.user1, &f.base.user1, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base.yt_client.try_claim_user_yield(&f.base.user1),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .yt_client
            .try_transfer(&f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );
    assert_eq!(
        f.base
            .yt_client
            .try_transfer_from(&f.base.user1, &f.base.user1, &f.base.user2, &1000),
        Err(Ok(ContractError::ContractPaused))
    );

    // Read queries succeed
    assert_eq!(f.base.pt_client.decimals(), 7);
    assert_eq!(f.base.yt_client.decimals(), 7);
}

#[test]
fn test_governance_pause_read_only_methods_succeed_all_contracts() {
    let f = setup_governance_fixture();

    f.base.pool_client.pause(&f.guardian);
    f.base.sy_client.pause(&f.guardian);
    f.base.pt_client.pause(&f.guardian);
    f.base.yt_client.pause(&f.guardian);

    // Yield pool read-only queries
    assert_eq!(f.base.pool_client.decimals(), 7);
    assert_eq!(
        f.base.pool_client.name(),
        String::from_str(&f.base.env, "Pendle LP Token")
    );
    assert_eq!(
        f.base.pool_client.symbol(),
        String::from_str(&f.base.env, "LP-PT-SY")
    );
    assert_eq!(f.base.pool_client.total_supply(), 0);
    assert_eq!(f.base.pool_client.balance(&f.base.user1), 0);
    assert_eq!(
        f.base.pool_client.allowance(&f.base.user1, &f.base.user2),
        0
    );
    let (r_pt, r_sy) = f.base.pool_client.get_reserves();
    assert_eq!(r_pt, 0);
    assert_eq!(r_sy, 0);

    // SY wrapper read-only queries
    assert_eq!(f.base.sy_client.decimals(), 7);
    assert_eq!(
        f.base.sy_client.name(),
        String::from_str(&f.base.env, "Standardized Yield Blend USDC")
    );
    assert_eq!(
        f.base.sy_client.symbol(),
        String::from_str(&f.base.env, "sy-bUSDC")
    );
    assert_eq!(f.base.sy_client.total_supply(), 0);
    assert_eq!(f.base.sy_client.total_shares(), 0);
    assert_eq!(f.base.sy_client.balance(&f.base.user1), 0);
    assert_eq!(f.base.sy_client.exchange_rate(), SCALAR_9);

    // PT & YT read-only queries
    assert_eq!(f.base.pt_client.decimals(), 7);
    assert_eq!(f.base.pt_client.maturity(), f.base.maturity);
    assert_eq!(f.base.pt_client.total_supply(), 0);

    assert_eq!(f.base.yt_client.decimals(), 7);
    assert_eq!(f.base.yt_client.maturity(), f.base.maturity);
    assert_eq!(f.base.yt_client.total_supply(), 0);
    let yt_state = f.base.yt_client.get_user_yield_state(&f.base.user1);
    assert_eq!(yt_state.yt_balance, 0);
}

#[test]
fn test_governance_unpause_resumes_full_operations_cleanly() {
    let f = setup_governance_fixture();

    // Pause all contracts
    f.base.pool_client.pause(&f.guardian);
    f.base.sy_client.pause(&f.guardian);
    f.base.pt_client.pause(&f.guardian);
    f.base.yt_client.pause(&f.guardian);

    assert!(f.base.pool_client.is_paused());
    assert!(f.base.sy_client.is_paused());
    assert!(f.base.pt_client.is_paused());
    assert!(f.base.yt_client.is_paused());

    // Unpause all contracts by Admin
    f.base.pool_client.unpause(&f.base.admin);
    f.base.sy_client.unpause(&f.base.admin);
    f.base.pt_client.unpause(&f.base.admin);
    f.base.yt_client.unpause(&f.base.admin);

    assert!(!f.base.pool_client.is_paused());
    assert!(!f.base.sy_client.is_paused());
    assert!(!f.base.pt_client.is_paused());
    assert!(!f.base.yt_client.is_paused());

    // Operations resume cleanly
    let seed = 2_000_000_000i128;
    f.base.usdc_admin_client.mint(&f.base.user1, &seed);
    f.base
        .sy_client
        .deposit(&f.base.user1, &f.base.user1, &seed);
    let (pt_out, yt_out) = f
        .base
        .pool_client
        .mint_py(&f.base.user1, &f.base.user1, &1_000_000_000);
    assert_eq!(pt_out, 1_000_000_000);
    assert_eq!(yt_out, 1_000_000_000);

    let lp = f.base.pool_client.add_liquidity(
        &f.base.user1,
        &f.base.user1,
        &500_000_000,
        &500_000_000,
        &1,
    );
    assert!(lp > 0);
}

// =============================================================================
// 9. UPGRADEABILITY TEST SUITE
// =============================================================================

#[test]
fn test_governance_upgrade_unauthorized_rejection() {
    let f = setup_governance_fixture();
    let dummy_hash = BytesN::from_array(&f.base.env, &[0xCC; 32]);

    assert_eq!(
        f.base
            .pool_client
            .try_upgrade(&f.rogue_attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.pool_client.try_upgrade(&f.guardian, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.sy_client.try_upgrade(&f.rogue_attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.pt_client.try_upgrade(&f.rogue_attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.yt_client.try_upgrade(&f.rogue_attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_governance_upgrade_zero_hash_rejection() {
    let f = setup_governance_fixture();
    let zero_hash = BytesN::from_array(&f.base.env, &[0u8; 32]);
    assert_eq!(
        f.base.pool_client.try_upgrade(&f.base.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.base.sy_client.try_upgrade(&f.base.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.base.pt_client.try_upgrade(&f.base.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.base.yt_client.try_upgrade(&f.base.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

#[test]
fn test_governance_upgrade_preserves_storage_and_resumes_operations() {
    let f = setup_governance_fixture();

    // 1. Seed state in yield_pool: liquidity, reserves, user positions
    let seed = 2_000_000_000i128;
    f.base.usdc_admin_client.mint(&f.base.user1, &seed);
    f.base
        .sy_client
        .deposit(&f.base.user1, &f.base.user1, &seed);
    f.base
        .pool_client
        .mint_py(&f.base.user1, &f.base.user1, &1_000_000_000);
    f.base.pool_client.add_liquidity(
        &f.base.user1,
        &f.base.user1,
        &1_000_000_000,
        &1_000_000_000,
        &1,
    );

    // Record pre-upgrade state
    let state_before = f.base.pool_client.get_market_state();
    let total_lp_before = f.base.pool_client.total_supply();
    let user1_bal_before = f.base.pool_client.balance(&f.base.user1);
    let admin_before = f.base.pool_client.get_admin();
    let guardian_before = f.base.pool_client.get_guardian();

    assert!(total_lp_before > 0);
    assert_eq!(user1_bal_before, total_lp_before - MINIMUM_LIQUIDITY);

    // 2. Attempt upgrade with dummy hash -> reaches deployer in host
    let dummy_hash = BytesN::from_array(&f.base.env, &[0xDE; 32]);
    let upgrade_res = f.base.pool_client.try_upgrade(&f.base.admin, &dummy_hash);
    // Deployer in host verifies authorization and hash; in unit tests host rejects unuploaded bytecode
    assert!(upgrade_res.is_err());

    // 3. Post-attempt verification: all storage keys, reserves, admin, guardian completely intact
    let state_after = f.base.pool_client.get_market_state();
    assert_eq!(state_after.total_pt_reserve, state_before.total_pt_reserve);
    assert_eq!(state_after.total_sy_reserve, state_before.total_sy_reserve);
    assert_eq!(state_after.total_lp_supply, state_before.total_lp_supply);
    assert_eq!(f.base.pool_client.total_supply(), total_lp_before);
    assert_eq!(f.base.pool_client.balance(&f.base.user1), user1_bal_before);
    assert_eq!(f.base.pool_client.get_admin(), admin_before);
    assert_eq!(f.base.pool_client.get_guardian(), guardian_before);

    // 4. Contract operations continue with existing reserves
    let rate = f.base.pool_client.get_exchange_rate();
    assert!(rate > 0);
}

// =============================================================================
// 10. MULTISIG SINGLE-KEY COMPROMISE DEFENSE TESTS
// =============================================================================

#[test]
fn test_governance_single_key_compromise_guardian_containment() {
    let f = setup_governance_fixture();

    // 1. Compromised guardian halts pool
    f.base.pool_client.pause(&f.guardian);
    assert!(f.base.pool_client.is_paused());

    // 2. Attacker cannot escalate or drain
    assert_eq!(
        f.base.pool_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_propose_admin(&f.guardian, &f.rogue_attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_set_fee_recipient(&f.guardian, &f.rogue_attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Admin multisig rotates guardian and unpauses
    f.base
        .pool_client
        .set_guardian(&f.base.admin, &f.alternate_user);
    f.base.pool_client.unpause(&f.base.admin);
    assert!(!f.base.pool_client.is_paused());

    // 4. Compromised guardian can no longer pause
    assert_eq!(
        f.base.pool_client.try_pause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_governance_single_key_compromise_two_step_proposal_overwrite() {
    let f = setup_governance_fixture();

    // Rogue single key proposes attacker
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.rogue_attacker);
    assert_eq!(
        f.base.pool_client.get_pending_admin(),
        Some(f.rogue_attacker.clone())
    );

    // Attacker cannot act as admin
    assert_eq!(
        f.base
            .pool_client
            .try_set_guardian(&f.rogue_attacker, &f.rogue_attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin multisig overwrites proposal
    f.base
        .pool_client
        .propose_admin(&f.base.admin, &f.prospective_admin);

    // Attacker attempt to accept fails
    assert_eq!(
        f.base.pool_client.try_accept_admin(&f.rogue_attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // Legitimate nominee accepts
    f.base.pool_client.accept_admin(&f.prospective_admin);
    assert_eq!(f.base.pool_client.get_admin(), f.prospective_admin);
}

#[test]
fn test_governance_single_key_compromise_multisig_threshold_isolation() {
    let f = setup_governance_fixture();

    // Verify auth requirements: non-admin cannot execute privileged operations
    assert_eq!(
        f.base
            .pool_client
            .try_propose_admin(&f.rogue_attacker, &f.prospective_admin),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base.pool_client.try_unpause(&f.rogue_attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.base
            .pool_client
            .try_set_guardian(&f.rogue_attacker, &f.alternate_user),
        Err(Ok(ContractError::Unauthorized))
    );
    let dummy_hash = BytesN::from_array(&f.base.env, &[0x55; 32]);
    assert_eq!(
        f.base
            .pool_client
            .try_upgrade(&f.rogue_attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_governance_client_polymorphism() {
    let f = setup_governance_fixture();
    let gov_pool = GovernanceClient::new(&f.base.env, &f.base.pool_client.address);
    let gov_sy = GovernanceClient::new(&f.base.env, &f.base.sy_client.address);
    let gov_pt = GovernanceClient::new(&f.base.env, &f.base.pt_client.address);
    let gov_yt = GovernanceClient::new(&f.base.env, &f.base.yt_client.address);

    // All contracts report identical initial governance state via polymorphic client
    assert_eq!(gov_pool.get_admin(), f.base.admin);
    assert_eq!(gov_sy.get_admin(), f.base.admin);
    assert_eq!(gov_pt.get_admin(), f.base.admin);
    assert_eq!(gov_yt.get_admin(), f.base.admin);

    assert_eq!(gov_pool.get_guardian(), Some(f.guardian.clone()));
    assert_eq!(gov_sy.get_guardian(), Some(f.guardian.clone()));
    assert_eq!(gov_pt.get_guardian(), Some(f.guardian.clone()));
    assert_eq!(gov_yt.get_guardian(), Some(f.guardian.clone()));

    assert!(!gov_pool.is_paused());
    assert!(!gov_sy.is_paused());
    assert!(!gov_pt.is_paused());
    assert!(!gov_yt.is_paused());

    // Guardian can pause via polymorphic client
    gov_pool.pause(&f.guardian);
    assert!(gov_pool.is_paused());

    // Admin unpauses via polymorphic client
    gov_pool.unpause(&f.base.admin);
    assert!(!gov_pool.is_paused());
}

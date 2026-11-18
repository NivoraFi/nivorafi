#![cfg(test)]
extern crate std;

use common::fixed_point::{SCALAR_9, WAD};
use common::storage_keys::DataKey;
use common::ttl::{
    bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl, calculate_bump_threshold,
    calculate_bump_to, DEFAULT_BUMP_TO, MAX_NETWORK_TTL, MIN_BUMP_THRESHOLD,
};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct TestFixture<'a> {
    env: Env,
    admin: Address,
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

fn setup_fixture<'a>() -> TestFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180 days

    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

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

    TestFixture {
        env,
        admin,
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
// PILLAR 1: Empirical TTL Boundary Calculations and Soroban Runtime Invariants
// =============================================================================

#[test]
fn test_empirical_ttl_boundary_timestamps_exhaustive() {
    let now = 1_700_000_000u64;

    // Boundary 1: 0 (maturity in past, maturity == now, or perpetual maturity == 0)
    assert_eq!(
        calculate_bump_to(now, 0),
        DEFAULT_BUMP_TO,
        "Perpetual maturity=0 must yield DEFAULT_BUMP_TO (120 days)"
    );
    assert_eq!(
        calculate_bump_to(now, now),
        DEFAULT_BUMP_TO,
        "Maturity == now must yield DEFAULT_BUMP_TO (120 days)"
    );
    assert_eq!(
        calculate_bump_to(now, now - 100),
        DEFAULT_BUMP_TO,
        "Past maturity must yield DEFAULT_BUMP_TO (120 days)"
    );

    // Boundary 2: 1 second into the future
    // remaining = 1s, remaining_ledgers = 0, target = 0 + 30d buffer = 30d < 120d -> clamped to DEFAULT_BUMP_TO
    assert_eq!(
        calculate_bump_to(now, now + 1),
        DEFAULT_BUMP_TO,
        "1-second horizon must clamp to DEFAULT_BUMP_TO (120 days)"
    );

    // Boundary 3: 90 days into the future
    // remaining = 90d, 90d + 30d buffer = 120d = DEFAULT_BUMP_TO
    let mat_90d = now + 90 * 86400;
    assert_eq!(
        calculate_bump_to(now, mat_90d),
        DEFAULT_BUMP_TO,
        "90-day horizon (90d + 30d buffer) must exactly equal DEFAULT_BUMP_TO (120 days)"
    );

    // Boundary 4: 150 days into the future
    // remaining = 150d, 150d + 30d buffer = 180d = MAX_NETWORK_TTL
    let mat_150d = now + 150 * 86400;
    assert_eq!(
        calculate_bump_to(now, mat_150d),
        MAX_NETWORK_TTL,
        "150-day horizon (150d + 30d buffer) must exactly equal MAX_NETWORK_TTL (180 days)"
    );

    // Boundary 5: 365 days into the future
    // remaining = 365d, 365d + 30d buffer = 395d > 180d -> clamped to MAX_NETWORK_TTL
    let mat_365d = now + 365 * 86400;
    assert_eq!(
        calculate_bump_to(now, mat_365d),
        MAX_NETWORK_TTL,
        "365-day horizon must clamp to MAX_NETWORK_TTL (180 days)"
    );

    // Additional boundary: Extreme future (e.g. 500 days)
    let mat_500d = now + 500 * 86400;
    assert_eq!(
        calculate_bump_to(now, mat_500d),
        MAX_NETWORK_TTL,
        "500-day horizon must clamp to MAX_NETWORK_TTL (180 days)"
    );

    // Threshold verification across the entire spectrum
    let thresh_120 = calculate_bump_threshold(DEFAULT_BUMP_TO);
    assert_eq!(
        thresh_120, MIN_BUMP_THRESHOLD,
        "120-day bump threshold must be exactly 30 days (MIN_BUMP_THRESHOLD)"
    );
    assert!(thresh_120 < DEFAULT_BUMP_TO);

    let thresh_180 = calculate_bump_threshold(MAX_NETWORK_TTL);
    assert_eq!(
        thresh_180, 777_600,
        "180-day bump threshold must be exactly 45 days (777,600 ledgers)"
    );
    assert!(thresh_180 < MAX_NETWORK_TTL);
    assert!(thresh_180 >= MIN_BUMP_THRESHOLD);

    // Soroban Runtime execution test for all 5 boundaries
    let f = setup_fixture();
    let boundaries = [0, now + 1, mat_90d, mat_150d, mat_365d];
    let key = DataKey::Balance(f.user1.clone());

    f.env.as_contract(&f.pool_client.address, || {
        for &b in boundaries.iter() {
            bump_instance_ttl(&f.env, b);
        }
        f.env.storage().persistent().set(&key, &1000i128);
        for &b in boundaries.iter() {
            bump_persistent_ttl(&f.env, &key, b);
        }
    });

    // Temporary storage allowance TTL bumping
    f.env.as_contract(&f.pool_client.address, || {
        let allow_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().set(&allow_key, &true);
        let seq = f.env.ledger().sequence();
        bump_allowance_ttl(&f.env, &allow_key, seq);
        bump_allowance_ttl(&f.env, &allow_key, seq.saturating_sub(100));
        bump_allowance_ttl(&f.env, &allow_key, seq + 1_000);
        bump_allowance_ttl(&f.env, &allow_key, seq + MAX_NETWORK_TTL);
        bump_allowance_ttl(&f.env, &allow_key, seq + MAX_NETWORK_TTL * 2);
    });
}

// =============================================================================
// PILLAR 2: Unauthenticated Invocations Fail with Authorization Errors
// =============================================================================

#[test]
fn test_empirical_unauthenticated_invocations_fail() {
    let env = Env::default();
    // CRITICAL: env.mock_all_auths() is INTENTIONALLY NOT CALLED
    let admin = Address::generate(&env);
    let market = Address::generate(&env);
    let user = Address::generate(&env);
    let recipient = Address::generate(&env);
    let maturity = env.ledger().timestamp() + 180 * 86400;

    // 1. PT Token initialize without auth fails
    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    let res_pt_init = pt_client.try_initialize(
        &admin,
        &market,
        &String::from_str(&env, "PT"),
        &String::from_str(&env, "PT"),
        &7u32,
        &maturity,
    );
    assert!(
        res_pt_init.is_err(),
        "PT initialize without admin auth must fail!"
    );

    // 2. MockBlend initialize without auth fails
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    let res_blend_init = blend_client.try_initialize(&admin, &user, &SCALAR_9);
    assert!(
        res_blend_init.is_err(),
        "MockBlend initialize without admin auth must fail!"
    );

    // 3. MockBlend set_b_rate without auth fails
    let res_set_b_rate = blend_client.try_set_b_rate(&1_100_000_000);
    assert!(
        res_set_b_rate.is_err(),
        "MockBlend set_b_rate without admin auth must fail!"
    );

    // 4. MockBlend transfer_collateral without auth fails
    let res_trans_collat = blend_client.try_transfer_collateral(&user, &recipient, &100);
    assert!(
        res_trans_collat.is_err(),
        "MockBlend transfer_collateral without user auth must fail!"
    );

    // 5. StandardizedYield initialize without auth fails
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    let res_sy_init = sy_client.try_initialize(&admin, &user, &blend_id);
    assert!(
        res_sy_init.is_err(),
        "SY initialize without admin auth must fail!"
    );

    // 6. StandardizedYield deposit without auth fails
    let res_sy_dep = sy_client.try_deposit(&user, &user, &1000);
    assert!(
        res_sy_dep.is_err(),
        "SY deposit without caller auth must fail!"
    );

    // 7. StandardizedYield transfer without auth fails
    let res_sy_xfer = sy_client.try_transfer(&user, &recipient, &1000);
    assert!(
        res_sy_xfer.is_err(),
        "SY transfer without sender auth must fail!"
    );

    // 8. StandardizedYield burn without auth fails
    let res_sy_burn = sy_client.try_burn(&user, &1000);
    assert!(
        res_sy_burn.is_err(),
        "SY burn without owner auth must fail!"
    );

    // 9. YieldPool initialize without auth fails
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);
    let res_pool_init = pool_client.try_initialize(
        &admin,
        &sy_id,
        &pt_id,
        &pool_id, // placeholder
        &maturity,
        &(20 * WAD),
        &WAD,
    );
    assert!(
        res_pool_init.is_err(),
        "YieldPool initialize without admin auth must fail!"
    );

    let dl = env.ledger().timestamp() + 3600;
    // 10. YieldPool mint_py without auth fails
    let res_pool_mint = pool_client.try_mint_py(&user, &user, &1000, &dl);
    assert!(
        res_pool_mint.is_err(),
        "YieldPool mint_py without caller auth must fail!"
    );

    // 11. YieldPool redeem_py without auth fails
    let res_pool_redeem = pool_client.try_redeem_py(&user, &user, &1000);
    assert!(
        res_pool_redeem.is_err(),
        "YieldPool redeem_py without caller auth must fail!"
    );

    // 12. YieldPool swaps without auth fail
    let res_swap_pt_sy = pool_client.try_swap_exact_pt_for_sy(&user, &user, &1000, &1, &dl);
    assert!(
        res_swap_pt_sy.is_err(),
        "swap_exact_pt_for_sy without caller auth must fail!"
    );

    let res_swap_sy_pt = pool_client.try_swap_exact_sy_for_pt(&user, &user, &1000, &1, &dl);
    assert!(
        res_swap_sy_pt.is_err(),
        "swap_exact_sy_for_pt without caller auth must fail!"
    );

    let res_swap_sy_yt = pool_client.try_swap_exact_sy_for_yt(&user, &user, &1000, &1, &dl);
    assert!(
        res_swap_sy_yt.is_err(),
        "swap_exact_sy_for_yt without caller auth must fail!"
    );

    let res_swap_yt_sy = pool_client.try_swap_exact_yt_for_sy(&user, &user, &1000, &1, &dl);
    assert!(
        res_swap_yt_sy.is_err(),
        "swap_exact_yt_for_sy without caller auth must fail!"
    );

    // 13. YieldPool liquidity without auth fails
    let res_add_liq = pool_client.try_add_liquidity(&user, &user, &1000, &1000, &1);
    assert!(
        res_add_liq.is_err(),
        "add_liquidity without caller auth must fail!"
    );

    let res_rem_liq = pool_client.try_remove_liquidity(&user, &user, &1000, &1, &1);
    assert!(
        res_rem_liq.is_err(),
        "remove_liquidity without caller auth must fail!"
    );

    // 14. YieldPool fee recipient without auth fails
    let res_fee_rec = pool_client.try_set_fee_recipient(&user, &recipient);
    assert!(
        res_fee_rec.is_err(),
        "set_fee_recipient without admin auth must fail!"
    );
}

// =============================================================================
// PILLAR 3: Privileged Market Authorization on PT and YT Tokens
// =============================================================================

#[test]
fn test_empirical_privileged_market_authorization_isolation() {
    let f = setup_fixture();
    let non_market_user = Address::generate(&f.env);

    // PT Mint demands market address authorization exclusively
    f.pt_client.mint(&non_market_user, &50_000);
    let pt_mint_auths = f.env.auths();
    assert_eq!(pt_mint_auths.len(), 1);
    assert_eq!(
        pt_mint_auths[0].0, f.pool_client.address,
        "PT mint must record market address as the authorized caller"
    );

    // PT Burn demands market address authorization exclusively
    f.pt_client.burn(&non_market_user, &20_000);
    let pt_burn_auths = f.env.auths();
    assert_eq!(pt_burn_auths.len(), 1);
    assert_eq!(
        pt_burn_auths[0].0, f.pool_client.address,
        "PT burn must record market address as the authorized caller"
    );

    // YT Mint demands market address authorization exclusively
    f.yt_client.mint(&non_market_user, &50_000);
    let yt_mint_auths = f.env.auths();
    assert_eq!(yt_mint_auths.len(), 1);
    assert_eq!(
        yt_mint_auths[0].0, f.pool_client.address,
        "YT mint must record market address as the authorized caller"
    );

    // YT Burn demands market address authorization exclusively
    f.yt_client.burn(&non_market_user, &20_000);
    let yt_burn_auths = f.env.auths();
    assert_eq!(yt_burn_auths.len(), 1);
    assert_eq!(
        yt_burn_auths[0].0, f.pool_client.address,
        "YT burn must record market address as the authorized caller"
    );

    // YT Claim User Yield demands market address authorization exclusively
    f.yt_client.claim_user_yield(&non_market_user);
    let yt_claim_auths = f.env.auths();
    assert_eq!(yt_claim_auths.len(), 1);
    assert_eq!(
        yt_claim_auths[0].0, f.pool_client.address,
        "YT claim_user_yield must record market address as the authorized caller"
    );

    // Standard transfers demand the user's ('from') authorization, NOT the market
    f.pt_client.transfer(&non_market_user, &f.user1, &5_000);
    let xfer_auths = f.env.auths();
    assert!(
        xfer_auths.iter().any(|(addr, _)| *addr == non_market_user),
        "PT transfer must require 'from' user authorization"
    );
    assert!(
        !xfer_auths
            .iter()
            .any(|(addr, _)| *addr == f.pool_client.address),
        "PT transfer must NOT authorize market address"
    );
}

// =============================================================================
// PILLAR 4: Blend Bad-Debt Proportional Haircut under 100% Pool Utilization
// =============================================================================

#[test]
fn test_empirical_blend_bad_debt_100_percent_utilization_haircut() {
    let f = setup_fixture();

    // Two users with unequal shares:
    // User 1 has 600M PT (60%)
    // User 2 has 400M PT (40%)
    // Total PT = 1,000M PT
    let u1_amount = 600_000_000i128;
    let u2_amount = 400_000_000i128;
    let total_amount = u1_amount + u2_amount;

    f.usdc_admin_client.mint(&f.user1, &u1_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &u1_amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &u1_amount, &f.maturity);

    f.usdc_admin_client.mint(&f.user2, &u2_amount);
    f.sy_client.deposit(&f.user2, &f.user2, &u2_amount);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &u2_amount, &f.maturity);

    assert_eq!(f.pt_client.total_supply(), total_amount);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), total_amount);

    // Simulate 50% bad-debt loss in the underlying pool:
    // 500M SY burned out of 1000M SY -> 500M SY remaining
    let bad_debt_loss = 500_000_000i128;
    f.sy_client.burn(&f.pool_client.address, &bad_debt_loss);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 500_000_000);
    assert_eq!(f.pt_client.total_supply(), total_amount);

    // Fast-forward past maturity
    f.env.ledger().set_timestamp(f.maturity + 100);

    // SCENARIO: 100% Blend pool utilization
    // Under 100% utilization, underlying cash (USDC) cannot be withdrawn from Blend.
    // Users exit via redeem_pt_to_btoken to claim raw bToken collateral directly.
    // The pool MUST enforce the 50% proportional haircut on bTokens, guaranteeing
    // zero first-redeemer advantage and complete solvency preservation!

    // Step 1: User 1 redeems full position (600M PT)
    // Haircut H = 500M / 1000M = 50%
    // Expected bTokens = 600M * 50% = 300M bTokens
    let btokens_u1 = f
        .pool_client
        .redeem_pt_to_btoken(&f.user1, &f.user1, &u1_amount);
    assert_eq!(
        btokens_u1, 300_000_000,
        "User 1 must receive exactly 50% haircut recovery (300M bTokens)"
    );
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.blend_client.get_collateral(&f.user1), 300_000_000);
    assert_eq!(f.pt_client.total_supply(), 400_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 200_000_000);

    // Step 2: User 2 redeems full position (400M PT)
    // Haircut H = 200M / 400M = 50%
    // Expected bTokens = 400M * 50% = 200M bTokens
    let btokens_u2 = f
        .pool_client
        .redeem_pt_to_btoken(&f.user2, &f.user2, &u2_amount);
    assert_eq!(
        btokens_u2, 200_000_000,
        "User 2 must receive exactly 50% haircut recovery (200M bTokens)"
    );
    assert_eq!(f.pt_client.balance(&f.user2), 0);
    assert_eq!(f.blend_client.get_collateral(&f.user2), 200_000_000);
    assert_eq!(f.pt_client.total_supply(), 0);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);

    // Verification of invariant properties:
    // 1. Equal recovery rate: User 1 received 300/600 = 50%, User 2 received 200/400 = 50%
    assert_eq!(btokens_u1 * 100 / u1_amount, btokens_u2 * 100 / u2_amount);
    // 2. Exact sum conservation: 300M + 200M = 500M total recovered bTokens
    assert_eq!(btokens_u1 + btokens_u2, 500_000_000);
    // 3. Pool vault SY balance is cleanly 0 without negative debt
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);
}

#[test]
fn test_empirical_blend_100_percent_bad_debt_wipeout_safety() {
    let f = setup_fixture();

    let user3 = Address::generate(&f.env);
    let u3_amount = 100_000_000i128;

    // Mint position BEFORE maturity
    f.usdc_admin_client.mint(&user3, &u3_amount);
    f.sy_client.deposit(&user3, &user3, &u3_amount);
    f.pool_client
        .mint_py(&user3, &user3, &u3_amount, &f.maturity);

    // Wipe out 100% of the pool's SY balance (catastrophic bad-debt failure)
    f.sy_client.burn(&f.pool_client.address, &u3_amount);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);

    // Fast-forward past maturity
    f.env.ledger().set_timestamp(f.maturity + 100);

    // User 3 redeems PT with 0 collateral in vault
    let btokens_u3 = f
        .pool_client
        .redeem_pt_to_btoken(&user3, &user3, &u3_amount);
    assert_eq!(
        btokens_u3, 0,
        "100% wipeout must return 0 bTokens without panic"
    );
    assert_eq!(
        f.pt_client.balance(&user3),
        0,
        "User 3 PT tokens must be burned cleanly"
    );
    assert_eq!(f.pt_client.total_supply(), 0);
}

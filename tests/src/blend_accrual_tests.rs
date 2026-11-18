#![cfg(test)]
extern crate std;

use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::BlendPoolClient;
use mock_blend::MockBlend;
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
pub struct AccrualIntegrationFixture<'a> {
    pub env: Env,
    pub admin: Address,
    pub user1: Address,
    pub user2: Address,
    pub lp_provider: Address,
    pub usdc_client: token::Client<'a>,
    pub usdc_admin_client: token::StellarAssetClient<'a>,
    pub blend_client: BlendPoolClient<'a>,
    pub sy_client: StandardizedYieldClient<'a>,
    pub pt_client: PrincipalTokenClient<'a>,
    pub yt_client: YieldTokenClient<'a>,
    pub pool_client: YieldPoolClient<'a>,
    pub maturity: u64,
    pub t0: u64,
    pub annual_rate: i128,
}

pub fn setup_accrual_protocol<'a>(annual_rate_wad: i128) -> AccrualIntegrationFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let lp_provider = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    let t0 = 1_000_000u64;
    env.ledger().set_timestamp(t0);
    env.ledger().set_sequence_number(100);

    // 1. Mock Blend Pool
    let blend_id = env.register(MockBlend, ());
    let blend_client = BlendPoolClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);
    if annual_rate_wad > 0 {
        blend_client.set_annual_rate(&annual_rate_wad);
    }

    // 2. SY Blend Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    // 180-day maturity
    let maturity = t0 + 180 * 86400;

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

    AccrualIntegrationFixture {
        env,
        admin,
        user1,
        user2,
        lp_provider,
        usdc_client,
        usdc_admin_client,
        blend_client,
        sy_client,
        pt_client,
        yt_client,
        pool_client,
        maturity,
        t0,
        annual_rate: annual_rate_wad,
    }
}

pub fn advance_time_and_ledgers(f: &AccrualIntegrationFixture, delta_seconds: u64) {
    let now = f.env.ledger().timestamp();
    let seq = f.env.ledger().sequence();
    let ledgers = (delta_seconds / 5) as u32; // ~5 seconds per Soroban ledger
    f.env.ledger().set_timestamp(now + delta_seconds);
    f.env.ledger().set_sequence_number(seq + ledgers.max(1));
}

// =============================================================================
// Suite 1: Progressive Ledger Time-Advancement & Organic Accrual
// =============================================================================

#[test]
fn test_progressive_timestamp_accrual_10d_30d_60d_90d() {
    let f = setup_accrual_protocol(WAD / 10); // 10% APR
    let r0 = f.sy_client.exchange_rate();
    assert_eq!(r0, SCALAR_9);

    // Advance 10 days
    advance_time_and_ledgers(&f, 10 * 86400);
    let r10 = f.sy_client.exchange_rate();
    assert!(r10 > r0);
    // 10^9 * (1 + 0.10 * 10 / 365) = 1_002_739_726
    assert!((r10 - 1_002_739_726).abs() <= 5);

    // Advance 20 more days (30 days total)
    advance_time_and_ledgers(&f, 20 * 86400);
    let r30 = f.sy_client.exchange_rate();
    assert!(r30 > r10);
    assert!((r30 - 1_008_234_186).abs() <= 5);

    // Advance 30 more days (60 days total)
    advance_time_and_ledgers(&f, 30 * 86400);
    let r60 = f.sy_client.exchange_rate();
    assert!(r60 > r30);

    // Advance 30 more days (90 days total)
    advance_time_and_ledgers(&f, 30 * 86400);
    let r90 = f.sy_client.exchange_rate();
    assert!(r90 > r60);

    // Strict monotonic organic compound growth
    assert!(r0 < r10 && r10 < r30 && r30 < r60 && r60 < r90);
}

#[test]
fn test_organic_compound_growth_without_admin_intervention() {
    let f = setup_accrual_protocol(WAD / 10); // 10% APR

    let deposit_amount = 1_000_000_000i128; // 1,000 USDC
    f.usdc_admin_client.mint(&f.user1, &deposit_amount);
    let shares = f.sy_client.deposit(&f.user1, &f.user1, &deposit_amount);
    assert_eq!(shares, deposit_amount);

    // Advance 45 days without ANY admin calls
    advance_time_and_ledgers(&f, 45 * 86400);

    let r45 = f.sy_client.exchange_rate();
    assert!(r45 > SCALAR_9);

    let expected_payout = (shares * r45) / SCALAR_9;
    let interest_needed = expected_payout - deposit_amount;
    if interest_needed > 0 {
        f.usdc_admin_client
            .mint(&f.blend_client.address, &interest_needed);
    }

    let payout = f.sy_client.redeem(&f.user1, &f.user1, &shares);
    assert!(payout > deposit_amount);
    assert_eq!(payout, expected_payout);
    assert_eq!(f.usdc_client.balance(&f.user1), expected_payout);
}

#[test]
fn test_zero_time_advancement_idempotency() {
    let f = setup_accrual_protocol(WAD / 10);
    advance_time_and_ledgers(&f, 30 * 86400);

    let r_first = f.sy_client.exchange_rate();
    for _ in 0..25 {
        assert_eq!(f.sy_client.exchange_rate(), r_first);
        assert_eq!(f.blend_client.accrue(), r_first);
    }

    // 0-second advance maintains idempotency
    advance_time_and_ledgers(&f, 0);
    assert_eq!(f.sy_client.exchange_rate(), r_first);
}

#[test]
fn test_variable_annual_interest_rates_and_accrual_scaling() {
    // 1. 0% APR
    let f0 = setup_accrual_protocol(0);
    advance_time_and_ledgers(&f0, 30 * 86400);
    assert_eq!(f0.sy_client.exchange_rate(), SCALAR_9);

    // 2. 5% APR
    let f5 = setup_accrual_protocol(WAD * 5 / 100);
    advance_time_and_ledgers(&f5, 30 * 86400);
    let dr5 = f5.sy_client.exchange_rate() - SCALAR_9;
    assert!(dr5 > 0);

    // 3. 10% APR
    let f10 = setup_accrual_protocol(WAD / 10);
    advance_time_and_ledgers(&f10, 30 * 86400);
    let dr10 = f10.sy_client.exchange_rate() - SCALAR_9;
    assert!(dr10 > dr5);

    // 4. 25% APR
    let f25 = setup_accrual_protocol(WAD * 25 / 100);
    advance_time_and_ledgers(&f25, 30 * 86400);
    let dr25 = f25.sy_client.exchange_rate() - SCALAR_9;
    assert!(dr25 > dr10);

    // Relative scaling ~2.0x and ~2.5x
    let ratio_10_5 = (dr10 * 1000) / dr5;
    assert!((ratio_10_5 - 2000).abs() <= 10);
    let ratio_25_10 = (dr25 * 1000) / dr10;
    assert!((ratio_25_10 - 2500).abs() <= 10);
}

// =============================================================================
// Suite 2: Dynamic YT Accrual & Multi-User Claims
// =============================================================================

#[test]
fn test_yt_holders_claim_organically_accrued_yield_across_horizons() {
    let f = setup_accrual_protocol(WAD / 10); // 10% APR
    let amount = 10_000_000_000i128; // 10,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    assert_eq!(f.pool_client.claim_yield(&f.user1, &f.user1), 0);

    // 10D
    advance_time_and_ledgers(&f, 10 * 86400);
    let c1 = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(c1 > 0);
    assert_eq!(f.pool_client.claim_yield(&f.user1, &f.user1), 0);

    // 30D (20 days further)
    advance_time_and_ledgers(&f, 20 * 86400);
    let c2 = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(c2 > 0);

    // 60D (30 days further)
    advance_time_and_ledgers(&f, 30 * 86400);
    let c3 = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(c3 > 0);

    // 90D (30 days further)
    advance_time_and_ledgers(&f, 30 * 86400);
    let c4 = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(c4 > 0);

    let c_total = c1 + c2 + c3 + c4;
    assert_eq!(f.sy_client.balance(&f.user1), c_total);

    let r90 = f.sy_client.exchange_rate();
    let usdc_value = (c_total * r90) / SCALAR_9;
    f.usdc_admin_client
        .mint(&f.blend_client.address, &usdc_value);

    let payout = f.sy_client.redeem(&f.user1, &f.user1, &c_total);
    assert_eq!(payout, usdc_value);
    assert!(payout > 0);
}

#[test]
fn test_differential_claiming_schedules_yield_convergence() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 5_000_000_000i128; // 5,000 USDC each

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.usdc_admin_client.mint(&f.user2, &amount);

    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.sy_client.deposit(&f.user2, &f.user2, &amount);

    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &amount, &f.maturity);

    // User1 claims progressively: 10D, 30D, 60D, 90D
    advance_time_and_ledgers(&f, 10 * 86400);
    let c1_1 = f.pool_client.claim_yield(&f.user1, &f.user1);

    advance_time_and_ledgers(&f, 20 * 86400);
    let c1_2 = f.pool_client.claim_yield(&f.user1, &f.user1);

    advance_time_and_ledgers(&f, 30 * 86400);
    let c1_3 = f.pool_client.claim_yield(&f.user1, &f.user1);

    advance_time_and_ledgers(&f, 30 * 86400);
    let c1_4 = f.pool_client.claim_yield(&f.user1, &f.user1);

    let user1_total_sy = c1_1 + c1_2 + c1_3 + c1_4;

    // User2 claims ONLY at 90D
    let user2_total_sy = f.pool_client.claim_yield(&f.user2, &f.user2);

    let r90 = f.sy_client.exchange_rate();
    let v1 = (user1_total_sy * r90) / SCALAR_9;
    let v2 = (user2_total_sy * r90) / SCALAR_9;

    // Both claim schedules converge within 0.5%
    let diff = (v1 - v2).abs();
    assert!(diff * 1000 / v2 <= 5);
}

#[test]
fn test_yt_transfer_checkpointing_preserves_accrued_yield_under_dynamic_clock() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 1_000_000_000i128; // 1,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    // Advance 30 days
    advance_time_and_ledgers(&f, 30 * 86400);

    // Transfer 40% of YT to User2
    let transfer_yt = 400_000_000i128;
    f.yt_client.transfer(&f.user1, &f.user2, &transfer_yt);

    let state1 = f.yt_client.get_user_yield_state(&f.user1);
    let state2 = f.yt_client.get_user_yield_state(&f.user2);
    assert!(state1.unclaimed_yield > 0);
    assert_eq!(state2.unclaimed_yield, 0);

    // Advance 30 more days (60D total)
    advance_time_and_ledgers(&f, 30 * 86400);

    let y1 = f.pool_client.claim_yield(&f.user1, &f.user1);
    let y2 = f.pool_client.claim_yield(&f.user2, &f.user2);
    assert!(y1 > 0);
    assert!(y2 > 0);

    // Benchmark comparison: single user with identical amount who checkpoints at 30D without claiming
    let f_bench = setup_accrual_protocol(WAD / 10);
    f_bench.usdc_admin_client.mint(&f_bench.user1, &amount);
    f_bench
        .sy_client
        .deposit(&f_bench.user1, &f_bench.user1, &amount);
    f_bench
        .pool_client
        .mint_py(&f_bench.user1, &f_bench.user1, &amount, &f_bench.maturity);

    advance_time_and_ledgers(&f_bench, 30 * 86400);
    // Checkpoint at 30D via self-transfer without claiming
    f_bench
        .yt_client
        .transfer(&f_bench.user1, &f_bench.user1, &1);

    advance_time_and_ledgers(&f_bench, 30 * 86400);
    let y_bench_total = f_bench
        .pool_client
        .claim_yield(&f_bench.user1, &f_bench.user1);

    // Total yield claimed across transfer split matches benchmark within integer dust
    assert!((y1 + y2 - y_bench_total).abs() <= 5);
}

#[test]
fn test_post_maturity_yt_claim_clamped_at_maturity_index() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    // Advance to maturity (180D)
    advance_time_and_ledgers(&f, 180 * 86400);
    let settled_index = f.pool_client.settle_maturity();

    let claimed_at_maturity = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert!(claimed_at_maturity > 0);

    // Yield was computed up to settled_index (180D)
    let expected_sy = amount - (amount * SCALAR_9) / settled_index;
    assert!((claimed_at_maturity - expected_sy).abs() <= 5);

    // Advance 60 days post-maturity (240D total)
    advance_time_and_ledgers(&f, 60 * 86400);
    let r240 = f.sy_client.exchange_rate();
    assert!(r240 > settled_index);

    // Subsequent post-maturity claims yield 0 because yield stops at maturity
    assert_eq!(f.pool_client.claim_yield(&f.user1, &f.user1), 0);
}

// =============================================================================
// Suite 3: Zero-Deficit & Protocol Solvency Invariants
// =============================================================================

#[test]
fn test_zero_deficit_pool_balance_invariant_under_continuous_accrual() {
    let f = setup_accrual_protocol(WAD / 10);
    let a1 = 1_000_000_000i128;
    let a2 = 2_000_000_000i128;
    let total_sy = a1 + a2;

    f.usdc_admin_client.mint(&f.user1, &a1);
    f.usdc_admin_client.mint(&f.user2, &a2);

    f.sy_client.deposit(&f.user1, &f.user1, &a1);
    f.sy_client.deposit(&f.user2, &f.user2, &a2);

    f.pool_client.mint_py(&f.user1, &f.user1, &a1, &f.maturity);
    f.pool_client.mint_py(&f.user2, &f.user2, &a2, &f.maturity);

    let mut cumulative_claimed = 0i128;

    let steps = [10, 20, 30, 30, 30, 30, 30]; // reaches 180D
    for (i, step) in steps.iter().enumerate() {
        advance_time_and_ledgers(&f, *step * 86400);
        if i % 2 == 0 {
            cumulative_claimed += f.pool_client.claim_yield(&f.user1, &f.user1);
        } else {
            cumulative_claimed += f.pool_client.claim_yield(&f.user2, &f.user2);
        }

        let pool_bal = f.sy_client.balance(&f.pool_client.address);
        // Zero-deficit invariant: pool_balance + sum(claimed) == initial_total_sy
        assert_eq!(pool_bal + cumulative_claimed, total_sy);
        assert!(pool_bal > 0);
    }
}

#[test]
fn test_pt_redemption_post_maturity_full_principal_solvency() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 10_000_000_000i128; // 10,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    // Claim yield periodically across 180D
    for _ in 0..6 {
        advance_time_and_ledgers(&f, 30 * 86400);
        f.pool_client.claim_yield(&f.user1, &f.user1);
    }

    // At maturity (180D)
    let sy_out = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &amount);
    assert!(sy_out > 0);

    // Provide mock blend liquidity for principal redemption
    f.usdc_admin_client.mint(&f.blend_client.address, &amount);

    let usdc_out = f.sy_client.redeem(&f.user1, &f.user1, &sy_out);
    // User recovers full 10,000 USDC principal within integer division dust
    assert!((usdc_out - amount).abs() <= 5);
}

#[test]
fn test_total_underlying_conservation_invariant() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 5_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &amount, &f.maturity);

    advance_time_and_ledgers(&f, 90 * 86400);

    let claimed_sy = f.pool_client.claim_yield(&f.user1, &f.user1);
    let pool_sy = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(claimed_sy + pool_sy, amount);

    let r90 = f.sy_client.exchange_rate();
    let total_underlying_value = ((claimed_sy + pool_sy) * r90) / SCALAR_9;
    assert!(total_underlying_value > amount);
}

// =============================================================================
// Suite 4: AMM Invariants with Dynamic Accrual & Temporal Decay
// =============================================================================

#[test]
fn test_amm_swaps_during_progressive_accrual() {
    let f = setup_accrual_protocol(WAD / 10);
    // Positive yield initial liquidity: 1,200 PT and 1,000 SY
    let pt_init = 1_200_000_000i128;
    let sy_init = 1_000_000_000i128;
    let total_mint = pt_init + sy_init;

    f.usdc_admin_client.mint(&f.lp_provider, &total_mint);
    f.sy_client
        .deposit(&f.lp_provider, &f.lp_provider, &total_mint);
    f.pool_client
        .mint_py(&f.lp_provider, &f.lp_provider, &pt_init, &f.maturity);

    f.pool_client
        .add_liquidity(&f.lp_provider, &f.lp_provider, &pt_init, &sy_init, &0);

    // Advance 30 days
    advance_time_and_ledgers(&f, 30 * 86400);

    // Trader gets SY shares to swap
    let trader = Address::generate(&f.env);
    let trader_mint = 100_000_000i128;
    f.usdc_admin_client.mint(&trader, &trader_mint);
    let trader_sy = f.sy_client.deposit(&trader, &trader, &trader_mint);

    let swap_sy = trader_sy / 2; // Swap half of trader's SY
    let (pt_out, fee_pt) =
        f.pool_client
            .swap_exact_sy_for_pt(&trader, &trader, &swap_sy, &0, &f.maturity);
    assert!(pt_out > 0);
    assert!(fee_pt > 0);

    // Non-negative yield invariant: PT reserve >= SY reserve
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert!(pt_res >= sy_res);

    // Advance to 60 days
    advance_time_and_ledgers(&f, 30 * 86400);

    // Trader swaps part of PT for SY
    let swap_pt = pt_out / 2;
    let (sy_out, fee_sy) =
        f.pool_client
            .swap_exact_pt_for_sy(&trader, &trader, &swap_pt, &0, &f.maturity);
    assert!(sy_out > 0);
    assert!(fee_sy > 0);

    // Advance to 179 days (1 day before maturity)
    advance_time_and_ledgers(&f, 119 * 86400);
    let e = f.pool_client.get_exchange_rate();
    // Implied rate E converges toward 1.0 WAD as tau -> 0
    assert!((e - WAD).abs() < 50_000_000_000_000);
}

#[test]
fn test_amm_liquidity_removal_post_accrual() {
    let f = setup_accrual_protocol(WAD / 10);
    let pt_init = 1_200_000_000i128;
    let sy_init = 1_000_000_000i128;
    let total_mint = pt_init + sy_init;

    f.usdc_admin_client.mint(&f.lp_provider, &total_mint);
    f.sy_client
        .deposit(&f.lp_provider, &f.lp_provider, &total_mint);
    f.pool_client
        .mint_py(&f.lp_provider, &f.lp_provider, &pt_init, &f.maturity);

    let lp_shares =
        f.pool_client
            .add_liquidity(&f.lp_provider, &f.lp_provider, &pt_init, &sy_init, &0);
    assert!(lp_shares > 0);

    // Advance 90 days
    advance_time_and_ledgers(&f, 90 * 86400);

    let (pt_out, sy_out) =
        f.pool_client
            .remove_liquidity(&f.lp_provider, &f.lp_provider, &lp_shares, &0, &0);
    assert!(pt_out > 0);
    assert!(sy_out > 0);

    // Dead shares (1,000) permanently locked in pool
    assert_eq!(f.pool_client.total_supply(), 1000);
}

// =============================================================================
// Suite 5: Defensive Boundary & Adversarial Invariants
// =============================================================================

#[test]
fn test_accrual_past_timestamp_monotonicity_and_overflow_safety() {
    let f = setup_accrual_protocol(WAD / 10);

    advance_time_and_ledgers(&f, 30 * 86400);
    let r30 = f.sy_client.exchange_rate();
    assert!(r30 > SCALAR_9);

    // Retrograde timestamp to t0 + 10D (clock anomaly defense)
    f.env.ledger().set_timestamp(f.t0 + 10 * 86400);
    let r_retro = f.sy_client.exchange_rate();
    // Monotonicity invariant: rate does not drop
    assert!(r_retro >= r30);

    // Advance 100 years into the future (3,153,600,000 seconds)
    f.env.ledger().set_timestamp(f.t0 + 100 * 31_536_000);
    let r_far = f.sy_client.exchange_rate();
    assert!(r_far > r30);

    // Safe arithmetic with small deposit
    let small_dep = 10_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &small_dep);
    let shares = f.sy_client.deposit(&f.user1, &f.user1, &small_dep);
    assert!(shares > 0);
}

#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{wad_div, wad_mul, SCALAR_9, WAD};
use common::interfaces::BlendPoolClient;
use common::yield_math::{
    calculate_fee_rate, calculate_haircut, calculate_tau_wad, get_exchange_rate, SECONDS_PER_YEAR,
};
use mock_blend::MockBlend;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env};

#[allow(dead_code)]
struct MockBlendHarness<'a> {
    env: Env,
    admin: Address,
    usdc_addr: Address,
    blend_client: BlendPoolClient<'a>,
    t0: u64,
}

fn setup_mock_blend_harness<'a>(annual_rate_wad: i128) -> MockBlendHarness<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);

    let t0 = 1_000_000u64;
    env.ledger().set_timestamp(t0);
    env.ledger().set_sequence_number(100);

    let blend_id = env.register(MockBlend, ());
    let blend_client = BlendPoolClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    if annual_rate_wad > 0 {
        blend_client.set_annual_rate(&annual_rate_wad);
    }

    MockBlendHarness {
        env,
        admin,
        usdc_addr: usdc.address(),
        blend_client,
        t0,
    }
}

// =============================================================================
// Suite 1: Rapid Small Delta-T vs Single-Shot Delta-T Stress Testing
// =============================================================================

#[test]
fn test_stress_rapid_small_delta_t_vs_single_shot_1_percent_apr() {
    // 1% APR = 10^16 WAD
    let rate_1pct = WAD / 100;

    // Harness A: Rapid 1-second queries
    let h_rapid = setup_mock_blend_harness(rate_1pct);
    let mut prev_rate = h_rapid.blend_client.get_b_rate();
    assert_eq!(prev_rate, SCALAR_9);

    // Call accrue every 1 second for 120 seconds
    let mut zero_accrual_count = 0;
    let mut non_zero_accrual_count = 0;

    for s in 1..=120 {
        h_rapid.env.ledger().set_timestamp(h_rapid.t0 + s);
        let curr_rate = h_rapid.blend_client.accrue();

        // Verify strict monotonicity at every single second
        assert!(
            curr_rate >= prev_rate,
            "Monotonicity violated at second {}: prev={}, curr={}",
            s,
            prev_rate,
            curr_rate
        );

        if curr_rate == prev_rate {
            zero_accrual_count += 1;
        } else {
            non_zero_accrual_count += 1;
            prev_rate = curr_rate;
        }
    }

    let rapid_final_rate = h_rapid.blend_client.get_b_rate();

    // Harness B: Single 120-second jump
    let h_single = setup_mock_blend_harness(rate_1pct);
    h_single.env.ledger().set_timestamp(h_single.t0 + 120);
    let single_final_rate = h_single.blend_client.accrue();

    // Theoretical analysis:
    // dt = 1s -> accrued_wad = (10^16 * 1) / 31_536_000 = 317_097_919
    // wad_mul(10^9, 317_097_919) = 317_097_919 * 10^9 / 10^18 = 0
    // Every 4 seconds, accrued_wad = 4 * 10^16 / 31_536_000 = 1_268_391_679
    // wad_mul(10^9, 1_268_391_679) = 1
    // Thus, in 120 seconds, rapid calls increase rate exactly 120 / 4 = 30 times by 1 stroop:
    assert_eq!(rapid_final_rate - SCALAR_9, 30);
    assert_eq!(non_zero_accrual_count, 30);
    assert_eq!(zero_accrual_count, 90);

    // Single jump:
    // dt = 120s -> accrued_wad = (10^16 * 120) / 31_536_000 = 38_051_750_380
    // wad_mul(10^9, 38_051_750_380) = 38
    assert_eq!(single_final_rate - SCALAR_9, 38);

    // Truncation loss:
    // Rapid queries yield 30 stroops vs single jump of 38 stroops.
    // 8 stroops (21.05%) lost to integer division truncation!
    let truncation_loss = single_final_rate - rapid_final_rate;
    assert_eq!(truncation_loss, 8);
    assert!(
        rapid_final_rate <= single_final_rate,
        "Rapid small delta-t cannot exceed single-shot jump"
    );
}

#[test]
fn test_stress_rapid_small_delta_t_vs_single_shot_10_percent_apr() {
    // 10% APR = 10^17 WAD
    let rate_10pct = WAD / 10;

    let h_rapid = setup_mock_blend_harness(rate_10pct);
    let mut prev_rate = SCALAR_9;

    // Call accrue every 1 second for 100 seconds
    for s in 1..=100 {
        h_rapid.env.ledger().set_timestamp(h_rapid.t0 + s);
        let curr_rate = h_rapid.blend_client.accrue();
        assert!(curr_rate >= prev_rate);
        prev_rate = curr_rate;
    }
    let rapid_final_rate = h_rapid.blend_client.get_b_rate();

    let h_single = setup_mock_blend_harness(rate_10pct);
    h_single.env.ledger().set_timestamp(h_single.t0 + 100);
    let single_final_rate = h_single.blend_client.accrue();

    // At 10% APR:
    // dt = 1s -> accrued_wad = (10^17 * 1) / 31_536_000 = 3_170_979_198
    // wad_mul(10^9, 3_170_979_198) = 3
    // Over 100s, rapid calls accrue 3 * 100 = 300 stroops
    assert_eq!(rapid_final_rate - SCALAR_9, 300);

    // Single jump:
    // dt = 100s -> accrued_wad = 317_097_919_837
    // wad_mul(10^9, 317_097_919_837) = 317
    assert_eq!(single_final_rate - SCALAR_9, 317);

    // Truncation loss is 17 stroops (5.36%)
    assert_eq!(single_final_rate - rapid_final_rate, 17);
}

// =============================================================================
// Suite 2: Extreme Annual Rates (0%, 1%, 100%, 1000%)
// =============================================================================

#[test]
fn test_stress_extreme_annual_rate_zero_percent() {
    let h = setup_mock_blend_harness(0); // 0% APR
    assert_eq!(h.blend_client.get_annual_rate(), 0);

    // Advance 100 years
    h.env.ledger().set_timestamp(h.t0 + 100 * 31_536_000);
    let rate_100y = h.blend_client.accrue();

    // 0% APR must produce exactly 0 growth and maintain exact SCALAR_9
    assert_eq!(rate_100y, SCALAR_9);
    assert_eq!(h.blend_client.get_b_rate(), SCALAR_9);

    let reserve = h.blend_client.get_reserve(&h.usdc_addr);
    assert_eq!(reserve.b_rate, SCALAR_9);
    assert_eq!(reserve.supply_apr, 0);
}

#[test]
fn test_stress_extreme_annual_rate_one_percent() {
    let rate_1pct = WAD / 100;
    let h = setup_mock_blend_harness(rate_1pct);

    // Advance exactly 1 year (31,536,000s)
    h.env.ledger().set_timestamp(h.t0 + 31_536_000);
    let rate_1y = h.blend_client.accrue();

    // Expected: 10^9 * 1.01 = 1_010_000_000
    assert_eq!(rate_1y, 1_010_000_000);
    assert_eq!(
        h.blend_client.get_reserve(&h.usdc_addr).b_rate,
        1_010_000_000
    );
}

#[test]
fn test_stress_extreme_annual_rate_one_hundred_percent() {
    let rate_100pct = WAD; // 100% APR = 10^18 WAD
    let h = setup_mock_blend_harness(rate_100pct);

    // Advance 1 year
    h.env.ledger().set_timestamp(h.t0 + 31_536_000);
    let rate_1y = h.blend_client.accrue();

    // Simple 1-year accrual: 10^9 + 10^9 = 2_000_000_000 (2.0x)
    assert_eq!(rate_1y, 2_000_000_000);

    // Now advance another year (2 years total)
    h.env.ledger().set_timestamp(h.t0 + 2 * 31_536_000);
    let rate_2y = h.blend_client.accrue();

    // Compounded on top of 2.0x: 2_000_000_000 * 2.0 = 4_000_000_000 (4.0x)
    assert_eq!(rate_2y, 4_000_000_000);
}

#[test]
fn test_stress_extreme_annual_rate_one_thousand_percent() {
    let rate_1000pct = 10 * WAD; // 1000% APR = 10^19 WAD
    let h = setup_mock_blend_harness(rate_1000pct);

    // Advance 1 year
    h.env.ledger().set_timestamp(h.t0 + 31_536_000);
    let rate_1y = h.blend_client.accrue();

    // Simple 1-year accrual: 10^9 + 10 * 10^9 = 11_000_000_000 (11.0x)
    assert_eq!(rate_1y, 11_000_000_000);

    // Advance 2nd year
    h.env.ledger().set_timestamp(h.t0 + 2 * 31_536_000);
    let rate_2y = h.blend_client.accrue();

    // Compounded: 11_000_000_000 * 11.0 = 121_000_000_000 (121.0x)
    assert_eq!(rate_2y, 121_000_000_000);
}

// =============================================================================
// Suite 3: Massive Multi-Year Delta-T & Overflow Invariant
// =============================================================================

#[test]
fn test_stress_massive_multi_year_delta_t_hundred_years() {
    let rate_10pct = WAD / 10;
    let h = setup_mock_blend_harness(rate_10pct);

    // Advance 100 years in a single step
    let dt_100y = 100 * 31_536_000;
    h.env.ledger().set_timestamp(h.t0 + dt_100y);

    let rate_100y = h.blend_client.accrue();
    // 10^9 * (1 + 0.10 * 100) = 10^9 * 11 = 11_000_000_000
    assert_eq!(rate_100y, 11_000_000_000);
}

#[test]
fn test_stress_massive_multi_year_delta_t_ten_thousand_years() {
    let rate_10pct = WAD / 10;
    let h = setup_mock_blend_harness(rate_10pct);

    // Advance 10,000 years in a single step (315,360,000,000 seconds)
    let dt_10ky = 10_000 * 31_536_000;
    h.env.ledger().set_timestamp(h.t0 + dt_10ky);

    let rate_10ky = h.blend_client.accrue();
    // 10^9 * (1 + 0.10 * 10,000) = 10^9 * 1001 = 1_001_000_000_000
    assert_eq!(rate_10ky, 1_001_000_000_000);
}

#[test]
fn test_stress_arithmetic_overflow_safety_at_u64_max_timestamp() {
    // Extreme 1000% APR with maximum possible u64 timestamp
    let rate_1000pct = 10 * WAD;
    let h = setup_mock_blend_harness(rate_1000pct);

    // Set timestamp to u64::MAX
    // dt = u64::MAX - 1_000_000 ~ 1.84 * 10^19
    // annual_rate = 10^19
    // annual_rate * dt = 1.84 * 10^38 > i128::MAX (1.70 * 10^38)
    h.env.ledger().set_timestamp(u64::MAX);

    // checked_mul triggers MathOverflow error cleanly without panic!
    let res = h.blend_client.try_accrue();
    assert!(
        res.is_err(),
        "Overflowing timestamp must return Err(MathOverflow)"
    );
    assert_eq!(
        res.unwrap_err().unwrap(),
        ContractError::MathOverflow.into()
    );
}

// =============================================================================
// Suite 4: Strict Monotonicity Across All Perturbations
// =============================================================================

#[test]
fn test_stress_strict_monotonicity_under_random_temporal_steps() {
    let h = setup_mock_blend_harness(WAD / 10); // 10% APR
    let mut current_time = h.t0;
    let mut current_rate = h.blend_client.get_b_rate();

    // Test pseudo-random delta-t steps ranging from 0 seconds to 10 days
    let deltas: [u64; 20] = [
        0,
        1,
        0,
        2,
        5,
        10,
        100,
        3600,
        0,
        86400,
        1,
        0,
        7 * 86400,
        30 * 86400,
        0,
        1,
        10 * 86400,
        0,
        365 * 86400,
        0,
    ];

    for (step_idx, dt) in deltas.iter().enumerate() {
        current_time += dt;
        h.env.ledger().set_timestamp(current_time);

        let new_rate = h.blend_client.accrue();
        assert!(
            new_rate >= current_rate,
            "Strict monotonicity violated at step {}: dt={}, prev_rate={}, new_rate={}",
            step_idx,
            dt,
            current_rate,
            new_rate
        );
        current_rate = new_rate;
    }
}

#[test]
fn test_stress_strict_monotonicity_under_retrograde_clock() {
    let h = setup_mock_blend_harness(WAD / 10);

    // Advance 60 days
    h.env.ledger().set_timestamp(h.t0 + 60 * 86400);
    let rate_60d = h.blend_client.accrue();

    // Clock steps backwards to t0 + 30D (e.g. reorg or bad mock timestamp)
    h.env.ledger().set_timestamp(h.t0 + 30 * 86400);
    let rate_retro_30d = h.blend_client.accrue();

    // Rate must NOT decrease: b_rate(t_retro) >= b_rate(t_peak)
    assert_eq!(rate_retro_30d, rate_60d);

    // Clock steps backwards to 0
    h.env.ledger().set_timestamp(0);
    let rate_retro_0 = h.blend_client.accrue();
    assert_eq!(rate_retro_0, rate_60d);
}

// =============================================================================
// Suite 5: Fixed-Point Wad_Mul & Div Math Stress Testing
// =============================================================================

#[test]
fn test_stress_fixed_point_wad_mul_precision_and_overflow() {
    // 1. Extreme small values (underflow to 0)
    assert_eq!(wad_mul(1, 1).unwrap(), 0);
    assert_eq!(wad_mul(SCALAR_9, 100_000_000).unwrap(), 0); // 10^17 / 10^18 = 0
    assert_eq!(wad_mul(SCALAR_9, SCALAR_9).unwrap(), 1); // 10^18 / 10^18 = 1

    // 2. Exact identity
    assert_eq!(wad_mul(WAD, WAD).unwrap(), WAD);
    assert_eq!(wad_mul(5 * WAD, WAD).unwrap(), 5 * WAD);

    // 3. Multiplication overflow boundary
    // i128::MAX * WAD / WAD = i128::MAX
    assert_eq!(wad_mul(i128::MAX, WAD).unwrap(), i128::MAX);
    // (i128::MAX + 1) would overflow
    assert_eq!(
        wad_mul(i128::MAX, WAD + 1),
        Err(ContractError::MathOverflow)
    );
    assert_eq!(
        wad_mul(i128::MAX, i128::MAX),
        Err(ContractError::MathOverflow)
    );

    // 4. wad_div edge cases
    assert_eq!(wad_div(WAD, 0), Err(ContractError::DivisionByZero));
    assert_eq!(wad_div(WAD, WAD).unwrap(), WAD);
    assert_eq!(wad_div(i128::MAX, WAD).unwrap(), i128::MAX);
    assert_eq!(
        wad_div(i128::MAX, WAD - 1),
        Err(ContractError::MathOverflow)
    );
}

// =============================================================================
// Suite 6: Yield Math Module Edge & Boundary Stress Testing
// =============================================================================

#[test]
fn test_stress_yield_math_boundaries() {
    // 1. calculate_tau_wad
    let now = 1_000_000u64;
    // Matured or post-maturity returns 0
    assert_eq!(calculate_tau_wad(now, now), 0);
    assert_eq!(calculate_tau_wad(now + 100, now), 0);

    // Exactly 1 year remaining
    let tau_1y = calculate_tau_wad(now, now + SECONDS_PER_YEAR as u64);
    assert_eq!(tau_1y, WAD);

    // 50 years remaining
    let tau_50y = calculate_tau_wad(now, now + 50 * SECONDS_PER_YEAR as u64);
    assert_eq!(tau_50y, 50 * WAD);

    // 2. get_exchange_rate edge cases
    // Division by zero if scalar_root == 0
    assert_eq!(
        get_exchange_rate(1000 * WAD, 1000 * WAD, WAD, 0, WAD),
        Err(ContractError::DivisionByZero)
    );

    // Negative log input if reserves <= 0
    assert_eq!(
        get_exchange_rate(0, 1000 * WAD, WAD, 20 * WAD, WAD),
        Err(ContractError::NegativeLogarithmInput)
    );
    assert_eq!(
        get_exchange_rate(1000 * WAD, -5, WAD, 20 * WAD, WAD),
        Err(ContractError::NegativeLogarithmInput)
    );

    // At tau = 0 (maturity), exact convergence to anchor (or WAD floor)
    let e_mat = get_exchange_rate(2000 * WAD, 1000 * WAD, 0, 20 * WAD, WAD).unwrap();
    assert_eq!(e_mat, WAD);

    // Negative yield rejection: PT < SY (e.g. 500 PT, 1000 SY)
    let neg_res = get_exchange_rate(500 * WAD, 1000 * WAD, WAD, 20 * WAD, WAD);
    assert_eq!(neg_res, Err(ContractError::NegativeYieldNotSupported));

    // 3. calculate_fee_rate clamping
    let min_fee = calculate_fee_rate(0, WAD / 100);
    assert_eq!(min_fee, common::yield_math::MIN_FEE_RATE);

    let max_fee = calculate_fee_rate(100 * WAD, WAD); // 100 years * 100% APR
    assert_eq!(max_fee, common::yield_math::MAX_FEE_RATE);

    // 4. calculate_haircut
    // Solvency >= 100% capped at WAD
    assert_eq!(calculate_haircut(2000 * WAD, 1000 * WAD).unwrap(), WAD);
    // Solvency 80%
    assert_eq!(
        calculate_haircut(800 * WAD, 1000 * WAD).unwrap(),
        WAD * 8 / 10
    );
    // 0 pt supply errors with DivisionByZero
    assert_eq!(
        calculate_haircut(100 * WAD, 0),
        Err(ContractError::DivisionByZero)
    );
}

#![cfg(test)]
extern crate std;

use crate::blend_accrual_tests::{advance_time_and_ledgers, setup_accrual_protocol};
use common::fixed_point::WAD;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::Address;

// =============================================================================
// Suite 1: Periodic vs. Lump-Sum Yield Claiming Multi-User Stress Tests
// =============================================================================

#[test]
fn test_stress_periodic_vs_lump_sum_across_4_users_convergence() {
    let f = setup_accrual_protocol(WAD / 10); // 10% APR
    let amount = 10_000_000_000i128; // 10,000 USDC each

    let u1 = Address::generate(&f.env); // ultra-frequent (every 3 days = 60 claims)
    let u2 = Address::generate(&f.env); // bi-weekly (every 15 days = 12 claims)
    let u3 = Address::generate(&f.env); // monthly (every 30 days = 6 claims)
    let u4 = Address::generate(&f.env); // lump-sum at maturity (1 claim at 180D)
    let u5 = Address::generate(&f.env); // post-maturity (1 claim at 240D)

    let users = [&u1, &u2, &u3, &u4, &u5];
    for u in users.iter() {
        f.usdc_admin_client.mint(u, &amount);
        f.sy_client.deposit(u, u, &amount);
        f.pool_client.mint_py(u, u, &amount);
    }

    let mut u1_claimed_sy = 0i128;
    let mut u2_claimed_sy = 0i128;
    let mut u3_claimed_sy = 0i128;

    // Simulate 180 days in 3-day increments (60 intervals)
    for day_step in 1..=60 {
        advance_time_and_ledgers(&f, 3 * 86400);

        // U1 claims every 3 days
        u1_claimed_sy += f.pool_client.claim_yield(&u1, &u1);

        // U2 claims every 15 days (every 5 steps)
        if day_step % 5 == 0 {
            u2_claimed_sy += f.pool_client.claim_yield(&u2, &u2);
        }

        // U3 claims every 30 days (every 10 steps)
        if day_step % 10 == 0 {
            u3_claimed_sy += f.pool_client.claim_yield(&u3, &u3);
        }
    }

    // At maturity (180D), settle pool and claim for U4
    let _settled_index = f.pool_client.settle_maturity();
    let u4_claimed_sy = f.pool_client.claim_yield(&u4, &u4);

    // Verify all 4 users claimed yield
    assert!(u1_claimed_sy > 0);
    assert!(u2_claimed_sy > 0);
    assert!(u3_claimed_sy > 0);
    assert!(u4_claimed_sy > 0);

    // Mathematical convergence:
    // Due to telescoping sum property:
    // sum(1/I_{k-1} - 1/I_k) = 1/I_0 - 1/I_final
    // All claiming schedules must converge within rounding dust (bounded by 1 stroop per claim).
    let diff_1_4 = (u1_claimed_sy - u4_claimed_sy).abs();
    let diff_2_4 = (u2_claimed_sy - u4_claimed_sy).abs();
    let diff_3_4 = (u3_claimed_sy - u4_claimed_sy).abs();

    std::println!("U1 (60 claims): {} SY", u1_claimed_sy);
    std::println!("U2 (12 claims): {} SY", u2_claimed_sy);
    std::println!("U3 ( 6 claims): {} SY", u3_claimed_sy);
    std::println!("U4 ( 1 claim ): {} SY", u4_claimed_sy);
    std::println!(
        "diff_1_4: {}, diff_2_4: {}, diff_3_4: {}",
        diff_1_4,
        diff_2_4,
        diff_3_4
    );

    assert!(
        diff_1_4 <= 60,
        "U1 vs U4 diff exceeds tolerance: {}",
        diff_1_4
    );
    assert!(
        diff_2_4 <= 15,
        "U2 vs U4 diff exceeds tolerance: {}",
        diff_2_4
    );
    assert!(
        diff_3_4 <= 10,
        "U3 vs U4 diff exceeds tolerance: {}",
        diff_3_4
    );

    // Advance 60 days into post-maturity (240 days total)
    advance_time_and_ledgers(&f, 60 * 86400);

    // U5 claims at 240D.
    // In underlying USDC value terms, U5's yield accrued up to maturity is exactly preserved.
    // In SY terms, sy_payout = yield_amount * SCALAR_9 / r240.
    let u5_claimed_sy = f.pool_client.claim_yield(&u5, &u5);
    let r240 = f.sy_client.exchange_rate();
    let settled_index = f.pool_client.settle_maturity();

    let u4_usdc_value = (u4_claimed_sy * settled_index) / common::fixed_point::SCALAR_9;
    let u5_usdc_value = (u5_claimed_sy * r240) / common::fixed_point::SCALAR_9;
    std::println!("U4 USDC value: {}", u4_usdc_value);
    std::println!("U5 USDC value: {}", u5_usdc_value);
    assert!(
        (u4_usdc_value - u5_usdc_value).abs() <= 5,
        "Post-maturity claim did not preserve underlying yield value: U4={}, U5={}",
        u4_usdc_value,
        u5_usdc_value
    );

    // Subsequent claims by any user must return exactly 0
    assert_eq!(f.pool_client.claim_yield(&u1, &u1), 0);
    assert_eq!(f.pool_client.claim_yield(&u4, &u4), 0);
    assert_eq!(f.pool_client.claim_yield(&u5, &u5), 0);
}

#[test]
fn test_stress_interleaved_yt_transfers_and_checkpoint_integrity() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 10_000_000_000i128; // 10,000 USDC

    let ua = Address::generate(&f.env);
    let ub = Address::generate(&f.env);
    let uc = Address::generate(&f.env);
    let u_control = Address::generate(&f.env);

    // Setup UA and U_control with 10,000 PT/YT
    for u in [&ua, &u_control] {
        f.usdc_admin_client.mint(u, &amount);
        f.sy_client.deposit(u, u, &amount);
        f.pool_client.mint_py(u, u, &amount);
    }

    // Day 30: advance 30 days
    advance_time_and_ledgers(&f, 30 * 86400);
    let mut claimed_a = f.pool_client.claim_yield(&ua, &ua);

    // UA transfers 4,000 YT to UB and 3,000 YT to UC (UA keeps 3,000 YT)
    f.yt_client.transfer(&ua, &ub, &4_000_000_000i128);
    f.yt_client.transfer(&ua, &uc, &3_000_000_000i128);

    // Day 60: advance 30 days
    advance_time_and_ledgers(&f, 30 * 86400);
    let mut claimed_b = f.pool_client.claim_yield(&ub, &ub);
    claimed_a += f.pool_client.claim_yield(&ua, &ua);
    let mut claimed_c = f.pool_client.claim_yield(&uc, &uc);

    // Day 90: advance 30 days
    advance_time_and_ledgers(&f, 30 * 86400);
    // All parties claim accrued yield at 90D before UC transfers 1,000 YT to UB
    claimed_a += f.pool_client.claim_yield(&ua, &ua);
    claimed_b += f.pool_client.claim_yield(&ub, &ub);
    claimed_c += f.pool_client.claim_yield(&uc, &uc);
    f.yt_client.transfer(&uc, &ub, &1_000_000_000i128);

    // Day 180: advance 90 days to maturity
    advance_time_and_ledgers(&f, 90 * 86400);
    f.pool_client.settle_maturity();

    claimed_a += f.pool_client.claim_yield(&ua, &ua);
    claimed_b += f.pool_client.claim_yield(&ub, &ub);
    claimed_c += f.pool_client.claim_yield(&uc, &uc);

    let total_claimed_transferred = claimed_a + claimed_b + claimed_c;

    // Control claims across identical horizons (30D, 60D, 90D, 180D)
    let f_ctrl = setup_accrual_protocol(WAD / 10);
    f_ctrl.usdc_admin_client.mint(&f_ctrl.user1, &amount);
    f_ctrl
        .sy_client
        .deposit(&f_ctrl.user1, &f_ctrl.user1, &amount);
    f_ctrl
        .pool_client
        .mint_py(&f_ctrl.user1, &f_ctrl.user1, &amount);

    advance_time_and_ledgers(&f_ctrl, 30 * 86400);
    let mut ctrl_claimed = f_ctrl.pool_client.claim_yield(&f_ctrl.user1, &f_ctrl.user1);

    advance_time_and_ledgers(&f_ctrl, 30 * 86400);
    ctrl_claimed += f_ctrl.pool_client.claim_yield(&f_ctrl.user1, &f_ctrl.user1);

    advance_time_and_ledgers(&f_ctrl, 30 * 86400);
    ctrl_claimed += f_ctrl.pool_client.claim_yield(&f_ctrl.user1, &f_ctrl.user1);

    advance_time_and_ledgers(&f_ctrl, 90 * 86400);
    f_ctrl.pool_client.settle_maturity();
    ctrl_claimed += f_ctrl.pool_client.claim_yield(&f_ctrl.user1, &f_ctrl.user1);

    let diff = (total_claimed_transferred - ctrl_claimed).abs();
    std::println!("Transferred group total: {} SY", total_claimed_transferred);
    std::println!("Control user total:      {} SY", ctrl_claimed);
    std::println!("Difference:              {} SY", diff);

    assert!(
        diff <= 10,
        "Transfer-split yield diverged from control: {}",
        diff
    );
}

// =============================================================================
// Suite 2: Exhaustive Zero-Deficit Invariant Stress Tests
// =============================================================================

#[test]
fn test_stress_zero_deficit_invariant_multi_user_randomized_claims() {
    let f = setup_accrual_protocol(WAD * 15 / 100); // 15% APR
    let user_count = 5;
    let amount_per_user = 4_000_000_000i128; // 4,000 USDC
    let total_minted_sy = amount_per_user * (user_count as i128); // 20,000 SY

    let mut users = std::vec::Vec::new();
    for _ in 0..user_count {
        let u = Address::generate(&f.env);
        f.usdc_admin_client.mint(&u, &amount_per_user);
        f.sy_client.deposit(&u, &u, &amount_per_user);
        f.pool_client.mint_py(&u, &u, &amount_per_user);
        users.push(u);
    }

    let mut cumulative_claimed = 0i128;

    // 40 sequential intervals of advancing time across 180 days
    let time_deltas = [
        2, 5, 3, 7, 1, 4, 6, 2, 8, 3, 5, 4, 2, 6, 3, 7, 2, 5, 4, 6, 3, 8, 2, 4, 5, 3, 6, 4, 7, 2,
        5, 3, 6, 4, 2, 8, 3, 5, 4, 6,
    ]; // sum = 170 days

    for (step_idx, dt_days) in time_deltas.iter().enumerate() {
        advance_time_and_ledgers(&f, *dt_days * 86400);

        // Deterministically select user subset to claim at this step
        let claimer_idx = step_idx % user_count;
        let claimed = f
            .pool_client
            .claim_yield(&users[claimer_idx], &users[claimer_idx]);
        cumulative_claimed += claimed;

        let pool_sy_balance = f.sy_client.balance(&f.pool_client.address);

        // ZERO-DEFICIT INVARIANT:
        // Pool SY Balance + Cumulative Claimed SY == Total Minted SY
        assert_eq!(
            pool_sy_balance + cumulative_claimed,
            total_minted_sy,
            "Zero-deficit breach at step {}: pool={} claimed={} total={}",
            step_idx,
            pool_sy_balance,
            cumulative_claimed,
            total_minted_sy
        );
        assert!(
            pool_sy_balance > 0,
            "Pool SY balance underflowed at step {}",
            step_idx
        );
    }

    // Advance to 180D (maturity) and have all remaining users claim
    advance_time_and_ledgers(&f, 10 * 86400);
    f.pool_client.settle_maturity();

    for u in users.iter() {
        cumulative_claimed += f.pool_client.claim_yield(u, u);
    }

    let final_pool_balance = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(
        final_pool_balance + cumulative_claimed,
        total_minted_sy,
        "Zero-deficit breach at maturity: pool={} claimed={}",
        final_pool_balance,
        cumulative_claimed
    );
}

#[test]
fn test_stress_zero_deficit_with_early_py_redemptions() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 10_000_000_000i128; // 10,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    let mut total_claimed = 0i128;
    let mut total_unwound = 0i128;

    // Advance 30D
    advance_time_and_ledgers(&f, 30 * 86400);
    total_claimed += f.pool_client.claim_yield(&f.user1, &f.user1);

    // Early unwind 3,000 PT/YT
    let unwind_1 = 3_000_000_000i128;
    f.pool_client.redeem_py(&f.user1, &f.user1, &unwind_1);
    total_unwound += unwind_1;

    let pool_bal_1 = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(pool_bal_1 + total_claimed + total_unwound, amount);

    // Advance 60D further (90D total)
    advance_time_and_ledgers(&f, 60 * 86400);
    total_claimed += f.pool_client.claim_yield(&f.user1, &f.user1);

    // Early unwind 2,000 PT/YT
    let unwind_2 = 2_000_000_000i128;
    f.pool_client.redeem_py(&f.user1, &f.user1, &unwind_2);
    total_unwound += unwind_2;

    let pool_bal_2 = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(pool_bal_2 + total_claimed + total_unwound, amount);

    // Advance to maturity (180D)
    advance_time_and_ledgers(&f, 90 * 86400);
    f.pool_client.settle_maturity();
    total_claimed += f.pool_client.claim_yield(&f.user1, &f.user1);

    let final_pool_bal = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(final_pool_bal + total_claimed + total_unwound, amount);
}

// =============================================================================
// Suite 3: Post-Maturity PT 100% Solvency Stress Tests
// =============================================================================

#[test]
fn test_stress_pt_solvency_under_diverse_yield_claiming_schedules() {
    // We compare 3 separate protocols with identical parameters:
    // Protocol 1: Frequent periodic YT claims across 180D
    // Protocol 2: Zero YT claims until AFTER PT redeems post-maturity
    // Protocol 3: Large rate expansion (40% APR)

    let principal = 10_000_000_000i128; // 10,000 USDC

    // Protocol 1: Periodic claims
    let f1 = setup_accrual_protocol(WAD / 10);
    f1.usdc_admin_client.mint(&f1.user1, &principal);
    f1.sy_client.deposit(&f1.user1, &f1.user1, &principal);
    f1.pool_client.mint_py(&f1.user1, &f1.user1, &principal);

    for _ in 0..18 {
        advance_time_and_ledgers(&f1, 10 * 86400);
        f1.pool_client.claim_yield(&f1.user1, &f1.user1);
    }
    f1.pool_client.settle_maturity();
    let pt_sy_out_1 = f1
        .pool_client
        .redeem_pt_post_maturity(&f1.user1, &f1.user1, &principal);
    f1.usdc_admin_client
        .mint(&f1.blend_client.address, &principal);
    let usdc_1 = f1.sy_client.redeem(&f1.user1, &f1.user1, &pt_sy_out_1);
    assert!(
        (usdc_1 - principal).abs() <= 25,
        "Protocol 1 PT not 100% solvent: {}",
        usdc_1
    );

    // Protocol 2: Zero claims before maturity; PT redeems first, then YT claims
    let f2 = setup_accrual_protocol(WAD / 10);
    f2.usdc_admin_client.mint(&f2.user1, &principal);
    f2.sy_client.deposit(&f2.user1, &f2.user1, &principal);
    f2.pool_client.mint_py(&f2.user1, &f2.user1, &principal);

    advance_time_and_ledgers(&f2, 180 * 86400);
    f2.pool_client.settle_maturity();

    let pt_sy_out_2 = f2
        .pool_client
        .redeem_pt_post_maturity(&f2.user1, &f2.user1, &principal);
    assert!(pt_sy_out_2 > 0);
    f2.usdc_admin_client
        .mint(&f2.blend_client.address, &principal);
    let usdc_2 = f2.sy_client.redeem(&f2.user1, &f2.user1, &pt_sy_out_2);
    // PT recovers 100% of principal
    assert!(
        usdc_2 >= principal,
        "Protocol 2 PT under-recovered principal: {}",
        usdc_2
    );

    // Protocol 3: High interest rate (40% APR)
    let f3 = setup_accrual_protocol(WAD * 40 / 100);
    f3.usdc_admin_client.mint(&f3.user1, &principal);
    f3.sy_client.deposit(&f3.user1, &f3.user1, &principal);
    f3.pool_client.mint_py(&f3.user1, &f3.user1, &principal);

    for _ in 0..6 {
        advance_time_and_ledgers(&f3, 30 * 86400);
        f3.pool_client.claim_yield(&f3.user1, &f3.user1);
    }
    f3.pool_client.settle_maturity();

    let pt_sy_out_3 = f3
        .pool_client
        .redeem_pt_post_maturity(&f3.user1, &f3.user1, &principal);
    f3.usdc_admin_client
        .mint(&f3.blend_client.address, &principal);
    let usdc_3 = f3.sy_client.redeem(&f3.user1, &f3.user1, &pt_sy_out_3);
    assert!(
        (usdc_3 - principal).abs() <= 5,
        "Protocol 3 PT not 100% solvent: {}",
        usdc_3
    );
}

#[test]
fn test_stress_pt_redemption_in_fractional_tranches() {
    let f = setup_accrual_protocol(WAD / 10);
    let amount = 10_000_000_000i128; // 10,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Claim yield periodically
    for _ in 0..6 {
        advance_time_and_ledgers(&f, 30 * 86400);
        f.pool_client.claim_yield(&f.user1, &f.user1);
    }

    f.pool_client.settle_maturity();

    // Redeem PT in 4 tranches: 10%, 25%, 35%, 30%
    let tranches = [
        1_000_000_000i128,
        2_500_000_000i128,
        3_500_000_000i128,
        3_000_000_000i128,
    ];

    let mut total_usdc_recovered = 0i128;
    f.usdc_admin_client.mint(&f.blend_client.address, &amount);

    for (i, tranche) in tranches.iter().enumerate() {
        let sy_payout = f
            .pool_client
            .redeem_pt_post_maturity(&f.user1, &f.user1, tranche);
        assert!(sy_payout > 0);
        let usdc_payout = f.sy_client.redeem(&f.user1, &f.user1, &sy_payout);
        total_usdc_recovered += usdc_payout;
        std::println!(
            "Tranche {}: PT {} -> SY {} -> USDC {}",
            i + 1,
            tranche,
            sy_payout,
            usdc_payout
        );
    }

    assert!(
        (total_usdc_recovered - amount).abs() <= 10,
        "Tranche PT redemptions diverged from principal: {}",
        total_usdc_recovered
    );
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.pt_client.total_supply(), 0);
}

// =============================================================================
// Suite 4: AMM Swaps and Proportion Bounds [0.04, 0.96] Stress Tests
// =============================================================================

#[test]
fn test_stress_amm_swaps_strictly_enforce_proportion_bounds() {
    let f = setup_accrual_protocol(WAD / 10);
    // Initial liquidity: PT = 1,200, SY = 1,000 (proportion = 1200 / 2200 = 0.545)
    let pt_init = 1_200_000_000i128;
    let sy_init = 1_000_000_000i128;
    let total_mint = pt_init + sy_init;

    f.usdc_admin_client.mint(&f.lp_provider, &total_mint);
    f.sy_client
        .deposit(&f.lp_provider, &f.lp_provider, &total_mint);
    f.pool_client
        .mint_py(&f.lp_provider, &f.lp_provider, &pt_init);
    f.pool_client
        .add_liquidity(&f.lp_provider, &f.lp_provider, &pt_init, &sy_init, &0);

    let trader = Address::generate(&f.env);

    // 1. Stress Test: Massive swap_exact_pt_for_sy that pushes proportion > 0.96
    // If trader deposits huge PT, pt_reserve skyrockets, pushing proportion toward 1.0
    let huge_pt = 100_000_000_000i128; // 100,000 PT
    f.usdc_admin_client.mint(&trader, &huge_pt);
    f.sy_client.deposit(&trader, &trader, &huge_pt);
    f.pool_client.mint_py(&trader, &trader, &huge_pt);

    // Attempt swap that breaches upper proportion bound (0.96)
    let result_upper = f
        .pool_client
        .try_swap_exact_pt_for_sy(&trader, &trader, &huge_pt, &0);
    assert!(
        result_upper.is_err(),
        "Expected upper proportion breach error, but swap succeeded"
    );

    // 2. Stress Test: Massive swap_exact_sy_for_pt that pushes proportion < 0.04 or triggers negative yield
    // Large SY in drains PT, pushing proportion down toward 0
    let large_sy = 2_000_000_000i128; // 2,000 SY (larger than total PT reserve of 1,200)
    let result_lower = f
        .pool_client
        .try_swap_exact_sy_for_pt(&trader, &trader, &large_sy, &0);
    assert!(
        result_lower.is_err(),
        "Expected lower proportion / insufficient balance error, but swap succeeded"
    );

    // 3. Stress Test: Boundary preservation across 20 valid swaps
    // We execute alternating valid small swaps and verify proportion stays in [0.04, 0.96] after every single trade
    let trade_funds = 500_000_000i128;
    f.usdc_admin_client.mint(&trader, &trade_funds);
    f.sy_client.deposit(&trader, &trader, &trade_funds);

    let trade_amount = 20_000_000i128; // 20 units

    for i in 0..10 {
        // Swap SY for PT
        let (pt_out, _) = f
            .pool_client
            .swap_exact_sy_for_pt(&trader, &trader, &trade_amount, &0);
        assert!(pt_out > 0);

        let (pt_res, sy_res) = f.pool_client.get_reserves();
        let total = pt_res + sy_res;
        let p_wad = (pt_res * WAD) / total;

        assert!(
            p_wad >= common::yield_math::MIN_MARKET_PROPORTION,
            "Proportion below 0.04 after swap_exact_sy_for_pt at step {}: {}",
            i,
            p_wad
        );
        assert!(
            p_wad <= common::yield_math::MAX_MARKET_PROPORTION,
            "Proportion above 0.96 after swap_exact_sy_for_pt at step {}: {}",
            i,
            p_wad
        );
        // Non-negative yield invariant: PT reserve >= SY reserve
        assert!(
            pt_res >= sy_res,
            "Negative yield invariant violated: PT {} < SY {}",
            pt_res,
            sy_res
        );

        // Swap PT for SY
        let (sy_out, _) = f
            .pool_client
            .swap_exact_pt_for_sy(&trader, &trader, &trade_amount, &0);
        assert!(sy_out > 0);

        let (pt_res2, sy_res2) = f.pool_client.get_reserves();
        let total2 = pt_res2 + sy_res2;
        let p_wad2 = (pt_res2 * WAD) / total2;

        assert!(
            p_wad2 >= common::yield_math::MIN_MARKET_PROPORTION,
            "Proportion below 0.04 after swap_exact_pt_for_sy at step {}: {}",
            i,
            p_wad2
        );
        assert!(
            p_wad2 <= common::yield_math::MAX_MARKET_PROPORTION,
            "Proportion above 0.96 after swap_exact_pt_for_sy at step {}: {}",
            i,
            p_wad2
        );
        assert!(
            pt_res2 >= sy_res2,
            "Negative yield invariant violated: PT {} < SY {}",
            pt_res2,
            sy_res2
        );
    }
}

// =============================================================================
// Suite 5: Adversarial Boundary & Corner-Case Stress Tests
// =============================================================================

#[test]
fn test_stress_unclaimed_yt_when_pt_redeems_first_behavior() {
    let f = setup_accrual_protocol(WAD / 10); // 10% APR
    let amount = 10_000_000_000i128; // 10,000 USDC

    let pt_holder = Address::generate(&f.env);
    let yt_holder = Address::generate(&f.env);

    f.usdc_admin_client.mint(&pt_holder, &amount);
    f.sy_client.deposit(&pt_holder, &pt_holder, &amount);
    f.pool_client.mint_py(&pt_holder, &pt_holder, &amount);

    // Transfer all YT to yt_holder
    f.yt_client.transfer(&pt_holder, &yt_holder, &amount);

    // Advance 180 days to maturity WITHOUT yt_holder claiming any yield
    advance_time_and_ledgers(&f, 180 * 86400);
    let settled_index = f.pool_client.settle_maturity();
    assert!(settled_index > common::fixed_point::SCALAR_9);

    // Pool balance is still 10,000 SY (no yield has been claimed yet)
    let pool_sy_before = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(pool_sy_before, amount);

    // PT holder calls redeem_pt_post_maturity FIRST
    let pt_sy_out = f
        .pool_client
        .redeem_pt_post_maturity(&pt_holder, &pt_holder, &amount);
    std::println!(
        "PT holder received {} SY out of {} initial",
        pt_sy_out,
        amount
    );

    // Provide underlying liquidity for mock blend
    let underlying_needed = (pt_sy_out * settled_index) / common::fixed_point::SCALAR_9;
    f.usdc_admin_client
        .mint(&f.blend_client.address, &underlying_needed);

    let usdc_out = f.sy_client.redeem(&pt_holder, &pt_holder, &pt_sy_out);
    std::println!("PT holder redeemed {} USDC", usdc_out);
    // PT holder recovers AT LEAST 100% of initial principal
    assert!(
        usdc_out >= amount,
        "PT holder suffered loss when redeeming first"
    );

    // Check pool SY balance remaining for YT holder
    let pool_sy_remaining = f.sy_client.balance(&f.pool_client.address);
    std::println!("Remaining pool SY for YT holder: {}", pool_sy_remaining);

    // Now YT holder attempts to claim yield
    let yt_claim_res = f.pool_client.try_claim_yield(&yt_holder, &yt_holder);
    std::println!(
        "YT holder claim result after PT took full balance: {:?}",
        yt_claim_res
    );

    if pool_sy_remaining == 0 {
        // If PT took all 10,000 SY, pool balance is 0 and YT claim errors with InsufficientBalance
        assert!(yt_claim_res.is_err());
    } else {
        assert!(yt_claim_res.is_ok());
    }
}

#[test]
fn test_stress_extreme_100_percent_apr_zero_deficit_and_solvency() {
    // 100% APR = 1.0 * WAD
    let f = setup_accrual_protocol(WAD);
    let amount = 10_000_000_000i128; // 10,000 USDC

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    let mut total_claimed = 0i128;

    // Advance in 6 monthly steps to maturity (30 days each = 180 days)
    for step in 1..=6 {
        advance_time_and_ledgers(&f, 30 * 86400);
        let claimed = f.pool_client.claim_yield(&f.user1, &f.user1);
        total_claimed += claimed;

        let pool_bal = f.sy_client.balance(&f.pool_client.address);
        // Zero-deficit invariant holds under extreme 100% compounding rate
        assert_eq!(
            pool_bal + total_claimed,
            amount,
            "Zero-deficit breach at step {}",
            step
        );
    }

    f.pool_client.settle_maturity();

    let pool_bal_mat = f.sy_client.balance(&f.pool_client.address);
    assert_eq!(pool_bal_mat + total_claimed, amount);

    // Post-maturity PT redemption at maturity
    let pt_sy_out = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &amount);
    assert_eq!(pt_sy_out, pool_bal_mat);

    f.usdc_admin_client.mint(&f.blend_client.address, &amount);
    let usdc_out = f.sy_client.redeem(&f.user1, &f.user1, &pt_sy_out);
    std::println!("usdc_out at maturity: {}, amount: {}", usdc_out, amount);
    // User recovers full 10,000 USDC principal within integer division rounding
    assert!((usdc_out - amount).abs() <= 15);
}

#[test]
fn test_stress_proportion_bounds_edge_cases_and_negative_yield_rejection() {
    let f = setup_accrual_protocol(WAD / 10);
    let pt_init = 1_500_000_000i128;
    let sy_init = 1_000_000_000i128;
    let total_mint = pt_init + sy_init;

    f.usdc_admin_client.mint(&f.lp_provider, &total_mint);
    f.sy_client
        .deposit(&f.lp_provider, &f.lp_provider, &total_mint);
    f.pool_client
        .mint_py(&f.lp_provider, &f.lp_provider, &pt_init);
    f.pool_client
        .add_liquidity(&f.lp_provider, &f.lp_provider, &pt_init, &sy_init, &0);

    let trader = Address::generate(&f.env);
    let trader_funds = 10_000_000_000i128;
    f.usdc_admin_client.mint(&trader, &trader_funds);
    f.sy_client.deposit(&trader, &trader, &trader_funds);
    f.pool_client.mint_py(&trader, &trader, &(trader_funds / 2));

    // 1. Swap that would cause PT < SY (negative implied rate)
    // Current reserves: PT = 1,500, SY = 1,000.
    // If trader tries to swap 600 SY for PT, new PT would drop below new SY:
    let large_sy_in = 600_000_000i128;
    let err_neg = f
        .pool_client
        .try_swap_exact_sy_for_pt(&trader, &trader, &large_sy_in, &0);
    assert!(
        err_neg.is_err(),
        "Swapping large SY that inverts PT < SY must be rejected"
    );

    // 2. Exact valid swap that preserves PT >= SY and stays in bounds
    let safe_sy_in = 100_000_000i128;
    let (pt_out, fee_pt) = f
        .pool_client
        .swap_exact_sy_for_pt(&trader, &trader, &safe_sy_in, &0);
    assert!(pt_out > 0);
    assert!(fee_pt > 0);

    let (res_pt, res_sy) = f.pool_client.get_reserves();
    assert!(
        res_pt >= res_sy,
        "Negative yield invariant violated: PT < SY"
    );

    let total = res_pt + res_sy;
    let prop = (res_pt * WAD) / total;
    assert!(prop >= common::yield_math::MIN_MARKET_PROPORTION);
    assert!(prop <= common::yield_math::MAX_MARKET_PROPORTION);
}

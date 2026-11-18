#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::storage_keys::DataKey;
use common::yield_math::{calculate_tau_wad, get_exchange_rate};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct ChallengerFixture<'a> {
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

fn setup_challenger<'a>() -> ChallengerFixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
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

    ChallengerFixture {
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
// CHALLENGE 1: Empirical Parity Convergence Stress Test (tau -> 0 => E -> 1.0 WAD)
// =============================================================================

#[test]
fn test_empirical_parity_convergence_at_maturity() {
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;

    // Test a wide spectrum of pool ratios (x/y) spanning valid proportions p in [0.50, 0.96]
    // x/y = 1.000 (p = 0.50)
    // x/y = 1.222 (p = 0.55)
    // x/y = 1.500 (p = 0.60)
    // x/y = 2.333 (p = 0.70)
    // x/y = 4.000 (p = 0.80)
    // x/y = 9.000 (p = 0.90)
    // x/y = 19.000 (p = 0.95)
    // x/y = 24.000 (p = 0.96, proportion boundary limit)
    let test_ratios: [(i128, i128); 8] = [
        (1_000_000 * WAD, 1_000_000 * WAD),  // 1:1
        (1_222_222 * WAD, 1_000_000 * WAD),  // ~1.222:1
        (1_500_000 * WAD, 1_000_000 * WAD),  // 1.5:1
        (2_333_333 * WAD, 1_000_000 * WAD),  // ~2.333:1
        (4_000_000 * WAD, 1_000_000 * WAD),  // 4:1
        (9_000_000 * WAD, 1_000_000 * WAD),  // 9:1
        (19_000_000 * WAD, 1_000_000 * WAD), // 19:1
        (24_000_000 * WAD, 1_000_000 * WAD), // 24:1 (boundary 96%)
    ];

    // Decreasing time to maturity steps (seconds) down to 0 and beyond
    let time_steps_seconds: [u64; 13] = [
        365 * 86400, // 1 year
        180 * 86400, // 180 days
        90 * 86400,  // 90 days
        30 * 86400,  // 30 days
        7 * 86400,   // 7 days
        86400,       // 1 day
        3600,        // 1 hour
        600,         // 10 minutes
        60,          // 1 minute
        10,          // 10 seconds
        1,           // 1 second
        0,           // at maturity (tau = 0)
        0,           // post-maturity (simulated)
    ];

    let maturity = 100_000_000u64;

    for (pt_res, sy_res) in test_ratios.iter() {
        let mut prev_e = i128::MAX;

        for &secs_left in time_steps_seconds.iter() {
            let current_time = if secs_left == 0 {
                maturity
            } else {
                maturity - secs_left
            };

            let tau_wad = calculate_tau_wad(current_time, maturity);
            let e = get_exchange_rate(*pt_res, *sy_res, tau_wad, scalar_root, rate_anchor)
                .expect("Valid ratio exchange rate calculation failed");

            // 1. Floor property: E >= 1.0 WAD unconditionally
            assert!(
                e >= WAD,
                "E {} is strictly below 1.0 WAD floor for ratio {}/{}",
                e,
                pt_res,
                sy_res
            );

            // 2. Monotonic convergence: as tau decreases, E decreases (or stays at 1.0 WAD if ratio 1:1)
            assert!(
                e <= prev_e,
                "E did not converge monotonically: prev {}, current {}",
                prev_e,
                e
            );
            prev_e = e;

            // 3. Convergence tightness at near-maturity (tau = 1s)
            if secs_left == 1 {
                let diff_from_wad = e - WAD;
                // At tau = 1 second (1 / 31,536,000 years), with scalar_root = 20 WAD,
                // time_factor is ~1.58 * 10^(-9) WAD.
                // The difference (E - 1.0 WAD) must be < 10^(-6) WAD (10^12 stroops WAD)
                assert!(
                    diff_from_wad < 1_000_000_000_000,
                    "Near-maturity error too high at 1s: diff = {}",
                    diff_from_wad
                );
            }

            // 4. Exact parity at maturity (tau = 0): E == 1.0 WAD identically
            if secs_left == 0 {
                assert_eq!(
                    e, WAD,
                    "At tau = 0, E must identically equal 1.0 WAD for ratio {}/{}",
                    pt_res, sy_res
                );
            }
        }
    }

    // Now test contract-level parity convergence on Soroban runtime
    let f = setup_challenger();
    let init_sy = 2_500_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_200_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // Initial E at 180 days > 1.0 WAD
    let e_start = f.pool_client.get_exchange_rate();
    assert!(e_start > WAD);

    // Fast-forward to 1 second before maturity
    f.env.ledger().set_timestamp(f.maturity - 1);
    let e_1s = f.pool_client.get_exchange_rate();
    assert!(e_1s >= WAD);
    assert!((e_1s - WAD) < 1_000_000_000_000); // within 10^-6 WAD

    // Fast-forward to exact maturity
    f.env.ledger().set_timestamp(f.maturity);
    let e_mat = f.pool_client.get_exchange_rate();
    assert_eq!(
        e_mat, WAD,
        "On-chain pool exchange rate at maturity must equal exactly 1.0 WAD"
    );

    // Fast-forward post maturity
    f.env.ledger().set_timestamp(f.maturity + 86400);
    let e_post = f.pool_client.get_exchange_rate();
    assert_eq!(
        e_post, WAD,
        "On-chain pool exchange rate post-maturity must remain 1.0 WAD"
    );
}

// =============================================================================
// CHALLENGE 2: Single-Pool YT Flash Swap Collateral Conservation Stress Test
// =============================================================================

#[test]
fn test_empirical_single_pool_yt_flash_swap_collateral_conservation() {
    let f = setup_challenger();

    // Seed AMM with 2,000,000 PT and 1,500,000 SY
    let seed_sy = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &2_000_000_000, &1_500_000_000, &1);

    // User2 will execute randomized flash trades
    let user2_fund = 2_000_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_fund);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_fund);

    // Deterministic pseudo-random sequence (Linear Congruential Generator)
    let mut rng_state: u64 = 0xDEADBEEFCAFE1234;
    let mut next_rand = |min: i128, max: i128| -> i128 {
        rng_state = rng_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let span = (max - min) as u64;
        let val = (rng_state >> 32) % span;
        min + val as i128
    };

    let mut user2_yt_accumulated = 0i128;

    // Stress: 60 randomized trades back and forth
    for trade_idx in 0..60 {
        let is_buy = trade_idx % 2 == 0 || user2_yt_accumulated == 0;

        if is_buy {
            // Buy YT with SY via flash swap: spend between 50_000 and 200_000 stroops
            let sy_spend = next_rand(50_000, 200_000);
            let (yt_received, fee_yt) = f.pool_client.swap_exact_sy_for_yt(
                &f.user2,
                &f.user2,
                &sy_spend,
                &1,
                &f.maturity,
            );
            assert!(yt_received > 0);
            assert!(fee_yt > 0);
            user2_yt_accumulated += yt_received;
        } else {
            // Sell a fraction of accumulated YT for SY via flash swap
            let yt_to_sell = next_rand(10_000, user2_yt_accumulated.min(100_000));
            if yt_to_sell > 0 {
                let (sy_received, _fee) = f.pool_client.swap_exact_yt_for_sy(
                    &f.user2,
                    &f.user2,
                    &yt_to_sell,
                    &1,
                    &f.maturity,
                );
                assert!(sy_received > 0);
                user2_yt_accumulated -= yt_to_sell;
            }
        }

        // =====================================================================
        // COLLATERAL CONSERVATION & DEFICIT CHECK AT EVERY ITERATION
        // =====================================================================
        let pool_sy_bal = f.sy_client.balance(&f.pool_client.address);
        let pool_pt_bal = f.pt_client.balance(&f.pool_client.address);
        let user1_pt = f.pt_client.balance(&f.user1);
        let user2_pt = f.pt_client.balance(&f.user2);
        let total_circulating_pt = user1_pt + user2_pt;

        let (_res_pt, res_sy) = f.pool_client.get_reserves();

        // Liabilities:
        // 1. Every circulating PT held by users is entitled to 1 SY at maturity.
        // 2. The AMM pool virtual SY reserve belongs to liquidity providers.
        // Total active SY obligations = total_circulating_pt + res_sy.
        let total_obligations = total_circulating_pt + res_sy;

        // Any deficit = max(0, total_obligations - pool_sy_bal)
        let deficit = if total_obligations > pool_sy_bal {
            total_obligations - pool_sy_bal
        } else {
            0
        };

        // ZERO DEFICIT INVARIANT: Must be identically 0 at every iteration!
        assert_eq!(
            deficit, 0,
            "Trade #{}: Backing deficit detected! Obligations: {}, Pool SY: {}, Deficit: {}",
            trade_idx, total_obligations, pool_sy_bal, deficit
        );

        // Also verify PT backing: Pool's PT balance matches reserve PT
        assert_eq!(
            pool_pt_bal,
            f.pool_client.get_reserves().0,
            "Pool PT balance does not match tracked PT reserve"
        );
    }

    // Advance time past maturity to verify 100% full solvency on redemption
    f.env.ledger().set_timestamp(f.maturity + 10);
    f.pool_client.settle_maturity();

    let user1_pt = f.pt_client.balance(&f.user1);
    if user1_pt > 0 {
        let sy_out = f
            .pool_client
            .redeem_pt_post_maturity(&f.user1, &f.user1, &user1_pt);
        // Zero haircut: 1 PT -> 1 SY full payout
        assert_eq!(
            sy_out, user1_pt,
            "User1 experienced a haircut on maturity redemption!"
        );
    }
}

// =============================================================================
// CHALLENGE 3: Negative Yield Rejection (E >= 1.0 WAD Floor) Stress Test
// =============================================================================

#[test]
fn test_empirical_negative_yield_rejection_floor() {
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;
    let tau_wad = calculate_tau_wad(0, 180 * 86400); // 180 days

    // 1. Pure math: test that ANY ratio x < y (PT < SY) fails with NegativeYieldNotSupported
    let negative_yield_ratios: [(i128, i128); 6] = [
        (999_999 * WAD, 1_000_000 * WAD), // 0.999999
        (950_000 * WAD, 1_000_000 * WAD), // 0.95
        (800_000 * WAD, 1_000_000 * WAD), // 0.80
        (500_000 * WAD, 1_000_000 * WAD), // 0.50
        (200_000 * WAD, 1_000_000 * WAD), // 0.20
        (50_000 * WAD, 1_000_000 * WAD),  // 0.05
    ];

    for (pt_res, sy_res) in negative_yield_ratios.iter() {
        let err = get_exchange_rate(*pt_res, *sy_res, tau_wad, scalar_root, rate_anchor);
        assert_eq!(
            err,
            Err(ContractError::NegativeYieldNotSupported),
            "Failed to reject negative yield for ratio {} / {}",
            pt_res,
            sy_res
        );
    }

    // 2. Exact parity x == y => E == 1.0 WAD (valid zero yield floor)
    let parity_rate = get_exchange_rate(
        1_000_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    );
    assert_eq!(parity_rate, Ok(WAD));

    // 3. Contract level: Trades that would push E < 1.0 WAD must revert
    let f = setup_challenger();
    let init_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);

    // Initial pool with barely positive yield: 1,005,000 PT and 1,000,000 SY
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_005_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_005_000_000, &1_000_000_000, &1);

    // User2 tries to buy a massive amount of PT with SY, which would push PT reserve < SY reserve
    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);

    // Buying PT with 50_000_000 SY: would drain ~50M PT and add 50M SY, making PT < SY
    let swap_res =
        f.pool_client
            .try_swap_exact_sy_for_pt(&f.user2, &f.user2, &50_000_000, &1, &f.maturity);
    assert!(
        swap_res.is_err(),
        "Expected negative yield swap to fail, but it succeeded!"
    );

    // Verify reserves were untouched by failed transaction
    let (res_pt, res_sy) = f.pool_client.get_reserves();
    assert_eq!(res_pt, 1_005_000_000);
    assert_eq!(res_sy, 1_000_000_000);

    // 4. Zero-yield pool flash swap rejection
    // When E == 1.0 WAD (0% yield), buying YT must fail with NegativeYieldNotSupported
    // because YT spot price is 0 (worthless)
    let f2 = setup_challenger();
    f2.usdc_admin_client.mint(&f2.user1, &init_sy);
    f2.sy_client.deposit(&f2.user1, &f2.user1, &init_sy);
    // Balanced pool: 1,000,000 PT and 1,000,000 SY => E = 1.0 WAD
    f2.pool_client
        .mint_py(&f2.user1, &f2.user1, &1_000_000_000, &f2.maturity);
    f2.pool_client
        .add_liquidity(&f2.user1, &f2.user1, &1_000_000_000, &1_000_000_000, &1);

    f2.usdc_admin_client.mint(&f2.user2, &user2_sy);
    f2.sy_client.deposit(&f2.user2, &f2.user2, &user2_sy);

    let flash_res =
        f2.pool_client
            .try_swap_exact_sy_for_yt(&f2.user2, &f2.user2, &10_000, &1, &f2.maturity);
    assert!(
        flash_res.is_err(),
        "Flash swap buying YT in zero-yield pool must revert!"
    );
}

// =============================================================================
// CHALLENGE 4: Safe Reentrancy Teardown & Same-Ledger DoS Elimination Stress Test
// =============================================================================

#[test]
fn test_empirical_reentrancy_teardown_same_ledger_dos_elimination() {
    let f = setup_challenger();

    let fund = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &fund);
    f.sy_client.deposit(&f.user1, &f.user1, &fund);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    f.usdc_admin_client.mint(&f.user2, &fund);
    f.sy_client.deposit(&f.user2, &f.user2, &fund);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &1_000_000_000, &f.maturity);

    // 1. High-frequency sequence of 50 consecutive operations in the EXACT same ledger
    for i in 0..50 {
        match i % 5 {
            0 => {
                let (pt, yt) = f
                    .pool_client
                    .mint_py(&f.user2, &f.user2, &100_000, &f.maturity);
                assert_eq!(pt, 100_000);
                assert_eq!(yt, 100_000);
            }
            1 => {
                let (sy_out, _fee) = f.pool_client.swap_exact_pt_for_sy(
                    &f.user2,
                    &f.user2,
                    &50_000,
                    &1,
                    &f.maturity,
                );
                assert!(sy_out > 0);
            }
            2 => {
                let (pt_out, _fee) = f.pool_client.swap_exact_sy_for_pt(
                    &f.user2,
                    &f.user2,
                    &30_000,
                    &1,
                    &f.maturity,
                );
                assert!(pt_out > 0);
            }
            3 => {
                let (yt_out, _fee) = f.pool_client.swap_exact_sy_for_yt(
                    &f.user2,
                    &f.user2,
                    &20_000,
                    &1,
                    &f.maturity,
                );
                assert!(yt_out > 0);
            }
            4 => {
                let sy_out = f.pool_client.redeem_py(&f.user2, &f.user2, &50_000);
                assert_eq!(sy_out, 50_000);
            }
            _ => unreachable!(),
        }
    }

    // 2. Error injection & immediate subsequent call in same ledger
    // Ensure that failed transactions cleanly teardown reentrancy guards, causing ZERO DoS lock!
    for _ in 0..10 {
        // Deliberately trigger an error (ZeroAmount)
        let fail_mint = f
            .pool_client
            .try_mint_py(&f.user2, &f.user2, &0, &f.maturity);
        assert!(fail_mint.is_err());

        // Immediately following call MUST succeed without ReentrancyLocked
        let ok_mint = f
            .pool_client
            .mint_py(&f.user2, &f.user2, &1_000, &f.maturity);
        assert_eq!(ok_mint.0, 1_000);

        // Deliberately trigger slippage error
        let fail_swap = f.pool_client.try_swap_exact_pt_for_sy(
            &f.user2,
            &f.user2,
            &10_000,
            &i128::MAX,
            &f.maturity,
        );
        assert!(fail_swap.is_err());

        // Immediately following call MUST succeed
        let ok_swap = f.pool_client.swap_exact_pt_for_sy(
            &f.user2,
            &f.user2,
            &10_000,
            &1,
            &f.maturity,
        );
        assert!(ok_swap.0 > 0);
    }

    // 3. True reentrancy interception test:
    // If the FlashLoanGuard is active, calls into protected functions MUST be blocked with ReentrancyLocked.
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().set(&guard_key, &true);
    });

    let reentrant_attempt = f
        .pool_client
        .try_mint_py(&f.user2, &f.user2, &10_000, &f.maturity);
    assert!(reentrant_attempt.is_err());

    // Once guard is cleared (simulating normal function exit), subsequent calls proceed
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().remove(&guard_key);
    });

    let normal_call = f
        .pool_client
        .mint_py(&f.user2, &f.user2, &10_000, &f.maturity);
    assert_eq!(normal_call.0, 10_000);
}

// =============================================================================
// CHALLENGE 5: Empirical Negative Yield Floor Breach in swap_exact_sy_for_pt
// =============================================================================

#[test]
fn test_empirical_swap_sy_for_pt_negative_yield_breach() {
    let f = setup_challenger();
    let init_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);

    // Initial pool with barely positive yield: 1,005,000 PT and 1,000,000 SY (PT > SY)
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_005_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_005_000_000, &1_000_000_000, &1);

    // Initial exchange rate is valid (E > 1.0 WAD)
    let e_init = f.pool_client.get_exchange_rate();
    assert!(e_init > WAD);

    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);

    // User2 attempts to swap sy_in = 3_000_000.
    // Initial difference is 5_000_000. sy_in = 3M is less than 5M, so e_trade calculation
    // at (pt_reserve, new_sy) = (1005M, 1003M) would succeed because 1005M > 1003M,
    // but deducting net_pt_out ~ 2.97M PT would leave PT (1,002,029,854) < SY (1,003,000,000).
    // Invariant hardening MUST cleanly reject this trade with NegativeYieldNotSupported!
    let swap_res =
        f.pool_client
            .try_swap_exact_sy_for_pt(&f.user2, &f.user2, &3_000_000, &1, &f.maturity);
    assert_eq!(
        swap_res,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Swap driving PT < SY must revert cleanly with NegativeYieldNotSupported!"
    );

    // Reserves must remain unchanged and intact
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert_eq!(pt_res, 1_005_000_000);
    assert_eq!(sy_res, 1_000_000_000);

    // Pool remains in a healthy, operational state with positive yield
    assert!(f.pool_client.get_exchange_rate() > WAD);
}

// =============================================================================
// CHALLENGE 6: Empirical Proportion & Negative Yield Bypass in Subsequent add_liquidity
// =============================================================================

#[test]
fn test_empirical_subsequent_add_liquidity_skews_proportion_and_yield() {
    let f = setup_challenger();
    let init_sy = 100_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &50_000_000_000, &f.maturity);

    // Initial balanced liquidity (50% PT, 50% SY)
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_000_000_000, &1_000_000_000, &1);

    // 1. Skewed addition > 96% PT: add 40B PT and 100 SY
    // Invariant guard enforces check_market_proportion on subsequent deposits!
    let add_res = f
        .pool_client
        .try_add_liquidity(&f.user1, &f.user1, &40_000_000_000, &100, &0);
    assert_eq!(
        add_res,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Subsequent add_liquidity exceeding 96% PT must revert with ProportionOutOfBounds!"
    );

    // 2. Skewed addition pushing PT < SY within valid proportion bounds [0.04, 0.50)
    let f2 = setup_challenger();
    let init_sy2 = 50_000_000_000i128;
    f2.usdc_admin_client.mint(&f2.user1, &init_sy2);
    f2.sy_client.deposit(&f2.user1, &f2.user1, &init_sy2);
    f2.pool_client
        .mint_py(&f2.user1, &f2.user1, &2_000_000_000, &f2.maturity);
    f2.pool_client
        .add_liquidity(&f2.user1, &f2.user1, &1_000_000_000, &1_000_000_000, &1);

    // Add 100 PT and 10B SY: resulting reserves ~1.0B PT and 11.0B SY (proportion ~8.33% in [4%, 96%], but PT < SY)
    let add_res2 =
        f2.pool_client
            .try_add_liquidity(&f2.user1, &f2.user1, &100, &10_000_000_000, &0);
    assert_eq!(
        add_res2,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Subsequent add_liquidity driving PT < SY within proportion bounds must revert with NegativeYieldNotSupported!"
    );

    // 3. Skewed addition pushing proportion < 4% PT: add 100 PT and 30B SY (proportion ~3.125% < 4%)
    let add_res3 =
        f2.pool_client
            .try_add_liquidity(&f2.user1, &f2.user1, &100, &30_000_000_000, &0);
    assert_eq!(
        add_res3,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Subsequent add_liquidity below 4% PT must revert with ProportionOutOfBounds!"
    );
}

// =============================================================================
// CHALLENGE 7: Empirical Negative Yield Floor Breach in swap_exact_yt_for_sy
// =============================================================================

#[test]
fn test_empirical_swap_yt_for_sy_negative_yield_breach() {
    let f = setup_challenger();
    let init_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);

    // Initial pool with barely positive yield: 1,005,000,000 PT and 1,000,000,000 SY (PT > SY)
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_005_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_005_000_000, &1_000_000_000, &1);

    // Initial exchange rate is valid (E > 1.0 WAD)
    let e_init = f.pool_client.get_exchange_rate();
    assert!(e_init > WAD);

    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);
    // Mint PY so user2 holds YT tokens
    f.pool_client
        .mint_py(&f.user2, &f.user2, &10_000_000, &f.maturity);

    // Selling 3,000,000 YT:
    // new_pt = 1,005,000,000 - 3,000,000 = 1,002,000,000.
    // gross_sy_buy ~ 2,999,852 added to SY gives new_sy = 1,002,999,852.
    // Resulting state: new_pt (1,002,000,000) < new_sy (1,002,999,852)!
    // Invariant hardening MUST cleanly reject this trade with NegativeYieldNotSupported!
    let swap_res =
        f.pool_client
            .try_swap_exact_yt_for_sy(&f.user2, &f.user2, &3_000_000, &1, &f.maturity);
    assert_eq!(
        swap_res,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Selling YT driving PT < SY must revert cleanly with NegativeYieldNotSupported!"
    );

    // Verify reserves remain unchanged
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert_eq!(pt_res, 1_005_000_000);
    assert_eq!(sy_res, 1_000_000_000);

    // Pool remains in a healthy, operational state
    assert!(f.pool_client.get_exchange_rate() > WAD);
}

// =============================================================================
// CHALLENGE 8: Initial Liquidity Provision Invariant Stress Test
// =============================================================================

#[test]
fn test_empirical_initial_add_liquidity_invariants() {
    // 1. Initial liquidity with PT < SY within valid proportion bounds [0.04, 0.50)
    // e.g. PT = 800M, SY = 1000M (p ~ 44.4%)
    let f1 = setup_challenger();
    let fund = 5_000_000_000i128;
    f1.usdc_admin_client.mint(&f1.user1, &fund);
    f1.sy_client.deposit(&f1.user1, &f1.user1, &fund);
    f1.pool_client
        .mint_py(&f1.user1, &f1.user1, &3_000_000_000, &f1.maturity);

    let res_neg =
        f1.pool_client
            .try_add_liquidity(&f1.user1, &f1.user1, &800_000_000, &1_000_000_000, &0);
    assert_eq!(
        res_neg,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Initial liquidity with PT < SY must revert with NegativeYieldNotSupported!"
    );

    // 2. Initial liquidity below 4% PT: PT = 10M, SY = 1000M (p ~ 0.99%)
    let res_low =
        f1.pool_client
            .try_add_liquidity(&f1.user1, &f1.user1, &10_000_000, &1_000_000_000, &0);
    assert_eq!(
        res_low,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Initial liquidity with p < 4% must revert with ProportionOutOfBounds!"
    );

    // 3. Initial liquidity above 96% PT: PT = 2500M, SY = 100M (p ~ 96.15%)
    let res_high =
        f1.pool_client
            .try_add_liquidity(&f1.user1, &f1.user1, &2_500_000_000, &100_000_000, &0);
    assert_eq!(
        res_high,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Initial liquidity with p > 96% must revert with ProportionOutOfBounds!"
    );

    // 4. Initial liquidity at exact parity PT == SY (zero yield floor, p = 50%)
    let res_ok =
        f1.pool_client
            .try_add_liquidity(&f1.user1, &f1.user1, &1_000_000_000, &1_000_000_000, &0);
    assert!(
        res_ok.is_ok(),
        "Initial liquidity with PT == SY must succeed!"
    );
    let (pt_res, sy_res) = f1.pool_client.get_reserves();
    assert_eq!(pt_res, 1_000_000_000);
    assert_eq!(sy_res, 1_000_000_000);
    assert_eq!(f1.pool_client.get_exchange_rate(), WAD);
}

// =============================================================================
// CHALLENGE 9: Adversarial Multi-Action Invariant Fuzzing Matrix
// =============================================================================

#[test]
fn test_empirical_adversarial_multi_action_invariant_fuzzing() {
    let f = setup_challenger();
    let seed_sy = 20_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &10_000_000_000, &f.maturity);

    // Initial pool: 2,000,000,000 PT and 1,800,000,000 SY (p ~ 52.6%, E > 1.0 WAD)
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &2_000_000_000, &1_800_000_000, &1);

    let user2_fund = 10_000_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_fund);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_fund);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &5_000_000_000, &f.maturity);

    // LCG pseudo-random generator
    let mut rng: u64 = 0x1337BEEF98765432;
    let mut next_u64 = || -> u64 {
        rng = rng
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        rng
    };

    for step in 0..80 {
        let action = next_u64() % 6;
        let (pt_before, sy_before) = f.pool_client.get_reserves();

        match action {
            0 => {
                // swap_exact_pt_for_sy (increases PT, decreases SY)
                let pt_in = (next_u64() % 50_000_000 + 10_000) as i128;
                let _ = f.pool_client.try_swap_exact_pt_for_sy(
                    &f.user2,
                    &f.user2,
                    &pt_in,
                    &0,
                    &f.maturity,
                );
            }
            1 => {
                // swap_exact_sy_for_pt (decreases PT, increases SY)
                let sy_in = (next_u64() % 50_000_000 + 10_000) as i128;
                let _ = f.pool_client.try_swap_exact_sy_for_pt(
                    &f.user2,
                    &f.user2,
                    &sy_in,
                    &0,
                    &f.maturity,
                );
            }
            2 => {
                // swap_exact_sy_for_yt (increases PT, decreases SY)
                let sy_in = (next_u64() % 30_000_000 + 10_000) as i128;
                let _ = f.pool_client.try_swap_exact_sy_for_yt(
                    &f.user2,
                    &f.user2,
                    &sy_in,
                    &0,
                    &f.maturity,
                );
            }
            3 => {
                // swap_exact_yt_for_sy (decreases PT, increases SY)
                let yt_in = (next_u64() % 20_000_000 + 10_000) as i128;
                let _ = f.pool_client.try_swap_exact_yt_for_sy(
                    &f.user2,
                    &f.user2,
                    &yt_in,
                    &0,
                    &f.maturity,
                );
            }
            4 => {
                // add_liquidity (balanced or imbalanced)
                let pt_add = (next_u64() % 100_000_000 + 10_000) as i128;
                let sy_add = (next_u64() % 100_000_000 + 10_000) as i128;
                let _ = f
                    .pool_client
                    .try_add_liquidity(&f.user2, &f.user2, &pt_add, &sy_add, &0);
            }
            5 => {
                // remove_liquidity
                let user2_lp: i128 = f.env.as_contract(&f.pool_client.address, || {
                    let bal_key = DataKey::Balance(f.user2.clone());
                    f.env.storage().persistent().get(&bal_key).unwrap_or(0)
                });
                if user2_lp > 100 {
                    let burn_amount = (next_u64() % (user2_lp as u64 / 2) + 1) as i128;
                    let _ = f.pool_client.try_remove_liquidity(
                        &f.user2,
                        &f.user2,
                        &burn_amount,
                        &0,
                        &0,
                    );
                }
            }
            _ => unreachable!(),
        }

        let (pt_after, sy_after) = f.pool_client.get_reserves();

        // INVARIANT 1: PT reserve must ALWAYS be >= SY reserve (non-negative yield)
        assert!(
            pt_after >= sy_after,
            "Step #{}: Negative yield breached! PT = {}, SY = {} (before: PT={}, SY={})",
            step,
            pt_after,
            sy_after,
            pt_before,
            sy_before
        );

        // INVARIANT 2: Market proportion must ALWAYS remain in [0.04, 0.96]
        let total = pt_after + sy_after;
        let p_wad = common::fixed_point::wad_div(pt_after, total).unwrap();
        assert!(
            (common::yield_math::MIN_MARKET_PROPORTION..=common::yield_math::MAX_MARKET_PROPORTION)
                .contains(&p_wad),
            "Step #{}: Market proportion breached! p = {} WAD, PT = {}, SY = {}",
            step,
            p_wad,
            pt_after,
            sy_after
        );

        // INVARIANT 3: Exchange rate query must ALWAYS succeed and be >= 1.0 WAD
        let e = f.pool_client.get_exchange_rate();
        assert!(
            e >= WAD,
            "Step #{}: Exchange rate below WAD: e = {}",
            step,
            e
        );
    }
}

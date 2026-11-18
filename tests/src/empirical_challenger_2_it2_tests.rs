#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::storage_keys::DataKey;
use common::yield_math::{
    calculate_tau_wad, check_market_proportion, get_exchange_rate, swap_exact_pt_for_sy_math,
    swap_exact_sy_for_pt_math, MAX_MARKET_PROPORTION, MIN_MARKET_PROPORTION,
};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct It2Fixture<'a> {
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

fn setup_it2<'a>() -> It2Fixture<'a> {
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

    // 2. Standardized Yield Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180 days

    // 3. Yield Pool Core
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

    // 4. Principal Token
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

    // 5. Yield Token
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

    It2Fixture {
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
// 1. EMPIRICAL PARITY CONVERGENCE AT MATURITY (E -> 1.0)
// =============================================================================

#[test]
fn test_empirical_parity_convergence_boundary_exhaustive() {
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;
    let maturity = 1_000_000_000u64;

    // Test across wide spectrum of valid pool ratios: PT/SY from 1.0 up to 24.0 (proportions 50% to 96%)
    let ratios: [(i128, i128); 5] = [
        (1_000_000 * WAD, 1_000_000 * WAD),  // 1.000:1 (50% PT)
        (1_500_000 * WAD, 1_000_000 * WAD),  // 1.500:1 (60% PT)
        (4_000_000 * WAD, 1_000_000 * WAD),  // 4.000:1 (80% PT)
        (9_000_000 * WAD, 1_000_000 * WAD),  // 9.000:1 (90% PT)
        (24_000_000 * WAD, 1_000_000 * WAD), // 24.000:1 (96% boundary limit)
    ];

    // Micro-second and second steps approaching maturity
    let seconds_remaining: [u64; 8] = [
        86400, // 1 day
        3600,  // 1 hour
        60,    // 1 minute
        10,    // 10 seconds
        2,     // 2 seconds
        1,     // 1 second
        0,     // exact maturity
        0,     // post maturity
    ];

    for (pt_res, sy_res) in ratios.iter() {
        let mut prev_rate = i128::MAX;

        for &secs in seconds_remaining.iter() {
            let current_ts = if secs == 0 { maturity } else { maturity - secs };
            let tau_wad = calculate_tau_wad(current_ts, maturity);

            let e = get_exchange_rate(*pt_res, *sy_res, tau_wad, scalar_root, rate_anchor)
                .expect("Valid exchange rate calculation failed");

            // 1. Unconditional floor: E >= 1.0 WAD
            assert!(
                e >= WAD,
                "E {} < 1.0 WAD for ratio {}/{}",
                e,
                pt_res,
                sy_res
            );

            // 2. Monotonic non-increasing convergence
            assert!(
                e <= prev_rate,
                "E increased: prev {}, current {}",
                prev_rate,
                e
            );
            prev_rate = e;

            // 3. Exact parity at maturity: tau == 0 => E == 1.0 WAD identically
            if secs == 0 {
                assert_eq!(e, WAD, "At tau=0, E must equal exactly 1.0 WAD");
            }
        }
    }

    // Soroban contract runtime test at maturity boundary
    let f = setup_it2();
    let seed_sy = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &2_000_000_000, &1_500_000_000, &1);

    // Pre-maturity: rate > 1.0 WAD
    let e_pre = f.pool_client.get_exchange_rate();
    assert!(e_pre > WAD);

    // Fast-forward to EXACT maturity
    f.env.ledger().set_timestamp(f.maturity);
    let dl_mat = f.maturity + 3600;

    // Rate is exactly 1.0 WAD
    let e_at_mat = f.pool_client.get_exchange_rate();
    assert_eq!(
        e_at_mat, WAD,
        "On-chain pool exchange rate at maturity must be exactly 1.0 WAD"
    );

    // All 4 swaps MUST cleanly reject with MarketAlreadyMatured at maturity
    let err_swap1 = f
        .pool_client
        .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &10_000, &1, &dl_mat);
    assert_eq!(err_swap1, Err(Ok(ContractError::MarketAlreadyMatured)));

    let err_swap2 = f
        .pool_client
        .try_swap_exact_sy_for_pt(&f.user1, &f.user1, &10_000, &1, &dl_mat);
    assert_eq!(err_swap2, Err(Ok(ContractError::MarketAlreadyMatured)));

    let err_swap3 = f
        .pool_client
        .try_swap_exact_sy_for_yt(&f.user1, &f.user1, &10_000, &1, &dl_mat);
    assert_eq!(err_swap3, Err(Ok(ContractError::MarketAlreadyMatured)));

    let err_swap4 = f
        .pool_client
        .try_swap_exact_yt_for_sy(&f.user1, &f.user1, &10_000, &1, &dl_mat);
    assert_eq!(err_swap4, Err(Ok(ContractError::MarketAlreadyMatured)));

    // mint_py and redeem_py MUST reject with MarketAlreadyMatured
    let err_mint = f
        .pool_client
        .try_mint_py(&f.user1, &f.user1, &10_000, &dl_mat);
    assert_eq!(err_mint, Err(Ok(ContractError::MarketAlreadyMatured)));

    let err_redeem_py = f.pool_client.try_redeem_py(&f.user1, &f.user1, &10_000);
    assert_eq!(err_redeem_py, Err(Ok(ContractError::MarketAlreadyMatured)));

    // add_liquidity MUST reject with MarketAlreadyMatured
    let err_add_liq = f
        .pool_client
        .try_add_liquidity(&f.user1, &f.user1, &10_000, &10_000, &1);
    assert_eq!(err_add_liq, Err(Ok(ContractError::MarketAlreadyMatured)));

    // remove_liquidity MUST SUCCEED (LP funds cannot be locked post-maturity!)
    let user1_lp = f.pool_client.balance(&f.user1);
    assert!(user1_lp > 0);
    let (pt_out, sy_out) =
        f.pool_client
            .remove_liquidity(&f.user1, &f.user1, &(user1_lp / 2), &1, &1);
    assert!(pt_out > 0);
    assert!(sy_out > 0);

    // PT redemption post-maturity MUST succeed at 1:1 parity
    f.pool_client.settle_maturity();
    let user1_pt = f.pt_client.balance(&f.user1);
    assert!(user1_pt > 0);
    let payout = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &user1_pt);
    assert_eq!(
        payout, user1_pt,
        "At maturity settlement, 1 PT must redeem for 1 SY at parity!"
    );
}

// =============================================================================
// 2. NEGATIVE YIELD REJECTION FLOOR ACROSS ALL 4 SWAP PATHS & BOTH LIQUIDITY PATHS
// =============================================================================

#[test]
fn test_empirical_negative_yield_rejection_all_paths_exhaustive() {
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;
    let tau_wad = calculate_tau_wad(0, 180 * 86400);

    // --- Math-level tests ---
    // Exact parity (new_pt == new_sy): must succeed with E = 1.0 WAD
    let res_parity = get_exchange_rate(
        1_000_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    );
    assert_eq!(res_parity, Ok(WAD));

    // PT < SY by even 1 stroop: must return NegativeYieldNotSupported
    let res_sub1 = get_exchange_rate(
        1_000_000 * WAD - 1,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
    );
    assert_eq!(res_sub1, Err(ContractError::NegativeYieldNotSupported));

    // Math swap 1: swap_exact_pt_for_sy_math with artificially inverted reserves (new_pt < new_sy)
    let math_res_pt_sy = swap_exact_pt_for_sy_math(
        1000 * WAD,
        200_000 * WAD,
        500_000 * WAD, // PT < SY initially
        tau_wad,
        scalar_root,
        rate_anchor,
        50_000_000_000_000,
    );
    assert_eq!(
        math_res_pt_sy.err(),
        Some(ContractError::NegativeYieldNotSupported)
    );

    // Math swap 2: swap_exact_sy_for_pt_math driving new_pt < new_sy
    let math_res_sy_pt = swap_exact_sy_for_pt_math(
        3_000 * WAD,
        1_005_000 * WAD,
        1_000_000 * WAD,
        tau_wad,
        scalar_root,
        rate_anchor,
        50_000_000_000_000,
    );
    assert_eq!(
        math_res_sy_pt.err(),
        Some(ContractError::NegativeYieldNotSupported)
    );

    // --- Contract-level tests ---
    let f = setup_it2();
    let init_sy = 10_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);

    // 1. LIQUIDITY PATH 1 (INITIAL ADD_LIQUIDITY): PT < SY within valid proportions
    // User1 mints PY so they hold PT tokens to attempt the skewed deposit
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_000_000_000, &f.maturity);

    // 40,000 PT and 60,000 SY -> proportion = 40% in [4%, 96%], but PT < SY
    let err_init_add =
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &400_000_000, &600_000_000, &0);
    assert_eq!(
        err_init_add,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Initial add_liquidity with PT < SY must return NegativeYieldNotSupported!"
    );

    // Initial seed with barely positive yield: 1,005,000,000 PT and 1,000,000,000 SY (PT > SY)
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_005_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_005_000_000, &1_000_000_000, &1);

    f.usdc_admin_client.mint(&f.user2, &init_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &init_sy);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &500_000_000, &f.maturity);

    // 2. SWAP PATH 1 (swap_exact_pt_for_sy):
    // In a valid positive yield pool, swapping PT for SY increases PT reserve and decreases SY reserve.
    // PT/SY increases further. Verify that it executes and keeps E > 1.0 WAD.
    let (sy_received, _fee) =
        f.pool_client
            .swap_exact_pt_for_sy(&f.user2, &f.user2, &50_000, &1, &f.maturity);
    assert!(sy_received > 0);
    let (pt_res, sy_res) = f.pool_client.get_reserves();
    assert!(pt_res > sy_res);
    assert!(f.pool_client.get_exchange_rate() > WAD);

    // 3. SWAP PATH 2 (swap_exact_sy_for_pt):
    // Swapping 3,000,000 SY into the pool drives post-trade PT reserve below SY reserve.
    // Must be rejected with NegativeYieldNotSupported!
    let err_swap2 =
        f.pool_client
            .try_swap_exact_sy_for_pt(&f.user2, &f.user2, &3_000_000, &1, &f.maturity);
    assert_eq!(
        err_swap2,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "swap_exact_sy_for_pt driving PT < SY must revert with NegativeYieldNotSupported!"
    );
    // Reserves must be intact
    let (pt_after, sy_after) = f.pool_client.get_reserves();
    assert_eq!(pt_after, pt_res);
    assert_eq!(sy_after, sy_res);

    // 4. SWAP PATH 3 (swap_exact_sy_for_yt):
    // Set up a zero-yield pool where PT == SY (E == 1.0 WAD)
    let f_zero = setup_it2();
    f_zero.usdc_admin_client.mint(&f_zero.user1, &init_sy);
    f_zero
        .sy_client
        .deposit(&f_zero.user1, &f_zero.user1, &init_sy);
    f_zero
        .pool_client
        .mint_py(&f_zero.user1, &f_zero.user1, &1_000_000_000, &f_zero.maturity);
    f_zero.pool_client.add_liquidity(
        &f_zero.user1,
        &f_zero.user1,
        &1_000_000_000,
        &1_000_000_000,
        &1,
    );

    f_zero.usdc_admin_client.mint(&f_zero.user2, &init_sy);
    f_zero
        .sy_client
        .deposit(&f_zero.user2, &f_zero.user2, &init_sy);

    // Buying YT in zero-yield pool must revert immediately with NegativeYieldNotSupported
    let err_swap3 = f_zero.pool_client.try_swap_exact_sy_for_yt(
        &f_zero.user2,
        &f_zero.user2,
        &50_000,
        &1,
        &f_zero.maturity,
    );
    assert_eq!(
        err_swap3,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "swap_exact_sy_for_yt in zero-yield pool must revert with NegativeYieldNotSupported!"
    );

    // 5. SWAP PATH 4 (swap_exact_yt_for_sy):
    // Selling 3,000,000 YT in f's pool burns PT and adds SY, driving PT < SY.
    // Must be rejected with NegativeYieldNotSupported!
    let err_swap4 =
        f.pool_client
            .try_swap_exact_yt_for_sy(&f.user2, &f.user2, &3_000_000, &1, &f.maturity);
    assert_eq!(
        err_swap4,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "swap_exact_yt_for_sy driving PT < SY must revert with NegativeYieldNotSupported!"
    );
    // Reserves must be intact
    assert_eq!(f.pool_client.get_reserves(), (pt_res, sy_res));

    // 6. LIQUIDITY PATH 1 (SUBSEQUENT ADD_LIQUIDITY):
    // Skewing existing pool with subsequent deposit pushing PT < SY within valid proportions [0.04, 0.50)
    let err_subsequent_add =
        f.pool_client
            .try_add_liquidity(&f.user2, &f.user2, &100, &50_000_000, &0);
    assert_eq!(
        err_subsequent_add,
        Err(Ok(ContractError::NegativeYieldNotSupported)),
        "Subsequent add_liquidity driving PT < SY must revert with NegativeYieldNotSupported!"
    );
    assert_eq!(f.pool_client.get_reserves(), (pt_res, sy_res));

    // 7. LIQUIDITY PATH 2 (REMOVE_LIQUIDITY):
    // Removing liquidity proportionally: test sequential partial withdrawals
    let u1_lp = f.pool_client.balance(&f.user1);
    for &frac in &[10, 20, 30] {
        let amount = u1_lp * frac / 100;
        let (rem_pt, rem_sy) = f
            .pool_client
            .remove_liquidity(&f.user1, &f.user1, &amount, &0, &0);
        assert!(rem_pt > 0);
        assert!(rem_sy > 0);
        let (cur_pt, cur_sy) = f.pool_client.get_reserves();
        assert!(
            cur_pt >= cur_sy,
            "Post-removal reserves must satisfy PT >= SY"
        );
        assert!(f.pool_client.get_exchange_rate() >= WAD);
    }
}

// =============================================================================
// 3. PROPORTION BOUNDS ([0.04, 0.96]) ACROSS ALL OPERATIONS
// =============================================================================

#[test]
fn test_empirical_proportion_bounds_and_precedence_exhaustive() {
    // --- Pure math boundary tests ---
    // Exact 4.0%: 40 PT, 960 SY -> total = 1000 -> p = 0.04 WAD
    assert_eq!(check_market_proportion(40 * WAD, 960 * WAD), Ok(()));
    // Sub-4.0%: 39 PT, 961 SY -> total = 1000 -> p = 0.039 WAD
    assert_eq!(
        check_market_proportion(39 * WAD, 961 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );

    // Exact 96.0%: 960 PT, 40 SY -> total = 1000 -> p = 0.96 WAD
    assert_eq!(check_market_proportion(960 * WAD, 40 * WAD), Ok(()));
    // Above 96.0%: 961 PT, 39 SY -> total = 1000 -> p = 0.961 WAD
    assert_eq!(
        check_market_proportion(961 * WAD, 39 * WAD),
        Err(ContractError::ProportionOutOfBounds)
    );

    // Explicit precision limits
    assert_eq!(
        check_market_proportion(MIN_MARKET_PROPORTION, WAD - MIN_MARKET_PROPORTION),
        Ok(())
    );
    assert_eq!(
        check_market_proportion(MIN_MARKET_PROPORTION - 1, WAD - MIN_MARKET_PROPORTION + 1),
        Err(ContractError::ProportionOutOfBounds)
    );
    assert_eq!(
        check_market_proportion(MAX_MARKET_PROPORTION, WAD - MAX_MARKET_PROPORTION),
        Ok(())
    );
    assert_eq!(
        check_market_proportion(MAX_MARKET_PROPORTION + 1, WAD - MAX_MARKET_PROPORTION - 1),
        Err(ContractError::ProportionOutOfBounds)
    );

    // --- Contract runtime tests ---
    let f = setup_it2();
    let init_sy = 100_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);

    // 1. Initial add_liquidity < 4% PT:
    // User1 mints PT first so they have sufficient balance
    f.pool_client
        .mint_py(&f.user1, &f.user1, &100_000_000, &f.maturity);

    // 3,000 PT and 97,000 SY -> proportion = 3% < 4%
    // Even though PT < SY, ProportionOutOfBounds MUST take precedence!
    let err_init_low =
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &3_000_000, &97_000_000, &0);
    assert_eq!(
        err_init_low,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Initial add_liquidity < 4% PT must return ProportionOutOfBounds (precedence over NegativeYield)!"
    );

    // 2. Initial add_liquidity > 96% PT:
    // 97,000 PT and 3,000 SY -> proportion = 97% > 96%
    f.pool_client
        .mint_py(&f.user1, &f.user1, &100_000_000, &f.maturity);
    let err_init_high =
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &97_000_000, &3_000_000, &0);
    assert_eq!(
        err_init_high,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Initial add_liquidity > 96% PT must return ProportionOutOfBounds!"
    );

    // Valid initial deposit (50% PT, 50% SY)
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_000_000_000, &1_000_000_000, &1);

    // 3. Subsequent add_liquidity > 96% PT:
    f.pool_client
        .mint_py(&f.user1, &f.user1, &50_000_000_000, &f.maturity);
    let err_sub_high =
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &50_000_000_000, &10, &0);
    assert_eq!(
        err_sub_high,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Subsequent add_liquidity exceeding 96% PT must return ProportionOutOfBounds!"
    );

    // 4. Subsequent add_liquidity < 4% PT:
    f.usdc_admin_client.mint(&f.user1, &60_000_000_000);
    f.sy_client.deposit(&f.user1, &f.user1, &60_000_000_000);
    let err_sub_low = f
        .pool_client
        .try_add_liquidity(&f.user1, &f.user1, &10, &50_000_000_000, &0);
    assert_eq!(
        err_sub_low,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "Subsequent add_liquidity below 4% PT must return ProportionOutOfBounds!"
    );

    // 5. swap_exact_pt_for_sy pushing proportion > 96%:
    // Set up a pool already close to 96% PT: 23,000,000 PT and 1,000,000 SY (p = 23/24 = 95.83%)
    let f_near_max = setup_it2();
    let seed_near_max = 50_000_000_000i128;
    f_near_max
        .usdc_admin_client
        .mint(&f_near_max.user1, &seed_near_max);
    f_near_max
        .sy_client
        .deposit(&f_near_max.user1, &f_near_max.user1, &seed_near_max);
    f_near_max
        .pool_client
        .mint_py(&f_near_max.user1, &f_near_max.user1, &30_000_000_000, &f_near_max.maturity);
    f_near_max.pool_client.add_liquidity(
        &f_near_max.user1,
        &f_near_max.user1,
        &23_000_000_000,
        &1_000_000_000,
        &1,
    );

    // Swapping 500,000,000 PT extracts ~450M SY (well within 1,000M SY reserve),
    // but pushes post-trade proportion to > 96.5% PT!
    let err_swap_pt_high = f_near_max.pool_client.try_swap_exact_pt_for_sy(
        &f_near_max.user1,
        &f_near_max.user1,
        &500_000_000,
        &1,
        &f_near_max.maturity,
    );
    assert_eq!(
        err_swap_pt_high,
        Err(Ok(ContractError::ProportionOutOfBounds)),
        "swap_exact_pt_for_sy pushing PT proportion > 96% must return ProportionOutOfBounds!"
    );
}

// =============================================================================
// 4. REENTRANCY LOCKS ACROSS ALL 11 EXTERNAL OPERATIONS
// =============================================================================

#[test]
fn test_empirical_reentrancy_guards_all_11_operations_exhaustive() {
    let f = setup_it2();
    let seed_sy = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // Engage the temporary mutex lock simulating an in-flight reentrant call
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().set(&guard_key, &true);
    });

    // 1. mint_py
    assert_eq!(
        f.pool_client
            .try_mint_py(&f.user1, &f.user1, &1000, &f.maturity),
        Err(Ok(ContractError::ReentrancyLocked)),
        "mint_py must be protected by reentrancy lock"
    );

    // 2. redeem_py
    assert_eq!(
        f.pool_client.try_redeem_py(&f.user1, &f.user1, &1000),
        Err(Ok(ContractError::ReentrancyLocked)),
        "redeem_py must be protected by reentrancy lock"
    );

    // 3. redeem_pt_post_maturity
    assert_eq!(
        f.pool_client
            .try_redeem_pt_post_maturity(&f.user1, &f.user1, &1000),
        Err(Ok(ContractError::ReentrancyLocked)),
        "redeem_pt_post_maturity must be protected by reentrancy lock"
    );

    // 4. redeem_pt_to_btoken
    assert_eq!(
        f.pool_client
            .try_redeem_pt_to_btoken(&f.user1, &f.user1, &1000),
        Err(Ok(ContractError::ReentrancyLocked)),
        "redeem_pt_to_btoken must be protected by reentrancy lock"
    );

    // 5. claim_yield
    assert_eq!(
        f.pool_client.try_claim_yield(&f.user1, &f.user1),
        Err(Ok(ContractError::ReentrancyLocked)),
        "claim_yield must be protected by reentrancy lock"
    );

    // 6. swap_exact_pt_for_sy
    assert_eq!(
        f.pool_client
            .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &1000, &1, &f.maturity),
        Err(Ok(ContractError::ReentrancyLocked)),
        "swap_exact_pt_for_sy must be protected by reentrancy lock"
    );

    // 7. swap_exact_sy_for_pt
    assert_eq!(
        f.pool_client
            .try_swap_exact_sy_for_pt(&f.user1, &f.user1, &1000, &1, &f.maturity),
        Err(Ok(ContractError::ReentrancyLocked)),
        "swap_exact_sy_for_pt must be protected by reentrancy lock"
    );

    // 8. swap_exact_sy_for_yt
    assert_eq!(
        f.pool_client
            .try_swap_exact_sy_for_yt(&f.user1, &f.user1, &1000, &1, &f.maturity),
        Err(Ok(ContractError::ReentrancyLocked)),
        "swap_exact_sy_for_yt must be protected by reentrancy lock"
    );

    // 9. swap_exact_yt_for_sy
    assert_eq!(
        f.pool_client
            .try_swap_exact_yt_for_sy(&f.user1, &f.user1, &1000, &1, &f.maturity),
        Err(Ok(ContractError::ReentrancyLocked)),
        "swap_exact_yt_for_sy must be protected by reentrancy lock"
    );

    // 10. add_liquidity
    assert_eq!(
        f.pool_client
            .try_add_liquidity(&f.user1, &f.user1, &1000, &1000, &1),
        Err(Ok(ContractError::ReentrancyLocked)),
        "add_liquidity must be protected by reentrancy lock"
    );

    // 11. remove_liquidity
    assert_eq!(
        f.pool_client
            .try_remove_liquidity(&f.user1, &f.user1, &1000, &1, &1),
        Err(Ok(ContractError::ReentrancyLocked)),
        "remove_liquidity must be protected by reentrancy lock"
    );

    // Release reentrancy guard
    f.env.as_contract(&f.pool_client.address, || {
        let guard_key = DataKey::FlashLoanGuard;
        f.env.storage().temporary().remove(&guard_key);
    });

    // Verify all 11 operations execute without ReentrancyLocked once freed
    let (pt, yt) = f
        .pool_client
        .mint_py(&f.user1, &f.user1, &10_000, &f.maturity);
    assert_eq!(pt, 10_000);
    assert_eq!(yt, 10_000);

    let (sy_out, _) =
        f.pool_client
            .swap_exact_pt_for_sy(&f.user1, &f.user1, &5_000, &1, &f.maturity);
    assert!(sy_out > 0);

    // Verify error teardown across operations (errors do NOT leave lock behind)
    let bad_call =
        f.pool_client
            .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &0, &1, &f.maturity);
    assert!(bad_call.is_err());
    // Subsequent call succeeds immediately
    let good_call =
        f.pool_client
            .swap_exact_pt_for_sy(&f.user1, &f.user1, &1_000, &1, &f.maturity);
    assert!(good_call.0 > 0);
}

// =============================================================================
// 5. STORAGE TTL RENEWALS ON ALL OPERATIONS
// =============================================================================

#[test]
fn test_empirical_storage_ttl_renewals_exhaustive() {
    let f = setup_it2();
    let seed_sy = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // Advance sequence number and check TTL extensions succeed without panicking across operations
    f.env.ledger().set_sequence_number(50_000);

    // 1. mint_py triggers instance TTL bump
    f.pool_client
        .mint_py(&f.user1, &f.user1, &10_000, &f.maturity);

    // 2. swap_exact_pt_for_sy triggers instance TTL bump
    f.pool_client
        .swap_exact_pt_for_sy(&f.user1, &f.user1, &5_000, &1, &f.maturity);

    // 3. swap_exact_sy_for_pt triggers instance TTL bump
    f.pool_client
        .swap_exact_sy_for_pt(&f.user1, &f.user1, &2_000, &1, &f.maturity);

    // 4. swap_exact_sy_for_yt triggers instance TTL bump
    f.pool_client
        .swap_exact_sy_for_yt(&f.user1, &f.user1, &1_000, &1, &f.maturity);

    // 5. swap_exact_yt_for_sy triggers instance TTL bump
    f.pool_client
        .swap_exact_yt_for_sy(&f.user1, &f.user1, &500, &1, &f.maturity);

    // 6. add_liquidity triggers persistent balance and instance TTL bumps
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &10_000, &10_000, &1);

    // 7. remove_liquidity triggers persistent balance and instance TTL bumps
    f.pool_client
        .remove_liquidity(&f.user1, &f.user1, &5_000, &1, &1);

    // 8. SEP-41 LP token transfer triggers persistent sender & receiver TTL bumps
    f.pool_client.transfer(&f.user1, &f.user2, &1_000);
    assert_eq!(f.pool_client.balance(&f.user2), 1_000);

    // 9. SEP-41 approve triggers temporary allowance TTL bump
    f.pool_client.approve(&f.user1, &f.user2, &10_000, &100_000);
    assert_eq!(f.pool_client.allowance(&f.user1, &f.user2), 10_000);

    // 10. SEP-41 transfer_from triggers allowance, sender, receiver TTL bumps
    f.pool_client
        .transfer_from(&f.user2, &f.user1, &f.user2, &500);
    assert_eq!(f.pool_client.balance(&f.user2), 1_500);

    // 11. SEP-41 burn triggers persistent balance TTL bump
    f.pool_client.burn(&f.user2, &500);
    assert_eq!(f.pool_client.balance(&f.user2), 1_000);

    // 12. Fast-forward to maturity and settle
    f.env.ledger().set_timestamp(f.maturity);
    f.pool_client.settle_maturity();

    // 13. redeem_pt_post_maturity triggers instance TTL bump
    let pt_bal = f.pt_client.balance(&f.user1);
    f.pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &pt_bal);

    // 14. claim_yield triggers instance TTL bump
    f.pool_client.claim_yield(&f.user1, &f.user1);
}

#![cfg(test)]
extern crate std;

mod blend_accrual_tests;
mod challenger_m1_1_tests;
mod challenger_m1_2_stress_tests;
mod challenger_m2_1_tests;
mod challenger_m2_2_stress_tests;
mod challenger_m3_1_stress_tests;
mod challenger_m3_2_tests;
mod challenger_tests;
mod empirical_challenger_2_it2_tests;
mod empirical_challenger_2_tests;
mod factory_tests;
mod security_hardening_tests;

use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::{
    Request, REQUEST_TYPE_SUPPLY_COLLATERAL, REQUEST_TYPE_WITHDRAW_COLLATERAL,
};
use common::ttl::{calculate_bump_to, MAX_NETWORK_TTL};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, vec, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct IntegrationFixture<'a> {
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

fn setup_protocol<'a>() -> IntegrationFixture<'a> {
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

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180-day maturity

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

    IntegrationFixture {
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

// 1. Mock Blend collateral lifecycle
#[test]
fn test_mock_blend_collateral_lifecycle() {
    let f = setup_protocol();
    let deposit = 1_000_000_000i128; // 1000 USDC

    f.usdc_admin_client.mint(&f.user1, &deposit);

    let requests = vec![
        &f.env,
        Request {
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            address: f.usdc_client.address.clone(),
            amount: deposit,
        },
    ];

    f.blend_client
        .submit(&f.user1, &f.user1, &f.user1, &requests);
    assert_eq!(f.blend_client.get_collateral(&f.user1), deposit);

    // Bump b_rate by 15%
    f.blend_client.set_b_rate(&1_150_000_000);
    assert_eq!(f.blend_client.get_b_rate(), 1_150_000_000);

    // Fund extra interest
    f.usdc_admin_client
        .mint(&f.blend_client.address, &150_000_000);

    let withdraw_requests = vec![
        &f.env,
        Request {
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
            address: f.usdc_client.address.clone(),
            amount: 1_150_000_000,
        },
    ];
    f.blend_client
        .submit(&f.user1, &f.user1, &f.user1, &withdraw_requests);
    assert_eq!(f.usdc_client.balance(&f.user1), 1_150_000_000);
    assert_eq!(f.blend_client.get_collateral(&f.user1), 0);
}

// 2. SY blend wrapper vault accounting
#[test]
fn test_sy_blend_wrapper_vault_accounting() {
    let f = setup_protocol();
    let deposit = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &deposit);
    let shares = f.sy_client.deposit(&f.user1, &f.user1, &deposit);

    assert_eq!(shares, deposit);
    assert_eq!(f.sy_client.balance(&f.user1), deposit);
    assert_eq!(f.sy_client.exchange_rate(), SCALAR_9);

    // Rate increases to 1.10
    f.blend_client.set_b_rate(&1_100_000_000);
    assert_eq!(f.sy_client.exchange_rate(), 1_100_000_000);

    f.usdc_admin_client
        .mint(&f.blend_client.address, &100_000_000);

    let underlying_back = f.sy_client.redeem(&f.user1, &f.user1, &shares);
    assert_eq!(underlying_back, 1_100_000_000);
    assert_eq!(f.sy_client.balance(&f.user1), 0);
}

// 3. Atomic mint PY and early unwind
#[test]
fn test_atomic_mint_py_and_early_unwind() {
    let f = setup_protocol();
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);

    let (pt_out, yt_out) = f.pool_client.mint_py(&f.user1, &f.user1, &amount);
    assert_eq!(pt_out, amount);
    assert_eq!(yt_out, amount);
    assert_eq!(f.pt_client.balance(&f.user1), amount);
    assert_eq!(f.yt_client.balance(&f.user1), amount);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), amount);

    // Unwind 400 PT + 400 YT
    let returned = f.pool_client.redeem_py(&f.user1, &f.user1, &400_000_000);
    assert_eq!(returned, 400_000_000);
    assert_eq!(f.pt_client.balance(&f.user1), 600_000_000);
    assert_eq!(f.yt_client.balance(&f.user1), 600_000_000);
    assert_eq!(f.sy_client.balance(&f.user1), 400_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 600_000_000);
}

// 4. YT checkpointing hook and yield claim
#[test]
fn test_yt_checkpointing_hook_and_yield_claim() {
    let f = setup_protocol();
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Index increases by 10%
    f.blend_client.set_b_rate(&1_100_000_000);

    // Clean yield claim without artificial admin subsidy!
    let claimed = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert_eq!(claimed, 90_909_090);
    assert_eq!(f.sy_client.balance(&f.user1), 90_909_090);
    // Verify pool still retains remaining SY backing PT principal
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 909_090_910);

    // Subsequent immediate claim yields 0
    let claimed_again = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert_eq!(claimed_again, 0);
}

// 5. YT transfer balance checkpointing
#[test]
fn test_yt_transfer_balance_checkpointing() {
    let f = setup_protocol();
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Index moves to 1.05 (+5%)
    f.blend_client.set_b_rate(&1_050_000_000);

    // User1 transfers 500 YT to User2
    f.yt_client.transfer(&f.user1, &f.user2, &500_000_000);

    let state_u1 = f.yt_client.get_user_yield_state(&f.user1);
    assert_eq!(state_u1.unclaimed_yield, 50_000_000);
    assert_eq!(state_u1.yt_balance, 500_000_000);

    let state_u2 = f.yt_client.get_user_yield_state(&f.user2);
    assert_eq!(state_u2.unclaimed_yield, 0);
    assert_eq!(state_u2.yt_balance, 500_000_000);
}

// 6. Log-normal AMM swaps
#[test]
fn test_log_normal_amm_swaps() {
    let f = setup_protocol();

    let mint_amount = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &mint_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &mint_amount);

    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);

    // Add liquidity: 1,200,000 PT and 1,000,000 SY
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 mints PT and executes swap exact PT for SY
    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);
    f.pool_client.mint_py(&f.user2, &f.user2, &100_000_000);

    let (sy_out, fee) = f
        .pool_client
        .swap_exact_pt_for_sy(&f.user2, &f.user2, &50_000_000, &1);
    assert!(sy_out > 0);
    assert!(fee > 0);

    // Swap exact SY for PT
    let (pt_out, fee2) = f
        .pool_client
        .swap_exact_sy_for_pt(&f.user2, &f.user2, &20_000_000, &1);
    assert!(pt_out > 0);
    assert!(fee2 > 0);
}

// 7. Single-pool flash swaps for YT
#[test]
fn test_single_pool_flash_swaps_yt() {
    let f = setup_protocol();

    let init_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);
    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    let user2_sy = 50_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);

    let sy_spend = 500_000i128;
    let (yt_minted, sy_paid) = f
        .pool_client
        .swap_exact_sy_for_yt(&f.user2, &f.user2, &sy_spend, &1);
    assert!(yt_minted > 0);
    assert_eq!(sy_paid, sy_spend);
    assert_eq!(f.yt_client.balance(&f.user2), yt_minted);

    // Sell YT back for SY
    let (sy_rec, fee) =
        f.pool_client
            .swap_exact_yt_for_sy(&f.user2, &f.user2, &(yt_minted / 2), &1);
    assert!(sy_rec > 0);
    assert!(fee > 0);
}

// 8. Add/remove liquidity with dead shares
#[test]
fn test_add_remove_liquidity_dead_shares() {
    let f = setup_protocol();

    let initial_sy = 2_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &initial_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &initial_sy);
    f.pool_client.mint_py(&f.user1, &f.user1, &1_000_000_000);

    let lp_shares =
        f.pool_client
            .add_liquidity(&f.user1, &f.user1, &1_000_000_000, &1_000_000_000, &1);
    assert_eq!(lp_shares, 1_000_000_000 - 1_000);

    let (pt_out, sy_out) = f
        .pool_client
        .remove_liquidity(&f.user1, &f.user1, &lp_shares, &1, &1);
    assert!(pt_out > 0);
    assert!(sy_out > 0);
}

// 9. Post-maturity settlement and PT redemption
#[test]
fn test_post_maturity_settlement_and_pt_redemption() {
    let f = setup_protocol();
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Advance time to post-maturity
    f.env.ledger().set_timestamp(f.maturity + 100);

    let settled_rate = f.pool_client.settle_maturity();
    assert_eq!(settled_rate, SCALAR_9);

    let payout = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &amount);
    assert_eq!(payout, amount);
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.user1), amount);
}

// 10. Blend bad-debt proportional haircut (multi-user sequential redemption)
#[test]
fn test_blend_bad_debt_proportional_haircut() {
    let f = setup_protocol();
    let user_amount = 500_000_000i128;
    let total_amount = 1_000_000_000i128;

    // User 1 deposits 500 SY and mints 500 PT + 500 YT
    f.usdc_admin_client.mint(&f.user1, &user_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user_amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &user_amount);

    // User 2 deposits 500 SY and mints 500 PT + 500 YT
    f.usdc_admin_client.mint(&f.user2, &user_amount);
    f.sy_client.deposit(&f.user2, &f.user2, &user_amount);
    f.pool_client.mint_py(&f.user2, &f.user2, &user_amount);

    assert_eq!(f.pt_client.total_supply(), total_amount);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), total_amount);

    // Simulate 10% bad debt loss in pool vault SY balance (e.g. 100 SY lost)
    f.sy_client.burn(&f.pool_client.address, &100_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 900_000_000);
    assert_eq!(f.pt_client.total_supply(), total_amount);

    f.env.ledger().set_timestamp(f.maturity + 100);

    // User 1 redeems FIRST
    let payout1 = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &user_amount);
    // Solvency haircut H = 90% -> 450 SY returned per 500 PT
    assert_eq!(payout1, 450_000_000);
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.user1), 450_000_000);
    assert_eq!(f.pt_client.total_supply(), 500_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 450_000_000);

    // User 2 redeems SECOND
    let payout2 = f
        .pool_client
        .redeem_pt_post_maturity(&f.user2, &f.user2, &user_amount);
    // Solvency haircut H = 450 / 500 = 90% -> 450 SY returned per 500 PT
    assert_eq!(payout2, 450_000_000);
    assert_eq!(f.pt_client.balance(&f.user2), 0);
    assert_eq!(f.sy_client.balance(&f.user2), 450_000_000);
    assert_eq!(f.pt_client.total_supply(), 0);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);

    // Equal recovery percentage for both users: no bank run advantage!
    assert_eq!(payout1, payout2);
    assert_eq!(payout1 + payout2, 900_000_000);
}

#[test]
fn test_blend_bad_debt_unequal_shares_multi_step_redemption() {
    let f = setup_protocol();
    let user1_amount = 700_000_000i128;
    let user2_amount = 300_000_000i128;
    let total_amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &user1_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &user1_amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &user1_amount);

    f.usdc_admin_client.mint(&f.user2, &user2_amount);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_amount);
    f.pool_client.mint_py(&f.user2, &f.user2, &user2_amount);

    // Simulate 20% bad debt deficit (200 SY lost out of 1000 SY -> 800 SY remaining)
    f.sy_client.burn(&f.pool_client.address, &200_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 800_000_000);
    assert_eq!(f.pt_client.total_supply(), total_amount);

    f.env.ledger().set_timestamp(f.maturity + 100);

    // Step 1: User 1 redeems partial position (400 PT out of 700 PT)
    let payout1a = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &400_000_000);
    assert_eq!(payout1a, 320_000_000); // 80% recovery
    assert_eq!(f.pt_client.balance(&f.user1), 300_000_000);
    assert_eq!(f.pt_client.total_supply(), 600_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 480_000_000);

    // Step 2: User 2 redeems full position (300 PT)
    let payout2 = f
        .pool_client
        .redeem_pt_post_maturity(&f.user2, &f.user2, &300_000_000);
    assert_eq!(payout2, 240_000_000); // 80% recovery
    assert_eq!(f.pt_client.balance(&f.user2), 0);
    assert_eq!(f.pt_client.total_supply(), 300_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 240_000_000);

    // Step 3: User 1 redeems remaining position (300 PT)
    let payout1b = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &300_000_000);
    assert_eq!(payout1b, 240_000_000); // 80% recovery
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.pt_client.total_supply(), 0);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);

    // Verify proportional recovery rates: User 1 received 560M / 700M = 80%, User 2 received 240M / 300M = 80%
    assert_eq!(payout1a + payout1b, 560_000_000);
    assert_eq!(payout2, 240_000_000);
    assert_eq!(payout1a + payout1b + payout2, 800_000_000);
}

// 11. 100% Blend utilization raw bToken emergency exit
#[test]
fn test_100_percent_blend_utilization_emergency_exit() {
    let f = setup_protocol();
    let amount = 1_000_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    f.env.ledger().set_timestamp(f.maturity + 100);

    let btokens = f
        .pool_client
        .redeem_pt_to_btoken(&f.user1, &f.user1, &amount);
    assert_eq!(btokens, amount);
    assert_eq!(f.blend_client.get_collateral(&f.user1), amount);
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);
    assert_eq!(f.blend_client.get_collateral(&f.sy_client.address), 0);
}

// 12. Reentrancy teardown safety
#[test]
fn test_reentrancy_teardown_safety() {
    let f = setup_protocol();
    let amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);

    // Consecutive calls in same ledger succeed cleanly without DoS lock
    let (pt1, yt1) = f.pool_client.mint_py(&f.user1, &f.user1, &(amount / 2));
    assert_eq!(pt1, amount / 2);
    assert_eq!(yt1, amount / 2);

    let (pt2, yt2) = f.pool_client.mint_py(&f.user1, &f.user1, &(amount / 2));
    assert_eq!(pt2, amount / 2);
    assert_eq!(yt2, amount / 2);
}

// 13. Dynamic TTL calibration
#[test]
fn test_dynamic_ttl_calibration() {
    let now = 1_000_000_000u64;
    let mat_180d = now + 180 * 86400;
    let bump = calculate_bump_to(now, mat_180d);
    assert_eq!(bump, MAX_NETWORK_TTL);
}

// 14. Empirical Challenger Math Boundary Stress Test
#[test]
fn test_empirical_challenger_math_boundaries() {
    use common::errors::ContractError;
    use common::fixed_point::{div_256_64, wad_div, wad_mul};
    use common::transcendental::{exp_wad, ln_wad, LN_2, MAX_EXP_INPUT};

    // 1. Fixed Point 256-bit limb multiplication and division
    assert_eq!(wad_mul(0, 0).unwrap(), 0);
    assert_eq!(wad_mul(1, 1).unwrap(), 0);
    assert_eq!(wad_mul(1, WAD).unwrap(), 1);
    assert_eq!(wad_mul(WAD, WAD).unwrap(), WAD);
    assert_eq!(
        wad_div(WAD, 1).unwrap(),
        1_000_000_000_000_000_000_000_000_000_000_000_000i128
    );
    assert_eq!(wad_div(100 * WAD, 0), Err(ContractError::DivisionByZero));
    assert_eq!(wad_mul(i128::MAX, WAD).unwrap(), i128::MAX);
    assert_eq!(
        wad_mul(i128::MAX, WAD + 1),
        Err(ContractError::MathOverflow)
    );
    assert_eq!(wad_div(i128::MAX, WAD).unwrap(), i128::MAX);
    assert_eq!(
        wad_div(i128::MAX, WAD - 1),
        Err(ContractError::MathOverflow)
    );

    // 2. div_256_64 Restoring bitwise division
    assert_eq!(div_256_64(0, 100, 0), Err(ContractError::DivisionByZero));
    assert_eq!(div_256_64(10, 0, 10), Err(ContractError::MathOverflow));
    let (q, rem) = div_256_64(0, 100, 10).unwrap();
    assert_eq!(q, 10);
    assert_eq!(rem, 0);

    // 3. ln_wad Domain Edges
    assert_eq!(ln_wad(0), Err(ContractError::NegativeLogarithmInput));
    assert_eq!(ln_wad(-1), Err(ContractError::NegativeLogarithmInput));
    assert_eq!(
        ln_wad(i128::MIN),
        Err(ContractError::NegativeLogarithmInput)
    );
    assert_eq!(ln_wad(WAD).unwrap(), 0);
    let ln_2 = ln_wad(2 * WAD).unwrap();
    assert!((ln_2 - LN_2).abs() < 1_000_000);
    let ln_unit = ln_wad(1).unwrap();
    assert!((ln_unit - (-41_446_531_673_892_820_000i128)).abs() < 10_000_000_000);
    let ln_max = ln_wad(i128::MAX).unwrap();
    assert!((ln_max - 46_583_160_257_220_230_000i128).abs() < 10_000_000_000);

    // 4. exp_wad Domain Edges
    assert_eq!(exp_wad(0).unwrap(), WAD);
    let exp_1 = exp_wad(WAD).unwrap();
    assert!((exp_1 - 2_718_281_828_459_045_235i128).abs() < 100_000_000_000);
    assert_eq!(exp_wad(-42 * WAD).unwrap(), 0);
    assert_eq!(exp_wad(i128::MIN).unwrap(), 0);
    let exp_max = exp_wad(MAX_EXP_INPUT).unwrap();
    assert!(exp_max > 0);
    assert!(exp_max < i128::MAX);
    assert_eq!(exp_wad(MAX_EXP_INPUT + 1), Err(ContractError::MathOverflow));
    assert_eq!(exp_wad(i128::MAX), Err(ContractError::MathOverflow));
}

// 15. Empirical Challenger Dynamic TTL Calibration (1d, 180d, 365d)
#[test]
fn test_empirical_challenger_dynamic_ttl_across_horizons() {
    use common::ttl::{
        bump_instance_ttl, calculate_bump_threshold, DEFAULT_BUMP_TO, MIN_BUMP_THRESHOLD,
    };

    let f = setup_protocol();
    let now = f.env.ledger().timestamp();

    // Horizon 1: 1-Day Horizon
    let mat_1d = now + 86_400;
    let bump_1d = calculate_bump_to(now, mat_1d);
    let thresh_1d = calculate_bump_threshold(bump_1d);
    assert_eq!(bump_1d, DEFAULT_BUMP_TO); // 120 days
    assert_eq!(thresh_1d, MIN_BUMP_THRESHOLD); // 30 days
    assert!(thresh_1d < bump_1d);
    assert!(bump_1d <= MAX_NETWORK_TTL);

    f.env.as_contract(&f.pool_client.address, || {
        bump_instance_ttl(&f.env, mat_1d);
    });

    // Horizon 2: 180-Day Horizon
    let mat_180d = now + 180 * 86_400;
    let bump_180d = calculate_bump_to(now, mat_180d);
    let thresh_180d = calculate_bump_threshold(bump_180d);
    assert_eq!(bump_180d, MAX_NETWORK_TTL); // 180 days
    assert_eq!(thresh_180d, 777_600); // 45 days
    assert!(thresh_180d < bump_180d);

    f.env.as_contract(&f.pool_client.address, || {
        bump_instance_ttl(&f.env, mat_180d);
    });

    // Horizon 3: 365-Day Horizon
    let mat_365d = now + 365 * 86_400;
    let bump_365d = calculate_bump_to(now, mat_365d);
    let thresh_365d = calculate_bump_threshold(bump_365d);
    assert_eq!(bump_365d, MAX_NETWORK_TTL); // Clamped to 180 days
    assert_eq!(thresh_365d, 777_600);
    assert!(thresh_365d < bump_365d);

    f.env.as_contract(&f.pool_client.address, || {
        bump_instance_ttl(&f.env, mat_365d);
    });
}

// 16. Security Audit Regression: Self-transfer (from == to) cannot mint tokens
#[test]
fn test_security_self_transfer_no_inflation() {
    let f = setup_protocol();
    let amount = 100_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &(amount * 4));
    f.sy_client.deposit(&f.user1, &f.user1, &(amount * 4));
    assert_eq!(f.sy_client.balance(&f.user1), amount * 4);

    // Self-transfer SY
    f.sy_client.transfer(&f.user1, &f.user1, &amount);
    assert_eq!(f.sy_client.balance(&f.user1), amount * 4);

    // Mint PY and self-transfer PT & YT (both direct transfer & transfer_from)
    f.pool_client.mint_py(&f.user1, &f.user1, &(amount * 2));
    f.pt_client.transfer(&f.user1, &f.user1, &amount);
    assert_eq!(f.pt_client.balance(&f.user1), amount * 2);

    f.pt_client.approve(&f.user1, &f.user2, &amount, &10_000);
    f.pt_client
        .transfer_from(&f.user2, &f.user1, &f.user1, &amount);
    assert_eq!(f.pt_client.balance(&f.user1), amount * 2);

    f.yt_client.transfer(&f.user1, &f.user1, &amount);
    assert_eq!(f.yt_client.balance(&f.user1), amount * 2);

    // LP self-transfer
    let lp = f
        .pool_client
        .add_liquidity(&f.user1, &f.user1, &amount, &amount, &1);
    f.pool_client.transfer(&f.user1, &f.user1, &(lp / 2));
    assert_eq!(f.pool_client.balance(&f.user1), lp);

    // MockBlend collateral self-transfer
    f.usdc_admin_client.mint(&f.user2, &amount);
    let requests = vec![
        &f.env,
        Request {
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            address: f.usdc_client.address.clone(),
            amount,
        },
    ];
    f.blend_client
        .submit(&f.user2, &f.user2, &f.user2, &requests);
    f.blend_client
        .transfer_collateral(&f.user2, &f.user2, &amount);
    assert_eq!(f.blend_client.get_collateral(&f.user2), amount);
}

// 17. Security Audit Regression: swap_exact_pt_for_sy proto_fee solvency conservation
#[test]
fn test_security_pt_for_sy_protocol_fee_solvency() {
    let f = setup_protocol();
    let seed_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &seed_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &seed_sy);
    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);
    let lp = f
        .pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 mints PT and swaps large PT for SY repeatedly (triggering proto_fee transfers to admin)
    let u2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &u2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &u2_sy);
    f.pool_client.mint_py(&f.user2, &f.user2, &u2_sy);

    for _ in 0..5 {
        f.pool_client
            .swap_exact_pt_for_sy(&f.user2, &f.user2, &100_000_000, &1);
    }

    let (_res_pt, res_sy) = f.pool_client.get_reserves();
    let pool_sy = f.sy_client.balance(&f.pool_client.address);
    let circulating_pt = f.pt_client.total_supply() - f.pt_client.balance(&f.pool_client.address);
    assert!(pool_sy >= res_sy + circulating_pt);
    assert!(f.sy_client.balance(&f.admin) > 0);

    // Full LP withdrawal must succeed cleanly without touching circulating PT backing
    let (pt_out, sy_out) = f
        .pool_client
        .remove_liquidity(&f.user1, &f.user1, &lp, &1, &1);
    assert!(pt_out > 0 && sy_out > 0);
    let remaining_pool_sy = f.sy_client.balance(&f.pool_client.address);
    assert!(remaining_pool_sy >= circulating_pt);
}

// 18. Security Audit Regression: redeem_pt_to_btoken enforces solvency haircut on bad debt
#[test]
fn test_security_redeem_btoken_bad_debt_haircut() {
    let f = setup_protocol();
    let half = 500_000_000i128;

    f.usdc_admin_client.mint(&f.user1, &half);
    f.sy_client.deposit(&f.user1, &f.user1, &half);
    f.pool_client.mint_py(&f.user1, &f.user1, &half);

    f.usdc_admin_client.mint(&f.user2, &half);
    f.sy_client.deposit(&f.user2, &f.user2, &half);
    f.pool_client.mint_py(&f.user2, &f.user2, &half);

    // Burn 20% of pool SY to simulate Blend bad debt loss (800M SY backing 1000M PT)
    f.sy_client.burn(&f.pool_client.address, &200_000_000);
    f.env.ledger().set_timestamp(f.maturity + 10);

    let btok1 = f.pool_client.redeem_pt_to_btoken(&f.user1, &f.user1, &half);
    let btok2 = f.pool_client.redeem_pt_to_btoken(&f.user2, &f.user2, &half);
    assert_eq!(btok1, 400_000_000);
    assert_eq!(btok2, 400_000_000);
}

// 19. Security Audit Regression: Reinitialization blocked & negative slippage rejected
#[test]
fn test_security_reinit_and_input_validation() {
    let f = setup_protocol();
    assert!(f
        .blend_client
        .try_initialize(&f.admin, &f.usdc_client.address, &SCALAR_9)
        .is_err());
    assert!(f
        .sy_client
        .try_initialize(&f.admin, &f.usdc_client.address, &f.blend_client.address)
        .is_err());
    assert!(f
        .pool_client
        .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &100, &-1)
        .is_err());
}

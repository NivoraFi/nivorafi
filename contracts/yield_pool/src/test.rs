#![cfg(test)]
extern crate std;

use crate::{YieldPool, YieldPoolClient};
use common::fixed_point::{SCALAR_9, WAD};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct TestFixture<'a> {
    env: Env,
    admin: Address,
    user1: Address,
    user2: Address,
    _usdc_client: token::Client<'a>,
    usdc_admin_client: token::StellarAssetClient<'a>,
    blend_client: MockBlendClient<'a>,
    sy_client: StandardizedYieldClient<'a>,
    pt_client: PrincipalTokenClient<'a>,
    yt_client: YieldTokenClient<'a>,
    pool_client: YieldPoolClient<'a>,
    maturity: u64,
}

fn setup_test<'a>() -> TestFixture<'a> {
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

    // 2. SY Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180 days

    // 3. Pool placeholder (we register it first so we have the address for PT & YT)
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

    // 4. PT Token
    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    pt_client.initialize(
        &admin,
        &pool_id,
        &String::from_str(&env, "Pendle PT"),
        &String::from_str(&env, "PT"),
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
        &String::from_str(&env, "Pendle YT"),
        &String::from_str(&env, "YT"),
        &7u32,
        &maturity,
    );

    // 6. Initialize Pool
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
        _usdc_client: usdc_client,
        usdc_admin_client,
        blend_client,
        sy_client,
        pt_client,
        yt_client,
        pool_client,
        maturity,
    }
}

#[test]
fn test_atomic_mint_py_and_early_unwind() {
    let f = setup_test();
    let deposit = 1_000_000_000i128; // 1000 USDC / SY

    // Mint USDC and deposit into SY wrapper
    f.usdc_admin_client.mint(&f.user1, &deposit);
    f.sy_client.deposit(&f.user1, &f.user1, &deposit);
    assert_eq!(f.sy_client.balance(&f.user1), deposit);

    // Mint PY (1000 SY -> 1000 PT + 1000 YT)
    let (pt_out, yt_out) = f.pool_client.mint_py(&f.user1, &f.user1, &deposit);
    assert_eq!(pt_out, deposit);
    assert_eq!(yt_out, deposit);
    assert_eq!(f.pt_client.balance(&f.user1), deposit);
    assert_eq!(f.yt_client.balance(&f.user1), deposit);
    assert_eq!(f.sy_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), deposit);

    // Early Unwind (burn 400 PT + 400 YT -> returns 400 SY)
    let unwind_amount = 400_000_000i128;
    let sy_returned = f.pool_client.redeem_py(&f.user1, &f.user1, &unwind_amount);
    assert_eq!(sy_returned, unwind_amount);
    assert_eq!(f.pt_client.balance(&f.user1), 600_000_000);
    assert_eq!(f.yt_client.balance(&f.user1), 600_000_000);
    assert_eq!(f.sy_client.balance(&f.user1), 400_000_000);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 600_000_000);
}

#[test]
fn test_add_remove_liquidity_dead_shares() {
    let f = setup_test();

    // User1 deposits into SY
    let initial_sy = 2_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &initial_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &initial_sy);

    // Mint PT + YT from 1000 SY
    f.pool_client.mint_py(&f.user1, &f.user1, &1_000_000_000);
    assert_eq!(f.pt_client.balance(&f.user1), 1_000_000_000);
    assert_eq!(f.sy_client.balance(&f.user1), 1_000_000_000);

    // Add initial liquidity: 1000 PT + 1000 SY
    let pt_liq = 1_000_000_000i128;
    let sy_liq = 1_000_000_000i128;
    let lp_shares = f
        .pool_client
        .add_liquidity(&f.user1, &f.user1, &pt_liq, &sy_liq, &1);
    // sqrt(1000 * 1000) = 1000, minus 1000 dead shares = 1_000_000_000 - 1000
    assert_eq!(lp_shares, 1_000_000_000 - 1_000);
    assert_eq!(f.pool_client.balance(&f.user1), lp_shares);

    let (res_pt, res_sy) = f.pool_client.get_reserves();
    assert_eq!(res_pt, pt_liq);
    assert_eq!(res_sy, sy_liq);

    // Remove liquidity
    let (pt_out, sy_out) = f
        .pool_client
        .remove_liquidity(&f.user1, &f.user1, &lp_shares, &1, &1);
    assert!(pt_out > 0);
    assert!(sy_out > 0);
}

#[test]
fn test_log_normal_amm_swaps() {
    let f = setup_test();

    // Prepare liquidity: 1,200,000 PT and 1,000,000 SY
    let mint_amount = 2_500_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &mint_amount);
    f.sy_client.deposit(&f.user1, &f.user1, &mint_amount);

    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);

    // Initial LP deposit: 1,200,000 PT and 1,000,000 SY
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 swaps exact PT for SY
    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);
    f.pool_client.mint_py(&f.user2, &f.user2, &100_000_000);

    let pt_swap_in = 50_000_000i128;
    let (sy_out, fee) = f
        .pool_client
        .swap_exact_pt_for_sy(&f.user2, &f.user2, &pt_swap_in, &1);
    assert!(sy_out > 0);
    assert!(fee > 0);
    assert_eq!(
        f.sy_client.balance(&f.user2),
        (user2_sy - 100_000_000) + sy_out
    );

    // User2 swaps exact SY for PT
    let sy_swap_in = 30_000_000i128;
    let (pt_out, fee2) = f
        .pool_client
        .swap_exact_sy_for_pt(&f.user2, &f.user2, &sy_swap_in, &1);
    assert!(pt_out > 0);
    assert!(fee2 > 0);
}

#[test]
fn test_single_pool_flash_swaps_yt() {
    let f = setup_test();

    // Seed AMM pool: 1,200,000 PT and 1,000,000 SY (positive yield)
    let init_sy = 3_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);
    f.pool_client.mint_py(&f.user1, &f.user1, &1_200_000_000);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 buys YT using 500_000 SY via flash swap
    let user2_sy = 50_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);

    let sy_to_spend = 500_000i128;
    let (yt_minted, sy_paid) =
        f.pool_client
            .swap_exact_sy_for_yt(&f.user2, &f.user2, &sy_to_spend, &1);
    assert!(yt_minted > 0);
    assert_eq!(sy_paid, sy_to_spend);
    assert_eq!(f.yt_client.balance(&f.user2), yt_minted);

    // User2 sells part of YT back for SY
    let yt_to_sell = yt_minted / 2;
    let (sy_rec, fee) = f
        .pool_client
        .swap_exact_yt_for_sy(&f.user2, &f.user2, &yt_to_sell, &1);
    assert!(sy_rec > 0);
    assert!(fee > 0);
}

#[test]
fn test_post_maturity_settlement_and_pt_redemption() {
    let f = setup_test();

    // Mint PT
    let amount = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Before maturity: post-maturity redemption fails
    let early_res = f
        .pool_client
        .try_redeem_pt_post_maturity(&f.user1, &f.user1, &amount);
    assert!(early_res.is_err());

    // Advance time past maturity
    f.env.ledger().set_timestamp(f.maturity + 100);

    // Settle maturity
    let settled_rate = f.pool_client.settle_maturity();
    assert_eq!(settled_rate, SCALAR_9);

    // Redeem PT 1:1 for SY
    let payout = f
        .pool_client
        .redeem_pt_post_maturity(&f.user1, &f.user1, &amount);
    assert_eq!(payout, amount);
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.sy_client.balance(&f.user1), amount);

    // Swaps after maturity must fail
    let swap_fail = f
        .pool_client
        .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &1000, &1);
    assert!(swap_fail.is_err());
}

#[test]
fn test_yield_claim_via_pool() {
    let f = setup_test();

    let amount = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Bump Blend rate +10%
    f.blend_client.set_b_rate(&1_100_000_000);

    // User claims yield via pool router without artificial admin subsidy
    let claimed = f.pool_client.claim_yield(&f.user1, &f.user1);
    assert_eq!(claimed, 90_909_090);
    assert_eq!(f.sy_client.balance(&f.user1), 90_909_090);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 909_090_910);
}

#[test]
fn test_100_percent_blend_utilization_emergency_exit() {
    let f = setup_test();

    let amount = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount);

    // Advance time past maturity
    f.env.ledger().set_timestamp(f.maturity + 10);

    // User executes emergency raw bToken exit
    let btokens = f
        .pool_client
        .redeem_pt_to_btoken(&f.user1, &f.user1, &amount);
    assert_eq!(btokens, amount);
    assert_eq!(f.pt_client.balance(&f.user1), 0);
    assert_eq!(f.blend_client.get_collateral(&f.user1), amount);
    assert_eq!(f.sy_client.balance(&f.pool_client.address), 0);
    assert_eq!(f.blend_client.get_collateral(&f.sy_client.address), 0);
}

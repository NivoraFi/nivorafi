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
    let deadline = f.env.ledger().timestamp() + 3600;
    let (pt_out, yt_out) = f.pool_client.mint_py(&f.user1, &f.user1, &deposit, &deadline);
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
    let deadline = f.env.ledger().timestamp() + 3600;
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_000_000_000, &deadline);
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

    let deadline = f.env.ledger().timestamp() + 3600;
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_200_000_000, &deadline);

    // Initial LP deposit: 1,200,000 PT and 1,000,000 SY
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 swaps exact PT for SY
    let user2_sy = 500_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);
    f.pool_client
        .mint_py(&f.user2, &f.user2, &100_000_000, &deadline);

    let pt_swap_in = 50_000_000i128;
    let (sy_out, fee) =
        f.pool_client
            .swap_exact_pt_for_sy(&f.user2, &f.user2, &pt_swap_in, &1, &deadline);
    assert!(sy_out > 0);
    assert!(fee > 0);
    assert_eq!(
        f.sy_client.balance(&f.user2),
        (user2_sy - 100_000_000) + sy_out
    );

    // User2 swaps exact SY for PT
    let sy_swap_in = 30_000_000i128;
    let (pt_out, fee2) =
        f.pool_client
            .swap_exact_sy_for_pt(&f.user2, &f.user2, &sy_swap_in, &1, &deadline);
    assert!(pt_out > 0);
    assert!(fee2 > 0);
}

#[test]
fn test_single_pool_flash_swaps_yt() {
    let f = setup_test();

    // Seed AMM pool: 1,200,000 PT and 1,000,000 SY (positive yield)
    let init_sy = 3_000_000_000i128;
    let deadline = f.env.ledger().timestamp() + 3600;
    f.usdc_admin_client.mint(&f.user1, &init_sy);
    f.sy_client.deposit(&f.user1, &f.user1, &init_sy);
    f.pool_client
        .mint_py(&f.user1, &f.user1, &1_200_000_000, &deadline);
    f.pool_client
        .add_liquidity(&f.user1, &f.user1, &1_200_000_000, &1_000_000_000, &1);

    // User2 buys YT using 500_000 SY via flash swap
    let user2_sy = 50_000_000i128;
    f.usdc_admin_client.mint(&f.user2, &user2_sy);
    f.sy_client.deposit(&f.user2, &f.user2, &user2_sy);

    let sy_to_spend = 500_000i128;
    let (yt_minted, fee_yt) = f.pool_client.swap_exact_sy_for_yt(
        &f.user2,
        &f.user2,
        &sy_to_spend,
        &1,
        &deadline,
    );
    assert!(yt_minted > 0);
    assert!(fee_yt > 0);
    assert_eq!(f.yt_client.balance(&f.user2), yt_minted);

    // User2 sells part of YT back for SY
    let yt_to_sell = yt_minted / 2;
    let (sy_rec, fee) =
        f.pool_client
            .swap_exact_yt_for_sy(&f.user2, &f.user2, &yt_to_sell, &1, &deadline);
    assert!(sy_rec > 0);
    assert!(fee > 0);
}

#[test]
fn test_post_maturity_settlement_and_pt_redemption() {
    let f = setup_test();

    // Mint PT
    let amount = 1_000_000_000i128;
    let deadline = f.env.ledger().timestamp() + 3600;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount, &deadline);

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
        .try_swap_exact_pt_for_sy(&f.user1, &f.user1, &1000, &1, &(f.maturity + 200));
    assert!(swap_fail.is_err());
}

#[test]
fn test_yield_claim_via_pool() {
    let f = setup_test();

    let amount = 1_000_000_000i128;
    let deadline = f.env.ledger().timestamp() + 3600;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount, &deadline);

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
    let deadline = f.env.ledger().timestamp() + 3600;
    f.usdc_admin_client.mint(&f.user1, &amount);
    f.sy_client.deposit(&f.user1, &f.user1, &amount);
    f.pool_client.mint_py(&f.user1, &f.user1, &amount, &deadline);

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

mod r1_f3_f4_f5_tests {
    use crate::{YieldPool, YieldPoolClient};
    use common::errors::ContractError;
    use common::fixed_point::{SCALAR_9, WAD};
    use common::interfaces::{MockBlendClient, PrivilegedTokenClient, StandardizedYieldClient};
    use common::storage_keys::DataKey;
    use mock_blend::MockBlend;
    use pt_token::PrincipalToken;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{token, Address, Env, String};
    use sy_blend_wrapper::StandardizedYield;
    use yt_token::{YieldToken, YieldTokenClient};

    #[allow(dead_code)]
    struct R1PoolFixture<'a> {
        env: Env,
        admin: Address,
        fee_recipient: Address,
        lp_user: Address,
        py_user1: Address,
        py_user2: Address,
        trader: Address,
        usdc_admin: token::StellarAssetClient<'a>,
        blend_client: MockBlendClient<'a>,
        sy_client: StandardizedYieldClient<'a>,
        pt_client: PrivilegedTokenClient<'a>,
        yt_client: YieldTokenClient<'a>,
        pool_client: YieldPoolClient<'a>,
        maturity: u64,
    }

    fn setup_r1_pool<'a>(start_ts: u64, days: u64) -> R1PoolFixture<'a> {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(start_ts);

        let admin = Address::generate(&env);
        let fee_recipient = Address::generate(&env);
        let lp_user = Address::generate(&env);
        let py_user1 = Address::generate(&env);
        let py_user2 = Address::generate(&env);
        let trader = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let usdc = env.register_stellar_asset_contract_v2(token_admin);
        let usdc_admin = token::StellarAssetClient::new(&env, &usdc.address());

        let blend_id = env.register(MockBlend, ());
        let blend_client = MockBlendClient::new(&env, &blend_id);
        blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

        let sy_id = env.register(StandardizedYield, ());
        let sy_client = StandardizedYieldClient::new(&env, &sy_id);
        sy_client.initialize(&admin, &usdc.address(), &blend_id);

        let maturity = start_ts + days * 86400;
        let pool_id = env.register(YieldPool, ());
        let pool_client = YieldPoolClient::new(&env, &pool_id);

        let pt_id = env.register(PrincipalToken, ());
        let pt_client = PrivilegedTokenClient::new(&env, &pt_id);
        pt_client.initialize(
            &admin,
            &pool_id,
            &String::from_str(&env, "PT USDC"),
            &String::from_str(&env, "PT-USDC"),
            &7u32,
            &maturity,
        );

        let yt_id = env.register(YieldToken, ());
        let yt_client = YieldTokenClient::new(&env, &yt_id);
        yt_client.initialize(
            &admin,
            &pool_id,
            &sy_id,
            &String::from_str(&env, "YT USDC"),
            &String::from_str(&env, "YT-USDC"),
            &7u32,
            &maturity,
        );

        pool_client.initialize(
            &admin,
            &sy_id,
            &pt_id,
            &yt_id,
            &maturity,
            &(20 * WAD),
            &WAD,
        );
        pool_client.set_fee_recipient(&admin, &fee_recipient);

        R1PoolFixture {
            env,
            admin,
            fee_recipient,
            lp_user,
            py_user1,
            py_user2,
            trader,
            usdc_admin,
            blend_client,
            sy_client,
            pt_client,
            yt_client,
            pool_client,
            maturity,
        }
    }

    fn assert_reserve_conservation(f: &R1PoolFixture) {
        let state = f.pool_client.get_market_state();
        let (pt_principal_res, yt_yield_res) = f.pool_client.get_py_reserves();
        let pool_sy = f.sy_client.balance(&f.pool_client.address);
        let expected = state.total_sy_reserve + pt_principal_res + yt_yield_res;
        let diff = (pool_sy - expected).abs();
        assert!(
            diff <= 2,
            "Reserve conservation violated: pool_sy={}, total_sy={}, pt_principal={}, yt_yield={}, expected={}, diff={}",
            pool_sy,
            state.total_sy_reserve,
            pt_principal_res,
            yt_yield_res,
            expected,
            diff
        );
    }

    #[test]
    fn test_f3_consecutive_4way_swaps_reserve_conservation_and_fee_recipient() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // Seed LP and trader balances
        let lp_seed: i128 = 500_000_000_000;
        let trader_seed: i128 = 200_000_000_000;
        f.usdc_admin.mint(&f.lp_user, &(lp_seed * 2));
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &(lp_seed * 2));
        f.pool_client.mint_py(&f.lp_user, &f.lp_user, &lp_seed, &dl);
        // Add liquidity with 1.5:1 PT/SY ratio (pt_desired first, sy_desired second) so swaps keep proportions valid
        let pt_lp = 300_000_000_000i128;
        let sy_lp = 200_000_000_000i128;
        f.pool_client
            .add_liquidity(&f.lp_user, &f.lp_user, &pt_lp, &sy_lp, &1);
        assert_reserve_conservation(&f);

        f.usdc_admin.mint(&f.trader, &trader_seed);
        f.sy_client.deposit(&f.trader, &f.trader, &trader_seed);
        f.pool_client
            .mint_py(&f.trader, &f.trader, &50_000_000_000, &dl);
        assert_reserve_conservation(&f);

        // 1. PT -> SY
        let (sy_out_1, fee_1) =
            f.pool_client
                .swap_exact_pt_for_sy(&f.trader, &f.trader, &10_000_000_000, &1, &dl);
        assert!(sy_out_1 > 0 && fee_1 > 0);
        let fee_rec_sy_after_1 = f.sy_client.balance(&f.fee_recipient);
        assert!(fee_rec_sy_after_1 > 0, "Protocol fee in SY must accrue on PT->SY");
        assert_reserve_conservation(&f);

        // 2. SY -> PT (protocol fee must be paid in PT!)
        let (pt_out_2, fee_2) =
            f.pool_client
                .swap_exact_sy_for_pt(&f.trader, &f.trader, &10_000_000_000, &1, &dl);
        assert!(pt_out_2 > 0 && fee_2 > 0);
        let fee_rec_pt_after_2 = f.pt_client.balance(&f.fee_recipient);
        assert!(fee_rec_pt_after_2 > 0, "Protocol fee in PT must accrue on SY->PT");
        assert_reserve_conservation(&f);

        // 3. SY -> YT (returns (yt_out, fee) rather than (yt_out, sy_in); 90D YT has ~30-50x leverage)
        let sy_in_3 = 500_000_000i128;
        let (yt_out_3, fee_3) =
            f.pool_client
                .swap_exact_sy_for_yt(&f.trader, &f.trader, &sy_in_3, &1, &dl);
        assert!(yt_out_3 > 0 && fee_3 > 0);
        assert_ne!(fee_3, sy_in_3, "SY->YT second return must be swap fee, not sy_in");
        assert!(
            f.sy_client.balance(&f.fee_recipient) > fee_rec_sy_after_1,
            "SY->YT protocol fee must accrue to fee_recipient"
        );
        assert_reserve_conservation(&f);

        // 4. YT -> SY
        let (sy_out_4, fee_4) =
            f.pool_client
                .swap_exact_yt_for_sy(&f.trader, &f.trader, &1_000_000_000, &1, &dl);
        assert!(sy_out_4 > 0 && fee_4 > 0);
        assert_reserve_conservation(&f);

        // 5. Remove remaining LP shares and re-verify conservation
        let lp_bal = f.pool_client.balance(&f.lp_user);
        let (rem_sy, rem_pt) =
            f.pool_client
                .remove_liquidity(&f.lp_user, &f.lp_user, &lp_bal, &1, &1);
        assert!(rem_sy > 0 && rem_pt > 0);
        assert_reserve_conservation(&f);
    }

    #[test]
    fn test_f4_redeem_pt_before_claim_yield_with_lp_and_positive_yield() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // LP supplies liquidity
        f.usdc_admin.mint(&f.lp_user, &400_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &400_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &200_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &200_000_000_000,
            &200_000_000_000,
            &1,
        );

        // py_user1 & py_user2 mint PY
        let amt1 = 100_000_000_000i128;
        let amt2 = 150_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &amt1);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &amt1);
        f.pool_client.mint_py(&f.py_user1, &f.py_user1, &amt1, &dl);

        f.usdc_admin.mint(&f.py_user2, &amt2);
        f.sy_client.deposit(&f.py_user2, &f.py_user2, &amt2);
        f.pool_client.mint_py(&f.py_user2, &f.py_user2, &amt2, &dl);

        // Blend accrues 20% yield before maturity
        f.blend_client.set_b_rate(&1_200_000_000);

        // Advance past maturity
        f.env.ledger().set_timestamp(f.maturity + 100);

        // Redeem ALL PT BEFORE anyone claims YT yield!
        let pt_sy_1 = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user1, &f.py_user1, &amt1);
        let pt_sy_2 = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user2, &f.py_user2, &amt2);
        assert!(pt_sy_1 > 0 && pt_sy_2 > 0);
        // Principal in SY at 1.20 rate: pt * 1.0 / 1.2
        assert_eq!(pt_sy_1, amt1 * SCALAR_9 / 1_200_000_000);
        assert_eq!(pt_sy_2, amt2 * SCALAR_9 / 1_200_000_000);

        // Both YT holders MUST still claim their full accrued yield!
        let yt_sy_1 = f.pool_client.claim_yield(&f.py_user1, &f.py_user1);
        let yt_sy_2 = f.pool_client.claim_yield(&f.py_user2, &f.py_user2);
        assert!(yt_sy_1 > 0 && yt_sy_2 > 0);
        assert!(
            ((pt_sy_1 + yt_sy_1) - amt1).abs() <= 2,
            "py_user1 PT+YT SY should equal initial SY deposited"
        );
        assert!(
            ((pt_sy_2 + yt_sy_2) - amt2).abs() <= 2,
            "py_user2 PT+YT SY should equal initial SY deposited"
        );

        // LP removes liquidity completely untouched
        let lp_bal = f.pool_client.balance(&f.lp_user);
        let (lp_sy, lp_pt) =
            f.pool_client
                .remove_liquidity(&f.lp_user, &f.lp_user, &lp_bal, &1, &1);
        assert!(lp_sy > 0 && lp_pt > 0);
    }

    #[test]
    fn test_f4_bad_debt_burn_isolates_lp_reserve_and_redeem_py_guard() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // LP deposits 100k SY + 100k PT
        f.usdc_admin.mint(&f.lp_user, &200_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &200_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &100_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &100_000_000_000,
            &100_000_000_000,
            &1,
        );

        // py_user1 mints 50k PY
        let py_amt = 50_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &py_amt);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &py_amt);
        f.pool_client.mint_py(&f.py_user1, &f.py_user1, &py_amt, &dl);

        // Pre-maturity bad debt burning ALL PY SY + part of LP? First test small burn leaving LP intact:
        // Burn 20k SY from pool (external bad debt slashing PY backing, not LP)
        let loss = 20_000_000_000i128;
        f.sy_client.burn(&f.pool_client.address, &loss);

        // Advance past maturity and redeem py_user1's 50k PT -> must take proportional haircut, NOT touch LP reserve!
        f.env.ledger().set_timestamp(f.maturity + 100);
        let state_before = f.pool_client.get_market_state();
        let redeemed = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user1, &f.py_user1, &py_amt);
        // Total PT supply = 100k (in AMM) + 50k (user1) = 150k; available_for_pt = (150k - 20k) = 130k
        // User gets 50k/150k * 130k = 43,333,333,333
        assert!(redeemed < py_amt && redeemed > 0);
        assert!(
            f.sy_client.balance(&f.pool_client.address) >= state_before.total_sy_reserve,
            "PT redemption under bad debt must NEVER dip into LP total_sy_reserve"
        );

        // LP can still remove full liquidity
        let lp_bal = f.pool_client.balance(&f.lp_user);
        let (lp_sy, _lp_pt) =
            f.pool_client
                .remove_liquidity(&f.lp_user, &f.lp_user, &lp_bal, &1, &1);
        assert!(lp_sy > 0);

        // Pre-maturity redeem_py guard against TotalSyReserve when vault is short
        let f2 = setup_r1_pool(10_000, 90);
        f2.usdc_admin.mint(&f2.lp_user, &200_000_000_000);
        f2.sy_client
            .deposit(&f2.lp_user, &f2.lp_user, &200_000_000_000);
        f2.pool_client
            .mint_py(&f2.lp_user, &f2.lp_user, &100_000_000_000, &dl);
        f2.pool_client.add_liquidity(
            &f2.lp_user,
            &f2.lp_user,
            &100_000_000_000,
            &100_000_000_000,
            &1,
        );
        f2.usdc_admin.mint(&f2.py_user1, &50_000_000_000);
        f2.sy_client
            .deposit(&f2.py_user1, &f2.py_user1, &50_000_000_000);
        f2.pool_client
            .mint_py(&f2.py_user1, &f2.py_user1, &50_000_000_000, &dl);

        // Burn 140k SY from pool so vault_balance (110k) leaves only 10k available_for_pt across 150k PT
        f2.sy_client.burn(&f2.pool_client.address, &140_000_000_000);
        // redeem_py applies proportional haircut (50k * 10k / 150k = 3,333,333,333) and never touches LP reserve!
        let f2_state_before = f2.pool_client.get_market_state();
        let haircut_sy = f2
            .pool_client
            .redeem_py(&f2.py_user1, &f2.py_user1, &50_000_000_000);
        assert_eq!(haircut_sy, 3_333_333_333);
        assert!(
            f2.sy_client.balance(&f2.pool_client.address) >= f2_state_before.total_sy_reserve,
            "redeem_py under partial bad debt must never dip into LP total_sy_reserve"
        );

        // If ALL remaining PY backing is wiped out (available_for_pt == 0), redeem_py rejects with InsufficientBalance
        let f3 = setup_r1_pool(10_000, 90);
        f3.usdc_admin.mint(&f3.lp_user, &200_000_000_000);
        f3.sy_client
            .deposit(&f3.lp_user, &f3.lp_user, &200_000_000_000);
        f3.pool_client
            .mint_py(&f3.lp_user, &f3.lp_user, &100_000_000_000, &dl);
        f3.pool_client.add_liquidity(
            &f3.lp_user,
            &f3.lp_user,
            &100_000_000_000,
            &100_000_000_000,
            &1,
        );
        f3.usdc_admin.mint(&f3.py_user1, &50_000_000_000);
        f3.sy_client
            .deposit(&f3.py_user1, &f3.py_user1, &50_000_000_000);
        f3.pool_client
            .mint_py(&f3.py_user1, &f3.py_user1, &50_000_000_000, &dl);
        f3.sy_client.burn(&f3.pool_client.address, &150_000_000_000);
        let res = f3
            .pool_client
            .try_redeem_py(&f3.py_user1, &f3.py_user1, &50_000_000_000);
        assert_eq!(res, Err(Ok(ContractError::InsufficientBalance)));
    }

    #[test]
    fn test_f4_late_post_maturity_yt_transfer_syncs_maturity_index_with_pool() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        let amt = 100_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &amt);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &amt);
        f.pool_client.mint_py(&f.py_user1, &f.py_user1, &amt, &dl);

        // Accrue 15% before maturity
        f.blend_client.set_b_rate(&1_150_000_000);

        // Jump past maturity BEFORE pool.settle_maturity() is called; rate ticks to 1.25
        f.env.ledger().set_timestamp(f.maturity + 10);
        f.blend_client.set_b_rate(&1_250_000_000);

        // User transfers YT post-maturity -> yt_token::update_checkpoint pins MaturityIndex = 1.25
        f.yt_client.transfer(&f.py_user1, &f.py_user2, &(amt / 2));
        let yt_pinned: Option<i128> = f.env.as_contract(&f.yt_client.address, || {
            f.env.storage().instance().get(&DataKey::MaturityIndex)
        });
        assert_eq!(yt_pinned, Some(1_250_000_000));

        // Rate ticks again to 1.40 before settle_maturity is finally invoked on pool
        f.blend_client.set_b_rate(&1_400_000_000);
        f.pool_client.settle_maturity();

        // Pool MUST adopt YT's pinned 1.25 instead of overwriting with 1.40!
        let state = f.pool_client.get_market_state();
        assert_eq!(state.maturity_index, 1_250_000_000);
        let yt_pinned_after: Option<i128> = f.env.as_contract(&f.yt_client.address, || {
            f.env.storage().instance().get(&DataKey::MaturityIndex)
        });
        assert_eq!(yt_pinned_after, Some(1_250_000_000));
    }

    #[test]
    fn test_f5_yield_pool_deadlines_and_boundary() {
        let now = 10_000u64;
        let f = setup_r1_pool(now, 90);
        let ok_dl = now;
        let expired_dl = now - 1;

        f.usdc_admin.mint(&f.lp_user, &400_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &400_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &200_000_000_000, &ok_dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &200_000_000_000,
            &150_000_000_000,
            &1,
        );

        f.usdc_admin.mint(&f.trader, &100_000_000_000);
        f.sy_client.deposit(&f.trader, &f.trader, &100_000_000_000);
        f.pool_client
            .mint_py(&f.trader, &f.trader, &20_000_000_000, &ok_dl);

        // Exact boundary timestamp == deadline succeeds on all 4 swaps
        assert!(f
            .pool_client
            .try_swap_exact_pt_for_sy(&f.trader, &f.trader, &5_000_000_000, &1, &ok_dl)
            .is_ok());
        assert!(f
            .pool_client
            .try_swap_exact_sy_for_pt(&f.trader, &f.trader, &5_000_000_000, &1, &ok_dl)
            .is_ok());
        assert!(f
            .pool_client
            .try_swap_exact_sy_for_yt(&f.trader, &f.trader, &500_000_000, &1, &ok_dl)
            .is_ok());
        assert!(f
            .pool_client
            .try_swap_exact_yt_for_sy(&f.trader, &f.trader, &1_000_000_000, &1, &ok_dl)
            .is_ok());

        let state_before = f.pool_client.get_market_state();
        let sy_before = f.sy_client.balance(&f.trader);
        let pt_before = f.pt_client.balance(&f.trader);
        let yt_before = f.yt_client.balance(&f.trader);

        // Expired deadline (timestamp > deadline) rejected with DeadlineExpired and zero state mutation
        assert_eq!(
            f.pool_client
                .try_mint_py(&f.trader, &f.trader, &1_000_000_000, &expired_dl),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(
            f.pool_client.try_swap_exact_pt_for_sy(
                &f.trader,
                &f.trader,
                &1_000_000_000,
                &1,
                &expired_dl,
            ),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(
            f.pool_client.try_swap_exact_sy_for_pt(
                &f.trader,
                &f.trader,
                &1_000_000_000,
                &1,
                &expired_dl,
            ),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(
            f.pool_client.try_swap_exact_sy_for_yt(
                &f.trader,
                &f.trader,
                &1_000_000_000,
                &1,
                &expired_dl,
            ),
            Err(Ok(ContractError::DeadlineExpired))
        );
        assert_eq!(
            f.pool_client.try_swap_exact_yt_for_sy(
                &f.trader,
                &f.trader,
                &1_000_000_000,
                &1,
                &expired_dl,
            ),
            Err(Ok(ContractError::DeadlineExpired))
        );

        let state_after = f.pool_client.get_market_state();
        assert_eq!(state_after.total_sy_reserve, state_before.total_sy_reserve);
        assert_eq!(state_after.total_pt_reserve, state_before.total_pt_reserve);
        assert_eq!(f.sy_client.balance(&f.trader), sy_before);
        assert_eq!(f.pt_client.balance(&f.trader), pt_before);
        assert_eq!(f.yt_client.balance(&f.trader), yt_before);
    }

    #[test]
    fn test_f4_redeem_py_post_accrual_solvency_both_orders_and_two_users() {
        let amt = 100_000_000_000i128;

        // Order 1: redeem_py -> claim_yield (Alice & Bob both mint at 1.0, accrue to 1.2)
        let f1 = setup_r1_pool(10_000, 90);
        let dl1 = f1.maturity;
        for u in [&f1.py_user1, &f1.py_user2] {
            f1.usdc_admin.mint(u, &amt);
            f1.sy_client.deposit(u, u, &amt);
            f1.pool_client.mint_py(u, u, &amt, &dl1);
        }
        f1.blend_client.set_b_rate(&1_200_000_000);

        let a_redeem_1 = f1.pool_client.redeem_py(&f1.py_user1, &f1.py_user1, &amt);
        assert_eq!(a_redeem_1, 83_333_333_333);
        assert_reserve_conservation(&f1);

        let a_claim_1 = f1.pool_client.claim_yield(&f1.py_user1, &f1.py_user1);
        assert_eq!(a_claim_1, 16_666_666_666);
        assert!(a_redeem_1 + a_claim_1 <= amt);
        assert_reserve_conservation(&f1);

        // Bob must be able to redeem_py + claim_yield with ZERO DoS and ZERO principal loss
        let b_redeem_1 = f1.pool_client.redeem_py(&f1.py_user2, &f1.py_user2, &amt);
        assert_eq!(b_redeem_1, 83_333_333_333);
        let b_claim_1 = f1.pool_client.claim_yield(&f1.py_user2, &f1.py_user2);
        assert_eq!(b_claim_1, 16_666_666_666);
        assert!((b_redeem_1 + b_claim_1 - amt).abs() <= 1);

        // Order 2: claim_yield -> redeem_py (Alice claims first, then redeems PY)
        let f2 = setup_r1_pool(10_000, 90);
        let dl2 = f2.maturity;
        for u in [&f2.py_user1, &f2.py_user2] {
            f2.usdc_admin.mint(u, &amt);
            f2.sy_client.deposit(u, u, &amt);
            f2.pool_client.mint_py(u, u, &amt, &dl2);
        }
        f2.blend_client.set_b_rate(&1_200_000_000);

        let a_claim_2 = f2.pool_client.claim_yield(&f2.py_user1, &f2.py_user1);
        assert_eq!(a_claim_2, 16_666_666_666);
        let a_redeem_2 = f2.pool_client.redeem_py(&f2.py_user1, &f2.py_user1, &amt);
        assert_eq!(a_redeem_2, 83_333_333_333);
        assert!((a_claim_2 + a_redeem_2 - amt).abs() <= 1);
        assert_reserve_conservation(&f2);

        let b_redeem_2 = f2.pool_client.redeem_py(&f2.py_user2, &f2.py_user2, &amt);
        let b_claim_2 = f2.pool_client.claim_yield(&f2.py_user2, &f2.py_user2);
        assert!((b_redeem_2 + b_claim_2 - amt).abs() <= 2);

        // Order 3: redeem_py alone (Alice never claims before maturity; Bob holds to maturity)
        let f3 = setup_r1_pool(10_000, 90);
        let dl3 = f3.maturity;
        for u in [&f3.py_user1, &f3.py_user2] {
            f3.usdc_admin.mint(u, &amt);
            f3.sy_client.deposit(u, u, &amt);
            f3.pool_client.mint_py(u, u, &amt, &dl3);
        }
        f3.blend_client.set_b_rate(&1_200_000_000);

        let a_redeem_3 = f3.pool_client.redeem_py(&f3.py_user1, &f3.py_user1, &amt);
        assert_eq!(a_redeem_3, 83_333_333_333);
        assert_reserve_conservation(&f3);

        f3.env.ledger().set_timestamp(f3.maturity + 10);
        let b_pt_3 = f3
            .pool_client
            .redeem_pt_post_maturity(&f3.py_user2, &f3.py_user2, &amt);
        let b_yt_3 = f3.pool_client.claim_yield(&f3.py_user2, &f3.py_user2);
        let a_yt_3 = f3.pool_client.claim_yield(&f3.py_user1, &f3.py_user1);
        assert_eq!(b_pt_3, 83_333_333_333);
        assert_eq!(b_yt_3, 16_666_666_666);
        assert_eq!(a_yt_3, 16_666_666_666);

        // Case B: Alice enters at 1.0, b_rate -> 1.2, Bob deposits 120B USDC (100B SY) at 1.2
        // Under Design A, Bob receives 120B PT+YT (zero dilution!) and Alice keeps 100% of her backing.
        let f4 = setup_r1_pool(10_000, 90);
        let dl4 = f4.maturity;
        f4.usdc_admin.mint(&f4.py_user1, &amt);
        f4.sy_client.deposit(&f4.py_user1, &f4.py_user1, &amt);
        f4.pool_client.mint_py(&f4.py_user1, &f4.py_user1, &amt, &dl4);

        f4.blend_client.set_b_rate(&1_200_000_000);
        let bob_usdc = 120_000_000_000i128;
        f4.usdc_admin.mint(&f4.py_user2, &bob_usdc);
        let bob_sy = f4.sy_client.deposit(&f4.py_user2, &f4.py_user2, &bob_usdc);
        assert_eq!(bob_sy, amt);
        let (bob_pt, bob_yt) = f4.pool_client.mint_py(&f4.py_user2, &f4.py_user2, &bob_sy, &dl4);
        assert_eq!(bob_pt, 120_000_000_000);
        assert_eq!(bob_yt, 120_000_000_000);

        let a_redeem_4 = f4.pool_client.redeem_py(&f4.py_user1, &f4.py_user1, &amt);
        let a_claim_4 = f4.pool_client.claim_yield(&f4.py_user1, &f4.py_user1);
        assert_eq!(a_redeem_4, 83_333_333_333);
        assert_eq!(a_claim_4, 16_666_666_666);
        assert_reserve_conservation(&f4);

        // Bob redeems all 120B PT+YT with zero dilution (~100B SY = 120B USDC) and zero DoS
        let b_redeem_4 = f4.pool_client.redeem_py(&f4.py_user2, &f4.py_user2, &bob_pt);
        assert!((b_redeem_4 - 100_000_000_000).abs() <= 2);
        assert_eq!(f4.pool_client.claim_yield(&f4.py_user2, &f4.py_user2), 0);
        assert_reserve_conservation(&f4);
    }

    #[test]
    fn test_f3_f4_swap_exact_yt_for_sy_post_accrual_preserves_pt_principal() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // LP mints 500B PY and seeds 450B PT + 300B SY at b_rate = 1.0
        f.usdc_admin.mint(&f.lp_user, &800_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &800_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &500_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &450_000_000_000,
            &300_000_000_000,
            &1,
        );

        // Bob mints 100B PY at b_rate = 1.0
        let bob_amt = 100_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &bob_amt);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &bob_amt);
        f.pool_client
            .mint_py(&f.py_user1, &f.py_user1, &bob_amt, &dl);

        // Alice swaps 1B SY -> YT at b_rate = 1.0
        f.usdc_admin.mint(&f.trader, &1_000_000_000);
        f.sy_client.deposit(&f.trader, &f.trader, &1_000_000_000);
        let (yt_bought, _) = f.pool_client.swap_exact_sy_for_yt(
            &f.trader,
            &f.trader,
            &1_000_000_000,
            &1,
            &dl,
        );
        assert!(yt_bought > 0);
        assert_reserve_conservation(&f);

        // Accrue b_rate to 1.2
        f.blend_client.set_b_rate(&1_200_000_000);

        // Alice sells ALL YT back for SY, then claims accrued yield
        let (sy_from_swap, _) = f.pool_client.swap_exact_yt_for_sy(
            &f.trader,
            &f.trader,
            &yt_bought,
            &1,
            &dl,
        );
        assert!(sy_from_swap > 0);
        assert_reserve_conservation(&f);

        let alice_claimed = f.pool_client.claim_yield(&f.trader, &f.trader);
        let expected_alice_yield = (yt_bought * 200_000_000) / 1_200_000_000;
        assert!((alice_claimed - expected_alice_yield).abs() <= 2);
        assert_reserve_conservation(&f);

        // Post-maturity: Bob must suffer ZERO artificial haircut on PT principal!
        f.env.ledger().set_timestamp(f.maturity + 10);
        let bob_pt_sy = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user1, &f.py_user1, &bob_amt);
        let expected_bob_pt = (bob_amt * SCALAR_9) / 1_200_000_000;
        assert_eq!(bob_pt_sy, expected_bob_pt);

        let bob_claimed = f.pool_client.claim_yield(&f.py_user1, &f.py_user1);
        assert!((bob_pt_sy + bob_claimed - bob_amt).abs() <= 2);
        assert_reserve_conservation(&f);

        // LP removes liquidity cleanly
        let lp_bal = f.pool_client.balance(&f.lp_user);
        let (lp_pt, lp_sy) = f
            .pool_client
            .remove_liquidity(&f.lp_user, &f.lp_user, &lp_bal, &1, &1);
        assert!(lp_pt > 0 && lp_sy > 0);
        assert_reserve_conservation(&f);
    }

    #[test]
    fn test_design_a_sy_yt_sy_roundtrip_conservation_at_high_accrual() {
        for rate in [1_050_000_000i128, 1_200_000_000i128, 1_800_000_000i128] {
            let f = setup_r1_pool(10_000, 90);
            let dl = f.maturity;

            // Seed 600B PT : 300B SY at b_rate = 1.0 (stays positive yield even at b_rate = 1.80 -> 540B asset < 600B PT)
            f.usdc_admin.mint(&f.lp_user, &900_000_000_000);
            f.sy_client
                .deposit(&f.lp_user, &f.lp_user, &900_000_000_000);
            f.pool_client
                .mint_py(&f.lp_user, &f.lp_user, &600_000_000_000, &dl);
            f.pool_client.add_liquidity(
                &f.lp_user,
                &f.lp_user,
                &600_000_000_000,
                &300_000_000_000,
                &1,
            );

            // Trader has 500B PY minted at 1.0 + 5B SY working capital
            let eve_total_sy = 505_000_000_000i128;
            f.usdc_admin.mint(&f.trader, &eve_total_sy);
            f.sy_client.deposit(&f.trader, &f.trader, &eve_total_sy);
            f.pool_client
                .mint_py(&f.trader, &f.trader, &500_000_000_000, &dl);

            f.blend_client.set_b_rate(&rate);
            let lp_sy_before = f.pool_client.get_market_state().total_sy_reserve;

            for _ in 0..3 {
                let (yt_got, fee_in) = f.pool_client.swap_exact_sy_for_yt(
                    &f.trader,
                    &f.trader,
                    &1_000_000_000,
                    &1,
                    &dl,
                );
                assert!(yt_got > 0 && fee_in > 0);
                let (sy_back, fee_out) =
                    f.pool_client
                        .swap_exact_yt_for_sy(&f.trader, &f.trader, &yt_got, &1, &dl);
                assert!(sy_back > 0 && fee_out > 0);

                // Exact SY & PT conservation after every round-trip
                let state = f.pool_client.get_market_state();
                let (pt_prin, yt_yld) = f.pool_client.get_py_reserves();
                let pool_sy = f.sy_client.balance(&f.pool_client.address);
                assert_eq!(pool_sy, state.total_sy_reserve + pt_prin + yt_yld);
                assert_eq!(f.pt_client.balance(&f.pool_client.address), state.total_pt_reserve);
            }

            let lp_sy_after = f.pool_client.get_market_state().total_sy_reserve;
            assert!(
                lp_sy_after > lp_sy_before,
                "LP TotalSyReserve must strictly increase by LP fees at rate={}: before={} after={}",
                rate,
                lp_sy_before,
                lp_sy_after
            );

            let eve_redeem = f
                .pool_client
                .redeem_py(&f.trader, &f.trader, &500_000_000_000);
            let eve_claim = f.pool_client.claim_yield(&f.trader, &f.trader);
            let eve_end_sy = f.sy_client.balance(&f.trader);
            let eve_profit = eve_end_sy - eve_total_sy;
            assert!(
                eve_profit < 0,
                "Trader must lose fees/slippage on SY->YT->SY round-trips at rate={}: profit={} (redeem={} claim={})",
                rate,
                eve_profit,
                eve_redeem,
                eve_claim
            );
        }
    }

    #[test]
    fn test_design_a_dip_recovery_zero_phantom_yield_and_pt_preserved() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // Alice enters with 120B USDC (100B SY) at b_rate = 1.20
        f.blend_client.set_b_rate(&1_200_000_000);
        let alice_usdc = 120_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &alice_usdc);
        let alice_sy = f
            .sy_client
            .deposit(&f.py_user1, &f.py_user1, &alice_usdc);
        assert_eq!(alice_sy, 100_000_000_000);
        let (pt_minted, yt_minted) =
            f.pool_client
                .mint_py(&f.py_user1, &f.py_user1, &alice_sy, &dl);
        assert_eq!(pt_minted, 120_000_000_000);
        assert_eq!(yt_minted, 120_000_000_000);

        // b_rate dips to 1.00; Alice transfers 60B YT to Bob
        f.blend_client.set_b_rate(&1_000_000_000);
        f.yt_client
            .transfer(&f.py_user1, &f.py_user2, &(yt_minted / 2));

        // b_rate recovers to 1.20 -> zero phantom yield, full PT principal preserved
        f.blend_client.set_b_rate(&1_200_000_000);
        assert_eq!(f.pool_client.claim_yield(&f.py_user1, &f.py_user1), 0);
        assert_eq!(f.pool_client.claim_yield(&f.py_user2, &f.py_user2), 0);

        f.env.ledger().set_timestamp(f.maturity + 10);
        let pt_sy = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user1, &f.py_user1, &pt_minted);
        assert!((pt_sy - alice_sy).abs() <= 2);
    }

    #[test]
    fn test_design_a_post_checkpoint_crash_proportional_claim_no_lockup() {
        // 1. Single user: 1.0 -> 1.5 -> checkpoint -> 0.4
        let f1 = setup_r1_pool(10_000, 90);
        let amt = 100_000_000_000i128;
        f1.usdc_admin.mint(&f1.py_user1, &amt);
        f1.sy_client.deposit(&f1.py_user1, &f1.py_user1, &amt);
        f1.pool_client
            .mint_py(&f1.py_user1, &f1.py_user1, &amt, &f1.maturity);

        f1.blend_client.set_b_rate(&1_500_000_000);
        f1.yt_client.transfer(&f1.py_user1, &f1.py_user1, &1); // materialize 50B underlying
        f1.blend_client.set_b_rate(&400_000_000);

        let claimed1 = f1.pool_client.claim_yield(&f1.py_user1, &f1.py_user1);
        assert_eq!(claimed1, amt); // 100% of available SY recovered cleanly, zero InsufficientBalance
        assert_eq!(f1.pool_client.claim_yield(&f1.py_user1, &f1.py_user1), 0);

        // 2. Two equal users: 1.0 -> 1.5 -> Alice checkpoints -> 0.4 -> both get 50% (100B SY each)
        let f2 = setup_r1_pool(10_000, 90);
        for u in [&f2.py_user1, &f2.py_user2] {
            f2.usdc_admin.mint(u, &amt);
            f2.sy_client.deposit(u, u, &amt);
            f2.pool_client.mint_py(u, u, &amt, &f2.maturity);
        }
        f2.blend_client.set_b_rate(&1_500_000_000);
        f2.yt_client.transfer(&f2.py_user1, &f2.py_user1, &1);
        f2.blend_client.set_b_rate(&400_000_000);

        let c_a = f2.pool_client.claim_yield(&f2.py_user1, &f2.py_user1);
        let c_b = f2.pool_client.claim_yield(&f2.py_user2, &f2.py_user2);
        assert!((c_a - amt).abs() <= 2);
        assert!((c_b - amt).abs() <= 2);
        assert_eq!(c_a + c_b, amt * 2);

        // 3. Parity check: 1.0 -> 1.2 -> Alice checkpoints -> 0.8 (no first-mover advantage)
        let f3 = setup_r1_pool(10_000, 90);
        for u in [&f3.py_user1, &f3.py_user2] {
            f3.usdc_admin.mint(u, &amt);
            f3.sy_client.deposit(u, u, &amt);
            f3.pool_client.mint_py(u, u, &amt, &f3.maturity);
        }
        f3.blend_client.set_b_rate(&1_200_000_000);
        f3.yt_client.transfer(&f3.py_user1, &f3.py_user1, &1);
        f3.blend_client.set_b_rate(&800_000_000);

        let c3_a = f3.pool_client.claim_yield(&f3.py_user1, &f3.py_user1);
        let c3_b = f3.pool_client.claim_yield(&f3.py_user2, &f3.py_user2);
        let r3_a = f3.pool_client.redeem_py(&f3.py_user1, &f3.py_user1, &amt);
        let r3_b = f3.pool_client.redeem_py(&f3.py_user2, &f3.py_user2, &amt);
        assert_eq!(c3_a, 25_000_000_000);
        assert_eq!(c3_b, 25_000_000_000);
        assert_eq!(r3_a, 75_000_000_000);
        assert_eq!(r3_b, 75_000_000_000);
        assert_eq!(c3_a + r3_a, amt);
        assert_eq!(c3_b + r3_b, amt);
    }

    #[test]
    fn test_design_a_remove_liquidity_unblocked_when_asset_res_exceeds_pt_res() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        f.usdc_admin.mint(&f.lp_user, &250_000_000_000);
        f.sy_client
            .deposit(&f.lp_user, &f.lp_user, &250_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &120_000_000_000, &dl);
        let lp = f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &120_000_000_000,
            &100_000_000_000,
            &1,
        );

        // b_rate jumps to 1.50 -> asset_res = 150B > pt_res = 120B (negative implied yield)
        f.blend_client.set_b_rate(&1_500_000_000);
        assert_eq!(
            f.pool_client.try_get_exchange_rate(),
            Err(Ok(ContractError::NegativeYieldNotSupported))
        );

        // LP can STILL withdraw liquidity unconditionally!
        let (pt_out, sy_out) =
            f.pool_client
                .remove_liquidity(&f.lp_user, &f.lp_user, &lp, &1, &1);
        assert!(pt_out > 0 && sy_out > 0);
    }

    #[test]
    fn test_bug1_post_checkpoint_crash_clamps_available_for_pt_no_lp_drain_or_negative_payout() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        // Seed 600B PT + 300B SY LP + 100B PY Alice at b_rate = 1.0
        f.usdc_admin.mint(&f.lp_user, &900_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &900_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &600_000_000_000, &dl);
        let lp = f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &600_000_000_000,
            &300_000_000_000,
            &1,
        );

        let alice_amt = 100_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &alice_amt);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &alice_amt);
        f.pool_client
            .mint_py(&f.py_user1, &f.py_user1, &alice_amt, &dl);

        // b_rate = 1.50 -> checkpoint -> crash to 0.40
        f.blend_client.set_b_rate(&1_500_000_000);
        f.yt_client.transfer(&f.py_user1, &f.py_user1, &1);
        f.blend_client.set_b_rate(&400_000_000);

        // swap_exact_yt_for_sy must NEVER produce negative freed_pt_sy or drain LP TotalSyReserve
        let sy_res_before = f.pool_client.get_market_state().total_sy_reserve;
        let _ = f
            .pool_client
            .try_swap_exact_yt_for_sy(&f.py_user1, &f.py_user1, &10_000_000_000, &0, &dl);
        let state_mid = f.pool_client.get_market_state();
        let (pt_prin_mid, _) = f.pool_client.get_py_reserves();
        assert!(
            pt_prin_mid >= 0,
            "PtPrincipalReserve must never be negative: {}",
            pt_prin_mid
        );
        assert!(
            state_mid.total_sy_reserve >= sy_res_before,
            "LP TotalSyReserve must never be drained by negative available_for_pt: before={} after={}",
            sy_res_before,
            state_mid.total_sy_reserve
        );

        // Advance past maturity: redeem_pt_post_maturity returns >= 0 (0, never -2)
        f.env.ledger().set_timestamp(f.maturity + 10);
        let alice_pt = f.pt_client.balance(&f.py_user1);
        let payout = f
            .pool_client
            .redeem_pt_post_maturity(&f.py_user1, &f.py_user1, &alice_pt);
        assert_eq!(payout, 0);
        assert_eq!(f.pool_client.get_py_reserves().0, 0);

        // LP removes full 300B SY untouched
        let (_lp_pt, lp_sy) = f
            .pool_client
            .remove_liquidity(&f.lp_user, &f.lp_user, &lp, &1, &1);
        assert!(lp_sy >= 299_999_999_000);

        // Verify redeem_pt_to_btoken also returns 0 (never < 0) under same crash
        let f2 = setup_r1_pool(10_000, 90);
        let dl2 = f2.maturity;
        f2.usdc_admin.mint(&f2.py_user1, &alice_amt);
        f2.sy_client.deposit(&f2.py_user1, &f2.py_user1, &alice_amt);
        f2.pool_client
            .mint_py(&f2.py_user1, &f2.py_user1, &alice_amt, &dl2);
        f2.blend_client.set_b_rate(&1_500_000_000);
        f2.yt_client.transfer(&f2.py_user1, &f2.py_user1, &1);
        f2.blend_client.set_b_rate(&400_000_000);
        f2.env.ledger().set_timestamp(f2.maturity + 10);
        let btokens = f2
            .pool_client
            .redeem_pt_to_btoken(&f2.py_user1, &f2.py_user1, &alice_amt);
        assert_eq!(btokens, 0);
        assert_eq!(f2.pool_client.get_py_reserves().0, 0);
    }

    #[test]
    fn test_bug2_underwater_rejects_sy_for_yt_and_mint_py_with_zero_lp_drain() {
        // Sub-case A: sy.burn bad debt blocks BOTH swap_exact_sy_for_yt and mint_py
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;

        f.usdc_admin.mint(&f.lp_user, &7_500_000_000_000);
        f.sy_client
            .deposit(&f.lp_user, &f.lp_user, &7_500_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &4_500_000_000_000, &dl);
        let lp = f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &4_500_000_000_000,
            &3_000_000_000_000,
            &1,
        );

        f.usdc_admin.mint(&f.trader, &1_010_000_000_000);
        f.sy_client
            .deposit(&f.trader, &f.trader, &1_010_000_000_000);
        f.pool_client
            .mint_py(&f.trader, &f.trader, &1_000_000_000_000, &dl);

        // Burn 600B SY -> PT backing is underwater
        f.sy_client.burn(&f.pool_client.address, &600_000_000_000);
        let lp_sy_before = f.pool_client.get_market_state().total_sy_reserve;

        // Both swap_exact_sy_for_yt and mint_py MUST reject with InsufficientBalance
        assert_eq!(
            f.pool_client.try_swap_exact_sy_for_yt(
                &f.trader,
                &f.trader,
                &1_000_000_000,
                &1,
                &dl,
            ),
            Err(Ok(ContractError::InsufficientBalance))
        );
        assert_eq!(
            f.pool_client
                .try_mint_py(&f.trader, &f.trader, &1_000_000_000, &dl),
            Err(Ok(ContractError::InsufficientBalance))
        );
        assert_eq!(
            f.pool_client.get_market_state().total_sy_reserve,
            lp_sy_before
        );

        // Recovery/unwind functions remain unblocked
        assert!(f
            .pool_client
            .try_swap_exact_yt_for_sy(&f.trader, &f.trader, &10_000_000_000, &0, &dl)
            .is_ok());
        assert!(
            f.pool_client.get_market_state().total_sy_reserve >= lp_sy_before,
            "Selling existing YT back while underwater must not drain LP reserve"
        );
        let redeemed = f
            .pool_client
            .redeem_py(&f.trader, &f.trader, &100_000_000_000);
        assert!(redeemed > 0 && redeemed < 100_000_000_000);
        let (_lp_pt, lp_sy_out) =
            f.pool_client
                .remove_liquidity(&f.lp_user, &f.lp_user, &lp, &1, &1);
        assert!(lp_sy_out >= 2_999_999_000_000);

        // Sub-case B: b_rate dip (1.20 -> 1.32 -> checkpoint -> 1.15) blocks BOTH, then 1.32 recovery resumes cleanly
        let f2 = setup_r1_pool(10_000, 90);
        let dl2 = f2.maturity;
        f2.blend_client.set_b_rate(&1_200_000_000);
        f2.usdc_admin.mint(&f2.lp_user, &1_500_000_000_000);
        f2.sy_client
            .deposit(&f2.lp_user, &f2.lp_user, &1_500_000_000_000);
        f2.pool_client
            .mint_py(&f2.lp_user, &f2.lp_user, &750_000_000_000, &dl2); // 900B PY
        f2.pool_client.add_liquidity(
            &f2.lp_user,
            &f2.lp_user,
            &900_000_000_000,
            &300_000_000_000,
            &1,
        );
        f2.usdc_admin.mint(&f2.trader, &200_000_000_000);
        f2.sy_client
            .deposit(&f2.trader, &f2.trader, &200_000_000_000);
        f2.pool_client
            .mint_py(&f2.trader, &f2.trader, &125_000_000_000, &dl2); // 150B PY

        f2.blend_client.set_b_rate(&1_320_000_000);
        f2.yt_client.transfer(&f2.trader, &f2.trader, &1);
        f2.blend_client.set_b_rate(&1_150_000_000);

        let lp_sy_dip_before = f2.pool_client.get_market_state().total_sy_reserve;
        assert_eq!(
            f2.pool_client.try_swap_exact_sy_for_yt(
                &f2.trader,
                &f2.trader,
                &2_000_000_000,
                &1,
                &dl2,
            ),
            Err(Ok(ContractError::InsufficientBalance))
        );
        assert_eq!(
            f2.pool_client
                .try_mint_py(&f2.trader, &f2.trader, &2_000_000_000, &dl2),
            Err(Ok(ContractError::InsufficientBalance))
        );
        assert_eq!(
            f2.pool_client.get_market_state().total_sy_reserve,
            lp_sy_dip_before
        );

        // Recover b_rate to 1.32 -> both mint_py and swap_exact_sy_for_yt succeed with 0 permanent debt
        f2.blend_client.set_b_rate(&1_320_000_000);
        let (pt_rec, _) = f2
            .pool_client
            .mint_py(&f2.trader, &f2.trader, &2_000_000_000, &dl2);
        assert!(pt_rec > 0);
        let (yt_rec, _) = f2.pool_client.swap_exact_sy_for_yt(
            &f2.trader,
            &f2.trader,
            &2_000_000_000,
            &1,
            &dl2,
        );
        assert!(yt_rec > 0);
        assert_reserve_conservation(&f2);
    }

    #[test]
    fn test_bug3_sub_one_brate_0_80_redemptions_and_yt_swaps_zero_stranded_sy() {
        let usdc_in = 80_000_000_000i128; // 80B USDC at b_rate 0.80 = 100B SY -> 80B PT + 80B YT

        // A. redeem_pt_post_maturity returns full 100B SY
        let fa = setup_r1_pool(10_000, 90);
        fa.blend_client.set_b_rate(&800_000_000);
        fa.usdc_admin.mint(&fa.py_user1, &usdc_in);
        let sy_a = fa.sy_client.deposit(&fa.py_user1, &fa.py_user1, &usdc_in);
        assert_eq!(sy_a, 100_000_000_000);
        let (pt_a, _) = fa
            .pool_client
            .mint_py(&fa.py_user1, &fa.py_user1, &sy_a, &fa.maturity);
        assert_eq!(pt_a, 80_000_000_000);
        fa.env.ledger().set_timestamp(fa.maturity + 10);
        let out_a = fa
            .pool_client
            .redeem_pt_post_maturity(&fa.py_user1, &fa.py_user1, &pt_a);
        assert_eq!(out_a, 100_000_000_000);
        assert_eq!(fa.sy_client.balance(&fa.pool_client.address), 0);

        // B. redeem_pt_to_btoken returns full 100B bTokens
        let fb = setup_r1_pool(10_000, 90);
        fb.blend_client.set_b_rate(&800_000_000);
        fb.usdc_admin.mint(&fb.py_user1, &usdc_in);
        let sy_b = fb.sy_client.deposit(&fb.py_user1, &fb.py_user1, &usdc_in);
        let (pt_b, _) = fb
            .pool_client
            .mint_py(&fb.py_user1, &fb.py_user1, &sy_b, &fb.maturity);
        fb.env.ledger().set_timestamp(fb.maturity + 10);
        let out_b = fb
            .pool_client
            .redeem_pt_to_btoken(&fb.py_user1, &fb.py_user1, &pt_b);
        assert_eq!(out_b, 100_000_000_000);
        assert_eq!(fb.sy_client.balance(&fb.pool_client.address), 0);

        // C. partial & full pre-maturity redeem_py returns full 100B SY (50B + 50B)
        let fc = setup_r1_pool(10_000, 90);
        fc.blend_client.set_b_rate(&800_000_000);
        fc.usdc_admin.mint(&fc.py_user1, &usdc_in);
        let sy_c = fc.sy_client.deposit(&fc.py_user1, &fc.py_user1, &usdc_in);
        let (pt_c, _) = fc
            .pool_client
            .mint_py(&fc.py_user1, &fc.py_user1, &sy_c, &fc.maturity);
        let half1 = fc
            .pool_client
            .redeem_py(&fc.py_user1, &fc.py_user1, &(pt_c / 2));
        let half2 = fc
            .pool_client
            .redeem_py(&fc.py_user1, &fc.py_user1, &(pt_c / 2));
        assert_eq!(half1, 50_000_000_000);
        assert_eq!(half2, 50_000_000_000);
        assert_eq!(fc.sy_client.balance(&fc.pool_client.address), 0);

        // D. SY->YT->SY round-trip at b_rate = 0.80 leaves 0 stranded SY
        let fd = setup_r1_pool(10_000, 90);
        fd.blend_client.set_b_rate(&800_000_000);
        fd.usdc_admin.mint(&fd.lp_user, &840_000_000_000); // 1050B SY
        let lp_sy_dep = fd
            .sy_client
            .deposit(&fd.lp_user, &fd.lp_user, &840_000_000_000);
        assert_eq!(lp_sy_dep, 1_050_000_000_000);
        fd.pool_client
            .mint_py(&fd.lp_user, &fd.lp_user, &750_000_000_000, &fd.maturity); // 600B PT
        fd.pool_client.add_liquidity(
            &fd.lp_user,
            &fd.lp_user,
            &600_000_000_000,
            &300_000_000_000,
            &1,
        );
        fd.usdc_admin.mint(&fd.trader, &8_000_000_000); // 10B SY
        fd.sy_client
            .deposit(&fd.trader, &fd.trader, &8_000_000_000);
        let lp_sy_before = fd.pool_client.get_market_state().total_sy_reserve;
        let (yt_out, _) = fd.pool_client.swap_exact_sy_for_yt(
            &fd.trader,
            &fd.trader,
            &1_000_000_000,
            &1,
            &fd.maturity,
        );
        assert!(yt_out > 0);
        let (sy_back, _) = fd.pool_client.swap_exact_yt_for_sy(
            &fd.trader,
            &fd.trader,
            &yt_out,
            &1,
            &fd.maturity,
        );
        assert!(sy_back > 0);
        assert_reserve_conservation(&fd);
        let lp_sy_after = fd.pool_client.get_market_state().total_sy_reserve;
        assert!(lp_sy_after > lp_sy_before);
        let (pt_prin_d, _) = fd.pool_client.get_py_reserves();
        assert!(
            (pt_prin_d - 750_000_000_000).abs() <= 1,
            "pt_principal_reserve must match 750B within 1 stroop: {}",
            pt_prin_d
        );

        // E. 0.80 -> 1.00 recovery: 80B PT + 20B yield = 100B SY, 0 stranded
        let fe = setup_r1_pool(10_000, 90);
        fe.blend_client.set_b_rate(&800_000_000);
        fe.usdc_admin.mint(&fe.py_user1, &usdc_in);
        let sy_e = fe.sy_client.deposit(&fe.py_user1, &fe.py_user1, &usdc_in);
        let (pt_e, _) = fe
            .pool_client
            .mint_py(&fe.py_user1, &fe.py_user1, &sy_e, &fe.maturity);
        fe.blend_client.set_b_rate(&1_000_000_000);
        fe.env.ledger().set_timestamp(fe.maturity + 10);
        let pt_sy_e = fe
            .pool_client
            .redeem_pt_post_maturity(&fe.py_user1, &fe.py_user1, &pt_e);
        let yt_sy_e = fe.pool_client.claim_yield(&fe.py_user1, &fe.py_user1);
        assert_eq!(pt_sy_e, 80_000_000_000);
        assert_eq!(yt_sy_e, 20_000_000_000);
        assert_eq!(fe.sy_client.balance(&fe.pool_client.address), 0);
    }

    #[test]
    fn test_finding4_sy_for_yt_monotonic_sweep_and_no_zero_amount_near_capacity_or_maturity() {
        // Executable sweep up to MAX_MARKET_PROPORTION (0.96): yt_out must be strictly increasing
        let sizes = [
            1_000_000_000i128,
            5_000_000_000i128,
            8_000_000_000i128,
            10_000_000_000i128,
            10_500_000_000i128,
        ];
        let mut prev_yt_out = 0i128;
        for sy_in in sizes {
            let f = setup_r1_pool(10_000, 90);
            let dl = f.maturity;
            f.usdc_admin.mint(&f.lp_user, &900_000_000_000);
            f.sy_client
                .deposit(&f.lp_user, &f.lp_user, &900_000_000_000);
            f.pool_client
                .mint_py(&f.lp_user, &f.lp_user, &600_000_000_000, &dl);
            f.pool_client.add_liquidity(
                &f.lp_user,
                &f.lp_user,
                &600_000_000_000,
                &300_000_000_000,
                &1,
            );
            f.blend_client.set_b_rate(&1_050_000_000);

            f.usdc_admin.mint(&f.trader, &(sy_in * 2));
            f.sy_client.deposit(&f.trader, &f.trader, &(sy_in * 2));
            let (yt_out, fee) =
                f.pool_client
                    .swap_exact_sy_for_yt(&f.trader, &f.trader, &sy_in, &1, &dl);
            assert!(
                yt_out > prev_yt_out,
                "yt_out must strictly increase with sy_in={}: {} <= {}",
                sy_in,
                yt_out,
                prev_yt_out
            );
            assert!(fee > 0);
            assert_reserve_conservation(&f);
            prev_yt_out = yt_out;
        }

        // Over-capacity trades (12B..25B) at 90d must reject cleanly (ProportionOutOfBounds/InsufficientBalance), never ZeroAmount or non-monotonic shrinkage
        let f_big = setup_r1_pool(10_000, 90);
        f_big.usdc_admin.mint(&f_big.lp_user, &900_000_000_000);
        f_big
            .sy_client
            .deposit(&f_big.lp_user, &f_big.lp_user, &900_000_000_000);
        f_big
            .pool_client
            .mint_py(&f_big.lp_user, &f_big.lp_user, &600_000_000_000, &f_big.maturity);
        f_big.pool_client.add_liquidity(
            &f_big.lp_user,
            &f_big.lp_user,
            &600_000_000_000,
            &300_000_000_000,
            &1,
        );
        f_big.blend_client.set_b_rate(&1_050_000_000);
        f_big.usdc_admin.mint(&f_big.trader, &100_000_000_000);
        f_big
            .sy_client
            .deposit(&f_big.trader, &f_big.trader, &100_000_000_000);
        for oversized in [
            12_000_000_000i128,
            12_500_000_000i128,
            13_000_000_000i128,
            13_500_000_000i128,
            14_000_000_000i128,
            25_000_000_000i128,
        ] {
            let res = f_big.pool_client.try_swap_exact_sy_for_yt(
                &f_big.trader,
                &f_big.trader,
                &oversized,
                &1,
                &f_big.maturity,
            );
            assert_ne!(res, Err(Ok(ContractError::ZeroAmount)));
            assert!(matches!(
                res,
                Err(Ok(ContractError::ProportionOutOfBounds))
                    | Err(Ok(ContractError::InsufficientBalance))
            ));
        }

        // Near maturity (tau = 3600s and tau = 60s): 1B sy_in never fails with ZeroAmount
        for rem_s in [3600u64, 60u64] {
            let f_near = setup_r1_pool(10_000, 90);
            f_near.usdc_admin.mint(&f_near.lp_user, &900_000_000_000);
            f_near
                .sy_client
                .deposit(&f_near.lp_user, &f_near.lp_user, &900_000_000_000);
            f_near.pool_client.mint_py(
                &f_near.lp_user,
                &f_near.lp_user,
                &600_000_000_000,
                &f_near.maturity,
            );
            f_near.pool_client.add_liquidity(
                &f_near.lp_user,
                &f_near.lp_user,
                &600_000_000_000,
                &300_000_000_000,
                &1,
            );
            f_near.blend_client.set_b_rate(&1_050_000_000);
            f_near.usdc_admin.mint(&f_near.trader, &10_000_000_000);
            f_near
                .sy_client
                .deposit(&f_near.trader, &f_near.trader, &10_000_000_000);
            f_near.env.ledger().set_timestamp(f_near.maturity - rem_s);
            let res = f_near.pool_client.try_swap_exact_sy_for_yt(
                &f_near.trader,
                &f_near.trader,
                &1_000_000_000,
                &1,
                &f_near.maturity,
            );
            assert_ne!(res, Err(Ok(ContractError::ZeroAmount)));
            assert!(matches!(
                res,
                Ok(Ok(_))
                    | Err(Ok(ContractError::ProportionOutOfBounds))
                    | Err(Ok(ContractError::InsufficientBalance))
            ));
        }
    }

    #[test]
    fn test_defect_a_large_pool_600t_and_2e16_sy_for_yt_monotonic_conservation_and_budget() {
        // 1. 600T PT : 300T SY (48 binary-search iterations), b_rate = 1.05, 90d
        let mut prev_yt_600t = 0i128;
        for sy_in in [
            1_000_000_000i128,
            100_000_000_000i128,
            1_000_000_000_000i128,
            10_500_000_000_000i128,
        ] {
            let f = setup_r1_pool(10_000, 90);
            let dl = f.maturity;
            let pt_liq = 600_000_000_000_000i128;
            let sy_liq = 300_000_000_000_000i128;
            f.usdc_admin.mint(&f.lp_user, &(pt_liq + sy_liq));
            f.sy_client
                .deposit(&f.lp_user, &f.lp_user, &(pt_liq + sy_liq));
            f.pool_client
                .mint_py(&f.lp_user, &f.lp_user, &pt_liq, &dl);
            f.pool_client
                .add_liquidity(&f.lp_user, &f.lp_user, &pt_liq, &sy_liq, &1);
            f.blend_client.set_b_rate(&1_050_000_000);

            f.usdc_admin.mint(&f.trader, &(sy_in * 2));
            f.sy_client.deposit(&f.trader, &f.trader, &(sy_in * 2));

            f.env
                .cost_estimate()
                .budget()
                .reset_limits(100_000_000, 41_943_040);
            let (yt_out, fee) =
                f.pool_client
                    .swap_exact_sy_for_yt(&f.trader, &f.trader, &sy_in, &1, &dl);
            let cpu = f.env.cost_estimate().budget().cpu_instruction_cost();
            assert!(
                cpu < 35_000_000,
                "600T:300T swap_exact_sy_for_yt CPU {} >= 35M",
                cpu
            );
            assert!(
                yt_out > prev_yt_600t,
                "600T:300T yt_out must strictly increase: {} <= {}",
                yt_out,
                prev_yt_600t
            );
            assert!(fee > 0);
            assert_reserve_conservation(&f);
            prev_yt_600t = yt_out;
        }

        // 2. Large pool 20B:10B tokens (2e16 PT : 1e16 SY), dense monotonic sweep + oversized 1e15 rejection
        let base_2e16 = 350_000_000_000_000i128;
        let mut prev_yt_2e16 = 0i128;
        for delta in [0i128, 1, 10, 1_000, 1_000_000] {
            let f = setup_r1_pool(10_000, 90);
            let dl = f.maturity;
            let pt_liq = 20_000_000_000_000_000i128;
            let sy_liq = 10_000_000_000_000_000i128;
            f.usdc_admin.mint(&f.lp_user, &(pt_liq + sy_liq));
            f.sy_client
                .deposit(&f.lp_user, &f.lp_user, &(pt_liq + sy_liq));
            f.pool_client
                .mint_py(&f.lp_user, &f.lp_user, &pt_liq, &dl);
            f.pool_client
                .add_liquidity(&f.lp_user, &f.lp_user, &pt_liq, &sy_liq, &1);
            f.blend_client.set_b_rate(&1_050_000_000);

            let sy_in = base_2e16 + delta;
            f.usdc_admin.mint(&f.trader, &(sy_in * 2));
            f.sy_client.deposit(&f.trader, &f.trader, &(sy_in * 2));

            f.env
                .cost_estimate()
                .budget()
                .reset_limits(100_000_000, 41_943_040);
            let (yt_out, fee) =
                f.pool_client
                    .swap_exact_sy_for_yt(&f.trader, &f.trader, &sy_in, &1, &dl);
            let cpu = f.env.cost_estimate().budget().cpu_instruction_cost();
            assert!(
                cpu < 35_000_000,
                "2e16:1e16 swap_exact_sy_for_yt CPU {} >= 35M",
                cpu
            );
            assert!(
                yt_out >= prev_yt_2e16,
                "2e16:1e16 yt_out non-monotonic at delta={}: {} < {}",
                delta,
                yt_out,
                prev_yt_2e16
            );
            assert!(fee > 0);
            assert_reserve_conservation(&f);
            prev_yt_2e16 = yt_out;
        }

        // Oversized 1e15 on 2e16:1e16 cleanly rejects with ProportionOutOfBounds (never ZeroAmount or ExceededLimit)
        let f_over = setup_r1_pool(10_000, 90);
        let dl_over = f_over.maturity;
        let pt_liq = 20_000_000_000_000_000i128;
        let sy_liq = 10_000_000_000_000_000i128;
        f_over.usdc_admin.mint(&f_over.lp_user, &(pt_liq + sy_liq));
        f_over
            .sy_client
            .deposit(&f_over.lp_user, &f_over.lp_user, &(pt_liq + sy_liq));
        f_over
            .pool_client
            .mint_py(&f_over.lp_user, &f_over.lp_user, &pt_liq, &dl_over);
        f_over
            .pool_client
            .add_liquidity(&f_over.lp_user, &f_over.lp_user, &pt_liq, &sy_liq, &1);
        f_over.blend_client.set_b_rate(&1_050_000_000);
        let sy_over = 1_000_000_000_000_000i128;
        f_over.usdc_admin.mint(&f_over.trader, &(sy_over * 2));
        f_over
            .sy_client
            .deposit(&f_over.trader, &f_over.trader, &(sy_over * 2));
        f_over
            .env
            .cost_estimate()
            .budget()
            .reset_limits(100_000_000, 41_943_040);
        let res_over = f_over.pool_client.try_swap_exact_sy_for_yt(
            &f_over.trader,
            &f_over.trader,
            &sy_over,
            &1,
            &dl_over,
        );
        assert_eq!(res_over, Err(Ok(ContractError::ProportionOutOfBounds)));
    }

    #[test]
    fn test_tier5_bug_a1_yt_for_sy_1_stroop_drain_and_zero_out_rejected() {
        // 1. 1-stroop drain prevention: attacker spends 10 SY -> gets YT, then tries 1-stroop YT->SY sells
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;
        f.usdc_admin.mint(&f.lp_user, &220_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &220_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &120_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &120_000_000_000,
            &100_000_000_000,
            &1,
        );

        f.usdc_admin.mint(&f.trader, &1_000);
        f.sy_client.deposit(&f.trader, &f.trader, &1_000);
        let (yt_bought, _) =
            f.pool_client
                .swap_exact_sy_for_yt(&f.trader, &f.trader, &10, &0, &dl);
        assert!(yt_bought > 0);

        let yt_start = f.yt_client.balance(&f.trader);
        let mut sy_received = 0i128;
        for _ in 0..20 {
            let res = f
                .pool_client
                .try_swap_exact_yt_for_sy(&f.trader, &f.trader, &1, &0, &dl);
            match res {
                Ok(Ok((out, _fee))) => {
                    assert!(out > 0, "must never silently burn YT for 0 SY");
                    sy_received += out;
                }
                Err(Ok(err)) => {
                    assert!(
                        err == ContractError::NegativeYieldNotSupported
                            || err == ContractError::ZeroAmount,
                        "unexpected error on 1-stroop yt->sy: {:?}",
                        err
                    );
                }
                other => panic!("unexpected result: {:?}", other),
            }
        }
        assert!(
            sy_received <= 1,
            "1-stroop drain must not extract >1 SY: got {}",
            sy_received
        );
        // No YT burned on rejected calls
        assert_eq!(f.yt_client.balance(&f.trader), yt_start);

        // 2. At py_index = 1.15 and gross_yield = 1, net_sy_out = floor(1 / 1.15) = 0 -> must reject #4 ZeroAmount without burning YT/PT
        f.blend_client.set_b_rate(&1_150_000_000);
        let pt_pool_before = f.pt_client.balance(&f.pool_client.address);
        let yt_before = f.yt_client.balance(&f.trader);
        assert_eq!(
            f.pool_client
                .try_swap_exact_yt_for_sy(&f.trader, &f.trader, &1, &0, &dl),
            Err(Ok(ContractError::NegativeYieldNotSupported))
        );
        // At 120B PT : 115B asset (e_trade ~ 1.0005), ~1850..2100 YT yields gross_yield = 1 -> net_sy_out = 0 -> ZeroAmount
        let mut saw_zero_amount = false;
        let mut tiny = 100i128;
        while tiny <= yt_before {
            let r = f
                .pool_client
                .try_swap_exact_yt_for_sy(&f.trader, &f.trader, &tiny, &0, &dl);
            if r == Err(Ok(ContractError::ZeroAmount)) {
                saw_zero_amount = true;
                break;
            }
            tiny += 100;
        }
        assert!(saw_zero_amount, "expected ZeroAmount when net_sy_out == 0 at py_index=1.15");
        assert_eq!(f.yt_client.balance(&f.trader), yt_before);
        assert_eq!(f.pt_client.balance(&f.pool_client.address), pt_pool_before);
        assert_reserve_conservation(&f);
    }

    #[test]
    fn test_tier5_bug_a2_add_liquidity_zero_lp_rejected_before_transfers() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;
        f.usdc_admin.mint(&f.lp_user, &220_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &220_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &120_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &120_000_000_000,
            &100_000_000_000,
            &1,
        );

        f.usdc_admin.mint(&f.trader, &2_000);
        f.sy_client.deposit(&f.trader, &f.trader, &2_000);
        f.pool_client.mint_py(&f.trader, &f.trader, &500, &dl);

        let pt_before = f.pt_client.balance(&f.trader);
        let sy_before = f.sy_client.balance(&f.trader);
        let res = f
            .pool_client
            .try_add_liquidity(&f.trader, &f.trader, &1, &500, &0);
        assert_eq!(res, Err(Ok(ContractError::ZeroAmount)));
        assert_eq!(f.pt_client.balance(&f.trader), pt_before);
        assert_eq!(f.sy_client.balance(&f.trader), sy_before);
        assert_eq!(f.pool_client.balance(&f.trader), 0);
    }

    #[test]
    fn test_tier5_bug_a4_remove_liquidity_single_leg_and_both_zero() {
        let f = setup_r1_pool(10_000, 90);
        let dl = f.maturity;
        f.usdc_admin.mint(&f.lp_user, &220_000_000_000);
        f.sy_client.deposit(&f.lp_user, &f.lp_user, &220_000_000_000);
        f.pool_client
            .mint_py(&f.lp_user, &f.lp_user, &120_000_000_000, &dl);
        f.pool_client.add_liquidity(
            &f.lp_user,
            &f.lp_user,
            &120_000_000_000,
            &100_000_000_000,
            &1,
        );

        // 1-stroop LP withdrawal: pt_out = 1, sy_out = 0 -> must succeed without #4 ZeroAmount on sy.transfer(0)
        let pt_before = f.pt_client.balance(&f.lp_user);
        let sy_before = f.sy_client.balance(&f.lp_user);
        let (pt_out, sy_out) = f
            .pool_client
            .remove_liquidity(&f.lp_user, &f.lp_user, &1, &0, &0);
        assert_eq!(pt_out, 1);
        assert_eq!(sy_out, 0);
        assert_eq!(f.pt_client.balance(&f.lp_user), pt_before + 1);
        assert_eq!(f.sy_client.balance(&f.lp_user), sy_before);

        // Symmetric check: if both pt_out == 0 and sy_out == 0 (when total_lp > pt_res & sy_res), reject #4 ZeroAmount
        let f2 = setup_r1_pool(10_000, 90);
        f2.env.as_contract(&f2.pool_client.address, || {
            f2.env.storage().instance().set(&DataKey::TotalLpSupply, &1_000_000i128);
            f2.env.storage().instance().set(&DataKey::TotalPtReserve, &100i128);
            f2.env.storage().instance().set(&DataKey::TotalSyReserve, &100i128);
            f2.env
                .storage()
                .persistent()
                .set(&DataKey::Balance(f2.lp_user.clone()), &10i128);
        });
        assert_eq!(
            f2.pool_client
                .try_remove_liquidity(&f2.lp_user, &f2.lp_user, &1, &0, &0),
            Err(Ok(ContractError::ZeroAmount))
        );
    }

    #[test]
    fn test_tier5_bug_a5_claim_yield_bad_debt_preserves_unclaimed_yield() {
        let f = setup_r1_pool(10_000, 90);
        let amt = 10_000_000_000i128;
        f.usdc_admin.mint(&f.py_user1, &amt);
        f.sy_client.deposit(&f.py_user1, &f.py_user1, &amt);
        f.pool_client
            .mint_py(&f.py_user1, &f.py_user1, &amt, &f.maturity);

        // Accrue 1.0 -> 1.2, checkpoint via self-transfer, then drop rate 1.2 -> 0.8 and drain all pool SY
        f.blend_client.set_b_rate(&1_200_000_000);
        f.yt_client.transfer(&f.py_user1, &f.py_user1, &1);
        f.blend_client.set_b_rate(&800_000_000);
        f.sy_client.burn(&f.pool_client.address, &amt);

        let state_before = f.yt_client.get_user_yield_state(&f.py_user1);
        assert!(state_before.unclaimed_yield > 0);
        let total_before = f.yt_client.get_total_unclaimed_yield();
        assert!(total_before > 0);

        // claim_yield when available_py_sy == 0 MUST revert InsufficientBalance and preserve unclaimed_yield!
        assert_eq!(
            f.pool_client.try_claim_yield(&f.py_user1, &f.py_user1),
            Err(Ok(ContractError::InsufficientBalance))
        );
        let state_after = f.yt_client.get_user_yield_state(&f.py_user1);
        assert_eq!(state_after.unclaimed_yield, state_before.unclaimed_yield);
        assert_eq!(state_after.last_index, state_before.last_index);
        assert_eq!(f.yt_client.get_total_unclaimed_yield(), total_before);

        // Restore SY liquidity to pool -> user can now successfully claim their preserved yield!
        f.usdc_admin.mint(&f.py_user1, &amt);
        f.sy_client
            .deposit(&f.py_user1, &f.pool_client.address, &amt);
        let claimed = f.pool_client.claim_yield(&f.py_user1, &f.py_user1);
        assert!(claimed > 0);
        assert_eq!(f.yt_client.get_user_yield_state(&f.py_user1).unclaimed_yield, 0);
    }
}

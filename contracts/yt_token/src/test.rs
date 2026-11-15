#![cfg(test)]
extern crate std;

use crate::{YieldToken, YieldTokenClient};
use common::fixed_point::SCALAR_9;
use mock_blend::{MockBlend, MockBlendClient};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{Address, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};

fn setup_test<'a>() -> (
    Env,
    Address,
    Address,
    MockBlendClient<'a>,
    StandardizedYieldClient<'a>,
    YieldTokenClient<'a>,
    u64,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let market = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin.clone());

    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400;

    let yt_id = env.register(YieldToken, ());
    let yt_client = YieldTokenClient::new(&env, &yt_id);
    yt_client.initialize(
        &admin,
        &market,
        &sy_id,
        &String::from_str(&env, "Pendle bUSDC YT 180D"),
        &String::from_str(&env, "YT-bUSDC-180D"),
        &7u32,
        &maturity,
    );

    (
        env,
        admin,
        market,
        blend_client,
        sy_client,
        yt_client,
        maturity,
    )
}

#[test]
fn test_yt_checkpointing_and_yield_claim() {
    let (_env, _admin, _market, blend_client, _sy_client, yt_client, _maturity) = setup_test();
    let user = Address::generate(&_env);
    let amount = 1_000_000_000i128; // 1000 YT

    // Mint 1000 YT to user at index 1.00 * 10^9
    yt_client.mint(&user, &amount);
    assert_eq!(yt_client.balance(&user), amount);

    let state0 = yt_client.get_user_yield_state(&user);
    assert_eq!(state0.yt_balance, amount);
    assert_eq!(state0.last_index, SCALAR_9);
    assert_eq!(state0.unclaimed_yield, 0);

    // Bump Blend rate to 1.10 * 10^9 (10% yield accrued)
    blend_client.set_b_rate(&1_100_000_000);

    // User claims yield
    let claimed = yt_client.claim_user_yield(&user);
    // 1000 * (1.10 - 1.00) / 1.00 = 100
    assert_eq!(claimed, 100_000_000);

    // Immediate second claim yields 0
    let claimed2 = yt_client.claim_user_yield(&user);
    assert_eq!(claimed2, 0);
}

#[test]
fn test_yt_transfer_checkpointing() {
    let (_env, _admin, _market, blend_client, _sy_client, yt_client, _maturity) = setup_test();
    let user1 = Address::generate(&_env);
    let user2 = Address::generate(&_env);
    let amount = 1_000_000_000i128;

    // User1 receives 1000 YT at 1.00
    yt_client.mint(&user1, &amount);

    // Index moves to 1.05
    blend_client.set_b_rate(&1_050_000_000);

    // User1 transfers 500 YT to User2
    yt_client.transfer(&user1, &user2, &500_000_000);

    // Check User1 has 50 accrued yield recorded
    let state_u1 = yt_client.get_user_yield_state(&user1);
    assert_eq!(state_u1.yt_balance, 500_000_000);
    assert_eq!(state_u1.last_index, 1_050_000_000);
    assert_eq!(state_u1.unclaimed_yield, 50_000_000);

    // Check User2 has 0 accrued yield and last_index = 1.05
    let state_u2 = yt_client.get_user_yield_state(&user2);
    assert_eq!(state_u2.yt_balance, 500_000_000);
    assert_eq!(state_u2.last_index, 1_050_000_000);
    assert_eq!(state_u2.unclaimed_yield, 0);

    // Index moves to 1.155 (an extra 10% on 1.05)
    blend_client.set_b_rate(&1_155_000_000);

    let claimed_u1 = yt_client.claim_user_yield(&user1);
    let claimed_u2 = yt_client.claim_user_yield(&user2);

    // User1 gets 50 (from before) + 500 * (1.155 - 1.050)/1.050 = 50 + 50 = 100
    assert_eq!(claimed_u1, 100_000_000);
    // User2 gets 500 * (1.155 - 1.050)/1.050 = 50
    assert_eq!(claimed_u2, 50_000_000);
}

#[test]
fn test_yt_maturity_clamping() {
    let (env, _admin, _market, blend_client, _sy_client, yt_client, maturity) = setup_test();
    let user = Address::generate(&env);
    let amount = 1_000_000_000i128;

    yt_client.mint(&user, &amount);

    // Index moves to 1.10
    blend_client.set_b_rate(&1_100_000_000);

    // Advance time to maturity
    env.ledger().set_timestamp(maturity + 10);

    // Index at maturity was 1.10
    let claimed_at_maturity = yt_client.claim_user_yield(&user);
    assert_eq!(claimed_at_maturity, 100_000_000);

    // Index later moves to 1.30 post-maturity
    blend_client.set_b_rate(&1_300_000_000);

    // Post-maturity yield accrual is CLAMPED (frozen) -> should yield 0!
    let claimed_post_maturity = yt_client.claim_user_yield(&user);
    assert_eq!(claimed_post_maturity, 0);
}

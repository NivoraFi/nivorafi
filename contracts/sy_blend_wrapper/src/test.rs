#![cfg(test)]
extern crate std;

use crate::{StandardizedYield, StandardizedYieldClient};
use common::fixed_point::SCALAR_9;
use mock_blend::{MockBlend, MockBlendClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, Env, String};

fn setup_test<'a>() -> (
    Env,
    Address,
    token::Client<'a>,
    token::StellarAssetClient<'a>,
    MockBlendClient<'a>,
    StandardizedYieldClient<'a>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
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

    (
        env,
        admin,
        usdc_client,
        usdc_admin_client,
        blend_client,
        sy_client,
    )
}

#[test]
fn test_sy_wrapper_lifecycle() {
    let (env, _admin, usdc_client, usdc_admin_client, blend_client, sy_client) = setup_test();

    let user = Address::generate(&env);
    let deposit_amount = 1_000_000_000i128; // 100 USDC

    usdc_admin_client.mint(&user, &deposit_amount);

    // Deposit USDC -> mints SY shares
    let shares = sy_client.deposit(&user, &user, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(sy_client.balance(&user), deposit_amount);
    assert_eq!(sy_client.total_shares(), deposit_amount);
    assert_eq!(usdc_client.balance(&user), 0);
    assert_eq!(sy_client.exchange_rate(), SCALAR_9);

    // Bump Blend rate by 20%
    let new_rate = 1_200_000_000i128;
    blend_client.set_b_rate(&new_rate);
    assert_eq!(sy_client.exchange_rate(), new_rate);

    // Fund Blend mock so it can pay out the interest
    let interest = 200_000_000i128;
    usdc_admin_client.mint(&blend_client.address, &interest);

    // Redeem all SY shares -> should get 1200 USDC back!
    let payout = sy_client.redeem(&user, &user, &shares);
    assert_eq!(payout, 1_200_000_000i128);
    assert_eq!(sy_client.balance(&user), 0);
    assert_eq!(sy_client.total_shares(), 0);
    assert_eq!(usdc_client.balance(&user), 1_200_000_000i128);
}

#[test]
fn test_sy_token_methods() {
    let (env, _admin, _usdc_client, usdc_admin_client, _blend_client, sy_client) = setup_test();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let spender = Address::generate(&env);
    let amount = 1_000_000_000i128;

    usdc_admin_client.mint(&user1, &amount);
    sy_client.deposit(&user1, &user1, &amount);

    assert_eq!(sy_client.decimals(), 7);
    assert_eq!(
        sy_client.name(),
        String::from_str(&env, "Standardized Yield Blend USDC")
    );
    assert_eq!(sy_client.symbol(), String::from_str(&env, "sy-bUSDC"));

    // Transfer
    sy_client.transfer(&user1, &user2, &400_000_000);
    assert_eq!(sy_client.balance(&user1), 600_000_000);
    assert_eq!(sy_client.balance(&user2), 400_000_000);

    // Allowance & transfer_from
    sy_client.approve(&user1, &spender, &200_000_000, &1000);
    assert_eq!(sy_client.allowance(&user1, &spender), 200_000_000);

    sy_client.transfer_from(&spender, &user1, &user2, &200_000_000);
    assert_eq!(sy_client.balance(&user1), 400_000_000);
    assert_eq!(sy_client.balance(&user2), 600_000_000);
    assert_eq!(sy_client.allowance(&user1, &spender), 0);
}

#[test]
fn test_sy_redeem_to_btoken() {
    let (env, _admin, _usdc_client, usdc_admin_client, blend_client, sy_client) = setup_test();
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let deposit_amount = 1_000_000_000i128;

    usdc_admin_client.mint(&user, &deposit_amount);
    let shares = sy_client.deposit(&user, &user, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(
        blend_client.get_collateral(&sy_client.address),
        deposit_amount
    );

    let btokens = sy_client.redeem_to_btoken(&user, &receiver, &shares);
    assert_eq!(btokens, shares);
    assert_eq!(sy_client.balance(&user), 0);
    assert_eq!(sy_client.total_shares(), 0);
    assert_eq!(sy_client.total_supply(), 0);
    assert_eq!(blend_client.get_collateral(&sy_client.address), 0);
    assert_eq!(blend_client.get_collateral(&receiver), deposit_amount);
}

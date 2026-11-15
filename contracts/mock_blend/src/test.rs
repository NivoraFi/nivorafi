#![cfg(test)]
extern crate std;

use crate::{MockBlend, MockBlendClient};
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::{
    Request, REQUEST_TYPE_SUPPLY_COLLATERAL, REQUEST_TYPE_WITHDRAW_COLLATERAL,
};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, vec, Address, Env};

fn setup_test<'a>() -> (
    Env,
    Address,
    Address,
    MockBlendClient<'a>,
    token::Client<'a>,
    token::StellarAssetClient<'a>,
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

    (
        env,
        admin,
        usdc.address(),
        blend_client,
        usdc_client,
        usdc_admin_client,
    )
}

#[test]
fn test_mock_blend_lifecycle() {
    let (env, _admin, usdc, blend_client, usdc_client, usdc_admin_client) = setup_test();

    let user = Address::generate(&env);
    let deposit_amount = 1_000_000_000i128; // 100 USDC (7 decimals or 9 decimals)

    // Mint USDC to user
    usdc_admin_client.mint(&user, &deposit_amount);
    assert_eq!(usdc_client.balance(&user), deposit_amount);

    // Supply collateral
    let requests = vec![
        &env,
        Request {
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            address: usdc.clone(),
            amount: deposit_amount,
        },
    ];

    let processed = blend_client.submit(&user, &user, &user, &requests);
    assert_eq!(processed.collateral, deposit_amount);
    assert_eq!(blend_client.get_collateral(&user), deposit_amount);
    let pos = blend_client.get_positions(&user);
    assert_eq!(pos.collateral, deposit_amount);
    assert_eq!(pos.liabilities, 0);
    assert_eq!(pos.supply, 0);
    assert_eq!(usdc_client.balance(&user), 0);

    // Bump b_rate to 1.15 * 10^9 (15% yield accrued)
    let new_rate = 1_150_000_000i128;
    blend_client.set_b_rate(&new_rate);
    assert_eq!(blend_client.get_b_rate(), new_rate);

    let reserve = blend_client.get_reserve(&usdc);
    assert_eq!(reserve.b_rate, new_rate);
    assert_eq!(reserve.d_rate, new_rate);

    // Mint extra yield USDC to mock_blend so it can pay out the 15% interest
    let interest = 150_000_000i128;
    usdc_admin_client.mint(&blend_client.address, &interest);

    // Withdraw full collateral: 1000 bTokens * 1.15 = 1150 USDC
    let withdraw_amount = 1_150_000_000i128;
    let withdraw_requests = vec![
        &env,
        Request {
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
            address: usdc.clone(),
            amount: withdraw_amount,
        },
    ];

    let w_processed = blend_client.submit(&user, &user, &user, &withdraw_requests);
    assert_eq!(w_processed.collateral, 0);
    assert_eq!(blend_client.get_collateral(&user), 0);
    assert_eq!(usdc_client.balance(&user), withdraw_amount);
}

#[test]
fn test_transfer_collateral() {
    let (env, _admin, usdc, blend_client, _usdc_client, usdc_admin_client) = setup_test();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let amount = 1_000_000_000i128;

    usdc_admin_client.mint(&user1, &amount);
    let requests = vec![
        &env,
        Request {
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            address: usdc.clone(),
            amount,
        },
    ];
    blend_client.submit(&user1, &user1, &user1, &requests);
    assert_eq!(blend_client.get_collateral(&user1), amount);

    blend_client.transfer_collateral(&user1, &user2, &400_000_000);
    assert_eq!(blend_client.get_collateral(&user1), 600_000_000);
    assert_eq!(blend_client.get_collateral(&user2), 400_000_000);
}

#[test]
fn test_dynamic_time_accrual() {
    let (env, _admin, usdc, blend_client, _usdc_client, _usdc_admin_client) = setup_test();

    // Set 10% annual rate (0.10 WAD = 10^17)
    let annual_rate = WAD / 10;
    blend_client.set_annual_rate(&annual_rate);
    assert_eq!(blend_client.get_annual_rate(), annual_rate);

    let initial_time = env.ledger().timestamp();
    // Advance 365 days (31,536,000 seconds)
    env.ledger().set_timestamp(initial_time + 31_536_000);

    let new_rate = blend_client.get_b_rate();
    // b_rate should compound from 1.0e9 by 10% to 1.1e9
    assert_eq!(new_rate, 1_100_000_000i128);

    let reserve = blend_client.get_reserve(&usdc);
    assert_eq!(reserve.b_rate, 1_100_000_000i128);
    assert_eq!(reserve.supply_apr, annual_rate);
}

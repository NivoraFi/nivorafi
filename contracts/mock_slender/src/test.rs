#![cfg(test)]
extern crate std;

use crate::{MockSlender, MockSlenderClient};
use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::{token, Address, Env, String};

fn setup_test<'a>() -> (
    Env,
    Address,
    Address,
    MockSlenderClient<'a>,
    token::Client<'a>,
    token::StellarAssetClient<'a>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    let slender_id = env.register(MockSlender, ());
    let slender_client = MockSlenderClient::new(&env, &slender_id);
    slender_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    (
        env,
        admin,
        usdc.address(),
        slender_client,
        usdc_client,
        usdc_admin_client,
    )
}

#[test]
fn test_mock_slender_lifecycle_and_ceiling_withdraw() {
    let (env, admin, usdc, slender_client, usdc_client, usdc_admin_client) = setup_test();
    let user = Address::generate(&env);

    assert_eq!(slender_client.s_token(), slender_client.address);
    assert_eq!(slender_client.get_admin(), admin);
    assert_eq!(slender_client.asset(), usdc);
    assert_eq!(slender_client.decimals(), 7);
    assert_eq!(slender_client.name(), String::from_str(&env, "Slender saaa"));
    assert_eq!(slender_client.symbol(), String::from_str(&env, "saaa"));

    // Deposit 1000 units at 1.0 rate
    let amount = 1_000_000_000i128;
    usdc_admin_client.mint(&user, &amount);
    let minted = slender_client.deposit(&user, &user, &usdc, &amount);
    assert_eq!(minted, amount);
    assert_eq!(slender_client.balance(&user), amount);
    assert_eq!(slender_client.total_supply(), amount);

    // Bump index to 1.15 and fund interest
    slender_client.set_liquidity_index(&1_150_000_000);
    assert_eq!(slender_client.get_liquidity_index(), 1_150_000_000);
    usdc_admin_client.mint(&slender_client.address, &150_000_000);

    // Withdraw 1150 -> burns 1000 s-shares
    let withdrawn = slender_client.withdraw(&user, &user, &usdc, &1_150_000_000);
    assert_eq!(withdrawn, 1_150_000_000);
    assert_eq!(slender_client.balance(&user), 0);
    assert_eq!(slender_client.total_supply(), 0);
    assert_eq!(usdc_client.balance(&user), 1_150_000_000);

    // Micro-withdraw at index 2.0 burns at least 1 s-share (ceil rounding)
    slender_client.set_liquidity_index(&2_000_000_000);
    usdc_admin_client.mint(&user, &4);
    let s_minted = slender_client.deposit(&user, &user, &usdc, &4);
    assert_eq!(s_minted, 2);
    usdc_admin_client.mint(&slender_client.address, &10);
    slender_client.withdraw(&user, &user, &usdc, &1);
    // ceil(1 * 1e9 / 2e9) = 1 s-share burned -> 1 remaining
    assert_eq!(slender_client.balance(&user), 1);
}

#[test]
fn test_mock_slender_sep41_and_accrual() {
    let (env, _admin, usdc, slender_client, _usdc_client, usdc_admin_client) = setup_test();
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);
    let spender = Address::generate(&env);

    usdc_admin_client.mint(&u1, &1_000_000_000);
    slender_client.deposit(&u1, &u1, &usdc, &1_000_000_000);

    slender_client.transfer(&u1, &u2, &400_000_000);
    assert_eq!(slender_client.balance(&u1), 600_000_000);
    assert_eq!(slender_client.balance(&u2), 400_000_000);

    slender_client.approve(&u1, &spender, &200_000_000, &1000);
    slender_client.transfer_from(&spender, &u1, &u2, &200_000_000);
    assert_eq!(slender_client.balance(&u1), 400_000_000);
    assert_eq!(slender_client.balance(&u2), 600_000_000);
    assert_eq!(slender_client.allowance(&u1, &spender), 0);

    // Organic time-based accrual: 10% APR for 1 year -> 1.1e9
    slender_client.set_annual_rate(&(WAD / 10));
    assert_eq!(slender_client.get_annual_rate(), WAD / 10);
    let t0 = env.ledger().timestamp();
    env.ledger().set_timestamp(t0 + 31_536_000);
    let rate = slender_client.accrue();
    assert_eq!(rate, 1_100_000_000);
    let res = slender_client.get_reserve(&usdc);
    assert_eq!(res.liquidity_index, 1_100_000_000);
    assert_eq!(res.supply_apr, WAD / 10);
}

#[test]
fn test_mock_slender_error_guards() {
    let (env, admin, usdc, slender_client, _usdc_client, _usdc_admin_client) = setup_test();
    let attacker = Address::generate(&env);

    // Re-init returns AlreadyInitialized even for attacker
    assert_eq!(
        slender_client.try_initialize(&attacker, &usdc, &SCALAR_9),
        Err(Ok(ContractError::AlreadyInitialized))
    );

    // Negative APR rejected with InvalidRate
    assert_eq!(
        slender_client.try_set_annual_rate(&-1),
        Err(Ok(ContractError::InvalidRate))
    );

    // Zero liquidity index rejected with ZeroAmount
    assert_eq!(
        slender_client.try_set_liquidity_index(&0),
        Err(Ok(ContractError::ZeroAmount))
    );

    // Invalid asset rejected with InvalidAsset
    let fake_asset = Address::generate(&env);
    assert_eq!(
        slender_client.try_get_reserve(&fake_asset),
        Err(Ok(ContractError::InvalidAsset))
    );
    assert_eq!(
        slender_client.try_deposit(&admin, &admin, &fake_asset, &100),
        Err(Ok(ContractError::InvalidAsset))
    );
}

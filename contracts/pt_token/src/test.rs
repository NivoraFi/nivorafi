#![cfg(test)]
extern crate std;

use crate::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env, String};

fn setup_test<'a>() -> (Env, Address, Address, PrincipalTokenClient<'a>, u64) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let market = Address::generate(&env);
    let maturity = env.ledger().timestamp() + 180 * 86400;

    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);

    pt_client.initialize(
        &admin,
        &market,
        &String::from_str(&env, "Pendle bUSDC PT 180D"),
        &String::from_str(&env, "PT-bUSDC-180D"),
        &7u32,
        &maturity,
    );

    (env, admin, market, pt_client, maturity)
}

#[test]
fn test_pt_token_lifecycle() {
    let (env, _admin, _market, pt_client, maturity) = setup_test();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let spender = Address::generate(&env);
    let amount = 1_000_000_000i128;

    assert_eq!(pt_client.maturity(), maturity);
    assert_eq!(pt_client.decimals(), 7);
    assert_eq!(
        pt_client.name(),
        String::from_str(&env, "Pendle bUSDC PT 180D")
    );
    assert_eq!(pt_client.symbol(), String::from_str(&env, "PT-bUSDC-180D"));

    // Market mints PT to user1
    pt_client.mint(&user1, &amount);
    assert_eq!(pt_client.balance(&user1), amount);

    // Transfer
    pt_client.transfer(&user1, &user2, &400_000_000);
    assert_eq!(pt_client.balance(&user1), 600_000_000);
    assert_eq!(pt_client.balance(&user2), 400_000_000);

    // Approve & transfer_from
    pt_client.approve(&user1, &spender, &200_000_000, &1000);
    assert_eq!(pt_client.allowance(&user1, &spender), 200_000_000);

    pt_client.transfer_from(&spender, &user1, &user2, &200_000_000);
    assert_eq!(pt_client.balance(&user1), 400_000_000);
    assert_eq!(pt_client.balance(&user2), 600_000_000);
    assert_eq!(pt_client.allowance(&user1, &spender), 0);

    // Market burns PT from user2
    pt_client.burn(&user2, &300_000_000);
    assert_eq!(pt_client.balance(&user2), 300_000_000);
}

#[test]
fn test_pt_total_supply() {
    let (env, _admin, _market, pt_client, _maturity) = setup_test();
    let user1 = Address::generate(&env);
    let user2 = Address::generate(&env);
    let amount = 1_000_000_000i128;

    assert_eq!(pt_client.total_supply(), 0);
    pt_client.mint(&user1, &amount);
    assert_eq!(pt_client.total_supply(), amount);
    pt_client.transfer(&user1, &user2, &400_000_000);
    assert_eq!(pt_client.total_supply(), amount);
    pt_client.burn(&user2, &300_000_000);
    assert_eq!(pt_client.total_supply(), 700_000_000);
}

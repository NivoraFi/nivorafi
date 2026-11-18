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

mod r1_f4_yt_tests {
    use crate::{YieldToken, YieldTokenClient};
    use common::errors::ContractError;
    use common::fixed_point::SCALAR_9;
    use common::interfaces::{MockBlendClient, StandardizedYieldClient};
    use common::storage_keys::DataKey;
    use mock_blend::MockBlend;
    use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{Address, Env, IntoVal, String, Val, Vec};
    use sy_blend_wrapper::StandardizedYield;

    fn setup_yt_env(
        env: &Env,
        maturity: u64,
    ) -> (
        Address,
        Address,
        MockBlendClient<'_>,
        StandardizedYieldClient<'_>,
        YieldTokenClient<'_>,
    ) {
        let admin = Address::generate(env);
        let market = Address::generate(env);
        let token_admin = Address::generate(env);
        let usdc = env.register_stellar_asset_contract_v2(token_admin);

        let blend_id = env.register(MockBlend, ());
        let blend_client = MockBlendClient::new(env, &blend_id);
        blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

        let sy_id = env.register(StandardizedYield, ());
        let sy_client = StandardizedYieldClient::new(env, &sy_id);
        sy_client.initialize(&admin, &usdc.address(), &blend_id);

        let yt_id = env.register(YieldToken, ());
        let yt_client = YieldTokenClient::new(env, &yt_id);
        yt_client.initialize(
            &admin,
            &market,
            &sy_id,
            &String::from_str(env, "YT USDC 30D"),
            &String::from_str(env, "YT-USDC-30D"),
            &7u32,
            &maturity,
        );

        (admin, market, blend_client, sy_client, yt_client)
    }

    #[test]
    fn test_yt_total_unclaimed_yield_multi_user_conservation() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1000);
        let maturity = 1000 + 30 * 86400;

        let (_admin, _market, blend_client, _sy_client, yt_client) = setup_yt_env(&env, maturity);
        let user1 = Address::generate(&env);
        let user2 = Address::generate(&env);

        let amt1: i128 = 100_000_000_000;
        let amt2: i128 = 200_000_000_000;
        yt_client.mint(&user1, &amt1);
        yt_client.mint(&user2, &amt2);
        assert_eq!(yt_client.get_total_unclaimed_yield(), 0);

        // Accrue 10% (index 1.0 -> 1.1)
        blend_client.set_b_rate(&1_100_000_000);
        // Transfer 40% of user1's YT to user2 mid-period (triggers update_checkpoint on both)
        yt_client.transfer(&user1, &user2, &40_000_000_000);

        let unclaimed_mid = yt_client.get_total_unclaimed_yield();
        assert!(unclaimed_mid > 0);

        // Accrue another bump (1.1 -> 1.2)
        blend_client.set_b_rate(&1_200_000_000);
        // Burn partial YT from user2 (must preserve accumulated unclaimed yield without underflow)
        yt_client.burn(&user2, &200_000_000_000);

        let total_unclaimed_before_claims = yt_client.get_total_unclaimed_yield();
        assert!(total_unclaimed_before_claims > unclaimed_mid);

        let c1 = yt_client.claim_user_yield(&user1);
        let c2 = yt_client.claim_user_yield(&user2);
        assert!(c1 > 0 && c2 > 0);
        assert_eq!(c1 + c2, total_unclaimed_before_claims);
        assert_eq!(yt_client.get_total_unclaimed_yield(), 0);

        // Re-check burn of remaining YT at same index causes no underflow
        yt_client.burn(&user1, &60_000_000_000);
        yt_client.burn(&user2, &40_000_000_000);
        assert_eq!(yt_client.total_supply(), 0);
        assert_eq!(yt_client.get_total_unclaimed_yield(), 0);
    }

    #[test]
    fn test_yt_settle_maturity_auth_pause_immunity_and_bidirectional_pin() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1000);
        let maturity = 1000 + 30 * 86400;

        let (admin, market, blend_client, _sy_client, yt_client) = setup_yt_env(&env, maturity);
        let user = Address::generate(&env);
        yt_client.mint(&user, &100_000_000_000);

        // 1. settle_maturity without market auth must fail
        env.mock_auths(&[]);
        assert!(yt_client.try_settle_maturity(&1_200_000_000).is_err());

        // 2. Pause YT, advance past maturity, and invoke settle_maturity with market auth ONLY -> succeeds while paused!
        env.mock_all_auths();
        yt_client.pause(&admin);
        assert!(yt_client.is_paused());
        env.ledger().set_timestamp(maturity + 100);

        let settle_args: Vec<Val> = (1_250_000_000i128,).into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &market,
            invoke: &MockAuthInvoke {
                contract: &yt_client.address,
                fn_name: "settle_maturity",
                args: settle_args,
                sub_invokes: &[],
            },
        }]);
        let pinned = yt_client.settle_maturity(&1_250_000_000);
        assert_eq!(pinned, 1_250_000_000);
        let stored_pin: Option<i128> = env.as_contract(&yt_client.address, || {
            env.storage().instance().get(&DataKey::MaturityIndex)
        });
        assert_eq!(stored_pin, Some(1_250_000_000));

        // Subsequent settle_maturity with a different index returns the already-pinned 1.25
        env.mock_all_auths();
        blend_client.set_b_rate(&1_500_000_000);
        assert_eq!(yt_client.settle_maturity(&1_500_000_000), 1_250_000_000);

        // Unpause and claim: yield must be capped at 1.25, NOT 1.50 (100B * (1.25 - 1.00) = 25B; 1.50 would be 50B)
        yt_client.unpause(&admin);
        let claimed = yt_client.claim_user_yield(&user);
        assert_eq!(claimed, 25_000_000_000);

        // 3. Reverse direction: update_checkpoint settles first (post-maturity transfer), then settle_maturity adopts it
        let env2 = Env::default();
        env2.mock_all_auths();
        env2.ledger().set_timestamp(1000);
        let (_admin2, _market2, blend2, _sy2, yt2) = setup_yt_env(&env2, maturity);
        let u_a = Address::generate(&env2);
        let u_b = Address::generate(&env2);
        yt2.mint(&u_a, &50_000_000_000);

        env2.ledger().set_timestamp(maturity + 50);
        blend2.set_b_rate(&1_150_000_000);
        yt2.transfer(&u_a, &u_b, &10_000_000_000);
        let stored_pin2: Option<i128> = env2.as_contract(&yt2.address, || {
            env2.storage().instance().get(&DataKey::MaturityIndex)
        });
        assert_eq!(stored_pin2, Some(1_150_000_000));

        // Even if rate rises later, settle_maturity returns the pinned 1.15 index
        blend2.set_b_rate(&1_400_000_000);
        assert_eq!(yt2.settle_maturity(&1_400_000_000), 1_150_000_000);
    }

    #[test]
    fn test_yt_initialize_from_factory_scoped_auth() {
        let env = Env::default();
        let deployer = Address::generate(&env);
        let admin = Address::generate(&env);
        let market = Address::generate(&env);
        let sy_id = Address::generate(&env);
        let yt_id = env.register(YieldToken, ());
        let yt = YieldTokenClient::new(&env, &yt_id);

        let args: Vec<Val> = (
            deployer.clone(),
            admin.clone(),
            market.clone(),
            sy_id.clone(),
            String::from_str(&env, "YT USDC 30D"),
            String::from_str(&env, "YT-USDC-30D"),
            7u32,
            100_000u64,
        )
            .into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &deployer,
            invoke: &MockAuthInvoke {
                contract: &yt_id,
                fn_name: "initialize_from_factory",
                args,
                sub_invokes: &[],
            },
        }]);
        yt.initialize_from_factory(
            &deployer,
            &admin,
            &market,
            &sy_id,
            &String::from_str(&env, "YT USDC 30D"),
            &String::from_str(&env, "YT-USDC-30D"),
            &7u32,
            &100_000u64,
        );
        assert_eq!(yt.get_admin(), admin);
        let stored_market: Option<Address> = env.as_contract(&yt_id, || {
            env.storage().instance().get(&DataKey::Market)
        });
        assert_eq!(stored_market, Some(market.clone()));

        env.mock_all_auths();
        assert_eq!(
            yt.try_initialize(
                &deployer,
                &market,
                &sy_id,
                &String::from_str(&env, "YT"),
                &String::from_str(&env, "YT"),
                &7u32,
                &100_000u64,
            ),
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }

    #[test]
    fn test_yt_monotonic_py_index_prevents_dip_recovery_phantom_yield() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1000);
        let maturity = 1000 + 30 * 86400;

        let (_admin, _market, blend_client, _sy_client, yt_client) = setup_yt_env(&env, maturity);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        // Start at b_rate = 1.20
        blend_client.set_b_rate(&1_200_000_000);
        assert_eq!(yt_client.get_py_index(), 1_200_000_000);

        let amt = 100_000_000_000i128;
        yt_client.mint(&alice, &amt);
        assert_eq!(yt_client.get_user_yield_state(&alice).last_index, 1_200_000_000);

        // b_rate dips to 1.00; Alice transfers 50% YT to Bob
        blend_client.set_b_rate(&1_000_000_000);
        assert_eq!(yt_client.get_py_index(), 1_200_000_000);
        yt_client.transfer(&alice, &bob, &(amt / 2));

        let st_alice = yt_client.get_user_yield_state(&alice);
        let st_bob = yt_client.get_user_yield_state(&bob);
        assert_eq!(st_alice.last_index, 1_200_000_000);
        assert_eq!(st_alice.unclaimed_yield, 0);
        assert_eq!(st_bob.last_index, 1_200_000_000);
        assert_eq!(st_bob.unclaimed_yield, 0);

        // b_rate recovers to 1.20 -> ZERO phantom yield!
        blend_client.set_b_rate(&1_200_000_000);
        assert_eq!(yt_client.get_total_unclaimed_yield(), 0);
        assert_eq!(yt_client.claim_user_yield(&alice), 0);
        assert_eq!(yt_client.claim_user_yield(&bob), 0);

        // Only when b_rate exceeds high-water mark (1.20 -> 1.32 = +10%) does genuine yield accrue
        blend_client.set_b_rate(&1_320_000_000);
        assert_eq!(yt_client.get_py_index(), 1_320_000_000);
        let c_alice = yt_client.claim_user_yield(&alice);
        let c_bob = yt_client.claim_user_yield(&bob);
        assert_eq!(c_alice, 5_000_000_000);
        assert_eq!(c_bob, 5_000_000_000);
    }
}

#![cfg(test)]
extern crate std;

use crate::{StandardizedYieldSlender, StandardizedYieldSlenderClient};
use common::errors::ContractError;
use common::fixed_point::SCALAR_9;
use mock_slender::{MockSlender, MockSlenderClient};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{token, Address, Env, IntoVal};

fn setup_test<'a>() -> (
    Env,
    Address,
    token::Client<'a>,
    token::StellarAssetClient<'a>,
    MockSlenderClient<'a>,
    StandardizedYieldSlenderClient<'a>,
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

    let sy_id = env.register(StandardizedYieldSlender, ());
    let sy_client = StandardizedYieldSlenderClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &slender_id, &slender_id);

    (
        env,
        admin,
        usdc_client,
        usdc_admin_client,
        slender_client,
        sy_client,
    )
}

#[test]
fn test_sy_slender_lifecycle() {
    let (env, _admin, usdc_client, usdc_admin_client, slender_client, sy_client) = setup_test();
    let user = Address::generate(&env);
    let deposit_amount = 1_000_000_000i128;

    usdc_admin_client.mint(&user, &deposit_amount);
    let shares = sy_client.deposit(&user, &user, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(sy_client.balance(&user), deposit_amount);
    assert_eq!(sy_client.total_shares(), deposit_amount);
    assert_eq!(usdc_client.balance(&user), 0);
    assert_eq!(sy_client.exchange_rate(), SCALAR_9);
    assert_eq!(sy_client.slender_pool(), slender_client.address);
    assert_eq!(sy_client.blend_pool(), slender_client.address);
    assert_eq!(sy_client.s_token(), slender_client.address);

    // Bump rate to 1.20 and fund pool interest
    slender_client.set_liquidity_index(&1_200_000_000);
    assert_eq!(sy_client.exchange_rate(), 1_200_000_000);
    usdc_admin_client.mint(&slender_client.address, &200_000_000);

    let payout = sy_client.redeem(&user, &user, &shares);
    assert_eq!(payout, 1_200_000_000);
    assert_eq!(sy_client.balance(&user), 0);
    assert_eq!(sy_client.total_shares(), 0);
    assert_eq!(usdc_client.balance(&user), 1_200_000_000);
}

#[test]
fn test_sy_slender_redeem_to_stoken_and_scoped_auth_deposit() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let receiver = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc.address());

    env.mock_all_auths();
    let slender_id = env.register(MockSlender, ());
    let slender_client = MockSlenderClient::new(&env, &slender_id);
    slender_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    let sy_id = env.register(StandardizedYieldSlender, ());
    let sy_client = StandardizedYieldSlenderClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &slender_id, &slender_id);

    let deposit_amount = 1_000_000_000i128;
    usdc_admin.mint(&user, &deposit_amount);

    // Clear mock_all_auths and prove scoped MockAuth works end-to-end with authorize_as_current_contract
    let sub_transfer = MockAuthInvoke {
        contract: &usdc.address(),
        fn_name: "transfer",
        args: (user.clone(), sy_id.clone(), deposit_amount).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &user,
        invoke: &MockAuthInvoke {
            contract: &sy_id,
            fn_name: "deposit",
            args: (user.clone(), user.clone(), deposit_amount).into_val(&env),
            sub_invokes: &[sub_transfer],
        },
    }]);

    let shares = sy_client.deposit(&user, &user, &deposit_amount);
    assert_eq!(shares, deposit_amount);
    assert_eq!(slender_client.balance(&sy_id), deposit_amount);

    env.mock_auths(&[MockAuth {
        address: &user,
        invoke: &MockAuthInvoke {
            contract: &sy_id,
            fn_name: "redeem_to_btoken",
            args: (user.clone(), receiver.clone(), shares).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let s_out = sy_client.redeem_to_btoken(&user, &receiver, &shares);
    assert_eq!(s_out, shares);
    assert_eq!(sy_client.balance(&user), 0);
    assert_eq!(slender_client.balance(&sy_id), 0);
    assert_eq!(slender_client.balance(&receiver), deposit_amount);
}

#[test]
fn test_sy_slender_admin_configurability_and_factory_init() {
    let (env, admin, _usdc_client, _usdc_admin, _slender_client, sy_client) = setup_test();
    let attacker = Address::generate(&env);
    let new_pool = Address::generate(&env);
    let new_stoken = Address::generate(&env);

    assert_eq!(
        sy_client.try_set_slender_pool(&attacker, &new_pool),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        sy_client.try_set_s_token(&attacker, &new_stoken),
        Err(Ok(ContractError::Unauthorized))
    );

    sy_client.set_slender_pool(&admin, &new_pool);
    sy_client.set_s_token(&admin, &new_stoken);
    assert_eq!(sy_client.slender_pool(), new_pool);
    assert_eq!(sy_client.blend_pool(), new_pool);
    assert_eq!(sy_client.s_token(), new_stoken);

    // Reject IdenticalAddresses for pool/s_token == underlying or self
    let underlying = sy_client.asset();
    assert_eq!(
        sy_client.try_set_slender_pool(&admin, &underlying),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        sy_client.try_set_s_token(&admin, &sy_client.address),
        Err(Ok(ContractError::IdenticalAddresses))
    );
}

mod metadata_and_factory_init_tests {
    use crate::{StandardizedYieldSlender, StandardizedYieldSlenderClient};
    use common::errors::ContractError;
    use common::fixed_point::SCALAR_9;
    use mock_slender::{MockSlender, MockSlenderClient};
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{
        contract, contractimpl, symbol_short, Address, Env, IntoVal, String, Symbol, Val, Vec,
    };

    const KEY_SYM: Symbol = symbol_short!("SYM");
    const KEY_DEC: Symbol = symbol_short!("DEC");

    #[contract]
    pub struct MockMetaToken;

    #[contractimpl]
    impl MockMetaToken {
        pub fn init(env: Env, sym: String, dec: u32) {
            env.storage().instance().set(&KEY_SYM, &sym);
            env.storage().instance().set(&KEY_DEC, &dec);
        }

        pub fn symbol(env: Env) -> String {
            env.storage()
                .instance()
                .get(&KEY_SYM)
                .unwrap_or_else(|| String::from_str(&env, "ASSET"))
        }

        pub fn decimals(env: Env) -> u32 {
            env.storage().instance().get(&KEY_DEC).unwrap_or(7)
        }
    }

    #[test]
    fn test_sy_slender_dynamic_metadata_variants() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let pool = Address::generate(&env);

        let usdc_id = env.register(MockMetaToken, ());
        MockMetaTokenClient::new(&env, &usdc_id).init(&String::from_str(&env, "USDC"), &7);
        let sy_usdc =
            StandardizedYieldSlenderClient::new(&env, &env.register(StandardizedYieldSlender, ()));
        sy_usdc.initialize(&admin, &usdc_id, &pool, &pool);
        assert_eq!(
            sy_usdc.name(),
            String::from_str(&env, "Standardized Yield Slender USDC")
        );
        assert_eq!(sy_usdc.symbol(), String::from_str(&env, "sy-sUSDC"));
        assert_eq!(sy_usdc.decimals(), 7);

        let eurc_id = env.register(MockMetaToken, ());
        MockMetaTokenClient::new(&env, &eurc_id).init(&String::from_str(&env, "EURC"), &6);
        let sy_eurc =
            StandardizedYieldSlenderClient::new(&env, &env.register(StandardizedYieldSlender, ()));
        sy_eurc.initialize(&admin, &eurc_id, &pool, &pool);
        assert_eq!(
            sy_eurc.name(),
            String::from_str(&env, "Standardized Yield Slender EURC")
        );
        assert_eq!(sy_eurc.symbol(), String::from_str(&env, "sy-sEURC"));
        assert_eq!(sy_eurc.decimals(), 6);
    }

    #[test]
    fn test_sy_slender_initialize_from_factory_scoped_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let deployer = Address::generate(&env);
        let asset = env.register(MockMetaToken, ());

        env.mock_all_auths();
        let slender_id = env.register(MockSlender, ());
        let slender = MockSlenderClient::new(&env, &slender_id);
        slender.initialize(&admin, &asset, &SCALAR_9);

        let sy_id = env.register(StandardizedYieldSlender, ());
        let sy = StandardizedYieldSlenderClient::new(&env, &sy_id);
        let args_ok: Vec<Val> =
            (deployer.clone(), admin.clone(), asset.clone(), slender_id.clone()).into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &deployer,
            invoke: &MockAuthInvoke {
                contract: &sy_id,
                fn_name: "initialize_from_factory",
                args: args_ok,
                sub_invokes: &[],
            },
        }]);
        sy.initialize_from_factory(&deployer, &admin, &asset, &slender_id);
        assert_eq!(sy.get_admin(), admin);
        assert_eq!(sy.asset(), asset);
        assert_eq!(sy.slender_pool(), slender_id);
        assert_eq!(sy.s_token(), slender_id);

        env.mock_all_auths();
        assert_eq!(
            sy.try_initialize(&deployer, &asset, &slender_id, &slender_id),
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }
}

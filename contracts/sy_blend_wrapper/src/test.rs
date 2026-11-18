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
        String::from_str(&env, "Standardized Yield Blend aaa")
    );
    assert_eq!(sy_client.symbol(), String::from_str(&env, "sy-baaa"));

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

mod r1_f1_f2_sy_tests {
    use crate::{StandardizedYield, StandardizedYieldClient};
    use common::errors::ContractError;
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

        pub fn name(env: Env) -> String {
            Self::symbol(env)
        }
    }

    #[test]
    fn test_sy_dynamic_metadata_variants() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let blend_pool = Address::generate(&env);

        // 1. USDC (7 decimals)
        let usdc_id = env.register(MockMetaToken, ());
        MockMetaTokenClient::new(&env, &usdc_id).init(&String::from_str(&env, "USDC"), &7);
        let sy_usdc = StandardizedYieldClient::new(&env, &env.register(StandardizedYield, ()));
        sy_usdc.initialize(&admin, &usdc_id, &blend_pool);
        assert_eq!(
            sy_usdc.name(),
            String::from_str(&env, "Standardized Yield Blend USDC")
        );
        assert_eq!(sy_usdc.symbol(), String::from_str(&env, "sy-bUSDC"));
        assert_eq!(sy_usdc.decimals(), 7);

        // 2. "native" SAC symbol -> mapped to "XLM"
        let xlm_id = env.register(MockMetaToken, ());
        MockMetaTokenClient::new(&env, &xlm_id).init(&String::from_str(&env, "native"), &7);
        let sy_xlm = StandardizedYieldClient::new(&env, &env.register(StandardizedYield, ()));
        sy_xlm.initialize(&admin, &xlm_id, &blend_pool);
        assert_eq!(
            sy_xlm.name(),
            String::from_str(&env, "Standardized Yield Blend XLM")
        );
        assert_eq!(sy_xlm.symbol(), String::from_str(&env, "sy-bXLM"));
        assert_eq!(sy_xlm.decimals(), 7);

        // 3. Custom symbol & decimals ("EURC", 6 decimals)
        let eurc_id = env.register(MockMetaToken, ());
        MockMetaTokenClient::new(&env, &eurc_id).init(&String::from_str(&env, "EURC"), &6);
        let sy_eurc = StandardizedYieldClient::new(&env, &env.register(StandardizedYield, ()));
        sy_eurc.initialize(&admin, &eurc_id, &blend_pool);
        assert_eq!(
            sy_eurc.name(),
            String::from_str(&env, "Standardized Yield Blend EURC")
        );
        assert_eq!(sy_eurc.symbol(), String::from_str(&env, "sy-bEURC"));
        assert_eq!(sy_eurc.decimals(), 6);

        // 4. Non-token address fallback -> "ASSET", 7 decimals
        let bogus_asset = Address::generate(&env);
        let sy_fallback = StandardizedYieldClient::new(&env, &env.register(StandardizedYield, ()));
        sy_fallback.initialize(&admin, &bogus_asset, &blend_pool);
        assert_eq!(
            sy_fallback.name(),
            String::from_str(&env, "Standardized Yield Blend ASSET")
        );
        assert_eq!(sy_fallback.symbol(), String::from_str(&env, "sy-bASSET"));
        assert_eq!(sy_fallback.decimals(), 7);
    }

    #[test]
    fn test_sy_identical_addresses_and_initialize_from_factory_scoped_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let deployer = Address::generate(&env);
        let asset = env.register(MockMetaToken, ());
        let blend_pool = Address::generate(&env);

        // Reject blend_pool == underlying_asset
        let sy_bad_id = env.register(StandardizedYield, ());
        let sy_bad = StandardizedYieldClient::new(&env, &sy_bad_id);
        let args_bad: Vec<Val> = (admin.clone(), asset.clone(), asset.clone()).into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &sy_bad_id,
                fn_name: "initialize",
                args: args_bad,
                sub_invokes: &[],
            },
        }]);
        assert_eq!(
            sy_bad.try_initialize(&admin, &asset, &asset),
            Err(Ok(ContractError::IdenticalAddresses))
        );

        // initialize_from_factory requires deployer auth ONLY (not admin), sets admin = admin
        let sy_id = env.register(StandardizedYield, ());
        let sy = StandardizedYieldClient::new(&env, &sy_id);
        let args_ok: Vec<Val> = (
            deployer.clone(),
            admin.clone(),
            asset.clone(),
            blend_pool.clone(),
        )
            .into_val(&env);
        env.mock_auths(&[MockAuth {
            address: &deployer,
            invoke: &MockAuthInvoke {
                contract: &sy_id,
                fn_name: "initialize_from_factory",
                args: args_ok,
                sub_invokes: &[],
            },
        }]);
        sy.initialize_from_factory(&deployer, &admin, &asset, &blend_pool);
        assert_eq!(sy.get_admin(), admin);
        assert_eq!(sy.asset(), asset);
        assert_eq!(sy.blend_pool(), blend_pool);

        // Re-init hijack attempt must fail with AlreadyInitialized
        env.mock_all_auths();
        assert_eq!(
            sy.try_initialize(&deployer, &asset, &blend_pool),
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }
}

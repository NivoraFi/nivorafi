#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use common::interfaces::{
    BlendPoolClient, MarketFactoryClient, PrivilegedTokenClient, SlenderPoolClient,
    StandardizedYieldClient, YieldMarketClient, YieldTokenClient,
};
use common::storage_keys::DataKey;
use soroban_sdk::testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{token, Address, BytesN, Env, IntoVal, String};
use sy_slender_wrapper::StandardizedYieldSlenderClient;

fn read_release_wasm(name: &str) -> std::vec::Vec<u8> {
    let base = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32v1-none/release/");
    let path = std::format!("{base}{name}");
    std::fs::read(&path).unwrap_or_else(|e| panic!("missing {path}: {e}"))
}

fn register_release_wasm(env: &Env, name: &str) -> Address {
    let bytes = read_release_wasm(name);
    env.register(bytes.as_slice(), ())
}

fn upload_release_wasm(env: &Env, name: &str) -> BytesN<32> {
    let bytes = read_release_wasm(name);
    env.deployer().upload_contract_wasm(bytes.as_slice())
}

fn assert_factory_zero_dust(env: &Env, factory: &Address, tokens: &[&Address]) {
    for tok in tokens {
        let bal = token::Client::new(env, tok).balance(factory);
        assert_eq!(bal, 0, "expected 0 factory dust on token {:?}", tok);
    }
}

fn assert_reserve_conservation(
    env: &Env,
    sy: &Address,
    pool: &Address,
    pool_client: &YieldMarketClient,
) {
    let state = pool_client.get_market_state();
    let (pt_principal, yt_yield) = pool_client.get_py_reserves();
    let sy_bal = token::Client::new(env, sy).balance(pool);
    assert!(
        sy_bal >= state.total_sy_reserve + pt_principal + yt_yield,
        "reserve conservation failed: bal={} < lp_sy={} + pt={} + yt={}",
        sy_bal,
        state.total_sy_reserve,
        pt_principal,
        yt_yield
    );
}

#[test]
fn test_zap_in_real_wasm_blend_usdc_scoped_auth_and_cpu_mem_budget() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_addr = usdc.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);
    let usdc_client = token::Client::new(&env, &usdc_addr);

    let pt_hash = upload_release_wasm(&env, "pt_token.wasm");
    let yt_hash = upload_release_wasm(&env, "yt_token.wasm");
    let pool_hash = upload_release_wasm(&env, "yield_pool.wasm");
    let sy_hash = upload_release_wasm(&env, "sy_blend_wrapper.wasm");

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);

    let blend_id = register_release_wasm(&env, "mock_blend.wasm");
    BlendPoolClient::new(&env, &blend_id).initialize(&admin, &usdc_addr, &SCALAR_9);

    let mat = t0 + 90 * 86_400;
    let anchor = WAD + WAD / 20; // 1.05 WAD (5% implied APY anchor)
    let meta = factory.create_market(&admin, &usdc_addr, &blend_id, &mat, &(20 * WAD), &anchor);
    let pool_client = YieldMarketClient::new(&env, &meta.pool);
    let sy_client = StandardizedYieldClient::new(&env, &meta.sy);
    let pt_client = PrivilegedTokenClient::new(&env, &meta.pt);
    let yt_client = YieldTokenClient::new(&env, &meta.yt);

    // Seed pool with 120B PT + 100B SY
    usdc_admin.mint(&lp, &220_000_000_000);
    sy_client.deposit(&lp, &lp, &220_000_000_000);
    pool_client.mint_py(&lp, &lp, &120_000_000_000, &mat);
    pool_client.add_liquidity(&lp, &lp, &120_000_000_000, &100_000_000_000, &1);

    let amt = 100_000_000i128;
    usdc_admin.mint(&u1, &(amt * 3));
    let dl = t0 + 60;

    // 1. zap_in_pt with STRICT scoped MockAuth (u1 signs ONLY zap_in_pt + usdc.transfer(u1 -> factory, amt))
    let sub_pt = MockAuthInvoke {
        contract: &usdc_addr,
        fn_name: "transfer",
        args: (u1.clone(), factory_id.clone(), amt).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &u1,
        invoke: &MockAuthInvoke {
            contract: &factory_id,
            fn_name: "zap_in_pt",
            args: (
                u1.clone(),
                u2.clone(),
                meta.pool.clone(),
                amt,
                1i128,
                dl,
            )
                .into_val(&env),
            sub_invokes: &[sub_pt],
        },
    }]);
    env.cost_estimate()
        .budget()
        .reset_unlimited();
    let pt_out = factory.zap_in_pt(&u1, &u2, &meta.pool, &amt, &1, &dl);
    let cpu_pt = env.cost_estimate().budget().cpu_instruction_cost();
    let mem_pt = env.cost_estimate().budget().memory_bytes_cost();
    std::eprintln!("REAL-WASM zap_in_pt: cpu={cpu_pt} mem={mem_pt}");
    assert!(cpu_pt < 100_000_000 && mem_pt < 41_943_040);
    assert!(pt_out >= amt);
    assert_eq!(pt_client.balance(&u2), pt_out);
    assert_factory_zero_dust(
        &env,
        &factory_id,
        &[&usdc_addr, &meta.sy, &meta.pt, &meta.yt, &meta.pool],
    );

    // 2. zap_in_yt with STRICT scoped MockAuth
    let sub_yt = MockAuthInvoke {
        contract: &usdc_addr,
        fn_name: "transfer",
        args: (u1.clone(), factory_id.clone(), amt).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &u1,
        invoke: &MockAuthInvoke {
            contract: &factory_id,
            fn_name: "zap_in_yt",
            args: (
                u1.clone(),
                u2.clone(),
                meta.pool.clone(),
                amt,
                1i128,
                dl,
            )
                .into_val(&env),
            sub_invokes: &[sub_yt],
        },
    }]);
    env.cost_estimate()
        .budget()
        .reset_unlimited();
    let yt_out = factory.zap_in_yt(&u1, &u2, &meta.pool, &amt, &1, &dl);
    let cpu_yt = env.cost_estimate().budget().cpu_instruction_cost();
    let mem_yt = env.cost_estimate().budget().memory_bytes_cost();
    std::eprintln!("REAL-WASM zap_in_yt: cpu={cpu_yt} mem={mem_yt}");
    assert!(cpu_yt < 100_000_000 && mem_yt < 41_943_040);
    assert!(yt_out > 0);
    assert_eq!(yt_client.balance(&u2), yt_out);
    assert_factory_zero_dust(
        &env,
        &factory_id,
        &[&usdc_addr, &meta.sy, &meta.pt, &meta.yt, &meta.pool],
    );

    // 3. zap_in_lp with STRICT scoped MockAuth (must NOT alter u2's PT or YT balances!)
    let sub_lp = MockAuthInvoke {
        contract: &usdc_addr,
        fn_name: "transfer",
        args: (u1.clone(), factory_id.clone(), amt).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &u1,
        invoke: &MockAuthInvoke {
            contract: &factory_id,
            fn_name: "zap_in_lp",
            args: (
                u1.clone(),
                u2.clone(),
                meta.pool.clone(),
                amt,
                1i128,
                dl,
            )
                .into_val(&env),
            sub_invokes: &[sub_lp],
        },
    }]);
    env.cost_estimate()
        .budget()
        .reset_unlimited();
    let (lp_out, residual_sy) = factory.zap_in_lp(&u1, &u2, &meta.pool, &amt, &1, &dl);
    let cpu_lp = env.cost_estimate().budget().cpu_instruction_cost();
    let mem_lp = env.cost_estimate().budget().memory_bytes_cost();
    std::eprintln!("REAL-WASM zap_in_lp: cpu={cpu_lp} mem={mem_lp}");
    assert!(cpu_lp < 100_000_000 && mem_lp < 41_943_040);
    assert!(lp_out > 0);
    assert!(residual_sy >= 0);
    assert_eq!(pt_client.balance(&u2), pt_out);
    assert_eq!(yt_client.balance(&u2), yt_out);
    assert_eq!(token::Client::new(&env, &meta.pool).balance(&u2), lp_out);
    assert_eq!(sy_client.balance(&u2), residual_sy);
    assert_eq!(usdc_client.balance(&u1), 0);
    assert_factory_zero_dust(
        &env,
        &factory_id,
        &[&usdc_addr, &meta.sy, &meta.pt, &meta.yt, &meta.pool],
    );
    assert_reserve_conservation(&env, &meta.sy, &meta.pool, &pool_client);
}

#[test]
fn test_zap_in_real_wasm_native_xlm_sac_and_preseeded_5_token_dust() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let u1 = Address::generate(&env);
    let u2 = Address::generate(&env);

    // Native XLM SAC (registered SAC contract)
    let xlm_admin_addr = Address::generate(&env);
    let xlm = env.register_stellar_asset_contract_v2(xlm_admin_addr);
    let xlm_addr = xlm.address();
    let xlm_admin = token::StellarAssetClient::new(&env, &xlm_addr);
    let xlm_client = token::Client::new(&env, &xlm_addr);

    let pt_hash = upload_release_wasm(&env, "pt_token.wasm");
    let yt_hash = upload_release_wasm(&env, "yt_token.wasm");
    let pool_hash = upload_release_wasm(&env, "yield_pool.wasm");
    let sy_hash = upload_release_wasm(&env, "sy_blend_wrapper.wasm");

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);

    let blend_id = register_release_wasm(&env, "mock_blend.wasm");
    BlendPoolClient::new(&env, &blend_id).initialize(&admin, &xlm_addr, &SCALAR_9);

    let mat = t0 + 90 * 86_400;
    let meta = factory.create_market(&admin, &xlm_addr, &blend_id, &mat, &(20 * WAD), &WAD);
    let pool_client = YieldMarketClient::new(&env, &meta.pool);
    let sy_client = StandardizedYieldClient::new(&env, &meta.sy);
    let pt_client = PrivilegedTokenClient::new(&env, &meta.pt);
    let yt_client = YieldTokenClient::new(&env, &meta.yt);
    let lp_client = token::Client::new(&env, &meta.pool);

    // Seed pool 120B PT / 100B SY
    xlm_admin.mint(&lp, &220_000_000_000);
    sy_client.deposit(&lp, &lp, &220_000_000_000);
    pool_client.mint_py(&lp, &lp, &120_000_000_000, &mat);
    pool_client.add_liquidity(&lp, &lp, &120_000_000_000, &100_000_000_000, &1);

    // Pre-seed dust across ALL 5 tokens directly onto factory
    let dust_collector = Address::generate(&env);
    xlm_admin.mint(&dust_collector, &10_000);
    xlm_client.transfer(&dust_collector, &factory_id, &100);
    sy_client.deposit(&dust_collector, &factory_id, &200);
    xlm_admin.mint(&lp, &10_000);
    sy_client.deposit(&lp, &lp, &10_000);
    pool_client.mint_py(&lp, &factory_id, &300, &mat);
    pool_client.mint_py(&lp, &lp, &2_000, &mat);
    pool_client.add_liquidity(&lp, &factory_id, &2_000, &2_000, &1);

    assert!(xlm_client.balance(&factory_id) > 0);
    assert!(sy_client.balance(&factory_id) > 0);
    assert!(pt_client.balance(&factory_id) > 0);
    assert!(yt_client.balance(&factory_id) > 0);
    assert!(lp_client.balance(&factory_id) > 0);

    // Execute zap_in_pt -> sweeps all 5 pre-seeded dust balances cleanly to u2
    let amt = 100_000_000i128;
    let dl = t0 + 60;
    xlm_admin.mint(&u1, &(amt * 3));

    let pt_out = factory.zap_in_pt(&u1, &u2, &meta.pool, &amt, &1, &dl);
    assert!(pt_out > 0);
    assert_factory_zero_dust(
        &env,
        &factory_id,
        &[&xlm_addr, &meta.sy, &meta.pt, &meta.yt, &meta.pool],
    );

    let pt_u2_after_pt = pt_client.balance(&u2);
    let yt_u2_after_pt = yt_client.balance(&u2);
    let lp_u2_after_pt = lp_client.balance(&u2);

    // Pre-seed dust again right before zap_in_lp to prove 5-token sweep on zap_in_lp too
    xlm_admin.mint(&dust_collector, &500);
    xlm_client.transfer(&dust_collector, &factory_id, &50);
    let (lp_out, _res_sy) = factory.zap_in_lp(&u1, &u2, &meta.pool, &amt, &1, &dl);
    assert!(lp_out > 0);
    assert_eq!(pt_client.balance(&u2), pt_u2_after_pt);
    assert_eq!(yt_client.balance(&u2), yt_u2_after_pt);
    assert_eq!(lp_client.balance(&u2), lp_u2_after_pt + lp_out);
    assert_factory_zero_dust(
        &env,
        &factory_id,
        &[&xlm_addr, &meta.sy, &meta.pt, &meta.yt, &meta.pool],
    );
}

#[test]
fn test_zap_in_real_wasm_slender_susdc_at_rate_1_0_and_1_25() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let u1 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_addr = usdc.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);

    let slender_id = register_release_wasm(&env, "mock_slender.wasm");
    let slender = SlenderPoolClient::new(&env, &slender_id);
    slender.initialize(&admin, &usdc_addr, &SCALAR_9);

    let sy_slender_id = register_release_wasm(&env, "sy_slender_wrapper.wasm");
    StandardizedYieldSlenderClient::new(&env, &sy_slender_id).initialize(
        &admin,
        &usdc_addr,
        &slender_id,
        &slender_id,
    );
    let sy_slender = StandardizedYieldClient::new(&env, &sy_slender_id);

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(
        &admin,
        &guardian,
        &BytesN::from_array(&env, &[1u8; 32]),
        &BytesN::from_array(&env, &[2u8; 32]),
        &BytesN::from_array(&env, &[3u8; 32]),
        &BytesN::from_array(&env, &[4u8; 32]),
    );

    let mat = t0 + 90 * 86_400;
    let pool_id = register_release_wasm(&env, "yield_pool.wasm");
    let pt_id = register_release_wasm(&env, "pt_token.wasm");
    let yt_id = register_release_wasm(&env, "yt_token.wasm");

    PrivilegedTokenClient::new(&env, &pt_id).initialize(
        &admin,
        &pool_id,
        &String::from_str(&env, "PT sUSDC 90D"),
        &String::from_str(&env, "PT-sUSDC-90D"),
        &7,
        &mat,
    );
    YieldTokenClient::new(&env, &yt_id).initialize(
        &admin,
        &pool_id,
        &sy_slender_id,
        &String::from_str(&env, "YT sUSDC 90D"),
        &String::from_str(&env, "YT-sUSDC-90D"),
        &7,
        &mat,
    );
    let pool_client = YieldMarketClient::new(&env, &pool_id);
    pool_client.initialize(
        &admin,
        &sy_slender_id,
        &pt_id,
        &yt_id,
        &mat,
        &(20 * WAD),
        &WAD,
    );
    factory.register_market(
        &admin,
        &pool_id,
        &sy_slender_id,
        &pt_id,
        &yt_id,
        &usdc_addr,
        &mat,
        &(20 * WAD),
        &WAD,
    );

    // Seed pool 120B PT / 100B SY
    usdc_admin.mint(&lp, &220_000_000_000);
    sy_slender.deposit(&lp, &lp, &220_000_000_000);
    pool_client.mint_py(&lp, &lp, &120_000_000_000, &mat);
    pool_client.add_liquidity(&lp, &lp, &120_000_000_000, &100_000_000_000, &1);

    let dl = t0 + 120;
    let amt = 100_000_000i128;

    // Rate = 1.0
    usdc_admin.mint(&u1, &(amt * 3));
    let pt1 = factory.zap_in_pt(&u1, &u1, &pool_id, &amt, &1, &dl);
    let yt1 = factory.zap_in_yt(&u1, &u1, &pool_id, &amt, &1, &dl);
    let (lp1, res1) = factory.zap_in_lp(&u1, &u1, &pool_id, &amt, &1, &dl);
    assert!(pt1 > 0 && yt1 > 0 && lp1 > 0 && res1 >= 0);
    assert_eq!(PrivilegedTokenClient::new(&env, &pt_id).balance(&u1), pt1);
    assert_eq!(YieldTokenClient::new(&env, &yt_id).balance(&u1), yt1);
    assert_factory_zero_dust(&env, &factory_id, &[&usdc_addr, &sy_slender_id, &pt_id, &yt_id, &pool_id]);
    assert_reserve_conservation(&env, &sy_slender_id, &pool_id, &pool_client);

    // Rate = 1.25 (py_index = 1.25e9 -> 1 SY = 1.25 USDC -> tests PyIndex-aware LP split!)
    slender.set_liquidity_index(&1_250_000_000);
    let shares_before = sy_slender.total_shares();
    let amt_2 = 125_000_000i128; // 125 USDC = 100_000_000 sy-sUSDC shares at 1.25
    usdc_admin.mint(&u1, &(amt_2 * 3));

    let pt2 = factory.zap_in_pt(&u1, &u1, &pool_id, &amt_2, &1, &dl);
    let yt2 = factory.zap_in_yt(&u1, &u1, &pool_id, &amt_2, &1, &dl);

    // Scoped auth + budget measurement for zap_in_lp at 1.25 rate
    let sub_lp = MockAuthInvoke {
        contract: &usdc_addr,
        fn_name: "transfer",
        args: (u1.clone(), factory_id.clone(), amt_2).into_val(&env),
        sub_invokes: &[],
    };
    env.mock_auths(&[MockAuth {
        address: &u1,
        invoke: &MockAuthInvoke {
            contract: &factory_id,
            fn_name: "zap_in_lp",
            args: (
                u1.clone(),
                u1.clone(),
                pool_id.clone(),
                amt_2,
                1i128,
                dl,
            )
                .into_val(&env),
            sub_invokes: &[sub_lp],
        },
    }]);
    env.cost_estimate()
        .budget()
        .reset_unlimited();
    let (lp2, res2) = factory.zap_in_lp(&u1, &u1, &pool_id, &amt_2, &1, &dl);
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
    std::eprintln!("REAL-WASM Slender zap_in_lp @1.25: cpu={cpu} mem={mem} lp2={lp2} res2={res2}");
    assert!(cpu < 100_000_000 && mem < 41_943_040);
    assert!(pt2 > 0 && yt2 > 0 && lp2 > 0 && res2 >= 0);

    // Confirm zap_in_lp added ZERO PT and ZERO YT to u1!
    assert_eq!(PrivilegedTokenClient::new(&env, &pt_id).balance(&u1), pt1 + pt2);
    assert_eq!(YieldTokenClient::new(&env, &yt_id).balance(&u1), yt1 + yt2);
    assert_eq!(sy_slender.total_shares() - shares_before, 300_000_000);
    assert_factory_zero_dust(&env, &factory_id, &[&usdc_addr, &sy_slender_id, &pt_id, &yt_id, &pool_id]);
    assert_reserve_conservation(&env, &sy_slender_id, &pool_id, &pool_client);
}

#[test]
fn test_zap_in_lp_skewed_pools_large_zap_and_empty_pool_zero_residual_pt() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let u1 = Address::generate(&env);
    let receiver = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_addr = usdc.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);

    let pt_hash = upload_release_wasm(&env, "pt_token.wasm");
    let yt_hash = upload_release_wasm(&env, "yt_token.wasm");
    let pool_hash = upload_release_wasm(&env, "yield_pool.wasm");
    let sy_hash = upload_release_wasm(&env, "sy_blend_wrapper.wasm");

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);

    let blend_id = register_release_wasm(&env, "mock_blend.wasm");
    let blend = BlendPoolClient::new(&env, &blend_id);
    blend.initialize(&admin, &usdc_addr, &SCALAR_9);

    let mat_empty = t0 + 30 * 86_400;
    let mat_skew_80 = t0 + 60 * 86_400;
    let mat_skew_90 = t0 + 90 * 86_400;
    let dl = t0 + 60;

    // 1. Empty pool zap_in_lp (total_lp == 0)
    let m_empty =
        factory.create_market(&admin, &usdc_addr, &blend_id, &mat_empty, &(20 * WAD), &WAD);
    usdc_admin.mint(&u1, &10_000_000);
    let (lp_e, res_e) = factory.zap_in_lp(&u1, &receiver, &m_empty.pool, &10_000_000, &0, &dl);
    assert!(lp_e > 0 && res_e == 0);
    assert_eq!(PrivilegedTokenClient::new(&env, &m_empty.pt).balance(&receiver), 0);
    assert_eq!(YieldTokenClient::new(&env, &m_empty.yt).balance(&receiver), 5_000_000);
    assert_factory_zero_dust(&env, &factory_id, &[&usdc_addr, &m_empty.sy, &m_empty.pt, &m_empty.yt, &m_empty.pool]);

    // 2. Skewed 80:20 pool (800B PT : 200B SY) with large zap (50B)
    let m_80 =
        factory.create_market(&admin, &usdc_addr, &blend_id, &mat_skew_80, &(20 * WAD), &WAD);
    let sy_c = StandardizedYieldClient::new(&env, &m_80.sy);
    let pool_80 = YieldMarketClient::new(&env, &m_80.pool);
    usdc_admin.mint(&lp, &1_000_000_000_000);
    sy_c.deposit(&lp, &lp, &1_000_000_000_000);
    pool_80.mint_py(&lp, &lp, &800_000_000_000, &mat_skew_80);
    pool_80.add_liquidity(&lp, &lp, &800_000_000_000, &200_000_000_000, &1);

    let zap_large = 50_000_000_000i128;
    usdc_admin.mint(&u1, &zap_large);
    let (lp_80, res_80) = factory.zap_in_lp(&u1, &receiver, &m_80.pool, &zap_large, &1, &dl);
    assert!(lp_80 > 0 && res_80 >= 0);
    // CRITICAL: 0 PT and 0 YT transferred to receiver!
    assert_eq!(PrivilegedTokenClient::new(&env, &m_80.pt).balance(&receiver), 0);
    assert_eq!(YieldTokenClient::new(&env, &m_80.yt).balance(&receiver), 0);
    assert_factory_zero_dust(&env, &factory_id, &[&usdc_addr, &m_80.sy, &m_80.pt, &m_80.yt, &m_80.pool]);

    // 3. Skewed 90:10 pool (900B PT : 100B SY) at b_rate = 1.25
    let m_90 =
        factory.create_market(&admin, &usdc_addr, &blend_id, &mat_skew_90, &(20 * WAD), &WAD);
    let pool_90 = YieldMarketClient::new(&env, &m_90.pool);
    usdc_admin.mint(&lp, &1_000_000_000_000);
    sy_c.deposit(&lp, &lp, &1_000_000_000_000);
    pool_90.mint_py(&lp, &lp, &900_000_000_000, &mat_skew_90);
    pool_90.add_liquidity(&lp, &lp, &900_000_000_000, &100_000_000_000, &1);

    blend.set_b_rate(&1_250_000_000);
    let zap_90 = 25_000_000_000i128;
    usdc_admin.mint(&u1, &zap_90);
    let (lp_90, res_90) = factory.zap_in_lp(&u1, &receiver, &m_90.pool, &zap_90, &1, &dl);
    assert!(lp_90 > 0 && res_90 >= 0);
    assert_eq!(PrivilegedTokenClient::new(&env, &m_90.pt).balance(&receiver), 0);
    assert_eq!(YieldTokenClient::new(&env, &m_90.yt).balance(&receiver), 0);
    assert_factory_zero_dust(&env, &factory_id, &[&usdc_addr, &m_90.sy, &m_90.pt, &m_90.yt, &m_90.pool]);
}

#[test]
fn test_zap_in_min_out_zero_and_auth_none_and_reentrancy_real_wasm() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let u1 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_addr = usdc.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);

    let pt_hash = upload_release_wasm(&env, "pt_token.wasm");
    let yt_hash = upload_release_wasm(&env, "yt_token.wasm");
    let pool_hash = upload_release_wasm(&env, "yield_pool.wasm");
    let sy_hash = upload_release_wasm(&env, "sy_blend_wrapper.wasm");

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);

    let blend_id = register_release_wasm(&env, "mock_blend.wasm");
    BlendPoolClient::new(&env, &blend_id).initialize(&admin, &usdc_addr, &SCALAR_9);

    let mat = t0 + 90 * 86_400;
    let anchor = WAD + WAD / 20; // 1.05 WAD (5% implied APY anchor)
    let meta = factory.create_market(&admin, &usdc_addr, &blend_id, &mat, &(20 * WAD), &anchor);
    let pool_client = YieldMarketClient::new(&env, &meta.pool);
    let sy_client = StandardizedYieldClient::new(&env, &meta.sy);

    usdc_admin.mint(&lp, &220_000_000_000);
    sy_client.deposit(&lp, &lp, &220_000_000_000);
    pool_client.mint_py(&lp, &lp, &120_000_000_000, &mat);
    pool_client.add_liquidity(&lp, &lp, &120_000_000_000, &100_000_000_000, &1);

    let amt = 50_000_000i128;
    let dl = t0 + 60;
    usdc_admin.mint(&u1, &(amt * 3));

    // min_out = 0 MUST succeed for all 3 entrypoints
    assert!(factory.zap_in_pt(&u1, &u1, &meta.pool, &amt, &0, &dl) > 0);
    assert!(factory.zap_in_yt(&u1, &u1, &meta.pool, &amt, &0, &dl) > 0);
    let (lp_out, _) = factory.zap_in_lp(&u1, &u1, &meta.pool, &amt, &0, &dl);
    assert!(lp_out > 0);

    // auth = none MUST fail
    usdc_admin.mint(&u1, &amt);
    env.set_auths(&[]);
    assert!(factory
        .try_zap_in_pt(&u1, &u1, &meta.pool, &amt, &0, &dl)
        .is_err());

    // Reentrancy guard active in temporary storage -> #17 ReentrancyLocked
    env.mock_all_auths();
    env.as_contract(&factory_id, || {
        env.storage()
            .temporary()
            .set(&DataKey::FlashLoanGuard, &true);
    });
    assert_eq!(
        factory.try_zap_in_lp(&u1, &u1, &meta.pool, &amt, &0, &dl),
        Err(Ok(ContractError::ReentrancyLocked))
    );
    env.as_contract(&factory_id, || {
        env.storage().temporary().remove(&DataKey::FlashLoanGuard);
    });
}

#[test]
fn test_tier5_real_wasm_bugs_a1_to_a5_remediation() {
    let env = Env::default();
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    let t0 = 1_700_000_000u64;
    env.ledger().set_timestamp(t0);

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let lp = Address::generate(&env);
    let attacker = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_addr = usdc.address();
    let usdc_admin = token::StellarAssetClient::new(&env, &usdc_addr);

    let pt_hash = upload_release_wasm(&env, "pt_token.wasm");
    let yt_hash = upload_release_wasm(&env, "yt_token.wasm");
    let pool_hash = upload_release_wasm(&env, "yield_pool.wasm");
    let sy_hash = upload_release_wasm(&env, "sy_blend_wrapper.wasm");

    let factory_id = register_release_wasm(&env, "market_factory.wasm");
    let factory = MarketFactoryClient::new(&env, &factory_id);
    factory.initialize(&admin, &guardian, &pt_hash, &yt_hash, &pool_hash, &sy_hash);

    let blend_id = register_release_wasm(&env, "mock_blend.wasm");
    let blend = BlendPoolClient::new(&env, &blend_id);
    blend.initialize(&admin, &usdc_addr, &SCALAR_9);

    let mat = t0 + 90 * 86_400;
    let meta = factory.create_market(&admin, &usdc_addr, &blend_id, &mat, &(20 * WAD), &WAD);
    let pool = YieldMarketClient::new(&env, &meta.pool);
    let sy = StandardizedYieldClient::new(&env, &meta.sy);
    let yt = YieldTokenClient::new(&env, &meta.yt);
    let pt = PrivilegedTokenClient::new(&env, &meta.pt);

    usdc_admin.mint(&lp, &220_000_000_000);
    sy.deposit(&lp, &lp, &220_000_000_000);
    pool.mint_py(&lp, &lp, &120_000_000_000, &mat);
    pool.add_liquidity(&lp, &lp, &120_000_000_000, &100_000_000_000, &1);

    // Bug A1 (real WASM): 10 SY -> YT, then 1-stroop YT->SY drain must reject and never exceed 1 SY
    usdc_admin.mint(&attacker, &1_000);
    sy.deposit(&attacker, &attacker, &1_000);
    let (yt_bought, _) = pool.swap_exact_sy_for_yt(&attacker, &attacker, &10, &0, &mat);
    assert!(yt_bought > 0);
    let yt_before = yt.balance(&attacker);
    let mut sy_extracted = 0i128;
    for _ in 0..20 {
        let r = pool.try_swap_exact_yt_for_sy(&attacker, &attacker, &1, &0, &mat);
        if let Ok(Ok((out, _))) = r {
            assert!(out > 0);
            sy_extracted += out;
        }
    }
    assert!(sy_extracted <= 1);
    assert_eq!(yt.balance(&attacker), yt_before);

    // Bug A2 (real WASM): imbalanced add_liquidity yielding 0 LP rejects #4 ZeroAmount without taking tokens
    pool.mint_py(&attacker, &attacker, &500, &mat);
    let pt_before = pt.balance(&attacker);
    let sy_before = sy.balance(&attacker);
    assert_eq!(
        pool.try_add_liquidity(&attacker, &attacker, &1, &500, &0),
        Err(Ok(soroban_sdk::Error::from_contract_error(
            ContractError::ZeroAmount as u32
        )))
    );
    assert_eq!(pt.balance(&attacker), pt_before);
    assert_eq!(sy.balance(&attacker), sy_before);

    // Bug A3 (real WASM): zap_in_* with receiver == factory rejects #15 IdenticalAddresses
    usdc_admin.mint(&attacker, &1_000_000_000);
    assert_eq!(
        factory.try_zap_in_pt(&attacker, &factory_id, &meta.pool, &1_000_000_000, &0, &mat),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        factory.try_zap_in_yt(&attacker, &factory_id, &meta.pool, &1_000_000_000, &0, &mat),
        Err(Ok(ContractError::IdenticalAddresses))
    );
    assert_eq!(
        factory.try_zap_in_lp(&attacker, &factory_id, &meta.pool, &1_000_000_000, &0, &mat),
        Err(Ok(ContractError::IdenticalAddresses))
    );

    // Bug A4 (real WASM): 1-stroop remove_liquidity with sy_out=0 succeeds cleanly
    let (rem_pt, rem_sy) = pool.remove_liquidity(&lp, &lp, &1, &0, &0);
    assert_eq!(rem_pt, 1);
    assert_eq!(rem_sy, 0);

    // Bug A5 (real WASM): claim_yield when available_py_sy == 0 reverts #5 InsufficientBalance and preserves unclaimed_yield
    let mat2 = t0 + 60 * 86_400;
    let meta2 = factory.create_market(&admin, &usdc_addr, &blend_id, &mat2, &(20 * WAD), &WAD);
    let pool2 = YieldMarketClient::new(&env, &meta2.pool);
    let sy2 = StandardizedYieldClient::new(&env, &meta2.sy);
    let yt2 = YieldTokenClient::new(&env, &meta2.yt);

    let u1 = Address::generate(&env);
    usdc_admin.mint(&u1, &10_000_000_000);
    sy2.deposit(&u1, &u1, &10_000_000_000);
    pool2.mint_py(&u1, &u1, &10_000_000_000, &mat2);
    blend.set_b_rate(&1_200_000_000);
    yt2.transfer(&u1, &u1, &1);
    let unclaimed_before = yt2.get_user_yield_state(&u1).unclaimed_yield;
    assert!(unclaimed_before > 0);
    sy2.burn(&meta2.pool, &10_000_000_000);
    assert_eq!(
        pool2.try_claim_yield(&u1, &u1),
        Err(Ok(soroban_sdk::Error::from_contract_error(
            ContractError::InsufficientBalance as u32
        )))
    );
    assert_eq!(yt2.get_user_yield_state(&u1).unclaimed_yield, unclaimed_before);
    assert_reserve_conservation(&env, &meta.sy, &meta.pool, &pool);
}

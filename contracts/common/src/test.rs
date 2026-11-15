#![cfg(test)]
extern crate std;

use crate::errors::ContractError;
use crate::fixed_point::{div_256_64, wad_div, wad_mul, WAD};
use crate::reentrancy::with_non_reentrant;
use crate::storage_keys::DataKey;
use crate::transcendental::{exp_wad, ln_wad, LN_2, MAX_EXP_INPUT};
use crate::ttl::{
    calculate_bump_threshold, calculate_bump_to, DEFAULT_BUMP_TO, MAX_NETWORK_TTL,
    MIN_BUMP_THRESHOLD,
};
use crate::yield_math::{
    calculate_fee_rate, calculate_haircut, calculate_tau_wad, get_exchange_rate,
    swap_exact_pt_for_sy_math, swap_exact_sy_for_pt_math, MAX_FEE_RATE, MIN_FEE_RATE,
};
use soroban_sdk::{contract, contractimpl, testutils::Address as _, Address, BytesN, Env};

#[contract]
struct MockReentrancyContract;

#[contractimpl]
impl MockReentrancyContract {
    pub fn test_normal(env: Env) -> Result<i32, ContractError> {
        with_non_reentrant(&env, || Ok(42))
    }

    pub fn test_nested(env: Env) -> Result<i32, ContractError> {
        with_non_reentrant(&env, || with_non_reentrant(&env, || Ok(100)))
    }
}

#[test]
fn test_fixed_point_basic() {
    let a = 1_000 * WAD;
    let b = 10 * WAD;
    assert_eq!(wad_div(a, b).unwrap(), 100 * WAD);
    assert_eq!(wad_mul(a, b).unwrap(), 10_000 * WAD);

    // Div by zero
    assert_eq!(wad_div(a, 0), Err(ContractError::DivisionByZero));

    // Zero mul
    assert_eq!(wad_mul(0, b).unwrap(), 0);
    assert_eq!(wad_mul(a, 0).unwrap(), 0);

    // Negative numbers
    assert_eq!(wad_mul(-a, b).unwrap(), -10_000 * WAD);
    assert_eq!(wad_div(-a, b).unwrap(), -100 * WAD);
    assert_eq!(wad_mul(-a, -b).unwrap(), 10_000 * WAD);
    assert_eq!(wad_div(-a, -b).unwrap(), 100 * WAD);
}

#[test]
fn test_div_256_64_edge_cases() {
    assert_eq!(div_256_64(0, 100, 0), Err(ContractError::DivisionByZero));
    assert_eq!(div_256_64(10, 0, 5), Err(ContractError::MathOverflow));
    let (q, rem) = div_256_64(0, 100, 10).unwrap();
    assert_eq!(q, 10);
    assert_eq!(rem, 0);
}

#[test]
fn test_transcendental_ln_and_exp() {
    // ln(WAD) == 0
    assert_eq!(ln_wad(WAD).unwrap(), 0);

    // ln(2 WAD) ~ LN_2
    let ln_2 = ln_wad(2 * WAD).unwrap();
    let diff = (ln_2 - LN_2).abs();
    assert!(diff < 1_000_000, "ln(2) difference too large: {}", diff);

    // ln(0) or negative errors
    assert_eq!(ln_wad(0), Err(ContractError::NegativeLogarithmInput));
    assert_eq!(ln_wad(-1), Err(ContractError::NegativeLogarithmInput));

    // exp(0) == WAD
    assert_eq!(exp_wad(0).unwrap(), WAD);

    // exp(1 WAD) ~ e
    let exp_1 = exp_wad(WAD).unwrap();
    // 2.718281828... * 10^18
    let expected_e = 2_718_281_828_459_045_235i128;
    let diff_e = (exp_1 - expected_e).abs();
    assert!(
        diff_e < 100_000_000_000,
        "exp(1) diff too large: {}",
        diff_e
    );

    // exp ceiling: 46.44 WAD accepts, 46.44 WAD + 1 rejects
    assert!(exp_wad(MAX_EXP_INPUT).is_ok());
    assert_eq!(
        exp_wad(MAX_EXP_INPUT + 1000),
        Err(ContractError::MathOverflow)
    );

    // Negative large returns 0
    assert_eq!(exp_wad(-50 * WAD).unwrap(), 0);
}

#[test]
fn test_yield_math_exchange_rate() {
    let pt = 1_000_000 * WAD;
    let sy = 1_000_000 * WAD;
    let scalar_root = 20 * WAD;
    let rate_anchor = WAD;
    let tau_wad = calculate_tau_wad(0, 180 * 86400);

    // Balanced pool
    let e = get_exchange_rate(pt, sy, tau_wad, scalar_root, rate_anchor).unwrap();
    assert_eq!(e, WAD);

    // At tau = 0
    let e_mat = get_exchange_rate(pt, sy, 0, scalar_root, rate_anchor).unwrap();
    assert_eq!(e_mat, WAD);

    // Rate cannot be negative yield
    let low_pt = 10_000 * WAD;
    let high_sy = 1_000_000 * WAD;
    let res = get_exchange_rate(low_pt, high_sy, tau_wad, scalar_root, rate_anchor);
    assert!(matches!(res, Err(ContractError::NegativeYieldNotSupported)));
}

#[test]
fn test_dynamic_fee_and_haircut() {
    let annual_rate = 50_000_000_000_000_000i128; // 5%
    let fee_0 = calculate_fee_rate(0, annual_rate);
    assert_eq!(fee_0, MIN_FEE_RATE);

    let tau_1y = WAD;
    let fee_1y = calculate_fee_rate(tau_1y, annual_rate);
    assert_eq!(fee_1y, MAX_FEE_RATE); // 5% capped at 100 bps = 1%

    let haircut_full = calculate_haircut(1_000_000 * WAD, 1_000_000 * WAD).unwrap();
    assert_eq!(haircut_full, WAD);

    let haircut_bad_debt = calculate_haircut(900_000 * WAD, 1_000_000 * WAD).unwrap();
    assert_eq!(haircut_bad_debt, 900_000_000_000_000_000);
}

#[test]
fn test_swap_math() {
    let pt_res = 1_200_000 * WAD;
    let sy_res = 1_000_000 * WAD;
    let tau = calculate_tau_wad(0, 90 * 86400);
    let scalar_root = 20 * WAD;
    let anchor = WAD;
    let fee = 3_000_000_000_000i128; // 30 bps

    let pt_in = 10_000 * WAD;
    let swap_res =
        swap_exact_pt_for_sy_math(pt_in, pt_res, sy_res, tau, scalar_root, anchor, fee).unwrap();
    assert!(swap_res.amount_out > 0);
    assert!(swap_res.amount_out < pt_in);
    assert_eq!(swap_res.new_pt_reserve, pt_res + pt_in);

    let sy_in = 10_000 * WAD;
    let swap_res2 =
        swap_exact_sy_for_pt_math(sy_in, pt_res, sy_res, tau, scalar_root, anchor, fee).unwrap();
    assert!(swap_res2.amount_out > 0);
    assert_eq!(swap_res2.new_sy_reserve, sy_res + sy_in);
}

#[test]
fn test_ttl_calculations() {
    let now = 1_000_000_000u64;
    let mat_past = now - 100;
    assert_eq!(calculate_bump_to(now, mat_past), DEFAULT_BUMP_TO);

    let mat_180d = now + 180 * 86400;
    let bump_180 = calculate_bump_to(now, mat_180d);
    assert_eq!(bump_180, MAX_NETWORK_TTL);

    let threshold = calculate_bump_threshold(bump_180);
    assert!(threshold >= MIN_BUMP_THRESHOLD);
}

#[test]
fn test_reentrancy_wrapper() {
    let env = Env::default();
    let contract_id = env.register(MockReentrancyContract, ());
    let client = MockReentrancyContractClient::new(&env, &contract_id);

    // Normal execution
    let res = client.test_normal();
    assert_eq!(res, 42);
    env.as_contract(&contract_id, || {
        assert!(!env.storage().temporary().has(&DataKey::FlashLoanGuard));
    });

    // Nested execution fails
    let nested_res = client.try_test_nested();
    assert!(nested_res.is_err());
    env.as_contract(&contract_id, || {
        assert!(!env.storage().temporary().has(&DataKey::FlashLoanGuard));
    });
}

#[test]
fn test_swap_exact_sy_for_pt_math_negative_yield_rejection() {
    let pt_res = 1_005_000 * WAD;
    let sy_res = 1_000_000 * WAD;
    let tau = calculate_tau_wad(0, 90 * 86400);
    let scalar_root = 20 * WAD;
    let anchor = WAD;
    let fee = 3_000_000_000_000i128; // 30 bps

    // Swapping 3,000 WAD SY in a pool with difference of 5,000 WAD
    // drives new_pt < new_sy, breaching negative yield floor
    let res = swap_exact_sy_for_pt_math(3_000 * WAD, pt_res, sy_res, tau, scalar_root, anchor, fee);
    assert!(matches!(res, Err(ContractError::NegativeYieldNotSupported)));
}

#[contract]
struct MockGovernanceContract;

#[contractimpl]
impl MockGovernanceContract {
    pub fn initialize(env: Env, admin: Address) -> Result<(), ContractError> {
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    pub fn state_mutating_action(env: Env) -> Result<i32, ContractError> {
        crate::governance::check_not_paused(&env)?;
        Ok(100)
    }

    pub fn propose_admin(
        env: Env,
        caller: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        crate::governance::propose_admin(&env, &caller, &new_admin)
    }
    pub fn accept_admin(env: Env, caller: Address) -> Result<(), ContractError> {
        crate::governance::accept_admin(&env, &caller)
    }
    pub fn set_guardian(
        env: Env,
        caller: Address,
        new_guardian: Address,
    ) -> Result<(), ContractError> {
        crate::governance::set_guardian(&env, &caller, &new_guardian)
    }
    pub fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        crate::governance::pause(&env, &caller)
    }
    pub fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        crate::governance::unpause(&env, &caller)
    }
    pub fn is_paused(env: Env) -> bool {
        crate::governance::is_paused(&env)
    }
    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        crate::governance::get_admin(&env)
    }
    pub fn get_pending_admin(env: Env) -> Option<Address> {
        crate::governance::get_pending_admin(&env)
    }
    pub fn get_guardian(env: Env) -> Option<Address> {
        crate::governance::get_guardian(&env)
    }
    pub fn upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        crate::governance::upgrade(&env, &caller, &new_wasm_hash)
    }
}

#[test]
fn test_governance_two_step_admin_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();

    let admin_a = Address::generate(&env);
    let admin_b = Address::generate(&env);
    let attacker = Address::generate(&env);

    let contract_id = env.register(MockGovernanceContract, ());
    let client = MockGovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin_a);
    assert_eq!(client.get_admin(), admin_a);
    assert_eq!(client.get_pending_admin(), None);

    // Non-admin cannot propose
    assert_eq!(
        client.try_propose_admin(&attacker, &admin_b),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin cannot propose self
    assert_eq!(
        client.try_propose_admin(&admin_a, &admin_a),
        Err(Ok(ContractError::InvalidAdmin))
    );

    // Admin proposes admin_b
    client.propose_admin(&admin_a, &admin_b);
    assert_eq!(client.get_pending_admin(), Some(admin_b.clone()));

    // Random user cannot accept
    assert_eq!(
        client.try_accept_admin(&attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // admin_b accepts
    client.accept_admin(&admin_b);
    assert_eq!(client.get_admin(), admin_b);
    assert_eq!(client.get_pending_admin(), None);

    // Former admin (admin_a) cannot propose anymore
    assert_eq!(
        client.try_propose_admin(&admin_a, &attacker),
        Err(Ok(ContractError::Unauthorized))
    );
}

#[test]
fn test_governance_admin_propose_overwrite() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let nominee_b = Address::generate(&env);
    let nominee_c = Address::generate(&env);

    let contract_id = env.register(MockGovernanceContract, ());
    let client = MockGovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin);

    client.propose_admin(&admin, &nominee_b);
    assert_eq!(client.get_pending_admin(), Some(nominee_b.clone()));

    // Admin overwrites proposal with nominee_c
    client.propose_admin(&admin, &nominee_c);
    assert_eq!(client.get_pending_admin(), Some(nominee_c.clone()));

    // nominee_b cannot accept
    assert_eq!(
        client.try_accept_admin(&nominee_b),
        Err(Ok(ContractError::Unauthorized))
    );

    // nominee_c accepts
    client.accept_admin(&nominee_c);
    assert_eq!(client.get_admin(), nominee_c);
    assert_eq!(client.get_pending_admin(), None);
}

#[test]
fn test_governance_guardian_pause_and_admin_unpause() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let attacker = Address::generate(&env);

    let contract_id = env.register(MockGovernanceContract, ());
    let client = MockGovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin);
    client.set_guardian(&admin, &guardian);
    assert_eq!(client.get_guardian(), Some(guardian.clone()));
    assert!(!client.is_paused());

    // Non-guardian / non-admin cannot pause
    assert_eq!(
        client.try_pause(&attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // Guardian pauses
    client.pause(&guardian);
    assert!(client.is_paused());

    // Mutating action blocked
    assert_eq!(
        client.try_state_mutating_action(),
        Err(Ok(ContractError::ContractPaused))
    );

    // Duplicate pause fails
    assert_eq!(
        client.try_pause(&guardian),
        Err(Ok(ContractError::ContractPaused))
    );

    // Guardian CANNOT unpause
    assert_eq!(
        client.try_unpause(&guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin unpauses
    client.unpause(&admin);
    assert!(!client.is_paused());

    // Mutating action succeeds
    assert_eq!(client.state_mutating_action(), 100);

    // Duplicate unpause fails
    assert_eq!(
        client.try_unpause(&admin),
        Err(Ok(ContractError::ContractNotPaused))
    );
}

#[test]
fn test_governance_admin_direct_pause() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(MockGovernanceContract, ());
    let client = MockGovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin);
    client.pause(&admin);
    assert!(client.is_paused());
}

#[test]
fn test_governance_upgrade_access_control() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let attacker = Address::generate(&env);
    let dummy_hash = BytesN::from_array(&env, &[0xAA; 32]);
    let zero_hash = BytesN::from_array(&env, &[0u8; 32]);

    let contract_id = env.register(MockGovernanceContract, ());
    let client = MockGovernanceContractClient::new(&env, &contract_id);

    client.initialize(&admin);

    // Non-admin upgrade rejected
    assert_eq!(
        client.try_upgrade(&attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );

    // Zero hash upgrade rejected
    assert_eq!(
        client.try_upgrade(&admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

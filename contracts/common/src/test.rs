#![cfg(test)]
extern crate std;

use crate::errors::ContractError;
use crate::fixed_point::{div_256_64, pos_sub, wad_div, wad_div_ceil, wad_mul, WAD};
use crate::reentrancy::with_non_reentrant;
use crate::storage_keys::DataKey;
use crate::transcendental::{exp_wad, ln_wad, LN_2, MAX_EXP_INPUT};
use crate::ttl::{
    calculate_bump_threshold, calculate_bump_to, DEFAULT_BUMP_TO, MAX_NETWORK_TTL,
    MIN_BUMP_THRESHOLD,
};
use crate::yield_math::{
    asset_to_sy, asset_to_sy_ceil, calculate_fee_rate, calculate_haircut,
    calculate_pro_rata_share, calculate_tau_wad, get_exchange_rate, swap_exact_pt_for_sy_math,
    swap_exact_sy_for_pt_math, sy_to_asset, MAX_FEE_RATE, MIN_FEE_RATE,
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
    assert_eq!(div_256_64(1, 0, 0), Err(ContractError::DivisionByZero));
    assert_eq!(div_256_64(10, 0, 5), Err(ContractError::MathOverflow));
    assert_eq!(div_256_64(5, 0, 5), Err(ContractError::MathOverflow));
    let (q, rem) = div_256_64(0, 100, 10).unwrap();
    assert_eq!(q, 10);
    assert_eq!(rem, 0);
}

fn reference_long_div_256_64(hi: u128, lo: u128, d: u128) -> Result<(u128, u128), ContractError> {
    if d == 0 {
        return Err(ContractError::DivisionByZero);
    }
    if hi >= d {
        return Err(ContractError::MathOverflow);
    }
    let mut q: u128 = 0;
    let mut rem = hi;
    for i in (0..128).rev() {
        let msb = (rem >> 127) != 0;
        rem = (rem << 1) | ((lo >> i) & 1);
        if msb || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1 << i;
        }
    }
    Ok((q, rem))
}

#[test]
fn test_div_256_64_fast_path_and_boundary_equivalence() {
    let wad_u = WAD as u128;

    // 1. hi == 0 fast-path matches long division identically
    let lo_cases = [0u128, 1, 7, u64::MAX as u128, wad_u, u128::MAX - 1, u128::MAX];
    let d_cases = [1u128, 2, 3, 1_000_000_007, wad_u, u128::MAX - 1, u128::MAX];
    for &lo in &lo_cases {
        for &d in &d_cases {
            assert_eq!(
                div_256_64(0, lo, d),
                reference_long_div_256_64(0, lo, d),
                "fast-path mismatch for lo={}, d={}",
                lo,
                d
            );
        }
    }

    // 2. Boundary hi > 0 (u128::MAX + 1 = (1, 0))
    assert_eq!(div_256_64(1, 0, 2), Ok((1u128 << 127, 0)));
    assert_eq!(div_256_64(1, 0, u128::MAX), Ok((1, 1)));
    for &d in &[2u128, 3, 1_000_000_007, wad_u, u128::MAX] {
        assert_eq!(div_256_64(1, 0, d), reference_long_div_256_64(1, 0, d));
        assert_eq!(
            div_256_64(d - 1, u128::MAX, d),
            reference_long_div_256_64(d - 1, u128::MAX, d)
        );
    }

    // 3. wad_div boundary across hi == 0 vs hi > 0 (u128::MAX / WAD)
    let threshold = (u128::MAX / wad_u) as i128; // 340_282_366_920_938_463_463
    assert_eq!(wad_div(threshold, 2 * WAD).unwrap(), threshold / 2);
    assert_eq!(wad_div(threshold + 1, 2 * WAD).unwrap(), (threshold + 1) / 2);
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

#[contract]
struct MockMetaToken;

#[contractimpl]
impl MockMetaToken {
    pub fn decimals(_env: Env) -> u32 {
        6
    }

    pub fn symbol(env: Env) -> soroban_sdk::String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| soroban_sdk::String::from_str(&env, "USDC"))
    }

    pub fn set_symbol(env: Env, sym: soroban_sdk::String) {
        env.storage().instance().set(&DataKey::Symbol, &sym);
    }
}

#[test]
fn test_metadata_utf8_truncation_respects_char_boundaries() {
    let env = Env::default();
    let tok_id = env.register(MockMetaToken, ());
    let tok_client = MockMetaTokenClient::new(&env, &tok_id);

    // 17-byte UTF-8: 15 'a' + 2-byte 'é' (split at byte 16 -> must drop incomplete leading byte -> 15 bytes)
    tok_client.set_symbol(&soroban_sdk::String::from_str(&env, "aaaaaaaaaaaaaaaé"));
    let (dec1, buf1, len1) = crate::metadata::resolve_token_metadata(&env, &tok_id);
    assert_eq!(dec1, 6);
    assert_eq!(len1, 15);
    assert_eq!(core::str::from_utf8(&buf1[..len1]), Ok("aaaaaaaaaaaaaaa"));

    // 18-byte UTF-8: 14 'a' + 4-byte '🚀' (split at byte 16 -> must drop partial emoji -> 14 bytes)
    tok_client.set_symbol(&soroban_sdk::String::from_str(&env, "aaaaaaaaaaaaaa🚀"));
    let (_, buf2, len2) = crate::metadata::resolve_token_metadata(&env, &tok_id);
    assert_eq!(len2, 14);
    assert_eq!(core::str::from_utf8(&buf2[..len2]), Ok("aaaaaaaaaaaaaa"));

    // 17-byte UTF-8 where 'é' completes at byte 16 and 'a' starts at byte 17 -> keeps 16 bytes
    tok_client.set_symbol(&soroban_sdk::String::from_str(&env, "aaaaaaaaaaaaaaéa"));
    let (_, buf3, len3) = crate::metadata::resolve_token_metadata(&env, &tok_id);
    assert_eq!(len3, 16);
    assert_eq!(core::str::from_utf8(&buf3[..len3]), Ok("aaaaaaaaaaaaaaé"));

    // 16-byte exact ASCII -> keeps all 16 bytes
    tok_client.set_symbol(&soroban_sdk::String::from_str(&env, "ABCDEFGHIJKLMNOP"));
    let (_, buf4, len4) = crate::metadata::resolve_token_metadata(&env, &tok_id);
    assert_eq!(len4, 16);
    assert_eq!(core::str::from_utf8(&buf4[..len4]), Ok("ABCDEFGHIJKLMNOP"));
}

#[test]
fn test_py_index_unit_conversions() {
    use crate::fixed_point::SCALAR_9;

    // py_index = 1.2 * SCALAR_9
    let idx = 1_200_000_000i128;
    assert_eq!(sy_to_asset(idx, 100_000_000_000).unwrap(), 120_000_000_000);
    assert_eq!(asset_to_sy(idx, 120_000_000_000).unwrap(), 100_000_000_000);
    assert_eq!(asset_to_sy_ceil(idx, 120_000_000_000).unwrap(), 100_000_000_000);

    // Non-divisible floor vs ceil
    // 10 * 10^9 / 1.2e9 = 8.3333... -> floor 8, ceil 9
    assert_eq!(asset_to_sy(idx, 10).unwrap(), 8);
    assert_eq!(asset_to_sy_ceil(idx, 10).unwrap(), 9);
    assert_eq!(sy_to_asset(idx, 10).unwrap(), 12);

    // Zero amounts
    assert_eq!(sy_to_asset(idx, 0).unwrap(), 0);
    assert_eq!(asset_to_sy(idx, 0).unwrap(), 0);
    assert_eq!(asset_to_sy_ceil(idx, 0).unwrap(), 0);

    // Invalid rate & negative amounts
    assert_eq!(sy_to_asset(0, 100), Err(ContractError::InvalidRate));
    assert_eq!(asset_to_sy(-1, 100), Err(ContractError::InvalidRate));
    assert_eq!(asset_to_sy_ceil(0, 100), Err(ContractError::InvalidRate));
    assert_eq!(sy_to_asset(SCALAR_9, -1), Err(ContractError::ZeroAmount));
    assert_eq!(asset_to_sy(SCALAR_9, -1), Err(ContractError::ZeroAmount));
    assert_eq!(asset_to_sy_ceil(SCALAR_9, -1), Err(ContractError::ZeroAmount));

    // Overflow guard
    assert_eq!(sy_to_asset(idx, i128::MAX), Err(ContractError::MathOverflow));
    assert_eq!(asset_to_sy(idx, i128::MAX), Err(ContractError::MathOverflow));
    assert_eq!(asset_to_sy_ceil(idx, i128::MAX), Err(ContractError::MathOverflow));
}

#[test]
fn test_pos_sub_and_haircut_and_pro_rata_share_edge_cases() {
    // 1. pos_sub clamps at 0 (never negative)
    assert_eq!(pos_sub(10, 3), 7);
    assert_eq!(pos_sub(3, 10), 0);
    assert_eq!(pos_sub(0, i128::MAX), 0);
    assert_eq!(pos_sub(i128::MIN, 1), 0);
    assert_eq!(pos_sub(-5, -10), 5);

    // 2. calculate_haircut negative/zero guard while preserving .min(WAD) cap
    assert_eq!(calculate_haircut(-100 * WAD, 1000 * WAD), Ok(0));
    assert_eq!(calculate_haircut(0, 1000 * WAD), Ok(0));
    assert_eq!(calculate_haircut(2000 * WAD, 1000 * WAD), Ok(WAD));
    assert_eq!(calculate_haircut(100 * WAD, 0), Err(ContractError::DivisionByZero));

    // 3. calculate_pro_rata_share (uncapped, exact integer sweep)
    let b = 1_000_000_000i128;
    // Sub-1.0 b_rate ratio: 100B SY across 80B PT -> 40B PT yields 50B SY
    assert_eq!(calculate_pro_rata_share(40 * b, 100 * b, 80 * b), Ok(50 * b));
    // Non-terminating sweep: 100B across 70B, redeeming full 70B returns exact 100B
    assert_eq!(calculate_pro_rata_share(70 * b, 100 * b, 70 * b), Ok(100 * b));
    // Negative / zero inputs clamp to 0
    assert_eq!(calculate_pro_rata_share(10 * b, -5, 70 * b), Ok(0));
    assert_eq!(calculate_pro_rata_share(0, 100 * b, 70 * b), Ok(0));
    assert_eq!(calculate_pro_rata_share(-1, 100 * b, 70 * b), Ok(0));
    // Zero supply errors
    assert_eq!(
        calculate_pro_rata_share(10 * b, 100 * b, 0),
        Err(ContractError::DivisionByZero)
    );
    // Overflow fallback branch (amount * available > u128::MAX)
    let large_avail = 1_000_000_000_000_000_000_000_000i128; // 10^24
    let large_supply = 2_000_000_000_000_000_000_000_000i128; // 2 * 10^24
    let large_amt = 1_000_000_000_000_000_000_000_000i128; // 10^24
    assert_eq!(
        calculate_pro_rata_share(large_amt, large_avail, large_supply),
        Ok(500_000_000_000_000_000_000_000)
    );
}

#[test]
fn test_wad_div_ceil_rounding_and_boundaries() {
    // 1-stroop division by > WAD rounds UP to 1 (prevents 0 PT buyback cost drain)
    let e_105 = WAD + WAD / 20; // 1.05 WAD
    assert_eq!(wad_div(1, e_105), Ok(0));
    assert_eq!(wad_div_ceil(1, e_105), Ok(1));

    // Exact divisibility: 105 / 1.05 = 100 (no extra +1)
    assert_eq!(wad_div_ceil(105, e_105), Ok(100));
    // Remainder > 0: 106 / 1.05 = 100.95 -> ceil 101
    assert_eq!(wad_div_ceil(106, e_105), Ok(101));
    // 20 / 1.05 = 19.047 -> ceil 20
    assert_eq!(wad_div_ceil(20, e_105), Ok(20));
    // 21 / 1.05 = 20.0 exact
    assert_eq!(wad_div_ceil(21, e_105), Ok(20));

    // Zero & division by zero
    assert_eq!(wad_div_ceil(0, e_105), Ok(0));
    assert_eq!(wad_div_ceil(10, 0), Err(ContractError::DivisionByZero));

    // Negative signs (ceil toward +inf)
    assert_eq!(wad_div_ceil(-1, e_105), Ok(0));
    assert_eq!(wad_div_ceil(-105, e_105), Ok(-100));
    assert_eq!(wad_div_ceil(-106, e_105), Ok(-100));
    assert_eq!(wad_div_ceil(-106, -e_105), Ok(101));

    // Overflow guard
    assert_eq!(wad_div_ceil(i128::MAX, 1), Err(ContractError::MathOverflow));
}

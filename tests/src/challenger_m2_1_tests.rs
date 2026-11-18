#![cfg(test)]
extern crate std;

use common::errors::ContractError;
use common::fixed_point::{SCALAR_9, WAD};
use mock_blend::{MockBlend, MockBlendClient};
use pt_token::{PrincipalToken, PrincipalTokenClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{token, Address, BytesN, Env, String};
use sy_blend_wrapper::{StandardizedYield, StandardizedYieldClient};
use yield_pool::{YieldPool, YieldPoolClient};
use yt_token::{YieldToken, YieldTokenClient};

#[allow(dead_code)]
struct ChallengerM2Fixture<'a> {
    env: Env,
    admin: Address,
    guardian: Address,
    attacker: Address,
    nominee1: Address,
    nominee2: Address,
    nominee3: Address,
    nominee4: Address,
    nominee5: Address,
    user: Address,
    multisig_vault: Address,
    signer1: Address,
    signer2: Address,
    signer3: Address,
    usdc_admin_client: token::StellarAssetClient<'a>,
    usdc_client: token::Client<'a>,
    blend_client: MockBlendClient<'a>,
    sy_client: StandardizedYieldClient<'a>,
    pt_client: PrincipalTokenClient<'a>,
    yt_client: YieldTokenClient<'a>,
    pool_client: YieldPoolClient<'a>,
    maturity: u64,
}

fn setup_challenger_m2_fixture<'a>() -> ChallengerM2Fixture<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let guardian = Address::generate(&env);
    let attacker = Address::generate(&env);
    let nominee1 = Address::generate(&env);
    let nominee2 = Address::generate(&env);
    let nominee3 = Address::generate(&env);
    let nominee4 = Address::generate(&env);
    let nominee5 = Address::generate(&env);
    let user = Address::generate(&env);
    let multisig_vault = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);
    let signer3 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let usdc = env.register_stellar_asset_contract_v2(token_admin);
    let usdc_client = token::Client::new(&env, &usdc.address());
    let usdc_admin_client = token::StellarAssetClient::new(&env, &usdc.address());

    // 1. Mock Blend Pool
    let blend_id = env.register(MockBlend, ());
    let blend_client = MockBlendClient::new(&env, &blend_id);
    blend_client.initialize(&admin, &usdc.address(), &SCALAR_9);

    // 2. SY Blend Wrapper
    let sy_id = env.register(StandardizedYield, ());
    let sy_client = StandardizedYieldClient::new(&env, &sy_id);
    sy_client.initialize(&admin, &usdc.address(), &blend_id);

    let maturity = env.ledger().timestamp() + 180 * 86400; // 180 days

    // 3. Yield Pool Core
    let pool_id = env.register(YieldPool, ());
    let pool_client = YieldPoolClient::new(&env, &pool_id);

    // 4. PT Token
    let pt_id = env.register(PrincipalToken, ());
    let pt_client = PrincipalTokenClient::new(&env, &pt_id);
    pt_client.initialize(
        &admin,
        &pool_id,
        &String::from_str(&env, "Pendle PT 180D"),
        &String::from_str(&env, "PT-180D"),
        &7u32,
        &maturity,
    );

    // 5. YT Token
    let yt_id = env.register(YieldToken, ());
    let yt_client = YieldTokenClient::new(&env, &yt_id);
    yt_client.initialize(
        &admin,
        &pool_id,
        &sy_id,
        &String::from_str(&env, "Pendle YT 180D"),
        &String::from_str(&env, "YT-180D"),
        &7u32,
        &maturity,
    );

    // 6. Pool Initialization
    let scalar_root = 20 * WAD;
    let initial_anchor = WAD;
    pool_client.initialize(
        &admin,
        &sy_id,
        &pt_id,
        &yt_id,
        &maturity,
        &scalar_root,
        &initial_anchor,
    );

    // 7. Configure guardian across all contracts
    pool_client.set_guardian(&admin, &guardian);
    sy_client.set_guardian(&admin, &guardian);
    pt_client.set_guardian(&admin, &guardian);
    yt_client.set_guardian(&admin, &guardian);

    ChallengerM2Fixture {
        env,
        admin,
        guardian,
        attacker,
        nominee1,
        nominee2,
        nominee3,
        nominee4,
        nominee5,
        user,
        multisig_vault,
        signer1,
        signer2,
        signer3,
        usdc_admin_client,
        usdc_client,
        blend_client,
        sy_client,
        pt_client,
        yt_client,
        pool_client,
        maturity,
    }
}

// =============================================================================
// 1. UNAUTHORIZED PROPOSE_ADMIN MATRIX TESTS
// =============================================================================

#[test]
fn test_stress_two_step_admin_unauthorized_propose_comprehensive_matrix() {
    let f = setup_challenger_m2_fixture();

    // Matrix of unauthorized callers:
    // 1. Rogue external attacker
    // 2. Configured Guardian (strictly authorized only to pause, NOT propose admin)
    // 3. User / LP provider
    // 4. Contract address itself
    let callers = [
        f.attacker.clone(),
        f.guardian.clone(),
        f.user.clone(),
        f.pool_client.address.clone(),
    ];

    for caller in callers.iter() {
        // YieldPool
        let res_pool = f.pool_client.try_propose_admin(caller, &f.nominee1);
        assert_eq!(
            res_pool,
            Err(Ok(ContractError::Unauthorized)),
            "YieldPool must reject unauthorized propose_admin from {:?}",
            caller
        );

        // SY Wrapper
        let res_sy = f.sy_client.try_propose_admin(caller, &f.nominee1);
        assert_eq!(
            res_sy,
            Err(Ok(ContractError::Unauthorized)),
            "SY Wrapper must reject unauthorized propose_admin from {:?}",
            caller
        );

        // PT Token
        let res_pt = f.pt_client.try_propose_admin(caller, &f.nominee1);
        assert_eq!(
            res_pt,
            Err(Ok(ContractError::Unauthorized)),
            "PT Token must reject unauthorized propose_admin from {:?}",
            caller
        );

        // YT Token
        let res_yt = f.yt_client.try_propose_admin(caller, &f.nominee1);
        assert_eq!(
            res_yt,
            Err(Ok(ContractError::Unauthorized)),
            "YT Token must reject unauthorized propose_admin from {:?}",
            caller
        );
    }

    // Pending admin must remain None across all contracts
    assert_eq!(f.pool_client.get_pending_admin(), None);
    assert_eq!(f.sy_client.get_pending_admin(), None);
    assert_eq!(f.pt_client.get_pending_admin(), None);
    assert_eq!(f.yt_client.get_pending_admin(), None);

    // Current admin remains original
    assert_eq!(f.pool_client.get_admin(), f.admin);
    assert_eq!(f.sy_client.get_admin(), f.admin);
    assert_eq!(f.pt_client.get_admin(), f.admin);
    assert_eq!(f.yt_client.get_admin(), f.admin);
}

#[test]
fn test_stress_propose_admin_self_proposal_rejection() {
    let f = setup_challenger_m2_fixture();

    // Admin proposing itself must fail with InvalidAdmin across all contracts
    assert_eq!(
        f.pool_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );
    assert_eq!(
        f.sy_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );
    assert_eq!(
        f.pt_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );
    assert_eq!(
        f.yt_client.try_propose_admin(&f.admin, &f.admin),
        Err(Ok(ContractError::InvalidAdmin))
    );

    // Pending admin remains None
    assert_eq!(f.pool_client.get_pending_admin(), None);
}

// =============================================================================
// 2. UNAUTHORIZED ACCEPT_ADMIN & STATE BOUNDARY TESTS
// =============================================================================

#[test]
fn test_stress_accept_admin_unauthorized_and_boundary_matrix() {
    let f = setup_challenger_m2_fixture();

    // Phase 1: No proposal exists -> Calling accept_admin must fail with NoPendingAdmin
    assert_eq!(
        f.pool_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    assert_eq!(
        f.pool_client.try_accept_admin(&f.admin),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    assert_eq!(
        f.pool_client.try_accept_admin(&f.guardian),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    assert_eq!(
        f.sy_client.try_accept_admin(&f.nominee1),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    assert_eq!(
        f.pt_client.try_accept_admin(&f.nominee1),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    assert_eq!(
        f.yt_client.try_accept_admin(&f.nominee1),
        Err(Ok(ContractError::NoPendingAdmin))
    );

    // Phase 2: Propose nominee1 across all contracts
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    f.sy_client.propose_admin(&f.admin, &f.nominee1);
    f.pt_client.propose_admin(&f.admin, &f.nominee1);
    f.yt_client.propose_admin(&f.admin, &f.nominee1);

    // Verify non-nominees cannot accept:
    // 1. Attacker
    assert_eq!(
        f.pool_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    // 2. Current admin
    assert_eq!(
        f.pt_client.try_accept_admin(&f.admin),
        Err(Ok(ContractError::Unauthorized))
    );
    // 3. Guardian
    assert_eq!(
        f.yt_client.try_accept_admin(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
    // 4. Alternate nominee
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );

    // Phase 3: Legitimate acceptance by nominee1
    f.pool_client.accept_admin(&f.nominee1);
    f.sy_client.accept_admin(&f.nominee1);
    f.pt_client.accept_admin(&f.nominee1);
    f.yt_client.accept_admin(&f.nominee1);

    assert_eq!(f.pool_client.get_admin(), f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), None);

    // Phase 4: Double acceptance attack
    // Newly accepted nominee1 tries to call accept_admin again -> NoPendingAdmin
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee1),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    // Attacker tries to call accept_admin -> NoPendingAdmin
    assert_eq!(
        f.pool_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::NoPendingAdmin))
    );
}

// =============================================================================
// 3. PROPOSAL OVERWRITE STRESS TESTING (RAPID & PING-PONG)
// =============================================================================

#[test]
fn test_stress_unaccepted_proposal_sequential_overwrites_chain() {
    let f = setup_challenger_m2_fixture();

    // Sequential overwrites: N1 -> N2 -> N3 -> N4 -> N5 without intermediate acceptances
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee1.clone()));

    f.pool_client.propose_admin(&f.admin, &f.nominee2);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee2.clone()));

    f.pool_client.propose_admin(&f.admin, &f.nominee3);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee3.clone()));

    f.pool_client.propose_admin(&f.admin, &f.nominee4);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee4.clone()));

    f.pool_client.propose_admin(&f.admin, &f.nominee5);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee5.clone()));

    // Verify all prior nominees (N1, N2, N3, N4) are strictly invalidated
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee1),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee3),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee4),
        Err(Ok(ContractError::Unauthorized))
    );

    // Only active nominee N5 can accept
    f.pool_client.accept_admin(&f.nominee5);
    assert_eq!(f.pool_client.get_admin(), f.nominee5);
    assert_eq!(f.pool_client.get_pending_admin(), None);

    // Post-acceptance: N1..N5 calling accept_admin must fail with NoPendingAdmin
    for n in [&f.nominee1, &f.nominee2, &f.nominee3, &f.nominee4] {
        assert_eq!(
            f.pool_client.try_accept_admin(n),
            Err(Ok(ContractError::NoPendingAdmin))
        );
    }
}

#[test]
fn test_stress_ping_pong_unaccepted_proposal_overwrite() {
    let f = setup_challenger_m2_fixture();

    // Propose Alice (nominee1)
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee1.clone()));

    // Overwrite with Bob (nominee2)
    f.pool_client.propose_admin(&f.admin, &f.nominee2);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee2.clone()));

    // Overwrite back with Alice (nominee1)
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee1.clone()));

    // Bob cannot accept
    assert_eq!(
        f.pool_client.try_accept_admin(&f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );

    // Alice accepts and becomes Admin
    f.pool_client.accept_admin(&f.nominee1);
    assert_eq!(f.pool_client.get_admin(), f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), None);
}

// =============================================================================
// 4. COMPLETE REVOCATION OF FORMER ADMIN RIGHTS
// =============================================================================

#[test]
fn test_stress_complete_revocation_of_former_admin_privileges() {
    let f = setup_challenger_m2_fixture();

    // Transfer admin to nominee1 across all 4 contracts
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    f.pool_client.accept_admin(&f.nominee1);

    f.sy_client.propose_admin(&f.admin, &f.nominee1);
    f.sy_client.accept_admin(&f.nominee1);

    f.pt_client.propose_admin(&f.admin, &f.nominee1);
    f.pt_client.accept_admin(&f.nominee1);

    f.yt_client.propose_admin(&f.admin, &f.nominee1);
    f.yt_client.accept_admin(&f.nominee1);

    let dummy_hash = BytesN::from_array(&f.env, &[0x42; 32]);

    // Former admin (admin) is strictly stripped of all administrative capabilities:
    // 1. Cannot propose admin
    assert_eq!(
        f.pool_client.try_propose_admin(&f.admin, &f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_propose_admin(&f.admin, &f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pt_client.try_propose_admin(&f.admin, &f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.yt_client.try_propose_admin(&f.admin, &f.nominee2),
        Err(Ok(ContractError::Unauthorized))
    );

    // 2. Cannot set guardian
    assert_eq!(
        f.pool_client.try_set_guardian(&f.admin, &f.user),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_set_guardian(&f.admin, &f.user),
        Err(Ok(ContractError::Unauthorized))
    );

    // 3. Cannot unpause
    f.pool_client.pause(&f.guardian);
    assert!(f.pool_client.is_paused());
    assert_eq!(
        f.pool_client.try_unpause(&f.admin),
        Err(Ok(ContractError::Unauthorized))
    );
    // New admin unpauses cleanly
    f.pool_client.unpause(&f.nominee1);
    assert!(!f.pool_client.is_paused());

    // 4. Cannot upgrade WASM
    assert_eq!(
        f.pool_client.try_upgrade(&f.admin, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_upgrade(&f.admin, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pt_client.try_upgrade(&f.admin, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.yt_client.try_upgrade(&f.admin, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );

    // 5. Cannot set fee recipient on pool
    assert_eq!(
        f.pool_client.try_set_fee_recipient(&f.admin, &f.user),
        Err(Ok(ContractError::Unauthorized))
    );

    // 6. Cannot pause (unless configured as guardian)
    assert_eq!(
        f.pool_client.try_pause(&f.admin),
        Err(Ok(ContractError::Unauthorized))
    );

    // New admin possesses 100% legitimate authority
    f.pool_client.set_fee_recipient(&f.nominee1, &f.user);
    assert_eq!(f.pool_client.get_market_state().fee_recipient, f.user);
}

#[test]
fn test_stress_multi_generation_admin_handshake_chain() {
    let f = setup_challenger_m2_fixture();

    // Gen0 (admin) -> Gen1 (nominee1)
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    f.pool_client.accept_admin(&f.nominee1);
    assert_eq!(f.pool_client.get_admin(), f.nominee1);

    // Gen1 -> Gen2 (nominee2)
    f.pool_client.propose_admin(&f.nominee1, &f.nominee2);
    f.pool_client.accept_admin(&f.nominee2);
    assert_eq!(f.pool_client.get_admin(), f.nominee2);

    // Gen2 -> Gen3 (nominee3)
    f.pool_client.propose_admin(&f.nominee2, &f.nominee3);
    f.pool_client.accept_admin(&f.nominee3);
    assert_eq!(f.pool_client.get_admin(), f.nominee3);

    // Gen3 -> Gen4 (nominee4)
    f.pool_client.propose_admin(&f.nominee3, &f.nominee4);
    f.pool_client.accept_admin(&f.nominee4);
    assert_eq!(f.pool_client.get_admin(), f.nominee4);

    // At Gen4, verify Gen0, Gen1, Gen2, Gen3 are ALL completely unauthorized
    let past_admins = [&f.admin, &f.nominee1, &f.nominee2, &f.nominee3];
    for past in past_admins.iter() {
        assert_eq!(
            f.pool_client.try_propose_admin(past, &f.nominee5),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(
            f.pool_client.try_set_guardian(past, &f.user),
            Err(Ok(ContractError::Unauthorized))
        );
        assert_eq!(
            f.pool_client.try_unpause(past),
            Err(Ok(ContractError::Unauthorized))
        );
    }

    // Gen4 cycles back and proposes original Gen0 (admin)
    f.pool_client.propose_admin(&f.nominee4, &f.admin);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.admin.clone()));

    // Gen0 still has NO authority before calling accept_admin
    assert_eq!(
        f.pool_client.try_propose_admin(&f.admin, &f.nominee5),
        Err(Ok(ContractError::Unauthorized))
    );

    // Gen0 accepts and re-assumes full authority
    f.pool_client.accept_admin(&f.admin);
    assert_eq!(f.pool_client.get_admin(), f.admin);
    assert_eq!(f.pool_client.get_pending_admin(), None);

    // Gen4 is now stripped
    assert_eq!(
        f.pool_client.try_propose_admin(&f.nominee4, &f.nominee5),
        Err(Ok(ContractError::Unauthorized))
    );
}

// =============================================================================
// 5. SINGLE-KEY COMPROMISE RESILIENCE TESTS
// =============================================================================

#[test]
fn test_stress_single_key_compromise_guardian_containment_and_drain_prevention() {
    let f = setup_challenger_m2_fixture();

    // Seed pool liquidity so that swaps/mints are normally active
    let seed_sy = 5_000_000_000i128;
    f.usdc_admin_client.mint(&f.user, &seed_sy);
    f.sy_client.deposit(&f.user, &f.user, &seed_sy);
    f.pool_client
        .mint_py(&f.user, &f.user, &2_000_000_000, &f.maturity);
    f.pool_client
        .add_liquidity(&f.user, &f.user, &1_000_000_000, &1_000_000_000, &0);

    // 1. Compromised Guardian invokes emergency pause
    f.pool_client.pause(&f.guardian);
    assert!(f.pool_client.is_paused());

    // 2. Attacker attempts malicious actions as Guardian:
    // a. Cannot unpause
    assert_eq!(
        f.pool_client.try_unpause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );
    // b. Cannot propose attacker as admin
    assert_eq!(
        f.pool_client.try_propose_admin(&f.guardian, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    // c. Cannot accept admin
    assert_eq!(
        f.pool_client.try_accept_admin(&f.guardian),
        Err(Ok(ContractError::NoPendingAdmin))
    );
    // d. Cannot upgrade WASM code
    let evil_hash = BytesN::from_array(&f.env, &[0x66; 32]);
    assert_eq!(
        f.pool_client.try_upgrade(&f.guardian, &evil_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    // e. Cannot divert fee recipient
    assert_eq!(
        f.pool_client
            .try_set_fee_recipient(&f.guardian, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    // f. Cannot drain pool funds via swap while paused
    assert_eq!(
        f.pool_client.try_swap_exact_sy_for_pt(
            &f.attacker,
            &f.attacker,
            &100_000_000,
            &0,
            &f.maturity,
        ),
        Err(Ok(ContractError::ContractPaused))
    );

    // 3. Multi-sig Admin containment response:
    // Rotate guardian to clean key (nominee1) and unpause
    f.pool_client.set_guardian(&f.admin, &f.nominee1);
    f.pool_client.unpause(&f.admin);
    assert!(!f.pool_client.is_paused());

    // 4. Compromised former guardian cannot even pause anymore
    assert_eq!(
        f.pool_client.try_pause(&f.guardian),
        Err(Ok(ContractError::Unauthorized))
    );

    // System operates normally with new guardian
    f.pool_client.pause(&f.nominee1);
    assert!(f.pool_client.is_paused());
    f.pool_client.unpause(&f.admin);
    assert!(!f.pool_client.is_paused());
}

#[test]
fn test_stress_single_key_compromise_nominee_containment() {
    let f = setup_challenger_m2_fixture();

    // Rogue key was proposed mistakenly
    f.pool_client.propose_admin(&f.admin, &f.attacker);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.attacker.clone()));

    // Attacker cannot exercise any admin functions prior to acceptance
    assert_eq!(
        f.pool_client.try_propose_admin(&f.attacker, &f.nominee1),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client.try_set_guardian(&f.attacker, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client.try_unpause(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    let dummy_hash = BytesN::from_array(&f.env, &[0x77; 32]);
    assert_eq!(
        f.pool_client.try_upgrade(&f.attacker, &dummy_hash),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.pool_client
            .try_set_fee_recipient(&f.attacker, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // Admin detects compromise and overwrites proposal with safe multisig vault
    f.pool_client.propose_admin(&f.admin, &f.multisig_vault);
    assert_eq!(
        f.pool_client.get_pending_admin(),
        Some(f.multisig_vault.clone())
    );

    // Attacker's attempt to accept fails
    assert_eq!(
        f.pool_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // Safe multisig vault accepts and locks out attacker permanently
    f.pool_client.accept_admin(&f.multisig_vault);
    assert_eq!(f.pool_client.get_admin(), f.multisig_vault);
    assert_eq!(f.pool_client.get_pending_admin(), None);

    assert_eq!(
        f.pool_client.try_accept_admin(&f.attacker),
        Err(Ok(ContractError::NoPendingAdmin))
    );
}

#[test]
fn test_stress_simulated_multisig_threshold_isolation() {
    let f = setup_challenger_m2_fixture();

    // Transfer admin to multisig_vault (representing 2-of-3 threshold account)
    f.pool_client.propose_admin(&f.admin, &f.multisig_vault);
    f.pool_client.accept_admin(&f.multisig_vault);
    assert_eq!(f.pool_client.get_admin(), f.multisig_vault);

    // An attacker who compromises a single signer key (signer1, signer2, or signer3)
    // attempts to call admin functions directly:
    for rogue_signer in [&f.signer1, &f.signer2, &f.signer3] {
        assert_eq!(
            f.pool_client.try_propose_admin(rogue_signer, &f.attacker),
            Err(Ok(ContractError::Unauthorized)),
            "Single rogue signer cannot propose admin directly!"
        );
        assert_eq!(
            f.pool_client.try_set_guardian(rogue_signer, &f.attacker),
            Err(Ok(ContractError::Unauthorized)),
            "Single rogue signer cannot set guardian directly!"
        );
        assert_eq!(
            f.pool_client.try_unpause(rogue_signer),
            Err(Ok(ContractError::Unauthorized)),
            "Single rogue signer cannot unpause directly!"
        );
        let dummy_hash = BytesN::from_array(&f.env, &[0x88; 32]);
        assert_eq!(
            f.pool_client.try_upgrade(rogue_signer, &dummy_hash),
            Err(Ok(ContractError::Unauthorized)),
            "Single rogue signer cannot upgrade contract directly!"
        );
    }

    // Only calls authenticated with the multisig_vault address succeed
    f.pool_client.set_guardian(&f.multisig_vault, &f.nominee1);
    assert_eq!(f.pool_client.get_guardian(), Some(f.nominee1.clone()));
}

// =============================================================================
// 6. GOVERNANCE UNIMPEDED DURING EMERGENCY PAUSE
// =============================================================================

#[test]
fn test_stress_governance_unimpeded_during_emergency_pause() {
    let f = setup_challenger_m2_fixture();

    // 1. Trigger emergency pause via guardian
    f.pool_client.pause(&f.guardian);
    assert!(f.pool_client.is_paused());

    // 2. Verify state-mutating operations are paused
    let seed_sy = 1_000_000_000i128;
    f.usdc_admin_client.mint(&f.user, &seed_sy);
    f.sy_client.deposit(&f.user, &f.user, &seed_sy);
    assert_eq!(
        f.pool_client
            .try_mint_py(&f.user, &f.user, &100_000_000, &f.maturity),
        Err(Ok(ContractError::ContractPaused))
    );

    // 3. Propose and accept new admin WHILE PAUSED
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    assert_eq!(f.pool_client.get_pending_admin(), Some(f.nominee1.clone()));
    f.pool_client.accept_admin(&f.nominee1);
    assert_eq!(f.pool_client.get_admin(), f.nominee1);

    // 4. New admin rotates guardian WHILE PAUSED
    f.pool_client.set_guardian(&f.nominee1, &f.nominee2);
    assert_eq!(f.pool_client.get_guardian(), Some(f.nominee2.clone()));

    // 5. New admin unpauses contract
    f.pool_client.unpause(&f.nominee1);
    assert!(!f.pool_client.is_paused());

    // 6. Normal operations resume cleanly
    let (pt, yt) = f
        .pool_client
        .mint_py(&f.user, &f.user, &100_000_000, &f.maturity);
    assert_eq!(pt, 100_000_000);
    assert_eq!(yt, 100_000_000);
}

// =============================================================================
// 7. CROSS-CONTRACT GOVERNANCE INDEPENDENCE & SECURITY ISOLATION
// =============================================================================

#[test]
fn test_stress_cross_contract_governance_isolation() {
    let f = setup_challenger_m2_fixture();

    // Independent admin assignments
    let admin_pool = f.nominee1.clone();
    let admin_sy = f.nominee2.clone();
    let admin_pt = f.nominee3.clone();
    let admin_yt = f.nominee4.clone();

    // YieldPool transfer
    f.pool_client.propose_admin(&f.admin, &admin_pool);
    f.pool_client.accept_admin(&admin_pool);

    // SY Wrapper transfer
    f.sy_client.propose_admin(&f.admin, &admin_sy);
    f.sy_client.accept_admin(&admin_sy);

    // PT Token transfer
    f.pt_client.propose_admin(&f.admin, &admin_pt);
    f.pt_client.accept_admin(&admin_pt);

    // YT Token transfer
    f.yt_client.propose_admin(&f.admin, &admin_yt);
    f.yt_client.accept_admin(&admin_yt);

    // Verify isolation: admin_pt CANNOT touch YieldPool, SY, or YT
    assert_eq!(
        f.pool_client.try_propose_admin(&admin_pt, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.sy_client.try_propose_admin(&admin_pt, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );
    assert_eq!(
        f.yt_client.try_propose_admin(&admin_pt, &f.attacker),
        Err(Ok(ContractError::Unauthorized))
    );

    // admin_pt CAN manage PT token
    f.pt_client.set_guardian(&admin_pt, &f.user);
    assert_eq!(f.pt_client.get_guardian(), Some(f.user.clone()));
}

// =============================================================================
// 8. ZERO-HASH WASM UPGRADE REJECTION ACROSS ALL CONTRACTS
// =============================================================================

#[test]
fn test_stress_zero_wasm_hash_upgrade_rejection_across_contracts() {
    let f = setup_challenger_m2_fixture();
    let zero_hash = BytesN::from_array(&f.env, &[0u8; 32]);

    assert_eq!(
        f.pool_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.sy_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.pt_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
    assert_eq!(
        f.yt_client.try_upgrade(&f.admin, &zero_hash),
        Err(Ok(ContractError::InvalidWasmHash))
    );
}

// =============================================================================
// 9. GOVERNANCE AUTHORIZATION RECORDING VERIFICATION
// =============================================================================

#[test]
fn test_stress_governance_auth_recording_integrity() {
    let f = setup_challenger_m2_fixture();

    // 1. propose_admin must demand admin auth
    f.pool_client.propose_admin(&f.admin, &f.nominee1);
    let auths = f.env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == f.admin),
        "propose_admin must record admin auth"
    );

    // 2. accept_admin must demand nominee auth
    f.pool_client.accept_admin(&f.nominee1);
    let auths = f.env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == f.nominee1),
        "accept_admin must record nominee auth"
    );

    // 3. set_guardian must demand new admin auth
    f.pool_client.set_guardian(&f.nominee1, &f.guardian);
    let auths = f.env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == f.nominee1),
        "set_guardian must record new admin auth"
    );

    // 4. pause must demand guardian auth
    f.pool_client.pause(&f.guardian);
    let auths = f.env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == f.guardian),
        "pause must record guardian auth"
    );

    // 5. unpause must demand new admin auth
    f.pool_client.unpause(&f.nominee1);
    let auths = f.env.auths();
    assert!(
        auths.iter().any(|(addr, _)| *addr == f.nominee1),
        "unpause must record new admin auth"
    );
}

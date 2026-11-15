use crate::errors::ContractError;
use crate::events::{
    AdminAcceptedEvent, AdminProposedEvent, ContractPausedEvent, ContractUnpausedEvent,
    ContractUpgradedEvent, GuardianUpdatedEvent,
};
use crate::storage_keys::DataKey;
use crate::ttl::bump_instance_ttl;
use soroban_sdk::{Address, BytesN, Env};

/// Reads the currently configured Admin address.
/// Returns `Err(ContractError::NotInitialized)` if `DataKey::Admin` is not set.
pub fn get_admin(env: &Env) -> Result<Address, ContractError> {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .ok_or(ContractError::NotInitialized)
}

/// Reads the currently designated Pending Admin address, if any.
pub fn get_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

/// Reads the currently configured Guardian address, if any.
pub fn get_guardian(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Guardian)
}

/// Returns true if the contract is in an emergency paused state.
pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::IsPaused)
        .unwrap_or(false)
}

/// Asserts that the contract is not paused.
/// Used as a gatekeeper across all state-mutating entrypoints.
#[inline(always)]
pub fn check_not_paused(env: &Env) -> Result<(), ContractError> {
    if is_paused(env) {
        Err(ContractError::ContractPaused)
    } else {
        Ok(())
    }
}

/// Step 1 of two-step admin transfer.
/// Caller must be current Admin. Designates `new_admin` as PendingAdmin.
pub fn propose_admin(
    env: &Env,
    caller: &Address,
    new_admin: &Address,
) -> Result<(), ContractError> {
    caller.require_auth();
    let current_admin = get_admin(env)?;
    if *caller != current_admin {
        return Err(ContractError::Unauthorized);
    }
    if *new_admin == current_admin {
        return Err(ContractError::InvalidAdmin);
    }

    env.storage()
        .instance()
        .set(&DataKey::PendingAdmin, new_admin);

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    AdminProposedEvent {
        current_admin,
        proposed_admin: new_admin.clone(),
    }
    .publish(env);

    Ok(())
}

/// Step 2 of two-step admin transfer.
/// Caller must be the designated PendingAdmin. Sets Admin to caller and removes PendingAdmin.
pub fn accept_admin(env: &Env, caller: &Address) -> Result<(), ContractError> {
    caller.require_auth();
    let pending_admin = get_pending_admin(env).ok_or(ContractError::NoPendingAdmin)?;
    if *caller != pending_admin {
        return Err(ContractError::Unauthorized);
    }
    let old_admin = get_admin(env)?;

    env.storage().instance().set(&DataKey::Admin, caller);
    env.storage().instance().remove(&DataKey::PendingAdmin);

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    AdminAcceptedEvent {
        old_admin,
        new_admin: caller.clone(),
    }
    .publish(env);

    Ok(())
}

/// Configures or rotates the emergency pause Guardian key.
/// Caller must be the active Admin.
pub fn set_guardian(
    env: &Env,
    caller: &Address,
    new_guardian: &Address,
) -> Result<(), ContractError> {
    caller.require_auth();
    let admin = get_admin(env)?;
    if *caller != admin {
        return Err(ContractError::Unauthorized);
    }

    env.storage()
        .instance()
        .set(&DataKey::Guardian, new_guardian);

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    GuardianUpdatedEvent {
        admin,
        new_guardian: new_guardian.clone(),
    }
    .publish(env);

    Ok(())
}

/// Triggers emergency pause.
/// Caller must be either active Admin OR configured Guardian.
/// Reverts with `ContractPaused` if already in paused state.
pub fn pause(env: &Env, caller: &Address) -> Result<(), ContractError> {
    caller.require_auth();
    let admin = get_admin(env)?;
    let guardian = get_guardian(env);

    let is_admin = *caller == admin;
    let is_guardian = guardian.is_some_and(|g| *caller == g);

    if !is_admin && !is_guardian {
        return Err(ContractError::Unauthorized);
    }

    if is_paused(env) {
        return Err(ContractError::ContractPaused);
    }

    env.storage().instance().set(&DataKey::IsPaused, &true);

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    ContractPausedEvent {
        caller: caller.clone(),
    }
    .publish(env);

    Ok(())
}

/// Lifts emergency pause.
/// Caller must be active Admin (Guardian is strictly unauthorized to unpause).
/// Reverts with `ContractNotPaused` if contract is not currently paused.
pub fn unpause(env: &Env, caller: &Address) -> Result<(), ContractError> {
    caller.require_auth();
    let admin = get_admin(env)?;
    if *caller != admin {
        return Err(ContractError::Unauthorized);
    }

    if !is_paused(env) {
        return Err(ContractError::ContractNotPaused);
    }

    env.storage().instance().set(&DataKey::IsPaused, &false);

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    ContractUnpausedEvent {
        admin: caller.clone(),
    }
    .publish(env);

    Ok(())
}

/// Upgrades the contract WASM bytecode in-place using native Soroban deployer.
/// Caller must be active Admin.
/// Reverts with `InvalidWasmHash` if the hash is 32 zero bytes.
#[allow(deprecated)]
pub fn upgrade(
    env: &Env,
    caller: &Address,
    new_wasm_hash: &BytesN<32>,
) -> Result<(), ContractError> {
    caller.require_auth();
    let admin = get_admin(env)?;
    if *caller != admin {
        return Err(ContractError::Unauthorized);
    }

    // Guard against blank/zero WASM hash
    if new_wasm_hash.to_array() == [0u8; 32] {
        return Err(ContractError::InvalidWasmHash);
    }

    env.deployer()
        .update_current_contract_wasm(new_wasm_hash.clone());

    let maturity: u64 = env
        .storage()
        .instance()
        .get(&DataKey::Maturity)
        .unwrap_or(0);
    bump_instance_ttl(env, maturity);

    ContractUpgradedEvent {
        admin,
        new_wasm_hash: new_wasm_hash.clone(),
    }
    .publish(env);

    Ok(())
}

// =============================================================================
// Ergonomic Aliases / Compatibility Wrappers
// =============================================================================

#[inline(always)]
pub fn get_admin_internal(env: &Env) -> Result<Address, ContractError> {
    get_admin(env)
}

#[inline(always)]
pub fn get_pending_admin_internal(env: &Env) -> Option<Address> {
    get_pending_admin(env)
}

#[inline(always)]
pub fn get_guardian_internal(env: &Env) -> Option<Address> {
    get_guardian(env)
}

#[inline(always)]
pub fn is_paused_internal(env: &Env) -> bool {
    is_paused(env)
}

#[inline(always)]
pub fn propose_admin_internal(
    env: &Env,
    caller: &Address,
    new_admin: &Address,
    _maturity: u64,
) -> Result<(), ContractError> {
    propose_admin(env, caller, new_admin)
}

#[inline(always)]
pub fn accept_admin_internal(
    env: &Env,
    caller: &Address,
    _maturity: u64,
) -> Result<(), ContractError> {
    accept_admin(env, caller)
}

#[inline(always)]
pub fn set_guardian_internal(
    env: &Env,
    caller: &Address,
    new_guardian: &Address,
    _maturity: u64,
) -> Result<(), ContractError> {
    set_guardian(env, caller, new_guardian)
}

#[inline(always)]
pub fn pause_internal(env: &Env, caller: &Address, _maturity: u64) -> Result<(), ContractError> {
    pause(env, caller)
}

#[inline(always)]
pub fn unpause_internal(env: &Env, caller: &Address, _maturity: u64) -> Result<(), ContractError> {
    unpause(env, caller)
}

#[inline(always)]
pub fn upgrade_internal(
    env: &Env,
    caller: &Address,
    new_wasm_hash: &BytesN<32>,
    _maturity: u64,
) -> Result<(), ContractError> {
    upgrade(env, caller, new_wasm_hash)
}

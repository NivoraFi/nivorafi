use crate::errors::ContractError;
use crate::storage_keys::DataKey;
use soroban_sdk::Env;

pub fn with_non_reentrant<T, F>(env: &Env, f: F) -> Result<T, ContractError>
where
    F: FnOnce() -> Result<T, ContractError>,
{
    let guard_key = DataKey::FlashLoanGuard;
    if env.storage().temporary().has(&guard_key) {
        return Err(ContractError::ReentrancyLocked);
    }
    env.storage().temporary().set(&guard_key, &true);
    let result = f();
    env.storage().temporary().remove(&guard_key);
    result
}

#![no_std]
#![allow(clippy::too_many_arguments)]

use common::errors::ContractError;
use common::events::{ApproveEvent, BurnEvent, MintEvent, TransferEvent};
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey};
use common::ttl::{bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String};

#[cfg(test)]
mod test;

#[contract]
pub struct PrincipalToken;

impl PrincipalToken {
    fn init_internal(
        env: &Env,
        auth_caller: &Address,
        admin: &Address,
        market: &Address,
        name: &String,
        symbol: &String,
        decimals: u32,
        maturity: u64,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        auth_caller.require_auth();
        if maturity <= env.ledger().timestamp() {
            return Err(ContractError::InvalidMaturity);
        }

        env.storage().instance().set(&DataKey::Admin, admin);
        env.storage().instance().set(&DataKey::Market, market);
        env.storage().instance().set(&DataKey::Name, name);
        env.storage().instance().set(&DataKey::Symbol, symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Maturity, &maturity);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(env, maturity);
        Ok(())
    }
}

#[contractimpl]
impl PrincipalToken {
    pub fn initialize(
        env: Env,
        admin: Address,
        market: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    ) -> Result<(), ContractError> {
        Self::init_internal(&env, &admin, &admin, &market, &name, &symbol, decimals, maturity)
    }

    pub fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        market: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    ) -> Result<(), ContractError> {
        Self::init_internal(
            &env,
            &deployer,
            &admin,
            &market,
            &name,
            &symbol,
            decimals,
            maturity,
        )
    }

    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), ContractError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::Market)
            .ok_or(ContractError::NotInitialized)?;
        market.require_auth();
        common::governance::check_not_paused(&env)?;

        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let bal_key = DataKey::Balance(to.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_bal = current_bal
            .checked_add(amount)
            .ok_or(ContractError::MathOverflow)?;
        env.storage().persistent().set(&bal_key, &new_bal);
        bump_persistent_ttl(&env, &bal_key, maturity);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_add(amount)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);
        bump_instance_ttl(&env, maturity);
        MintEvent { to, amount }.publish(&env);

        Ok(())
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), ContractError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::Market)
            .ok_or(ContractError::NotInitialized)?;
        market.require_auth();
        common::governance::check_not_paused(&env)?;

        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let bal_key = DataKey::Balance(from.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        if current_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }
        let new_bal = current_bal - amount;
        env.storage().persistent().set(&bal_key, &new_bal);
        bump_persistent_ttl(&env, &bal_key, maturity);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_sub(amount)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);
        bump_instance_ttl(&env, maturity);
        BurnEvent { from, amount }.publish(&env);

        Ok(())
    }

    // =========================================================================
    // SEP-41 Fungible Token Implementation
    // =========================================================================

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(
        env: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        from.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let from_key = DataKey::Balance(from.clone());
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }

        if from == to {
            bump_persistent_ttl(&env, &from_key, maturity);
            bump_instance_ttl(&env, maturity);
            TransferEvent { from, to, amount }.publish(&env);
            return Ok(());
        }

        let to_key = DataKey::Balance(to.clone());
        let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);

        let new_from = from_bal - amount;
        let new_to = to_bal
            .checked_add(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage().persistent().set(&from_key, &new_from);
        env.storage().persistent().set(&to_key, &new_to);

        bump_persistent_ttl(&env, &from_key, maturity);
        bump_persistent_ttl(&env, &to_key, maturity);
        bump_instance_ttl(&env, maturity);
        TransferEvent { from, to, amount }.publish(&env);

        Ok(())
    }

    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        spender.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let allow_key = AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        };
        let allowance: Option<AllowanceValue> = env
            .storage()
            .temporary()
            .get(&DataKey::Allowance(allow_key.clone()));
        let mut allow_val = match allowance {
            Some(v) => {
                if v.expiration_ledger < env.ledger().sequence() {
                    return Err(ContractError::InsufficientAllowance);
                }
                v
            }
            None => return Err(ContractError::InsufficientAllowance),
        };

        if allow_val.amount < amount {
            return Err(ContractError::InsufficientAllowance);
        }

        let from_key = DataKey::Balance(from.clone());
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }

        if from != to {
            let to_key = DataKey::Balance(to.clone());
            let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);

            let new_from = from_bal - amount;
            let new_to = to_bal
                .checked_add(amount)
                .ok_or(ContractError::MathOverflow)?;

            env.storage().persistent().set(&from_key, &new_from);
            env.storage().persistent().set(&to_key, &new_to);
            bump_persistent_ttl(&env, &to_key, maturity);
        }

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            common::ttl::bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
        }

        bump_persistent_ttl(&env, &from_key, maturity);
        bump_instance_ttl(&env, maturity);
        TransferEvent { from, to, amount }.publish(&env);

        Ok(())
    }

    pub fn approve(
        env: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), ContractError> {
        from.require_auth();
        if amount < 0 {
            return Err(ContractError::ZeroAmount);
        }
        let key = AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        };
        let val = AllowanceValue {
            amount,
            expiration_ledger,
        };
        let storage_key = DataKey::Allowance(key);
        env.storage().temporary().set(&storage_key, &val);
        common::ttl::bump_allowance_ttl(&env, &storage_key, expiration_ledger);
        ApproveEvent {
            from,
            spender,
            amount,
            expiration_ledger,
        }
        .publish(&env);
        Ok(())
    }

    pub fn allowance(env: Env, from: Address, spender: Address) -> i128 {
        let key = AllowanceKey { from, spender };
        let allowance: Option<AllowanceValue> =
            env.storage().temporary().get(&DataKey::Allowance(key));
        match allowance {
            Some(v) => {
                if v.expiration_ledger < env.ledger().sequence() {
                    0
                } else {
                    v.amount
                }
            }
            None => 0,
        }
    }

    pub fn burn_from(
        env: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        spender.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let allow_key = AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        };
        let allowance: Option<AllowanceValue> = env
            .storage()
            .temporary()
            .get(&DataKey::Allowance(allow_key.clone()));
        let mut allow_val = match allowance {
            Some(v) => {
                if v.expiration_ledger < env.ledger().sequence() {
                    return Err(ContractError::InsufficientAllowance);
                }
                v
            }
            None => return Err(ContractError::InsufficientAllowance),
        };

        if allow_val.amount < amount {
            return Err(ContractError::InsufficientAllowance);
        }

        let from_key = DataKey::Balance(from.clone());
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }
        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_sub(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            common::ttl::bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
        }

        bump_persistent_ttl(&env, &from_key, maturity);
        bump_instance_ttl(&env, maturity);
        BurnEvent { from, amount }.publish(&env);

        Ok(())
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Decimals)
            .unwrap_or(7)
    }

    pub fn name(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Name)
            .unwrap_or_else(|| String::from_str(&env, "Principal Token"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "PT"))
    }

    pub fn maturity(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0)
    }

    // =========================================================================
    // Enterprise Security, Governance & Pause
    // =========================================================================

    pub fn propose_admin(
        env: Env,
        caller: Address,
        new_admin: Address,
    ) -> Result<(), ContractError> {
        common::governance::propose_admin(&env, &caller, &new_admin)
    }

    pub fn accept_admin(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::accept_admin(&env, &caller)
    }

    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        common::governance::get_admin(&env)
    }

    pub fn get_pending_admin(env: Env) -> Option<Address> {
        common::governance::get_pending_admin(&env)
    }

    pub fn set_guardian(
        env: Env,
        caller: Address,
        new_guardian: Address,
    ) -> Result<(), ContractError> {
        common::governance::set_guardian(&env, &caller, &new_guardian)
    }

    pub fn get_guardian(env: Env) -> Option<Address> {
        common::governance::get_guardian(&env)
    }

    pub fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::pause(&env, &caller)
    }

    pub fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::unpause(&env, &caller)
    }

    pub fn is_paused(env: Env) -> bool {
        common::governance::is_paused(&env)
    }

    pub fn upgrade(
        env: Env,
        caller: Address,
        new_wasm_hash: BytesN<32>,
    ) -> Result<(), ContractError> {
        common::governance::upgrade(&env, &caller, &new_wasm_hash)
    }
}

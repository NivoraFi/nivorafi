#![no_std]
#![allow(clippy::too_many_arguments)]

use common::errors::ContractError;
use common::events::{ApproveEvent, BurnEvent, MintEvent, TransferEvent, YieldClaimedEvent};
use common::interfaces::StandardizedYieldClient;
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey, UserYieldState};
use common::ttl::{bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String};

#[cfg(test)]
mod test;

#[contract]
pub struct YieldToken;

impl YieldToken {
    fn init_internal(
        env: &Env,
        auth_caller: &Address,
        admin: &Address,
        market: &Address,
        sy_contract: &Address,
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
        env.storage()
            .instance()
            .set(&DataKey::SyContract, sy_contract);
        env.storage().instance().set(&DataKey::Name, name);
        env.storage().instance().set(&DataKey::Symbol, symbol);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Maturity, &maturity);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::GlobalAccruedYield, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalYieldWeight, &0i128);
        env.storage().instance().set(&DataKey::IsSettled, &false);
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(env, maturity);
        Ok(())
    }
}

#[contractimpl]
#[allow(clippy::too_many_arguments)]
impl YieldToken {
    pub fn initialize(
        env: Env,
        admin: Address,
        market: Address,
        sy_contract: Address,
        name: String,
        symbol: String,
        decimals: u32,
        maturity: u64,
    ) -> Result<(), ContractError> {
        Self::init_internal(
            &env,
            &admin,
            &admin,
            &market,
            &sy_contract,
            &name,
            &symbol,
            decimals,
            maturity,
        )
    }

    pub fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        market: Address,
        sy_contract: Address,
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
            &sy_contract,
            &name,
            &symbol,
            decimals,
            maturity,
        )
    }

    fn current_py_index(env: &Env, update_storage: bool) -> Result<i128, ContractError> {
        let is_settled: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsSettled)
            .unwrap_or(false);
        if is_settled {
            return Ok(env
                .storage()
                .instance()
                .get(&DataKey::MaturityIndex)
                .unwrap_or(common::fixed_point::SCALAR_9));
        }

        let sy_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SyContract)
            .ok_or(ContractError::NotInitialized)?;
        let sy_client = StandardizedYieldClient::new(env, &sy_addr);
        let raw_rate = sy_client.exchange_rate();
        if raw_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        let prev_max: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LastKnownIndex)
            .unwrap_or(0);
        let effective_index = raw_rate.max(prev_max);

        if update_storage {
            if effective_index > prev_max {
                env.storage()
                    .instance()
                    .set(&DataKey::LastKnownIndex, &effective_index);
            }
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .unwrap_or(0);
            if env.ledger().timestamp() >= maturity {
                env.storage()
                    .instance()
                    .set(&DataKey::MaturityIndex, &effective_index);
                env.storage()
                    .instance()
                    .set(&DataKey::LastKnownIndex, &effective_index);
                env.storage().instance().set(&DataKey::IsSettled, &true);
                bump_instance_ttl(env, maturity);
            }
        }

        Ok(effective_index)
    }

    pub fn get_py_index(env: Env) -> Result<i128, ContractError> {
        Self::current_py_index(&env, false)
    }

    fn update_checkpoint(
        env: &Env,
        user: &Address,
        new_yt_balance: i128,
    ) -> Result<(), ContractError> {
        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);
        let effective_index = Self::current_py_index(env, true)?;

        let state_key = DataKey::UserYieldState(user.clone());
        let current_state: Option<UserYieldState> = env.storage().persistent().get(&state_key);

        let (old_weight, old_unclaimed) = match &current_state {
            Some(s) => {
                let w = if s.yt_balance > 0 && s.last_index > 0 {
                    common::fixed_point::wad_div(s.yt_balance, s.last_index)?
                } else {
                    0
                };
                (w, s.unclaimed_yield)
            }
            None => (0, 0),
        };

        let user_state = match current_state {
            Some(mut state) => {
                if state.last_index > 0
                    && effective_index > state.last_index
                    && state.yt_balance > 0
                {
                    let index_delta = effective_index - state.last_index;
                    let accrued = match state.yt_balance.checked_mul(index_delta) {
                        Some(prod) => prod / state.last_index,
                        None => return Err(ContractError::MathOverflow),
                    };
                    state.unclaimed_yield = state
                        .unclaimed_yield
                        .checked_add(accrued)
                        .ok_or(ContractError::MathOverflow)?;
                }
                state.last_index = effective_index;
                state.yt_balance = new_yt_balance;
                state
            }
            None => UserYieldState {
                yt_balance: new_yt_balance,
                last_index: effective_index,
                unclaimed_yield: 0,
            },
        };

        let new_weight = if user_state.yt_balance > 0 {
            common::fixed_point::wad_div(user_state.yt_balance, effective_index)?
        } else {
            0
        };

        let global_accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalAccruedYield)
            .unwrap_or(0);
        let delta_unclaimed = user_state
            .unclaimed_yield
            .checked_sub(old_unclaimed)
            .ok_or(ContractError::MathOverflow)?;
        let new_global_accrued = global_accrued
            .checked_add(delta_unclaimed)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::GlobalAccruedYield, &new_global_accrued);

        let total_weight: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalYieldWeight)
            .unwrap_or(0);
        let new_total_weight = common::fixed_point::pos_sub(total_weight, old_weight)
            .checked_add(new_weight)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalYieldWeight, &new_total_weight);

        env.storage().persistent().set(&state_key, &user_state);
        bump_persistent_ttl(env, &state_key, maturity);
        Ok(())
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

        Self::update_checkpoint(&env, &to, new_bal)?;

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

        Self::update_checkpoint(&env, &from, new_bal)?;

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

    pub fn claim_user_yield(env: Env, user: Address) -> Result<i128, ContractError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::Market)
            .ok_or(ContractError::NotInitialized)?;
        market.require_auth();
        common::governance::check_not_paused(&env)?;

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);

        let current_bal: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(user.clone()))
            .unwrap_or(0);

        // Bring checkpoint up to date
        Self::update_checkpoint(&env, &user, current_bal)?;

        let state_key = DataKey::UserYieldState(user.clone());
        let mut user_state: UserYieldState =
            env.storage()
                .persistent()
                .get(&state_key)
                .unwrap_or(UserYieldState {
                    yt_balance: 0,
                    last_index: 0,
                    unclaimed_yield: 0,
                });

        let payout = user_state.unclaimed_yield;
        user_state.unclaimed_yield = 0;
        env.storage().persistent().set(&state_key, &user_state);
        if payout > 0 {
            let global_accrued: i128 = env
                .storage()
                .instance()
                .get(&DataKey::GlobalAccruedYield)
                .unwrap_or(0);
            env.storage().instance().set(
                &DataKey::GlobalAccruedYield,
                &common::fixed_point::pos_sub(global_accrued, payout),
            );
        }
        bump_persistent_ttl(&env, &state_key, maturity);
        bump_instance_ttl(&env, maturity);
        YieldClaimedEvent {
            user: user.clone(),
            receiver: user,
            yield_out: payout,
        }
        .publish(&env);

        Ok(payout)
    }

    /// Synchronizes maturity settlement from the YieldPool market contract.
    /// Intentionally NOT gated by `check_not_paused` so paused settlement works.
    pub fn settle_maturity(env: Env, maturity_index: i128) -> Result<i128, ContractError> {
        let market: Address = env
            .storage()
            .instance()
            .get(&DataKey::Market)
            .ok_or(ContractError::NotInitialized)?;
        market.require_auth();

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .ok_or(ContractError::NotInitialized)?;
        if env.ledger().timestamp() < maturity {
            return Err(ContractError::MarketNotYetMatured);
        }
        if maturity_index <= 0 {
            return Err(ContractError::InvalidRate);
        }

        let is_settled: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsSettled)
            .unwrap_or(false);
        if is_settled {
            let existing: i128 = env
                .storage()
                .instance()
                .get(&DataKey::MaturityIndex)
                .unwrap_or(maturity_index);
            return Ok(existing);
        }

        let prev_max: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LastKnownIndex)
            .unwrap_or(0);
        let pinned = maturity_index.max(prev_max);

        env.storage()
            .instance()
            .set(&DataKey::MaturityIndex, &pinned);
        env.storage()
            .instance()
            .set(&DataKey::LastKnownIndex, &pinned);
        env.storage().instance().set(&DataKey::IsSettled, &true);
        bump_instance_ttl(&env, maturity);
        Ok(pinned)
    }

    pub fn get_total_unclaimed_yield(env: Env) -> Result<i128, ContractError> {
        let global_accrued: i128 = env
            .storage()
            .instance()
            .get(&DataKey::GlobalAccruedYield)
            .unwrap_or(0);
        let total_weight: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalYieldWeight)
            .unwrap_or(0);
        if total_weight == 0 {
            return Ok(global_accrued);
        }

        let effective_index = Self::get_py_index(env.clone())?;
        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);

        let scaled = common::fixed_point::wad_mul(effective_index, total_weight)?;
        let unmaterialized = if scaled > total_supply {
            scaled - total_supply
        } else {
            0
        };
        global_accrued
            .checked_add(unmaterialized)
            .ok_or(ContractError::MathOverflow)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn get_user_yield_state(env: Env, user: Address) -> UserYieldState {
        env.storage()
            .persistent()
            .get(&DataKey::UserYieldState(user))
            .unwrap_or(UserYieldState {
                yt_balance: 0,
                last_index: 0,
                unclaimed_yield: 0,
            })
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
            Self::update_checkpoint(&env, &from, from_bal)?;
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

        // Update checkpoint hooks for both parties
        Self::update_checkpoint(&env, &from, new_from)?;
        Self::update_checkpoint(&env, &to, new_to)?;

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

        if from == to {
            Self::update_checkpoint(&env, &from, from_bal)?;
        } else {
            let to_key = DataKey::Balance(to.clone());
            let to_bal: i128 = env.storage().persistent().get(&to_key).unwrap_or(0);

            let new_from = from_bal - amount;
            let new_to = to_bal
                .checked_add(amount)
                .ok_or(ContractError::MathOverflow)?;

            Self::update_checkpoint(&env, &from, new_from)?;
            Self::update_checkpoint(&env, &to, new_to)?;

            env.storage().persistent().set(&from_key, &new_from);
            env.storage().persistent().set(&to_key, &new_to);
            bump_persistent_ttl(&env, &to_key, maturity);
        }

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key.clone());
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

        let new_bal = from_bal - amount;
        Self::update_checkpoint(&env, &from, new_bal)?;

        env.storage().persistent().set(&from_key, &new_bal);
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key.clone());
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
            .unwrap_or_else(|| String::from_str(&env, "Yield Token"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "YT"))
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

#![no_std]

use common::errors::ContractError;
use common::events::{ApproveEvent, BurnEvent, DepositEvent, RedeemEvent, TransferEvent};
use common::fixed_point::SCALAR_9;
use common::interfaces::{
    BlendPoolClient, Request, ReserveData, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL,
};
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey};
use common::ttl::{bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env, String, Vec};

#[cfg(test)]
mod test;

#[contract]
pub struct StandardizedYield;

#[contractimpl]
impl StandardizedYield {
    pub fn initialize(
        env: Env,
        admin: Address,
        underlying_asset: Address,
        blend_pool: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::UnderlyingAsset, &underlying_asset);
        env.storage()
            .instance()
            .set(&DataKey::BlendPool, &blend_pool);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
        env.storage().instance().set(&DataKey::Decimals, &7u32);
        env.storage().instance().set(
            &DataKey::Name,
            &String::from_str(&env, "Standardized Yield Blend USDC"),
        );
        env.storage()
            .instance()
            .set(&DataKey::Symbol, &String::from_str(&env, "sy-bUSDC"));
        env.storage().instance().set(&DataKey::Initialized, &true);
        bump_instance_ttl(&env, 0);
        Ok(())
    }

    pub fn deposit(
        env: Env,
        caller: Address,
        receiver: Address,
        amount: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        let blend_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::BlendPool)
            .ok_or(ContractError::NotInitialized)?;

        let token_client = token::Client::new(&env, &underlying);
        let blend_client = BlendPoolClient::new(&env, &blend_pool_addr);

        // Pull underlying from caller to wrapper, then transfer to blend pool
        token_client.transfer(&caller, env.current_contract_address(), &amount);
        token_client.transfer(&env.current_contract_address(), &blend_pool_addr, &amount);

        // Submit supply collateral to Blend (spender is blend_pool_addr since tokens are already there)
        let mut requests = Vec::new(&env);
        requests.push_back(Request {
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            address: underlying.clone(),
            amount,
        });

        blend_client.submit(
            &env.current_contract_address(),
            &blend_pool_addr,
            &env.current_contract_address(),
            &requests,
        );

        let reserve: ReserveData = blend_client.get_reserve(&underlying);
        let b_rate = reserve.b_rate;
        if b_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        // Shares minted: (amount * SCALAR_9) / b_rate
        let shares = match amount.checked_mul(SCALAR_9) {
            Some(prod) => prod / b_rate,
            None => return Err(ContractError::MathOverflow),
        };
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let current_bal: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(receiver.clone()))
            .unwrap_or(0);
        let new_bal = current_bal
            .checked_add(shares)
            .ok_or(ContractError::MathOverflow)?;
        let bal_key = DataKey::Balance(receiver.clone());
        env.storage().persistent().set(&bal_key, &new_bal);
        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_add(shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        DepositEvent {
            caller,
            receiver,
            underlying_amount: amount,
            shares_minted: shares,
        }
        .publish(&env);

        Ok(shares)
    }

    pub fn redeem(
        env: Env,
        caller: Address,
        receiver: Address,
        shares: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let current_bal: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(caller.clone()))
            .unwrap_or(0);
        if current_bal < shares {
            return Err(ContractError::InsufficientBalance);
        }

        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        let blend_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::BlendPool)
            .ok_or(ContractError::NotInitialized)?;

        let blend_client = BlendPoolClient::new(&env, &blend_pool_addr);
        let reserve: ReserveData = blend_client.get_reserve(&underlying);
        let b_rate = reserve.b_rate;
        if b_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        // Underlying payout: (shares * b_rate) / SCALAR_9
        let underlying_amount = match shares.checked_mul(b_rate) {
            Some(prod) => prod / SCALAR_9,
            None => return Err(ContractError::MathOverflow),
        };
        if underlying_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let bal_key = DataKey::Balance(caller.clone());
        env.storage()
            .persistent()
            .set(&bal_key, &(current_bal - shares));
        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_sub(shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        // Withdraw collateral from Blend directly to receiver
        let mut requests = Vec::new(&env);
        requests.push_back(Request {
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
            address: underlying,
            amount: underlying_amount,
        });

        blend_client.submit(
            &env.current_contract_address(),
            &env.current_contract_address(),
            &receiver,
            &requests,
        );

        RedeemEvent {
            caller,
            receiver,
            shares_burned: shares,
            assets_out: underlying_amount,
        }
        .publish(&env);

        Ok(underlying_amount)
    }

    pub fn exchange_rate(env: Env) -> Result<i128, ContractError> {
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        let blend_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::BlendPool)
            .ok_or(ContractError::NotInitialized)?;
        let blend_client = BlendPoolClient::new(&env, &blend_pool_addr);
        let reserve: ReserveData = blend_client.get_reserve(&underlying);
        let b_rate = reserve.b_rate;
        if b_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }
        Ok(b_rate)
    }

    pub fn asset(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn blend_pool(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::BlendPool)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn total_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
    }

    pub fn total_supply(env: Env) -> i128 {
        Self::total_shares(env)
    }

    pub fn redeem_to_btoken(
        env: Env,
        caller: Address,
        receiver: Address,
        shares: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let current_bal: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(caller.clone()))
            .unwrap_or(0);
        if current_bal < shares {
            return Err(ContractError::InsufficientBalance);
        }

        let blend_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::BlendPool)
            .ok_or(ContractError::NotInitialized)?;

        let blend_client = BlendPoolClient::new(&env, &blend_pool_addr);

        let bal_key = DataKey::Balance(caller.clone());
        let new_bal = current_bal - shares;
        env.storage().persistent().set(&bal_key, &new_bal);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_sub(shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        let btokens = shares;
        blend_client.transfer_collateral(&env.current_contract_address(), &receiver, &btokens);

        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        RedeemEvent {
            caller,
            receiver,
            shares_burned: shares,
            assets_out: btokens,
        }
        .publish(&env);

        Ok(btokens)
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
        let from_key = DataKey::Balance(from.clone());
        let from_bal: i128 = env.storage().persistent().get(&from_key).unwrap_or(0);
        if from_bal < amount {
            return Err(ContractError::InsufficientBalance);
        }
        if from == to {
            bump_persistent_ttl(&env, &from_key, 0);
            bump_instance_ttl(&env, 0);
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
        bump_persistent_ttl(&env, &from_key, 0);
        bump_persistent_ttl(&env, &to_key, 0);
        bump_instance_ttl(&env, 0);
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
            bump_persistent_ttl(&env, &to_key, 0);
        }
        bump_persistent_ttl(&env, &from_key, 0);
        bump_instance_ttl(&env, 0);

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
        }
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
        bump_allowance_ttl(&env, &storage_key, expiration_ledger);
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

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), ContractError> {
        from.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
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
        bump_persistent_ttl(&env, &from_key, 0);
        bump_instance_ttl(&env, 0);
        BurnEvent { from, amount }.publish(&env);
        Ok(())
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
        bump_persistent_ttl(&env, &from_key, 0);
        bump_instance_ttl(&env, 0);

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
        }
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
            .unwrap_or_else(|| String::from_str(&env, "Standardized Yield"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "SY"))
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

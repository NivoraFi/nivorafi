#![no_std]

use common::errors::ContractError;
use common::events::{ApproveEvent, BurnEvent, DepositEvent, RedeemEvent, TransferEvent};
use common::fixed_point::SCALAR_9;
use common::interfaces::SlenderPoolClient;
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey};
use common::ttl::{bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{contract, contractimpl, token, vec, Address, BytesN, Env, IntoVal, String, Symbol};

#[cfg(test)]
mod test;

#[contract]
pub struct StandardizedYieldSlender;

impl StandardizedYieldSlender {
    fn init_internal(
        env: &Env,
        auth_caller: &Address,
        admin: &Address,
        underlying_asset: &Address,
        slender_pool: &Address,
        s_token: &Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        auth_caller.require_auth();
        let current = env.current_contract_address();
        if *slender_pool == *underlying_asset
            || *slender_pool == current
            || *s_token == *underlying_asset
            || *s_token == current
        {
            return Err(ContractError::IdenticalAddresses);
        }

        let (decimals, sym_buf, sym_len) =
            common::metadata::resolve_token_metadata(env, underlying_asset);
        let sym_slice = &sym_buf[..sym_len];
        let name = common::metadata::join3(env, b"Standardized Yield Slender ", sym_slice, b"");
        let symbol = common::metadata::join3(env, b"sy-s", sym_slice, b"");

        env.storage().instance().set(&DataKey::Admin, admin);
        env.storage()
            .instance()
            .set(&DataKey::UnderlyingAsset, underlying_asset);
        env.storage()
            .instance()
            .set(&DataKey::SlenderPool, slender_pool);
        env.storage().instance().set(&DataKey::SToken, s_token);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Initialized, &true);
        bump_instance_ttl(env, 0);
        Ok(())
    }
}

#[contractimpl]
impl StandardizedYieldSlender {
    pub fn initialize(
        env: Env,
        admin: Address,
        underlying_asset: Address,
        slender_pool: Address,
        s_token: Address,
    ) -> Result<(), ContractError> {
        Self::init_internal(
            &env,
            &admin,
            &admin,
            &underlying_asset,
            &slender_pool,
            &s_token,
        )
    }

    pub fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        underlying_asset: Address,
        slender_pool: Address,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        let s_token = SlenderPoolClient::new(&env, &slender_pool)
            .try_s_token()
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_else(|| slender_pool.clone());
        Self::init_internal(
            &env,
            &deployer,
            &admin,
            &underlying_asset,
            &slender_pool,
            &s_token,
        )
    }

    pub fn set_slender_pool(
        env: Env,
        caller: Address,
        new_pool: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if new_pool == underlying || new_pool == env.current_contract_address() {
            return Err(ContractError::IdenticalAddresses);
        }
        env.storage()
            .instance()
            .set(&DataKey::SlenderPool, &new_pool);
        bump_instance_ttl(&env, 0);
        Ok(())
    }

    pub fn set_s_token(
        env: Env,
        caller: Address,
        new_s_token: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if new_s_token == underlying || new_s_token == env.current_contract_address() {
            return Err(ContractError::IdenticalAddresses);
        }
        env.storage()
            .instance()
            .set(&DataKey::SToken, &new_s_token);
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
        let slender_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SlenderPool)
            .ok_or(ContractError::NotInitialized)?;

        let wrapper = env.current_contract_address();
        let token_client = token::Client::new(&env, &underlying);
        let slender_client = SlenderPoolClient::new(&env, &slender_pool_addr);

        // Pull underlying from caller to wrapper
        token_client.transfer(&caller, &wrapper, &amount);

        // Authorize slender_pool to pull underlying from wrapper during deposit
        env.authorize_as_current_contract(vec![
            &env,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: underlying.clone(),
                    fn_name: Symbol::new(&env, "transfer"),
                    args: vec![
                        &env,
                        wrapper.clone().into_val(&env),
                        slender_pool_addr.into_val(&env),
                        amount.into_val(&env),
                    ],
                },
                sub_invocations: vec![&env],
            }),
        ]);

        slender_client.deposit(&wrapper, &wrapper, &underlying, &amount);

        let liquidity_index = slender_client.get_liquidity_index();
        if liquidity_index <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        // Shares minted: (amount * SCALAR_9) / liquidity_index
        let shares = match amount.checked_mul(SCALAR_9) {
            Some(prod) => prod / liquidity_index,
            None => return Err(ContractError::MathOverflow),
        };
        if shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let bal_key = DataKey::Balance(receiver.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_bal = current_bal
            .checked_add(shares)
            .ok_or(ContractError::MathOverflow)?;
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

        let bal_key = DataKey::Balance(caller.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        if current_bal < shares {
            return Err(ContractError::InsufficientBalance);
        }

        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        let slender_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SlenderPool)
            .ok_or(ContractError::NotInitialized)?;

        let slender_client = SlenderPoolClient::new(&env, &slender_pool_addr);
        let liquidity_index = slender_client.get_liquidity_index();
        if liquidity_index <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        // Underlying payout: (shares * liquidity_index) / SCALAR_9
        let underlying_amount = match shares.checked_mul(liquidity_index) {
            Some(prod) => prod / SCALAR_9,
            None => return Err(ContractError::MathOverflow),
        };
        if underlying_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

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

        slender_client.withdraw(
            &env.current_contract_address(),
            &receiver,
            &underlying,
            &underlying_amount,
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

        let bal_key = DataKey::Balance(caller.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        if current_bal < shares {
            return Err(ContractError::InsufficientBalance);
        }

        let s_token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SToken)
            .ok_or(ContractError::NotInitialized)?;

        env.storage()
            .persistent()
            .set(&bal_key, &(current_bal - shares));

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

        token::Client::new(&env, &s_token_addr).transfer(
            &env.current_contract_address(),
            &receiver,
            &shares,
        );

        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        RedeemEvent {
            caller,
            receiver,
            shares_burned: shares,
            assets_out: shares,
        }
        .publish(&env);

        Ok(shares)
    }

    pub fn exchange_rate(env: Env) -> Result<i128, ContractError> {
        let slender_pool_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SlenderPool)
            .ok_or(ContractError::NotInitialized)?;
        let slender_client = SlenderPoolClient::new(&env, &slender_pool_addr);
        let liquidity_index = slender_client.get_liquidity_index();
        if liquidity_index <= 0 {
            return Err(ContractError::BlendPoolError);
        }
        Ok(liquidity_index)
    }

    pub fn asset(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn slender_pool(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::SlenderPool)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn s_token(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::SToken)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn blend_pool(env: Env) -> Result<Address, ContractError> {
        Self::slender_pool(env)
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
            .unwrap_or_else(|| String::from_str(&env, "Standardized Yield Slender"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "sy-s"))
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

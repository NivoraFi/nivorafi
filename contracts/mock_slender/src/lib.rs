#![no_std]

use common::errors::ContractError;
use common::events::{ApproveEvent, BurnEvent, MintEvent, RateUpdatedEvent, TransferEvent};
use common::fixed_point::{div_256_64, wad_mul, SCALAR_9};
use common::interfaces::SlenderReserveData;
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey};
use common::ttl::{bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl};
use common::yield_math::SECONDS_PER_YEAR;
use soroban_sdk::{contract, contractimpl, token, Address, Env, String};

#[cfg(test)]
mod test;

#[contract]
pub struct MockSlender;

fn mul_scalar9_div_rem(amount: i128, divisor: i128) -> Result<(u128, u128), ContractError> {
    if amount <= 0 {
        return Err(ContractError::ZeroAmount);
    }
    if divisor <= 0 {
        return Err(ContractError::BlendPoolError);
    }
    let ua = amount as u128;
    let s = SCALAR_9 as u128;
    let d = divisor as u128;

    match ua.checked_mul(s) {
        Some(prod) => Ok((prod / d, prod % d)),
        None => {
            let a_lo = ua as u64 as u128;
            let a_hi = ua >> 64;
            let p0 = a_lo * s;
            let p1 = a_hi * s;
            let mid = (p0 >> 64) + (p1 & 0xFFFF_FFFF_FFFF_FFFF);
            let hi = (p1 >> 64) + (mid >> 64);
            let lo = (mid << 64) | (p0 as u64 as u128);
            div_256_64(hi, lo, d)
        }
    }
}

fn floor_mul_scalar9_div(amount: i128, divisor: i128) -> Result<i128, ContractError> {
    let (q, _) = mul_scalar9_div_rem(amount, divisor)?;
    if q > i128::MAX as u128 {
        return Err(ContractError::MathOverflow);
    }
    Ok(q as i128)
}

fn ceil_mul_scalar9_div(amount: i128, divisor: i128) -> Result<i128, ContractError> {
    let (q, rem) = mul_scalar9_div_rem(amount, divisor)?;
    let s_u128 = if rem > 0 {
        q.checked_add(1).ok_or(ContractError::MathOverflow)?
    } else {
        q
    };
    if s_u128 > i128::MAX as u128 {
        return Err(ContractError::MathOverflow);
    }
    Ok(s_u128 as i128)
}

impl MockSlender {
    fn accrue_internal(env: &Env) -> Result<i128, ContractError> {
        let now = env.ledger().timestamp();
        let last_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastAccrualTime)
            .unwrap_or(now);
        let index_prev: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LastKnownIndex)
            .ok_or(ContractError::NotInitialized)?;

        if now <= last_time {
            return Ok(index_prev);
        }

        let annual_rate: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AnnualRate)
            .unwrap_or(0);
        if annual_rate <= 0 {
            env.storage()
                .instance()
                .set(&DataKey::LastAccrualTime, &now);
            if let Some(asset) = env
                .storage()
                .instance()
                .get::<_, Address>(&DataKey::UnderlyingAsset)
            {
                let reserve = SlenderReserveData {
                    liquidity_index: index_prev,
                    last_time: now,
                    supply_apr: annual_rate,
                };
                env.storage()
                    .instance()
                    .set(&DataKey::ReserveData(asset), &reserve);
            }
            return Ok(index_prev);
        }

        let dt = (now - last_time) as i128;
        let accrued_wad = match annual_rate.checked_mul(dt) {
            Some(prod) => prod / SECONDS_PER_YEAR,
            None => return Err(ContractError::MathOverflow),
        };

        if accrued_wad > 0 {
            let interest = wad_mul(index_prev, accrued_wad)?;
            if interest > 0 {
                let index_new = index_prev
                    .checked_add(interest)
                    .ok_or(ContractError::MathOverflow)?;

                env.storage()
                    .instance()
                    .set(&DataKey::LastKnownIndex, &index_new);
                env.storage()
                    .instance()
                    .set(&DataKey::LastAccrualTime, &now);

                if let Some(asset) = env
                    .storage()
                    .instance()
                    .get::<_, Address>(&DataKey::UnderlyingAsset)
                {
                    let reserve = SlenderReserveData {
                        liquidity_index: index_new,
                        last_time: now,
                        supply_apr: annual_rate,
                    };
                    env.storage()
                        .instance()
                        .set(&DataKey::ReserveData(asset), &reserve);
                }

                RateUpdatedEvent {
                    new_rate: index_new,
                }
                .publish(env);
                return Ok(index_new);
            }
        }

        Ok(index_prev)
    }
}

#[contractimpl]
impl MockSlender {
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        initial_rate: i128,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        if initial_rate <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let now = env.ledger().timestamp();
        let (decimals, sym_buf, sym_len) = common::metadata::resolve_token_metadata(&env, &asset);
        let sym_slice = &sym_buf[..sym_len];
        let name = common::metadata::join3(&env, b"Slender s", sym_slice, b"");
        let symbol = common::metadata::join3(&env, b"s", sym_slice, b"");

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::UnderlyingAsset, &asset);
        env.storage()
            .instance()
            .set(&DataKey::LastKnownIndex, &initial_rate);
        env.storage().instance().set(&DataKey::AnnualRate, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::LastAccrualTime, &now);
        env.storage().instance().set(&DataKey::TotalSupply, &0i128);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);

        let reserve = SlenderReserveData {
            liquidity_index: initial_rate,
            last_time: now,
            supply_apr: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::ReserveData(asset), &reserve);
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(&env, 0);
        Ok(())
    }

    pub fn deposit(
        env: Env,
        from: Address,
        to: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, ContractError> {
        from.require_auth();
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if asset != underlying {
            return Err(ContractError::InvalidAsset);
        }

        let liquidity_index = Self::accrue_internal(&env)?;
        if liquidity_index <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&from, env.current_contract_address(), &amount);

        let s_shares = floor_mul_scalar9_div(amount, liquidity_index)?;
        if s_shares <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let bal_key = DataKey::Balance(to.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        let new_bal = current_bal
            .checked_add(s_shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage().persistent().set(&bal_key, &new_bal);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_add(s_shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        MintEvent {
            to,
            amount: s_shares,
        }
        .publish(&env);

        Ok(s_shares)
    }

    pub fn withdraw(
        env: Env,
        from: Address,
        to: Address,
        asset: Address,
        amount: i128,
    ) -> Result<i128, ContractError> {
        from.require_auth();
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if asset != underlying {
            return Err(ContractError::InvalidAsset);
        }

        let liquidity_index = Self::accrue_internal(&env)?;
        if liquidity_index <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        let s_shares = ceil_mul_scalar9_div(amount, liquidity_index)?;

        let bal_key = DataKey::Balance(from.clone());
        let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
        if current_bal < s_shares {
            return Err(ContractError::InsufficientBalance);
        }
        let new_bal = current_bal - s_shares;
        env.storage().persistent().set(&bal_key, &new_bal);

        let total_supply: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0);
        let new_supply = total_supply
            .checked_sub(s_shares)
            .ok_or(ContractError::MathOverflow)?;
        env.storage()
            .instance()
            .set(&DataKey::TotalSupply, &new_supply);

        bump_persistent_ttl(&env, &bal_key, 0);
        bump_instance_ttl(&env, 0);

        BurnEvent {
            from,
            amount: s_shares,
        }
        .publish(&env);

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        Ok(amount)
    }

    pub fn accrue(env: Env) -> Result<i128, ContractError> {
        let new_rate = Self::accrue_internal(&env)?;
        bump_instance_ttl(&env, 0);
        Ok(new_rate)
    }

    pub fn get_liquidity_index(env: Env) -> Result<i128, ContractError> {
        let current_rate = Self::accrue_internal(&env)?;
        bump_instance_ttl(&env, 0);
        Ok(current_rate)
    }

    pub fn set_liquidity_index(env: Env, new_rate: i128) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        if new_rate <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::LastKnownIndex, &new_rate);
        env.storage()
            .instance()
            .set(&DataKey::LastAccrualTime, &now);

        if let Some(asset) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::UnderlyingAsset)
        {
            let annual_rate: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AnnualRate)
                .unwrap_or(0);
            let reserve = SlenderReserveData {
                liquidity_index: new_rate,
                last_time: now,
                supply_apr: annual_rate,
            };
            env.storage()
                .instance()
                .set(&DataKey::ReserveData(asset), &reserve);
        }

        bump_instance_ttl(&env, 0);
        RateUpdatedEvent { new_rate }.publish(&env);
        Ok(())
    }

    pub fn set_annual_rate(env: Env, new_rate: i128) -> Result<(), ContractError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;
        admin.require_auth();
        if new_rate < 0 {
            return Err(ContractError::InvalidRate);
        }

        Self::accrue_internal(&env)?;
        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::AnnualRate, &new_rate);
        env.storage()
            .instance()
            .set(&DataKey::LastAccrualTime, &now);

        if let Some(asset) = env
            .storage()
            .instance()
            .get::<_, Address>(&DataKey::UnderlyingAsset)
        {
            let liquidity_index: i128 = env
                .storage()
                .instance()
                .get(&DataKey::LastKnownIndex)
                .unwrap_or(SCALAR_9);
            let reserve = SlenderReserveData {
                liquidity_index,
                last_time: now,
                supply_apr: new_rate,
            };
            env.storage()
                .instance()
                .set(&DataKey::ReserveData(asset), &reserve);
        }

        bump_instance_ttl(&env, 0);
        Ok(())
    }

    pub fn get_annual_rate(env: Env) -> Result<i128, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::AnnualRate)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn get_reserve(env: Env, asset: Address) -> Result<SlenderReserveData, ContractError> {
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if asset != underlying {
            return Err(ContractError::InvalidAsset);
        }

        let liquidity_index = Self::accrue_internal(&env)?;
        let now = env.ledger().timestamp();
        let annual_rate: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AnnualRate)
            .unwrap_or(0);

        bump_instance_ttl(&env, 0);
        Ok(SlenderReserveData {
            liquidity_index,
            last_time: now,
            supply_apr: annual_rate,
        })
    }

    pub fn s_token(env: Env) -> Result<Address, ContractError> {
        if !env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::NotInitialized);
        }
        Ok(env.current_contract_address())
    }

    pub fn get_admin(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)
    }

    pub fn asset(env: Env) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)
    }

    // =========================================================================
    // SEP-41 Receipt Token (sToken) Surface
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

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalSupply)
            .unwrap_or(0)
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
            .unwrap_or_else(|| String::from_str(&env, "Slender sToken"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "sTOKEN"))
    }
}

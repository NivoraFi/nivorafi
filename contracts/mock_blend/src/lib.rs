#![no_std]

use common::errors::ContractError;
use common::events::{BurnEvent, MintEvent, RateUpdatedEvent, TransferEvent};
use common::fixed_point::{wad_mul, SCALAR_9};
use common::interfaces::{
    Positions, Request, ReserveData, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL,
};
use common::storage_keys::DataKey;
use common::ttl::{bump_instance_ttl, bump_persistent_ttl};
use common::yield_math::SECONDS_PER_YEAR;
use soroban_sdk::{contract, contractimpl, token, Address, Env, Vec};

#[cfg(test)]
mod test;

#[contract]
pub struct MockBlend;

#[contractimpl]
impl MockBlend {
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
        env.storage().instance().set(&DataKey::Initialized, &true);

        let reserve = ReserveData {
            b_rate: initial_rate,
            d_rate: initial_rate,
            last_time: now,
            supply_apr: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::ReserveData(asset), &reserve);

        bump_instance_ttl(&env, 0);
        Ok(())
    }

    fn accrue_internal(env: &Env) -> Result<i128, ContractError> {
        let now = env.ledger().timestamp();
        let last_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::LastAccrualTime)
            .unwrap_or(now);
        let b_rate_prev: i128 = env
            .storage()
            .instance()
            .get(&DataKey::LastKnownIndex)
            .ok_or(ContractError::NotInitialized)?;

        if now <= last_time {
            return Ok(b_rate_prev);
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
            return Ok(b_rate_prev);
        }

        let dt = (now - last_time) as i128;
        let accrued_wad = match annual_rate.checked_mul(dt) {
            Some(prod) => prod / SECONDS_PER_YEAR,
            None => return Err(ContractError::MathOverflow),
        };

        if accrued_wad > 0 {
            let interest = wad_mul(b_rate_prev, accrued_wad)?;
            if interest > 0 {
                let b_rate_new = b_rate_prev
                    .checked_add(interest)
                    .ok_or(ContractError::MathOverflow)?;

                env.storage()
                    .instance()
                    .set(&DataKey::LastKnownIndex, &b_rate_new);
                env.storage()
                    .instance()
                    .set(&DataKey::LastAccrualTime, &now);

                if let Some(asset) = env
                    .storage()
                    .instance()
                    .get::<_, Address>(&DataKey::UnderlyingAsset)
                {
                    let reserve = ReserveData {
                        b_rate: b_rate_new,
                        d_rate: b_rate_new,
                        last_time: now,
                        supply_apr: annual_rate,
                    };
                    env.storage()
                        .instance()
                        .set(&DataKey::ReserveData(asset), &reserve);
                }

                RateUpdatedEvent {
                    new_rate: b_rate_new,
                }
                .publish(env);
                return Ok(b_rate_new);
            }
        }

        Ok(b_rate_prev)
    }

    pub fn accrue(env: Env) -> Result<i128, ContractError> {
        let new_rate = Self::accrue_internal(&env)?;
        bump_instance_ttl(&env, 0);
        Ok(new_rate)
    }

    pub fn submit(
        env: Env,
        from: Address,
        spender: Address,
        to: Address,
        requests: Vec<Request>,
    ) -> Result<Positions, ContractError> {
        from.require_auth();
        let asset: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;

        let b_rate = Self::accrue_internal(&env)?;
        if b_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }
        let token_client = token::Client::new(&env, &asset);

        for req in requests.iter() {
            if req.amount <= 0 {
                return Err(ContractError::ZeroAmount);
            }
            if req.address != asset {
                return Err(ContractError::InvalidAsset);
            }

            match req.request_type {
                REQUEST_TYPE_SUPPLY_COLLATERAL => {
                    // If spender is mock_blend itself, tokens have already been transferred to mock_blend
                    if spender != env.current_contract_address() {
                        token_client.transfer(
                            &spender,
                            env.current_contract_address(),
                            &req.amount,
                        );
                    }

                    // Calculate bTokens: (amount * SCALAR_9) / b_rate
                    let b_shares = match req.amount.checked_mul(SCALAR_9) {
                        Some(num) => num / b_rate,
                        None => return Err(ContractError::MathOverflow),
                    };

                    let bal_key = DataKey::Balance(to.clone());
                    let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
                    let new_bal = current_bal
                        .checked_add(b_shares)
                        .ok_or(ContractError::MathOverflow)?;
                    env.storage().persistent().set(&bal_key, &new_bal);
                    bump_persistent_ttl(&env, &bal_key, 0);
                    MintEvent {
                        to: to.clone(),
                        amount: b_shares,
                    }
                    .publish(&env);
                }
                REQUEST_TYPE_WITHDRAW_COLLATERAL => {
                    // Calculate bTokens needed: (amount * SCALAR_9) / b_rate
                    let b_shares = match req.amount.checked_mul(SCALAR_9) {
                        Some(num) => num / b_rate,
                        None => return Err(ContractError::MathOverflow),
                    };

                    let bal_key = DataKey::Balance(from.clone());
                    let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
                    if current_bal < b_shares {
                        return Err(ContractError::InsufficientBalance);
                    }
                    let new_bal = current_bal - b_shares;
                    env.storage().persistent().set(&bal_key, &new_bal);
                    bump_persistent_ttl(&env, &bal_key, 0);

                    // Transfer underlying tokens from mock_blend to receiver `to`
                    token_client.transfer(&env.current_contract_address(), &to, &req.amount);
                    BurnEvent {
                        from: from.clone(),
                        amount: b_shares,
                    }
                    .publish(&env);
                }
                _ => return Err(ContractError::BlendPoolError),
            }
        }

        bump_instance_ttl(&env, 0);

        let final_collateral: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(from))
            .unwrap_or(0);

        Ok(Positions {
            liabilities: 0,
            collateral: final_collateral,
            supply: 0,
        })
    }

    pub fn get_b_rate(env: Env) -> Result<i128, ContractError> {
        let current_rate = Self::accrue_internal(&env)?;
        bump_instance_ttl(&env, 0);
        Ok(current_rate)
    }

    pub fn set_b_rate(env: Env, new_rate: i128) -> Result<(), ContractError> {
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
            let reserve = ReserveData {
                b_rate: new_rate,
                d_rate: new_rate,
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
            return Err(ContractError::ZeroAmount);
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
            let b_rate: i128 = env
                .storage()
                .instance()
                .get(&DataKey::LastKnownIndex)
                .unwrap_or(SCALAR_9);
            let reserve = ReserveData {
                b_rate,
                d_rate: b_rate,
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

    pub fn get_reserve(env: Env, asset: Address) -> Result<ReserveData, ContractError> {
        let underlying: Address = env
            .storage()
            .instance()
            .get(&DataKey::UnderlyingAsset)
            .ok_or(ContractError::NotInitialized)?;
        if asset != underlying {
            return Err(ContractError::InvalidAsset);
        }

        let b_rate = Self::accrue_internal(&env)?;
        let now = env.ledger().timestamp();
        let annual_rate: i128 = env
            .storage()
            .instance()
            .get(&DataKey::AnnualRate)
            .unwrap_or(0);

        bump_instance_ttl(&env, 0);
        Ok(ReserveData {
            b_rate,
            d_rate: b_rate,
            last_time: now,
            supply_apr: annual_rate,
        })
    }

    pub fn get_positions(env: Env, account: Address) -> Positions {
        let collateral: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0);
        Positions {
            liabilities: 0,
            collateral,
            supply: 0,
        }
    }

    pub fn get_collateral(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    pub fn transfer_collateral(
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
        let new_to = to_bal
            .checked_add(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));
        env.storage().persistent().set(&to_key, &new_to);
        bump_persistent_ttl(&env, &from_key, 0);
        bump_persistent_ttl(&env, &to_key, 0);
        bump_instance_ttl(&env, 0);
        TransferEvent { from, to, amount }.publish(&env);
        Ok(())
    }
}

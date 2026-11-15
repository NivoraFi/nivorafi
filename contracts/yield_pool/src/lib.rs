#![no_std]
#![allow(clippy::too_many_arguments)]

use common::errors::ContractError;
use common::events::{
    ApproveEvent, BurnEvent, FeeRecipientEvent, LiquidityEvent, MaturitySettledEvent, MintPyEvent,
    RedeemPtEvent, RedeemPyEvent, SwapEvent, TransferEvent, YieldClaimedEvent,
};
use common::fixed_point::{wad_div, wad_mul, WAD};
use common::interfaces::{PrivilegedTokenClient, StandardizedYieldClient};
use common::reentrancy::with_non_reentrant;
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey, MarketState};
use common::ttl::{bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl};
use common::yield_math::{
    calculate_fee_rate, calculate_haircut, calculate_tau_wad, check_market_proportion,
    get_exchange_rate, swap_exact_pt_for_sy_math, swap_exact_sy_for_pt_math,
};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, String};

#[cfg(test)]
mod test;

pub const MINIMUM_LIQUIDITY: i128 = 1_000;

fn int_sqrt_u128(y: u128) -> i128 {
    if y == 0 {
        return 0;
    }
    let mut z = y;
    let mut x = (y / 2) + 1;
    while x < z {
        z = x;
        x = (y / x + x) / 2;
    }
    z as i128
}

#[contract]
pub struct YieldPool;

#[contractimpl]
#[allow(clippy::too_many_arguments)]
impl YieldPool {
    pub fn initialize(
        env: Env,
        admin: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();
        if maturity <= env.ledger().timestamp() {
            return Err(ContractError::InvalidMaturity);
        }
        if scalar_root <= 0 || initial_anchor <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::SyContract, &sy);
        env.storage().instance().set(&DataKey::PtContract, &pt);
        env.storage().instance().set(&DataKey::YtContract, &yt);
        env.storage().instance().set(&DataKey::Maturity, &maturity);
        env.storage()
            .instance()
            .set(&DataKey::ScalarRoot, &scalar_root);
        env.storage()
            .instance()
            .set(&DataKey::InitialAnchor, &initial_anchor);
        // Default 5% annual fee on interest (5 * 10^16)
        env.storage()
            .instance()
            .set(&DataKey::AnnualFeeRate, &50_000_000_000_000_000i128);
        // 20% protocol fee split (2000 bps)
        env.storage()
            .instance()
            .set(&DataKey::ProtocolFeeBps, &2000i128);
        env.storage().instance().set(&DataKey::FeeRecipient, &admin);
        env.storage()
            .instance()
            .set(&DataKey::TotalPtReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalSyReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalLpSupply, &0i128);
        env.storage().instance().set(&DataKey::IsSettled, &false);
        env.storage().instance().set(&DataKey::Decimals, &7u32);
        env.storage()
            .instance()
            .set(&DataKey::Name, &String::from_str(&env, "Pendle LP Token"));
        env.storage()
            .instance()
            .set(&DataKey::Symbol, &String::from_str(&env, "LP-PT-SY"));
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(&env, maturity);
        Ok(())
    }

    // =========================================================================
    // Core Router: Mint PY, Redeem PY, Redeem PT post-maturity
    // =========================================================================

    pub fn mint_py(
        env: Env,
        caller: Address,
        receiver: Address,
        amount: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let yt_client = PrivilegedTokenClient::new(&env, &yt_addr);

            // Pull SY from caller
            sy_client.transfer(&caller, &env.current_contract_address(), &amount);

            // Mint 1 PT and 1 YT to receiver per 1 SY
            pt_client.mint(&receiver, &amount);
            yt_client.mint(&receiver, &amount);

            bump_instance_ttl(&env, maturity);
            MintPyEvent {
                caller,
                receiver,
                sy_in: amount,
                py_out: amount,
            }
            .publish(&env);
            Ok((amount, amount))
        })
    }

    pub fn redeem_py(
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

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let yt_client = PrivilegedTokenClient::new(&env, &yt_addr);

            // Burn 1 PT and 1 YT from caller
            pt_client.burn(&caller, &amount);
            yt_client.burn(&caller, &amount);

            // Transfer 1 SY to receiver
            sy_client.transfer(&env.current_contract_address(), &receiver, &amount);

            bump_instance_ttl(&env, maturity);
            RedeemPyEvent {
                caller,
                receiver,
                py_burned: amount,
                sy_out: amount,
            }
            .publish(&env);
            Ok(amount)
        })
    }

    fn internal_settle_maturity(env: &Env) -> Result<i128, ContractError> {
        let is_settled: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsSettled)
            .unwrap_or(false);
        if is_settled {
            return env
                .storage()
                .instance()
                .get(&DataKey::MaturityIndex)
                .ok_or(ContractError::NotInitialized);
        }

        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .ok_or(ContractError::NotInitialized)?;
        if env.ledger().timestamp() < maturity {
            return Err(ContractError::MarketNotYetMatured);
        }

        let sy_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::SyContract)
            .ok_or(ContractError::NotInitialized)?;
        let sy_client = StandardizedYieldClient::new(env, &sy_addr);
        let current_rate = sy_client.exchange_rate();

        env.storage()
            .instance()
            .set(&DataKey::MaturityIndex, &current_rate);
        env.storage().instance().set(&DataKey::IsSettled, &true);
        bump_instance_ttl(env, maturity);
        MaturitySettledEvent {
            maturity,
            settled_index: current_rate,
        }
        .publish(env);

        Ok(current_rate)
    }

    pub fn settle_maturity(env: Env) -> Result<i128, ContractError> {
        Self::internal_settle_maturity(&env)
    }

    pub fn redeem_pt_post_maturity(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if pt_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() < maturity {
                return Err(ContractError::MarketNotYetMatured);
            }

            Self::internal_settle_maturity(&env)?;

            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);

            // Haircut calculation if vault SY balance < total PT supply
            let vault_balance = sy_client.balance(&env.current_contract_address());
            let pt_caller_balance = pt_client.balance(&caller);
            if pt_caller_balance < pt_amount {
                return Err(ContractError::InsufficientBalance);
            }

            let haircut = calculate_haircut(vault_balance, pt_client.total_supply())?;
            let payout = wad_mul(pt_amount, haircut)?.min(vault_balance);

            pt_client.burn(&caller, &pt_amount);
            if payout > 0 {
                sy_client.transfer(&env.current_contract_address(), &receiver, &payout);
            }

            bump_instance_ttl(&env, maturity);
            RedeemPtEvent {
                caller,
                receiver,
                pt_burned: pt_amount,
                payout,
                is_btoken: false,
            }
            .publish(&env);
            Ok(payout)
        })
    }

    pub fn redeem_pt_to_btoken(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if pt_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() < maturity {
                return Err(ContractError::MarketNotYetMatured);
            }

            Self::internal_settle_maturity(&env)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);

            let pt_caller_balance = pt_client.balance(&caller);
            if pt_caller_balance < pt_amount {
                return Err(ContractError::InsufficientBalance);
            }

            let vault_balance = sy_client.balance(&env.current_contract_address());
            let haircut = calculate_haircut(vault_balance, pt_client.total_supply())?;
            let redeem_shares = wad_mul(pt_amount, haircut)?.min(vault_balance);

            pt_client.burn(&caller, &pt_amount);
            let btokens = if redeem_shares > 0 {
                sy_client.redeem_to_btoken(
                    &env.current_contract_address(),
                    &receiver,
                    &redeem_shares,
                )
            } else {
                0
            };

            bump_instance_ttl(&env, maturity);
            RedeemPtEvent {
                caller,
                receiver,
                pt_burned: pt_amount,
                payout: btokens,
                is_btoken: true,
            }
            .publish(&env);
            Ok(btokens)
        })
    }

    pub fn claim_yield(env: Env, user: Address, receiver: Address) -> Result<i128, ContractError> {
        user.require_auth();
        common::governance::check_not_paused(&env)?;

        with_non_reentrant(&env, || {
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;

            let yt_client = PrivilegedTokenClient::new(&env, &yt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .unwrap_or(0);
            let yield_amount = yt_client.claim_user_yield(&user);
            if yield_amount > 0 {
                let current_rate = sy_client.exchange_rate();
                if current_rate <= 0 {
                    return Err(ContractError::BlendPoolError);
                }
                // Convert underlying yield to SY shares at current exchange rate
                let sy_payout = match yield_amount.checked_mul(common::fixed_point::SCALAR_9) {
                    Some(prod) => prod / current_rate,
                    None => return Err(ContractError::MathOverflow),
                };
                let pool_balance = sy_client.balance(&env.current_contract_address());
                if pool_balance < sy_payout {
                    return Err(ContractError::InsufficientBalance);
                }
                sy_client.transfer(&env.current_contract_address(), &receiver, &sy_payout);
                bump_instance_ttl(&env, maturity);
                YieldClaimedEvent {
                    user,
                    receiver,
                    yield_out: sy_payout,
                }
                .publish(&env);
                Ok(sy_payout)
            } else {
                bump_instance_ttl(&env, maturity);
                Ok(0)
            }
        })
    }

    pub fn set_fee_recipient(
        env: Env,
        admin: Address,
        new_recipient: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();
        let current_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::NotInitialized)?;
        if admin != current_admin {
            return Err(ContractError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::FeeRecipient, &new_recipient);
        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);
        bump_instance_ttl(&env, maturity);
        FeeRecipientEvent {
            admin,
            new_recipient,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_market_state(env: Env) -> Result<MarketState, ContractError> {
        Ok(MarketState {
            total_pt_reserve: env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0),
            total_sy_reserve: env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0),
            total_lp_supply: env
                .storage()
                .instance()
                .get(&DataKey::TotalLpSupply)
                .unwrap_or(0),
            scalar_root: env
                .storage()
                .instance()
                .get(&DataKey::ScalarRoot)
                .unwrap_or(0),
            initial_anchor: env
                .storage()
                .instance()
                .get(&DataKey::InitialAnchor)
                .unwrap_or(0),
            annual_fee_rate: env
                .storage()
                .instance()
                .get(&DataKey::AnnualFeeRate)
                .unwrap_or(0),
            protocol_fee_bps: env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeBps)
                .unwrap_or(0),
            fee_recipient: env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .ok_or(ContractError::NotInitialized)?,
            maturity: env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .unwrap_or(0),
            maturity_index: env
                .storage()
                .instance()
                .get(&DataKey::MaturityIndex)
                .unwrap_or(0),
            is_settled: env
                .storage()
                .instance()
                .get(&DataKey::IsSettled)
                .unwrap_or(false),
        })
    }

    // =========================================================================
    // AMM Entrypoints: Swaps, Liquidity, Exchange Rate
    // =========================================================================

    pub fn swap_exact_pt_for_sy(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_in: i128,
        min_sy_out: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if pt_in <= 0 || min_sy_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;

            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let scalar_root: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ScalarRoot)
                .unwrap_or(0);
            let anchor: i128 = env
                .storage()
                .instance()
                .get(&DataKey::InitialAnchor)
                .unwrap_or(WAD);
            let annual_fee: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AnnualFeeRate)
                .unwrap_or(0);

            let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
            let fee_rate = calculate_fee_rate(tau_wad, annual_fee);

            let swap_res = swap_exact_pt_for_sy_math(
                pt_in,
                pt_res,
                sy_res,
                tau_wad,
                scalar_root,
                anchor,
                fee_rate,
            )?;

            if swap_res.amount_out < min_sy_out {
                return Err(ContractError::SlippageExceeded);
            }

            // Deduct protocol fee from AMM SY reserve so TotalSyReserve matches backing
            let proto_bps: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeBps)
                .unwrap_or(0);
            let proto_fee = swap_res
                .fee
                .checked_mul(proto_bps)
                .ok_or(ContractError::MathOverflow)?
                / 10_000;
            let final_sy_reserve = swap_res
                .new_sy_reserve
                .checked_sub(proto_fee)
                .ok_or(ContractError::InsufficientBalance)?;
            check_market_proportion(swap_res.new_pt_reserve, final_sy_reserve)?;

            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .ok_or(ContractError::NotInitialized)?;

            // Pull PT from caller and update reserves before outbound transfers
            pt_client.transfer(&caller, &env.current_contract_address(), &pt_in);

            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &swap_res.new_pt_reserve);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_reserve);

            if proto_fee > 0 {
                sy_client.transfer(&env.current_contract_address(), &fee_recipient, &proto_fee);
            }

            sy_client.transfer(
                &env.current_contract_address(),
                &receiver,
                &swap_res.amount_out,
            );

            bump_instance_ttl(&env, maturity);
            SwapEvent {
                caller,
                receiver,
                direction: 0,
                amount_in: pt_in,
                amount_out: swap_res.amount_out,
                fee: swap_res.fee,
            }
            .publish(&env);
            Ok((swap_res.amount_out, swap_res.fee))
        })
    }

    pub fn swap_exact_sy_for_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_pt_out: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if sy_in <= 0 || min_pt_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;

            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let scalar_root: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ScalarRoot)
                .unwrap_or(0);
            let anchor: i128 = env
                .storage()
                .instance()
                .get(&DataKey::InitialAnchor)
                .unwrap_or(WAD);
            let annual_fee: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AnnualFeeRate)
                .unwrap_or(0);

            let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
            let fee_rate = calculate_fee_rate(tau_wad, annual_fee);

            let swap_res = swap_exact_sy_for_pt_math(
                sy_in,
                pt_res,
                sy_res,
                tau_wad,
                scalar_root,
                anchor,
                fee_rate,
            )?;

            if swap_res.amount_out < min_pt_out {
                return Err(ContractError::SlippageExceeded);
            }

            // Transfer SY from caller to yield_pool
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_in);

            // Update reserves
            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &swap_res.new_pt_reserve);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &swap_res.new_sy_reserve);

            // Transfer net PT out to receiver
            pt_client.transfer(
                &env.current_contract_address(),
                &receiver,
                &swap_res.amount_out,
            );

            bump_instance_ttl(&env, maturity);
            SwapEvent {
                caller,
                receiver,
                direction: 1,
                amount_in: sy_in,
                amount_out: swap_res.amount_out,
                fee: swap_res.fee,
            }
            .publish(&env);
            Ok((swap_res.amount_out, swap_res.fee))
        })
    }

    pub fn swap_exact_sy_for_yt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_yt_out: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if sy_in <= 0 || min_yt_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let yt_client = PrivilegedTokenClient::new(&env, &yt_addr);

            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let scalar_root: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ScalarRoot)
                .unwrap_or(0);
            let anchor: i128 = env
                .storage()
                .instance()
                .get(&DataKey::InitialAnchor)
                .unwrap_or(WAD);
            let annual_fee: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AnnualFeeRate)
                .unwrap_or(0);

            let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
            let fee_rate = calculate_fee_rate(tau_wad, annual_fee);

            // Initial exchange rate
            let e0 = get_exchange_rate(pt_res, sy_res, tau_wad, scalar_root, anchor)?;
            if e0 <= WAD {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let unit_yield0 = WAD
                .checked_sub(wad_div(WAD, e0)?)
                .ok_or(ContractError::MathOverflow)?;
            let unit_cost0 = unit_yield0
                .checked_add(wad_mul(unit_yield0, fee_rate)?)
                .ok_or(ContractError::MathOverflow)?;
            if unit_cost0 <= 0 {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let mut n = wad_div(sy_in, unit_cost0)?;

            // Refinement step
            let refined_pt = pt_res.checked_add(n).ok_or(ContractError::MathOverflow)?;
            let e1 = get_exchange_rate(refined_pt, sy_res, tau_wad, scalar_root, anchor)?;
            let unit_yield1 = WAD
                .checked_sub(wad_div(WAD, e1)?)
                .ok_or(ContractError::MathOverflow)?;
            let unit_cost1 = unit_yield1
                .checked_add(wad_mul(unit_yield1, fee_rate)?)
                .ok_or(ContractError::MathOverflow)?;
            if unit_cost1 > 0 {
                n = wad_div(sy_in, unit_cost1)?;
            }

            if n <= 0 {
                return Err(ContractError::ZeroAmount);
            }
            if n < min_yt_out {
                return Err(ContractError::SlippageExceeded);
            }

            // Flash swap mechanics: N PT added to reserves, net SY removed from reserves
            let gross_sy_sold = wad_div(n, e1)?;
            let yield_cost = n
                .checked_sub(gross_sy_sold)
                .ok_or(ContractError::NegativeYieldNotSupported)?;
            let fee = wad_mul(yield_cost, fee_rate)?;
            let net_sy_sold = gross_sy_sold;

            let protocol_bps: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeBps)
                .unwrap_or(0);
            let protocol_fee = fee
                .checked_mul(protocol_bps)
                .ok_or(ContractError::MathOverflow)?
                / 10_000;
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .ok_or(ContractError::NotInitialized)?;

            let new_pt_res = pt_res.checked_add(n).ok_or(ContractError::MathOverflow)?;
            let final_sy_res = sy_res
                .checked_sub(net_sy_sold)
                .ok_or(ContractError::InsufficientBalance)?;
            check_market_proportion(new_pt_res, final_sy_res)?;
            if new_pt_res < final_sy_res {
                return Err(ContractError::NegativeYieldNotSupported);
            }

            // Checks passed -> pull input, update reserves, route fee & mint PT/YT
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_in);

            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_res);

            if protocol_fee > 0 {
                sy_client.transfer(
                    &env.current_contract_address(),
                    &fee_recipient,
                    &protocol_fee,
                );
            }

            pt_client.mint(&env.current_contract_address(), &n);
            yt_client.mint(&receiver, &n);

            bump_instance_ttl(&env, maturity);
            SwapEvent {
                caller,
                receiver,
                direction: 2,
                amount_in: sy_in,
                amount_out: n,
                fee,
            }
            .publish(&env);
            Ok((n, sy_in))
        })
    }

    pub fn swap_exact_yt_for_sy(
        env: Env,
        caller: Address,
        receiver: Address,
        yt_in: i128,
        min_sy_out: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if yt_in <= 0 || min_sy_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;

            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let yt_client = PrivilegedTokenClient::new(&env, &yt_addr);

            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let scalar_root: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ScalarRoot)
                .unwrap_or(0);
            let anchor: i128 = env
                .storage()
                .instance()
                .get(&DataKey::InitialAnchor)
                .unwrap_or(WAD);
            let annual_fee: i128 = env
                .storage()
                .instance()
                .get(&DataKey::AnnualFeeRate)
                .unwrap_or(0);

            let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
            let fee_rate = calculate_fee_rate(tau_wad, annual_fee);

            if pt_res < yt_in {
                return Err(ContractError::InsufficientBalance);
            }

            let new_pt_res = pt_res
                .checked_sub(yt_in)
                .ok_or(ContractError::MathOverflow)?;
            let e_trade = get_exchange_rate(new_pt_res, sy_res, tau_wad, scalar_root, anchor)?;
            let gross_sy_buy = wad_div(yt_in, e_trade)?;
            if yt_in <= gross_sy_buy {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let gross_yield = yt_in
                .checked_sub(gross_sy_buy)
                .ok_or(ContractError::MathOverflow)?;
            let fee = wad_mul(gross_yield, fee_rate)?;
            let net_sy_out = gross_yield
                .checked_sub(fee)
                .ok_or(ContractError::MathOverflow)?;

            if net_sy_out < min_sy_out {
                return Err(ContractError::SlippageExceeded);
            }

            let final_sy_res = sy_res
                .checked_add(gross_sy_buy)
                .ok_or(ContractError::MathOverflow)?;
            check_market_proportion(new_pt_res, final_sy_res)?;
            if new_pt_res < final_sy_res {
                return Err(ContractError::NegativeYieldNotSupported);
            }

            let protocol_bps: i128 = env
                .storage()
                .instance()
                .get(&DataKey::ProtocolFeeBps)
                .unwrap_or(0);
            let protocol_fee = fee
                .checked_mul(protocol_bps)
                .ok_or(ContractError::MathOverflow)?
                / 10_000;
            let fee_recipient: Address = env
                .storage()
                .instance()
                .get(&DataKey::FeeRecipient)
                .ok_or(ContractError::NotInitialized)?;

            // Update AMM reserves & burn PT+YT before external transfers
            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_res);

            yt_client.burn(&caller, &yt_in);
            pt_client.burn(&env.current_contract_address(), &yt_in);

            if protocol_fee > 0 {
                sy_client.transfer(
                    &env.current_contract_address(),
                    &fee_recipient,
                    &protocol_fee,
                );
            }
            sy_client.transfer(&env.current_contract_address(), &receiver, &net_sy_out);

            bump_instance_ttl(&env, maturity);
            SwapEvent {
                caller,
                receiver,
                direction: 3,
                amount_in: yt_in,
                amount_out: net_sy_out,
                fee,
            }
            .publish(&env);
            Ok((net_sy_out, fee))
        })
    }

    pub fn add_liquidity(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
        sy_amount: i128,
        min_lp_out: i128,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if pt_amount <= 0 || sy_amount <= 0 || min_lp_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;

            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            // Pull PT and SY from caller
            pt_client.transfer(&caller, &env.current_contract_address(), &pt_amount);
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_amount);

            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let total_lp: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalLpSupply)
                .unwrap_or(0);

            let new_pt_res = pt_res
                .checked_add(pt_amount)
                .ok_or(ContractError::MathOverflow)?;
            let new_sy_res = sy_res
                .checked_add(sy_amount)
                .ok_or(ContractError::MathOverflow)?;

            check_market_proportion(new_pt_res, new_sy_res)?;
            if new_pt_res < new_sy_res {
                return Err(ContractError::NegativeYieldNotSupported);
            }

            let (lp_shares, new_total_lp) = if total_lp == 0 {
                let prod = (pt_amount as u128)
                    .checked_mul(sy_amount as u128)
                    .ok_or(ContractError::MathOverflow)?;
                let initial_shares = int_sqrt_u128(prod);
                if initial_shares <= MINIMUM_LIQUIDITY {
                    return Err(ContractError::ZeroAmount);
                }
                let shares = initial_shares - MINIMUM_LIQUIDITY;
                (shares, initial_shares)
            } else {
                let pt_shares = match pt_amount.checked_mul(total_lp) {
                    Some(p) => p / pt_res,
                    None => return Err(ContractError::MathOverflow),
                };
                let sy_shares = match sy_amount.checked_mul(total_lp) {
                    Some(p) => p / sy_res,
                    None => return Err(ContractError::MathOverflow),
                };
                let shares = pt_shares.min(sy_shares);
                let next_total_lp = total_lp
                    .checked_add(shares)
                    .ok_or(ContractError::MathOverflow)?;
                (shares, next_total_lp)
            };

            if lp_shares < min_lp_out {
                return Err(ContractError::SlippageExceeded);
            }

            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &new_sy_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalLpSupply, &new_total_lp);

            let bal_key = DataKey::Balance(receiver.clone());
            let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            let new_bal = current_bal
                .checked_add(lp_shares)
                .ok_or(ContractError::MathOverflow)?;
            env.storage().persistent().set(&bal_key, &new_bal);

            bump_persistent_ttl(&env, &bal_key, maturity);
            bump_instance_ttl(&env, maturity);
            LiquidityEvent {
                caller,
                receiver,
                is_add: true,
                pt_amount,
                sy_amount,
                lp_amount: lp_shares,
            }
            .publish(&env);

            Ok(lp_shares)
        })
    }

    pub fn remove_liquidity(
        env: Env,
        caller: Address,
        receiver: Address,
        lp_amount: i128,
        min_pt_out: i128,
        min_sy_out: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if lp_amount <= 0 || min_pt_out < 0 || min_sy_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;

            let bal_key = DataKey::Balance(caller.clone());
            let current_bal: i128 = env.storage().persistent().get(&bal_key).unwrap_or(0);
            if current_bal < lp_amount {
                return Err(ContractError::InsufficientBalance);
            }

            let total_lp: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalLpSupply)
                .unwrap_or(0);
            let pt_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalPtReserve)
                .unwrap_or(0);
            let sy_res: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);

            if total_lp == 0 {
                return Err(ContractError::InsufficientBalance);
            }

            let pt_out = match lp_amount.checked_mul(pt_res) {
                Some(p) => p / total_lp,
                None => return Err(ContractError::MathOverflow),
            };
            let sy_out = match lp_amount.checked_mul(sy_res) {
                Some(p) => p / total_lp,
                None => return Err(ContractError::MathOverflow),
            };

            if pt_out < min_pt_out || sy_out < min_sy_out {
                return Err(ContractError::SlippageExceeded);
            }

            let pt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::PtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;

            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            let new_total_lp = total_lp
                .checked_sub(lp_amount)
                .ok_or(ContractError::MathOverflow)?;
            let new_pt_res = pt_res
                .checked_sub(pt_out)
                .ok_or(ContractError::MathOverflow)?;
            let new_sy_res = sy_res
                .checked_sub(sy_out)
                .ok_or(ContractError::MathOverflow)?;

            env.storage()
                .persistent()
                .set(&bal_key, &(current_bal - lp_amount));
            env.storage()
                .instance()
                .set(&DataKey::TotalLpSupply, &new_total_lp);
            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &new_sy_res);

            pt_client.transfer(&env.current_contract_address(), &receiver, &pt_out);
            sy_client.transfer(&env.current_contract_address(), &receiver, &sy_out);

            bump_persistent_ttl(&env, &bal_key, maturity);
            bump_instance_ttl(&env, maturity);
            LiquidityEvent {
                caller,
                receiver,
                is_add: false,
                pt_amount: pt_out,
                sy_amount: sy_out,
                lp_amount,
            }
            .publish(&env);

            Ok((pt_out, sy_out))
        })
    }

    pub fn get_exchange_rate(env: Env) -> Result<i128, ContractError> {
        let maturity: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Maturity)
            .unwrap_or(0);
        let pt_res: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPtReserve)
            .unwrap_or(0);
        let sy_res: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSyReserve)
            .unwrap_or(0);
        let scalar_root: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ScalarRoot)
            .unwrap_or(0);
        let anchor: i128 = env
            .storage()
            .instance()
            .get(&DataKey::InitialAnchor)
            .unwrap_or(WAD);

        let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
        get_exchange_rate(pt_res, sy_res, tau_wad, scalar_root, anchor)
    }

    pub fn get_reserves(env: Env) -> (i128, i128) {
        let pt_res: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalPtReserve)
            .unwrap_or(0);
        let sy_res: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSyReserve)
            .unwrap_or(0);
        (pt_res, sy_res)
    }

    // =========================================================================
    // SEP-41 Fungible Token Implementation for LP shares
    // =========================================================================

    pub fn total_supply(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalLpSupply)
            .unwrap_or(0)
    }

    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), ContractError> {
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
        let total_lp: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLpSupply)
            .unwrap_or(0);
        let new_total_lp = total_lp
            .checked_sub(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalLpSupply, &new_total_lp);

        bump_persistent_ttl(&env, &from_key, maturity);
        bump_instance_ttl(&env, maturity);
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
        let total_lp: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalLpSupply)
            .unwrap_or(0);
        let new_total_lp = total_lp
            .checked_sub(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalLpSupply, &new_total_lp);

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
        }

        bump_persistent_ttl(&env, &from_key, maturity);
        bump_instance_ttl(&env, maturity);
        BurnEvent { from, amount }.publish(&env);
        Ok(())
    }

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
        let new_to = to_bal
            .checked_add(amount)
            .ok_or(ContractError::MathOverflow)?;

        env.storage()
            .persistent()
            .set(&from_key, &(from_bal - amount));
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
            let new_to = to_bal
                .checked_add(amount)
                .ok_or(ContractError::MathOverflow)?;

            env.storage()
                .persistent()
                .set(&from_key, &(from_bal - amount));
            env.storage().persistent().set(&to_key, &new_to);
            bump_persistent_ttl(&env, &to_key, maturity);
        }

        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            let storage_key = DataKey::Allowance(allow_key);
            env.storage().temporary().set(&storage_key, &allow_val);
            bump_allowance_ttl(&env, &storage_key, allow_val.expiration_ledger);
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
            .unwrap_or_else(|| String::from_str(&env, "Pendle LP"))
    }

    pub fn symbol(env: Env) -> String {
        env.storage()
            .instance()
            .get(&DataKey::Symbol)
            .unwrap_or_else(|| String::from_str(&env, "LP"))
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

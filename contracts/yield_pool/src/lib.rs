#![no_std]
#![allow(clippy::too_many_arguments)]

use common::errors::ContractError;
use common::events::{
    ApproveEvent, BurnEvent, FeeRecipientEvent, LiquidityEvent, MaturitySettledEvent, MintPyEvent,
    RedeemPtEvent, RedeemPyEvent, SwapEvent, TransferEvent, YieldClaimedEvent,
};
use common::fixed_point::{pos_sub, wad_div, wad_div_ceil, wad_mul, WAD};
use common::interfaces::{PrivilegedTokenClient, StandardizedYieldClient, YieldTokenClient};
use common::reentrancy::with_non_reentrant;
use common::storage_keys::{AllowanceKey, AllowanceValue, DataKey, MarketState};
use common::ttl::{bump_allowance_ttl, bump_instance_ttl, bump_persistent_ttl};
use common::yield_math::{
    asset_to_sy, asset_to_sy_ceil, calculate_fee_rate, calculate_pro_rata_share,
    calculate_tau_wad, check_market_proportion, get_exchange_rate, swap_exact_pt_for_sy_math,
    swap_exact_sy_for_pt_math, sy_to_asset,
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

struct PreMaturityCtx {
    maturity: u64,
    sy_addr: Address,
    pt_addr: Address,
    yt_addr: Address,
    pt_res: i128,
    sy_res: i128,
    scalar_root: i128,
    anchor: i128,
    tau_wad: i128,
    fee_rate: i128,
}

#[contract]
pub struct YieldPool;

impl YieldPool {
    #[inline(never)]
    fn sub_reserve(a: i128, b: i128) -> Result<i128, ContractError> {
        if a < b {
            Err(ContractError::InsufficientBalance)
        } else {
            Ok(a - b)
        }
    }

    #[inline(never)]
    fn require_pt_solvent(
        env: &Env,
        sy_client: &StandardizedYieldClient,
        yt_client: &YieldTokenClient,
        pt_client: &PrivilegedTokenClient,
        rate: i128,
        total_sy_reserve: i128,
        py_index: i128,
    ) -> Result<(i128, i128, i128), ContractError> {
        let (vault_balance, _, yt_reserved_sy) =
            Self::sync_py_reserves(env, sy_client, yt_client, rate)?;
        let pt_supply = pt_client.total_supply();
        let required_pt_sy = if pt_supply > 0 {
            asset_to_sy(py_index, pt_supply)?
        } else {
            0
        };
        let total_required = total_sy_reserve
            .checked_add(yt_reserved_sy)
            .ok_or(ContractError::MathOverflow)?
            .checked_add(required_pt_sy)
            .ok_or(ContractError::MathOverflow)?;
        if vault_balance < total_required {
            return Err(ContractError::InsufficientBalance);
        }
        Ok((vault_balance, total_sy_reserve, yt_reserved_sy))
    }

    #[inline(never)]
    fn load_pre_maturity_ctx(env: &Env) -> Result<PreMaturityCtx, ContractError> {
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

        Ok(PreMaturityCtx {
            maturity,
            sy_addr,
            pt_addr,
            yt_addr,
            pt_res,
            sy_res,
            scalar_root,
            anchor,
            tau_wad,
            fee_rate,
        })
    }

    #[inline(never)]
    fn compute_protocol_fee(env: &Env, fee_amount: i128) -> Result<(i128, Address), ContractError> {
        let proto_bps: i128 = env
            .storage()
            .instance()
            .get(&DataKey::ProtocolFeeBps)
            .unwrap_or(0);
        let proto_fee = fee_amount
            .checked_mul(proto_bps)
            .ok_or(ContractError::MathOverflow)?
            / 10_000;
        let fee_recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::FeeRecipient)
            .ok_or(ContractError::NotInitialized)?;
        Ok((proto_fee, fee_recipient))
    }

    #[inline(never)]
    fn publish_swap_event(
        env: &Env,
        maturity: u64,
        caller: Address,
        receiver: Address,
        direction: u32,
        amount_in: i128,
        amount_out: i128,
        fee: i128,
    ) {
        bump_instance_ttl(env, maturity);
        SwapEvent {
            caller,
            receiver,
            direction,
            amount_in,
            amount_out,
            fee,
        }
        .publish(env);
    }

    #[inline(never)]
    fn consume_allowance(
        env: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
    ) -> Result<(), ContractError> {
        let allow_key = AllowanceKey {
            from: from.clone(),
            spender: spender.clone(),
        };
        let storage_key = DataKey::Allowance(allow_key);
        let allowance: Option<AllowanceValue> = env.storage().temporary().get(&storage_key);
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
        if allow_val.amount != i128::MAX {
            allow_val.amount -= amount;
            env.storage().temporary().set(&storage_key, &allow_val);
            bump_allowance_ttl(env, &storage_key, allow_val.expiration_ledger);
        }
        Ok(())
    }

    #[inline(never)]
    fn redeem_pt_internal(
        env: &Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
        is_btoken: bool,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(env)?;
        if pt_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() < maturity {
                return Err(ContractError::MarketNotYetMatured);
            }

            let (_pinned, maybe_raw) = Self::internal_settle_if_needed(env)?;

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

            let sy_client = StandardizedYieldClient::new(env, &sy_addr);
            let pt_client = PrivilegedTokenClient::new(env, &pt_addr);
            let yt_client = YieldTokenClient::new(env, &yt_addr);

            if pt_client.balance(&caller) < pt_amount {
                return Err(ContractError::InsufficientBalance);
            }

            let (vault_balance, total_sy_reserve, yt_reserved_sy) =
                Self::sync_py_reserves_opt(env, &sy_client, &yt_client, maybe_raw)?;

            let protected_sy = total_sy_reserve
                .checked_add(yt_reserved_sy)
                .ok_or(ContractError::MathOverflow)?;
            let available_for_pt = pos_sub(vault_balance, protected_sy);

            let shares =
                calculate_pro_rata_share(pt_amount, available_for_pt, pt_client.total_supply())?;

            pt_client.burn(&caller, &pt_amount);
            let payout = if is_btoken {
                if shares > 0 {
                    sy_client.redeem_to_btoken(
                        &env.current_contract_address(),
                        &receiver,
                        &shares,
                    )
                } else {
                    0
                }
            } else {
                if shares > 0 {
                    sy_client.transfer(&env.current_contract_address(), &receiver, &shares);
                }
                shares
            };

            env.storage().instance().set(
                &DataKey::PtPrincipalReserve,
                &pos_sub(available_for_pt, shares),
            );
            env.storage()
                .instance()
                .set(&DataKey::YtYieldReserve, &yt_reserved_sy);

            bump_instance_ttl(env, maturity);
            RedeemPtEvent {
                caller,
                receiver,
                pt_burned: pt_amount,
                payout,
                is_btoken,
            }
            .publish(env);
            Ok(payout)
        })
    }
    fn init_internal(
        env: &Env,
        auth_caller: &Address,
        admin: &Address,
        sy: &Address,
        pt: &Address,
        yt: &Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        auth_caller.require_auth();
        if maturity <= env.ledger().timestamp() {
            return Err(ContractError::InvalidMaturity);
        }
        if scalar_root <= 0 || initial_anchor <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let (decimals, sym_buf, sym_len) = common::metadata::resolve_sy_metadata(env, sy);
        let sym_slice = &sym_buf[..sym_len];
        let lp_name = common::metadata::join3(env, b"NivoraFi LP ", sym_slice, b"");
        let lp_symbol = common::metadata::join3(env, b"LP-", sym_slice, b"");

        env.storage().instance().set(&DataKey::Admin, admin);
        env.storage().instance().set(&DataKey::SyContract, sy);
        env.storage().instance().set(&DataKey::PtContract, pt);
        env.storage().instance().set(&DataKey::YtContract, yt);
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
        env.storage().instance().set(&DataKey::FeeRecipient, admin);
        env.storage()
            .instance()
            .set(&DataKey::TotalPtReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalSyReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::PtPrincipalReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::YtYieldReserve, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalLpSupply, &0i128);
        env.storage().instance().set(&DataKey::IsSettled, &false);
        env.storage().instance().set(&DataKey::Decimals, &decimals);
        env.storage().instance().set(&DataKey::Name, &lp_name);
        env.storage().instance().set(&DataKey::Symbol, &lp_symbol);
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(env, maturity);
        Ok(())
    }

    fn sync_py_reserves_opt(
        env: &Env,
        sy_client: &StandardizedYieldClient,
        yt_client: &YieldTokenClient,
        rate_opt: Option<i128>,
    ) -> Result<(i128, i128, i128), ContractError> {
        let total_unclaimed_underlying = yt_client.get_total_unclaimed_yield();
        let yt_reserved_sy = if total_unclaimed_underlying > 0 {
            let rate = match rate_opt {
                Some(r) => r,
                None => {
                    let r = sy_client.exchange_rate();
                    if r <= 0 {
                        return Err(ContractError::BlendPoolError);
                    }
                    r
                }
            };
            asset_to_sy_ceil(rate, total_unclaimed_underlying)?
        } else {
            0
        };

        let vault_balance = sy_client.balance(&env.current_contract_address());
        let total_sy_reserve: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSyReserve)
            .unwrap_or(0);
        let actual_py_sy = pos_sub(vault_balance, total_sy_reserve);
        let pt_principal_sy = pos_sub(actual_py_sy, yt_reserved_sy);

        env.storage()
            .instance()
            .set(&DataKey::YtYieldReserve, &yt_reserved_sy);
        env.storage()
            .instance()
            .set(&DataKey::PtPrincipalReserve, &pt_principal_sy);

        Ok((vault_balance, total_sy_reserve, yt_reserved_sy))
    }

    fn sync_py_reserves(
        env: &Env,
        sy_client: &StandardizedYieldClient,
        yt_client: &YieldTokenClient,
        rate: i128,
    ) -> Result<(i128, i128, i128), ContractError> {
        Self::sync_py_reserves_opt(env, sy_client, yt_client, Some(rate))
    }

    fn check_amm_bounds(py_index: i128, pt_res: i128, sy_res: i128) -> Result<(), ContractError> {
        let asset_res = sy_to_asset(py_index, sy_res)?;
        check_market_proportion(pt_res, asset_res)?;
        if pt_res < asset_res {
            return Err(ContractError::NegativeYieldNotSupported);
        }
        Ok(())
    }
}

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
        Self::init_internal(
            &env,
            &admin,
            &admin,
            &sy,
            &pt,
            &yt,
            maturity,
            scalar_root,
            initial_anchor,
        )
    }

    pub fn initialize_from_factory(
        env: Env,
        deployer: Address,
        admin: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<(), ContractError> {
        Self::init_internal(
            &env,
            &deployer,
            &admin,
            &sy,
            &pt,
            &yt,
            maturity,
            scalar_root,
            initial_anchor,
        )
    }

    // =========================================================================
    // Core Router: Mint PY, Redeem PY, Redeem PT post-maturity
    // =========================================================================

    pub fn mint_py(
        env: Env,
        caller: Address,
        receiver: Address,
        amount: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
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
            let yt_client = YieldTokenClient::new(&env, &yt_addr);

            let py_index = yt_client.get_py_index();
            let py_out = sy_to_asset(py_index, amount)?;
            if py_out <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            let rate = sy_client.exchange_rate();
            if rate <= 0 {
                return Err(ContractError::BlendPoolError);
            }
            let total_sy_reserve: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let (vault_balance_before, _, yt_reserved_sy) = Self::require_pt_solvent(
                &env,
                &sy_client,
                &yt_client,
                &pt_client,
                rate,
                total_sy_reserve,
                py_index,
            )?;

            // Pull SY from caller
            sy_client.transfer(&caller, &env.current_contract_address(), &amount);

            // Mint py_out PT and py_out YT to receiver
            pt_client.mint(&receiver, &py_out);
            yt_client.mint(&receiver, &py_out);

            let new_vault_balance = vault_balance_before
                .checked_add(amount)
                .ok_or(ContractError::MathOverflow)?;
            let actual_py_sy = pos_sub(new_vault_balance, total_sy_reserve);
            let pt_principal_sy = pos_sub(actual_py_sy, yt_reserved_sy);
            env.storage()
                .instance()
                .set(&DataKey::YtYieldReserve, &yt_reserved_sy);
            env.storage()
                .instance()
                .set(&DataKey::PtPrincipalReserve, &pt_principal_sy);

            bump_instance_ttl(&env, maturity);
            MintPyEvent {
                caller,
                receiver,
                sy_in: amount,
                py_out,
            }
            .publish(&env);
            Ok((py_out, py_out))
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
            let yt_client = YieldTokenClient::new(&env, &yt_addr);

            let pt_supply = pt_client.total_supply();
            if pt_supply < amount
                || pt_client.balance(&caller) < amount
                || yt_client.balance(&caller) < amount
            {
                return Err(ContractError::InsufficientBalance);
            }

            let rate = sy_client.exchange_rate();
            if rate <= 0 {
                return Err(ContractError::BlendPoolError);
            }
            let py_index = yt_client.get_py_index();
            let (vault_balance, total_sy_reserve, yt_reserved_sy) =
                Self::sync_py_reserves(&env, &sy_client, &yt_client, rate)?;
            let protected_sy = total_sy_reserve
                .checked_add(yt_reserved_sy)
                .ok_or(ContractError::MathOverflow)?;
            let available_for_pt = pos_sub(vault_balance, protected_sy);

            let full_sy_for_pt = asset_to_sy(py_index, amount)?;
            let pro_rata_sy = calculate_pro_rata_share(amount, available_for_pt, pt_supply)?;
            let sy_payout = full_sy_for_pt.min(pro_rata_sy);
            if sy_payout <= 0 {
                return Err(ContractError::InsufficientBalance);
            }

            // Burn PT and YT from caller
            pt_client.burn(&caller, &amount);
            yt_client.burn(&caller, &amount);

            // Transfer PT principal SY payout to receiver (accrued YT yield remains in YtYieldReserve)
            sy_client.transfer(&env.current_contract_address(), &receiver, &sy_payout);

            Self::sync_py_reserves(&env, &sy_client, &yt_client, rate)?;

            bump_instance_ttl(&env, maturity);
            RedeemPyEvent {
                caller,
                receiver,
                py_burned: amount,
                sy_out: sy_payout,
            }
            .publish(&env);
            Ok(sy_payout)
        })
    }

    fn internal_settle_if_needed(env: &Env) -> Result<(i128, Option<i128>), ContractError> {
        let is_settled: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsSettled)
            .unwrap_or(false);
        if is_settled {
            let idx = env
                .storage()
                .instance()
                .get(&DataKey::MaturityIndex)
                .ok_or(ContractError::NotInitialized)?;
            return Ok((idx, None));
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
        let yt_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::YtContract)
            .ok_or(ContractError::NotInitialized)?;

        let sy_client = StandardizedYieldClient::new(env, &sy_addr);
        let yt_client = YieldTokenClient::new(env, &yt_addr);

        let raw_rate = sy_client.exchange_rate();
        if raw_rate <= 0 {
            return Err(ContractError::BlendPoolError);
        }

        // Bidirectional sync: yt_token::settle_maturity clamps raw_rate against LastKnownIndex
        // or returns already-pinned MaturityIndex if yt_token settled earlier.
        let pinned_rate = yt_client.settle_maturity(&raw_rate);

        env.storage()
            .instance()
            .set(&DataKey::MaturityIndex, &pinned_rate);
        env.storage().instance().set(&DataKey::IsSettled, &true);
        bump_instance_ttl(env, maturity);
        MaturitySettledEvent {
            maturity,
            settled_index: pinned_rate,
        }
        .publish(env);

        Ok((pinned_rate, Some(raw_rate)))
    }

    pub fn settle_maturity(env: Env) -> Result<i128, ContractError> {
        let (pinned_rate, maybe_raw) = Self::internal_settle_if_needed(&env)?;
        if let Some(raw_rate) = maybe_raw {
            let sy_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::SyContract)
                .ok_or(ContractError::NotInitialized)?;
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let yt_client = YieldTokenClient::new(&env, &yt_addr);
            Self::sync_py_reserves(&env, &sy_client, &yt_client, raw_rate)?;
        }
        Ok(pinned_rate)
    }

    pub fn redeem_pt_post_maturity(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
    ) -> Result<i128, ContractError> {
        Self::redeem_pt_internal(&env, caller, receiver, pt_amount, false)
    }

    pub fn redeem_pt_to_btoken(
        env: Env,
        caller: Address,
        receiver: Address,
        pt_amount: i128,
    ) -> Result<i128, ContractError> {
        Self::redeem_pt_internal(&env, caller, receiver, pt_amount, true)
    }

    pub fn claim_yield(env: Env, user: Address, receiver: Address) -> Result<i128, ContractError> {
        user.require_auth();
        common::governance::check_not_paused(&env)?;

        with_non_reentrant(&env, || {
            let maturity: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Maturity)
                .ok_or(ContractError::NotInitialized)?;
            if env.ledger().timestamp() >= maturity {
                Self::internal_settle_if_needed(&env)?;
            }

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

            let yt_client = YieldTokenClient::new(&env, &yt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);

            let yield_amount = yt_client.claim_user_yield(&user);
            let raw_rate = sy_client.exchange_rate();
            if raw_rate <= 0 {
                return Err(ContractError::BlendPoolError);
            }
            if yield_amount <= 0 {
                Self::sync_py_reserves(&env, &sy_client, &yt_client, raw_rate)?;
                bump_instance_ttl(&env, maturity);
                return Ok(0);
            }

            let pool_balance = sy_client.balance(&env.current_contract_address());
            let total_sy_reserve: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSyReserve)
                .unwrap_or(0);
            let available_py_sy = pos_sub(pool_balance, total_sy_reserve);
            if available_py_sy <= 0 {
                return Err(ContractError::InsufficientBalance);
            }

            let remaining_unclaimed = yt_client.get_total_unclaimed_yield();
            let total_claim_pool = remaining_unclaimed
                .checked_add(yield_amount)
                .ok_or(ContractError::MathOverflow)?;
            let total_sy_needed = asset_to_sy_ceil(raw_rate, total_claim_pool)?;

            let sy_payout = if total_sy_needed > available_py_sy {
                let share = wad_div(yield_amount, total_claim_pool)?;
                wad_mul(available_py_sy, share)?.min(available_py_sy)
            } else {
                asset_to_sy(raw_rate, yield_amount)?.min(available_py_sy)
            };

            if sy_payout <= 0 {
                return Err(ContractError::InsufficientBalance);
            }
            sy_client.transfer(&env.current_contract_address(), &receiver, &sy_payout);
            Self::sync_py_reserves(&env, &sy_client, &yt_client, raw_rate)?;
            bump_instance_ttl(&env, maturity);
            YieldClaimedEvent {
                user,
                receiver,
                yield_out: sy_payout,
            }
            .publish(&env);
            Ok(sy_payout)
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
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if pt_in <= 0 || min_sy_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let ctx = Self::load_pre_maturity_ctx(&env)?;
            let pt_client = PrivilegedTokenClient::new(&env, &ctx.pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &ctx.sy_addr);
            let yt_client = YieldTokenClient::new(&env, &ctx.yt_addr);

            let py_index = yt_client.get_py_index();
            let asset_res = sy_to_asset(py_index, ctx.sy_res)?;
            let swap_res = swap_exact_pt_for_sy_math(
                pt_in,
                ctx.pt_res,
                asset_res,
                ctx.tau_wad,
                ctx.scalar_root,
                ctx.anchor,
                ctx.fee_rate,
            )?;

            let sy_out = asset_to_sy(py_index, swap_res.amount_out)?;
            let fee_sy = asset_to_sy(py_index, swap_res.fee)?;
            if sy_out < min_sy_out {
                return Err(ContractError::SlippageExceeded);
            }
            if sy_out <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // Deduct protocol fee from AMM SY reserve so TotalSyReserve matches backing
            let (proto_fee_sy, fee_recipient) = Self::compute_protocol_fee(&env, fee_sy)?;
            let final_sy_reserve =
                Self::sub_reserve(Self::sub_reserve(ctx.sy_res, sy_out)?, proto_fee_sy)?;
            Self::check_amm_bounds(py_index, swap_res.new_pt_reserve, final_sy_reserve)?;

            // Pull PT from caller and update reserves before outbound transfers
            pt_client.transfer(&caller, &env.current_contract_address(), &pt_in);

            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &swap_res.new_pt_reserve);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_reserve);

            if proto_fee_sy > 0 {
                sy_client.transfer(
                    &env.current_contract_address(),
                    &fee_recipient,
                    &proto_fee_sy,
                );
            }

            sy_client.transfer(&env.current_contract_address(), &receiver, &sy_out);

            Self::publish_swap_event(&env, ctx.maturity, caller, receiver, 0, pt_in, sy_out, fee_sy);
            Ok((sy_out, fee_sy))
        })
    }

    pub fn swap_exact_sy_for_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_pt_out: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if sy_in <= 0 || min_pt_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let ctx = Self::load_pre_maturity_ctx(&env)?;
            let pt_client = PrivilegedTokenClient::new(&env, &ctx.pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &ctx.sy_addr);
            let yt_client = YieldTokenClient::new(&env, &ctx.yt_addr);

            let py_index = yt_client.get_py_index();
            let asset_res = sy_to_asset(py_index, ctx.sy_res)?;
            let asset_in = sy_to_asset(py_index, sy_in)?;
            if asset_in <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            let swap_res = swap_exact_sy_for_pt_math(
                asset_in,
                ctx.pt_res,
                asset_res,
                ctx.tau_wad,
                ctx.scalar_root,
                ctx.anchor,
                ctx.fee_rate,
            )?;

            if swap_res.amount_out < min_pt_out {
                return Err(ContractError::SlippageExceeded);
            }
            if swap_res.amount_out <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            let (proto_fee, fee_recipient) = Self::compute_protocol_fee(&env, swap_res.fee)?;
            let final_pt_reserve = Self::sub_reserve(swap_res.new_pt_reserve, proto_fee)?;
            let final_sy_reserve = ctx
                .sy_res
                .checked_add(sy_in)
                .ok_or(ContractError::MathOverflow)?;
            Self::check_amm_bounds(py_index, final_pt_reserve, final_sy_reserve)?;

            // Transfer SY from caller to yield_pool
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_in);

            // Update reserves
            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &final_pt_reserve);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_reserve);

            if proto_fee > 0 {
                pt_client.transfer(&env.current_contract_address(), &fee_recipient, &proto_fee);
            }

            // Transfer net PT out to receiver
            pt_client.transfer(
                &env.current_contract_address(),
                &receiver,
                &swap_res.amount_out,
            );

            Self::publish_swap_event(
                &env,
                ctx.maturity,
                caller,
                receiver,
                1,
                sy_in,
                swap_res.amount_out,
                swap_res.fee,
            );
            Ok((swap_res.amount_out, swap_res.fee))
        })
    }

    pub fn swap_exact_sy_for_yt(
        env: Env,
        caller: Address,
        receiver: Address,
        sy_in: i128,
        min_yt_out: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if sy_in <= 0 || min_yt_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let ctx = Self::load_pre_maturity_ctx(&env)?;
            let sy_client = StandardizedYieldClient::new(&env, &ctx.sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &ctx.pt_addr);
            let yt_client = YieldTokenClient::new(&env, &ctx.yt_addr);

            let py_index = yt_client.get_py_index();
            let asset_res = sy_to_asset(py_index, ctx.sy_res)?;
            let asset_in = sy_to_asset(py_index, sy_in)?;
            if asset_in <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // Initial exchange rate in underlying asset terms
            let e0 = get_exchange_rate(ctx.pt_res, asset_res, ctx.tau_wad, ctx.scalar_root, ctx.anchor)?;
            if e0 <= WAD {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let unit_yield0 = WAD
                .checked_sub(wad_div(WAD, e0)?)
                .ok_or(ContractError::MathOverflow)?;
            let unit_cost0 = unit_yield0
                .checked_add(wad_mul(unit_yield0, ctx.fee_rate)?)
                .ok_or(ContractError::MathOverflow)?;
            if unit_cost0 <= 0 {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let n0 = wad_div(asset_in, unit_cost0)?;
            let max_n_sy = sy_to_asset(
                py_index,
                ctx.sy_res
                    .checked_add(sy_in)
                    .ok_or(ContractError::MathOverflow)?,
            )?;
            let mut hi = n0.min(max_n_sy);
            let mut lo = 0i128;
            let mut best_e = e0;

            for _ in 0..48 {
                if lo >= hi {
                    break;
                }
                let mid = lo + (hi - lo + 1) / 2;
                let gross_est = wad_div(mid, e0)?;
                if gross_est >= asset_res {
                    hi = mid - 1;
                    continue;
                }
                let refined_pt = match ctx.pt_res.checked_add(mid) {
                    Some(v) => v,
                    None => {
                        hi = mid - 1;
                        continue;
                    }
                };
                let e_mid = match get_exchange_rate(
                    refined_pt,
                    asset_res - gross_est,
                    ctx.tau_wad,
                    ctx.scalar_root,
                    ctx.anchor,
                ) {
                    Ok(v) => v,
                    Err(_) => {
                        hi = mid - 1;
                        continue;
                    }
                };
                let unit_yield = WAD
                    .checked_sub(wad_div(WAD, e_mid)?)
                    .ok_or(ContractError::MathOverflow)?;
                let unit_cost = unit_yield
                    .checked_add(wad_mul(unit_yield, ctx.fee_rate)?)
                    .ok_or(ContractError::MathOverflow)?;
                let cost = wad_mul(mid, unit_cost)?;
                if cost <= asset_in {
                    lo = mid;
                    best_e = e_mid;
                } else {
                    hi = mid - 1;
                }
            }
            let n = lo;
            let e1 = best_e;

            if n <= 0 {
                return Err(ContractError::ZeroAmount);
            }
            if n < min_yt_out {
                return Err(ContractError::SlippageExceeded);
            }

            // Flash swap mechanics: N PT added to reserves, py_backing_sy locked for PT principal
            let gross_asset_sold = wad_div(n, e1)?;
            let yield_cost = n
                .checked_sub(gross_asset_sold)
                .ok_or(ContractError::NegativeYieldNotSupported)?;
            let fee_asset = wad_mul(yield_cost, ctx.fee_rate)?;
            let fee_sy = asset_to_sy(py_index, fee_asset)?;

            let (protocol_fee_sy, fee_recipient) = Self::compute_protocol_fee(&env, fee_sy)?;
            let py_backing_sy = asset_to_sy_ceil(py_index, n)?;

            let new_pt_res = ctx.pt_res.checked_add(n).ok_or(ContractError::MathOverflow)?;
            let total_in_sy = ctx.sy_res.checked_add(sy_in).ok_or(ContractError::MathOverflow)?;
            let after_fee_sy = Self::sub_reserve(total_in_sy, protocol_fee_sy)?;
            let final_sy_res = Self::sub_reserve(after_fee_sy, py_backing_sy)?;
            Self::check_amm_bounds(py_index, new_pt_res, final_sy_res)?;

            let rate = sy_client.exchange_rate();
            if rate <= 0 {
                return Err(ContractError::BlendPoolError);
            }
            let (vault_balance_before, _, yt_reserved_sy) = Self::require_pt_solvent(
                &env,
                &sy_client,
                &yt_client,
                &pt_client,
                rate,
                ctx.sy_res,
                py_index,
            )?;

            // Checks passed -> pull input, update reserves, route fee & mint PT/YT
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_in);

            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_res);

            if protocol_fee_sy > 0 {
                sy_client.transfer(
                    &env.current_contract_address(),
                    &fee_recipient,
                    &protocol_fee_sy,
                );
            }

            pt_client.mint(&env.current_contract_address(), &n);
            yt_client.mint(&receiver, &n);

            let new_vault_balance = vault_balance_before
                .checked_add(sy_in)
                .ok_or(ContractError::MathOverflow)?
                .checked_sub(protocol_fee_sy)
                .ok_or(ContractError::MathOverflow)?;
            let actual_py_sy = pos_sub(new_vault_balance, final_sy_res);
            let pt_principal_sy = pos_sub(actual_py_sy, yt_reserved_sy);
            env.storage()
                .instance()
                .set(&DataKey::YtYieldReserve, &yt_reserved_sy);
            env.storage()
                .instance()
                .set(&DataKey::PtPrincipalReserve, &pt_principal_sy);

            Self::publish_swap_event(&env, ctx.maturity, caller, receiver, 2, sy_in, n, fee_sy);
            Ok((n, fee_sy))
        })
    }

    pub fn swap_exact_yt_for_sy(
        env: Env,
        caller: Address,
        receiver: Address,
        yt_in: i128,
        min_sy_out: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if yt_in <= 0 || min_sy_out < 0 {
            return Err(ContractError::ZeroAmount);
        }

        with_non_reentrant(&env, || {
            let ctx = Self::load_pre_maturity_ctx(&env)?;
            let sy_client = StandardizedYieldClient::new(&env, &ctx.sy_addr);
            let pt_client = PrivilegedTokenClient::new(&env, &ctx.pt_addr);
            let yt_client = YieldTokenClient::new(&env, &ctx.yt_addr);

            if ctx.pt_res < yt_in {
                return Err(ContractError::InsufficientBalance);
            }

            let py_index = yt_client.get_py_index();
            let asset_res = sy_to_asset(py_index, ctx.sy_res)?;
            let new_pt_res = ctx
                .pt_res
                .checked_sub(yt_in)
                .ok_or(ContractError::MathOverflow)?;
            let e0 = get_exchange_rate(new_pt_res, asset_res, ctx.tau_wad, ctx.scalar_root, ctx.anchor)?;
            let gross_est0 = wad_div(yt_in, e0)?;
            let est_asset1 = asset_res
                .checked_add(gross_est0)
                .ok_or(ContractError::MathOverflow)?;
            let e1 = get_exchange_rate(new_pt_res, est_asset1, ctx.tau_wad, ctx.scalar_root, ctx.anchor)?;
            let gross_est1 = wad_div(yt_in, e1)?;
            let est_asset2 = asset_res
                .checked_add(gross_est1)
                .ok_or(ContractError::MathOverflow)?;
            let e_trade =
                get_exchange_rate(new_pt_res, est_asset2, ctx.tau_wad, ctx.scalar_root, ctx.anchor)?;
            let gross_asset_buy = wad_div_ceil(yt_in, e_trade)?;
            if yt_in <= gross_asset_buy {
                return Err(ContractError::NegativeYieldNotSupported);
            }
            let gross_yield = yt_in
                .checked_sub(gross_asset_buy)
                .ok_or(ContractError::MathOverflow)?;
            let fee_asset = wad_mul(gross_yield, ctx.fee_rate)?;
            let net_asset_out = gross_yield
                .checked_sub(fee_asset)
                .ok_or(ContractError::MathOverflow)?;

            let net_sy_out = asset_to_sy(py_index, net_asset_out)?;
            if net_sy_out < min_sy_out {
                return Err(ContractError::SlippageExceeded);
            }
            if net_sy_out <= 0 {
                return Err(ContractError::ZeroAmount);
            }
            let fee_sy = asset_to_sy(py_index, fee_asset)?;

            let (protocol_fee_sy, fee_recipient) = Self::compute_protocol_fee(&env, fee_sy)?;

            let rate = sy_client.exchange_rate();
            if rate <= 0 {
                return Err(ContractError::BlendPoolError);
            }
            let pt_supply = pt_client.total_supply();
            if pt_supply < yt_in || yt_client.balance(&caller) < yt_in {
                return Err(ContractError::InsufficientBalance);
            }
            let (vault_balance, _total_sy_reserve, yt_reserved_sy) =
                Self::sync_py_reserves(&env, &sy_client, &yt_client, rate)?;
            let protected_sy = ctx
                .sy_res
                .checked_add(yt_reserved_sy)
                .ok_or(ContractError::MathOverflow)?;
            let available_for_pt = pos_sub(vault_balance, protected_sy);
            let full_freed_sy = asset_to_sy(py_index, yt_in)?;
            let pro_rata_freed_sy = calculate_pro_rata_share(yt_in, available_for_pt, pt_supply)?;
            let freed_pt_sy = full_freed_sy.min(pro_rata_freed_sy);

            let total_sy_out = net_sy_out
                .checked_add(protocol_fee_sy)
                .ok_or(ContractError::MathOverflow)?;
            if freed_pt_sy < total_sy_out {
                return Err(ContractError::InsufficientBalance);
            }

            let total_sy_with_freed = ctx
                .sy_res
                .checked_add(freed_pt_sy)
                .ok_or(ContractError::MathOverflow)?;
            let after_out_sy = Self::sub_reserve(total_sy_with_freed, net_sy_out)?;
            let final_sy_res = Self::sub_reserve(after_out_sy, protocol_fee_sy)?;
            Self::check_amm_bounds(py_index, new_pt_res, final_sy_res)?;

            // Update AMM reserves & burn PT+YT before external transfers
            env.storage()
                .instance()
                .set(&DataKey::TotalPtReserve, &new_pt_res);
            env.storage()
                .instance()
                .set(&DataKey::TotalSyReserve, &final_sy_res);

            yt_client.burn(&caller, &yt_in);
            pt_client.burn(&env.current_contract_address(), &yt_in);

            if protocol_fee_sy > 0 {
                sy_client.transfer(
                    &env.current_contract_address(),
                    &fee_recipient,
                    &protocol_fee_sy,
                );
            }
            if net_sy_out > 0 {
                sy_client.transfer(&env.current_contract_address(), &receiver, &net_sy_out);
            }

            Self::sync_py_reserves(&env, &sy_client, &yt_client, rate)?;

            Self::publish_swap_event(&env, ctx.maturity, caller, receiver, 3, yt_in, net_sy_out, fee_sy);
            Ok((net_sy_out, fee_sy))
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
            let yt_addr: Address = env
                .storage()
                .instance()
                .get(&DataKey::YtContract)
                .ok_or(ContractError::NotInitialized)?;

            let pt_client = PrivilegedTokenClient::new(&env, &pt_addr);
            let sy_client = StandardizedYieldClient::new(&env, &sy_addr);
            let yt_client = YieldTokenClient::new(&env, &yt_addr);
            let py_index = yt_client.get_py_index();

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

            Self::check_amm_bounds(py_index, new_pt_res, new_sy_res)?;

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
                if pt_res <= 0 || sy_res <= 0 {
                    return Err(ContractError::InsufficientBalance);
                }
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
            if lp_shares <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // Pull PT and SY from caller only after validating positive LP shares
            pt_client.transfer(&caller, &env.current_contract_address(), &pt_amount);
            sy_client.transfer(&caller, &env.current_contract_address(), &sy_amount);

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
            if pt_out == 0 && sy_out == 0 {
                return Err(ContractError::ZeroAmount);
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

            if pt_out > 0 {
                pt_client.transfer(&env.current_contract_address(), &receiver, &pt_out);
            }
            if sy_out > 0 {
                sy_client.transfer(&env.current_contract_address(), &receiver, &sy_out);
            }

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
        let yt_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::YtContract)
            .ok_or(ContractError::NotInitialized)?;
        let yt_client = YieldTokenClient::new(&env, &yt_addr);
        let py_index = yt_client.get_py_index();
        let asset_res = sy_to_asset(py_index, sy_res)?;

        let tau_wad = calculate_tau_wad(env.ledger().timestamp(), maturity);
        get_exchange_rate(pt_res, asset_res, tau_wad, scalar_root, anchor)
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

    pub fn get_py_reserves(env: Env) -> (i128, i128) {
        let pt_principal: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PtPrincipalReserve)
            .unwrap_or(0);
        let yt_yield: i128 = env
            .storage()
            .instance()
            .get(&DataKey::YtYieldReserve)
            .unwrap_or(0);
        (pt_principal, yt_yield)
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
        Self::consume_allowance(&env, &from, &spender, amount)?;

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
        Self::consume_allowance(&env, &from, &spender, amount)?;

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

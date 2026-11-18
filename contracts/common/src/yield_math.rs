use crate::errors::ContractError;
use crate::fixed_point::{wad_div, wad_mul, WAD};
use crate::transcendental::ln_wad;

pub const SECONDS_PER_YEAR: i128 = 31_536_000;
pub const MIN_MARKET_PROPORTION: i128 = 40_000_000_000_000_000; // 0.04 WAD (4%)
pub const MAX_MARKET_PROPORTION: i128 = 960_000_000_000_000_000; // 0.96 WAD (96%)
pub const MIN_FEE_RATE: i128 = 200_000_000_000_000; // 2 bps (0.0002 WAD)
pub const MAX_FEE_RATE: i128 = 10_000_000_000_000_000; // 100 bps (0.01 WAD)

pub fn sy_to_asset(py_index: i128, sy_amount: i128) -> Result<i128, ContractError> {
    if py_index <= 0 {
        return Err(ContractError::InvalidRate);
    }
    if sy_amount < 0 {
        return Err(ContractError::ZeroAmount);
    }
    if sy_amount == 0 {
        return Ok(0);
    }
    let prod = sy_amount
        .checked_mul(py_index)
        .ok_or(ContractError::MathOverflow)?;
    Ok(prod / crate::fixed_point::SCALAR_9)
}

pub fn asset_to_sy(py_index: i128, asset_amount: i128) -> Result<i128, ContractError> {
    if py_index <= 0 {
        return Err(ContractError::InvalidRate);
    }
    if asset_amount < 0 {
        return Err(ContractError::ZeroAmount);
    }
    if asset_amount == 0 {
        return Ok(0);
    }
    let prod = asset_amount
        .checked_mul(crate::fixed_point::SCALAR_9)
        .ok_or(ContractError::MathOverflow)?;
    Ok(prod / py_index)
}

pub fn asset_to_sy_ceil(py_index: i128, asset_amount: i128) -> Result<i128, ContractError> {
    if py_index <= 0 {
        return Err(ContractError::InvalidRate);
    }
    if asset_amount < 0 {
        return Err(ContractError::ZeroAmount);
    }
    if asset_amount == 0 {
        return Ok(0);
    }
    let prod = asset_amount
        .checked_mul(crate::fixed_point::SCALAR_9)
        .ok_or(ContractError::MathOverflow)?;
    let num = prod
        .checked_add(py_index - 1)
        .ok_or(ContractError::MathOverflow)?;
    Ok(num / py_index)
}

pub fn calculate_tau_wad(now: u64, maturity: u64) -> i128 {
    if maturity <= now {
        return 0;
    }
    let remaining_seconds = (maturity - now) as i128;
    // tau in years WAD
    let num = match remaining_seconds.checked_mul(WAD) {
        Some(v) => v,
        None => return 0,
    };
    num / SECONDS_PER_YEAR
}

pub fn get_exchange_rate(
    total_pt: i128,
    total_sy: i128,
    tau_wad: i128,
    scalar_root: i128,
    rate_anchor: i128,
) -> Result<i128, ContractError> {
    if total_pt <= 0 || total_sy <= 0 {
        return Err(ContractError::NegativeLogarithmInput);
    }
    if tau_wad == 0 {
        return Ok(rate_anchor.max(WAD));
    }
    if scalar_root == 0 {
        return Err(ContractError::DivisionByZero);
    }

    let ratio = wad_div(total_pt, total_sy)?;
    let ln_ratio = ln_wad(ratio)?;

    let time_factor = wad_div(tau_wad, scalar_root)?;
    let scaled_ln = wad_mul(time_factor, ln_ratio)?;
    let e = rate_anchor
        .checked_add(scaled_ln)
        .ok_or(ContractError::MathOverflow)?;

    if e < WAD {
        return Err(ContractError::NegativeYieldNotSupported);
    }
    Ok(e)
}

pub fn calculate_fee_rate(tau_wad: i128, annual_fee_rate: i128) -> i128 {
    if tau_wad <= 0 {
        return MIN_FEE_RATE;
    }
    let dynamic_fee = match wad_mul(annual_fee_rate, tau_wad) {
        Ok(f) => f,
        Err(_) => MAX_FEE_RATE,
    };
    dynamic_fee.clamp(MIN_FEE_RATE, MAX_FEE_RATE)
}

pub fn calculate_haircut(
    vault_balance: i128,
    total_pt_supply: i128,
) -> Result<i128, ContractError> {
    if total_pt_supply <= 0 {
        return Err(ContractError::DivisionByZero);
    }
    if vault_balance <= 0 {
        return Ok(0);
    }
    let ratio = wad_div(vault_balance, total_pt_supply)?;
    Ok(ratio.min(WAD))
}

/// Computes uncapped pro-rata share `floor(amount * available / total_supply)` clamped to `[0, available]`.
/// Supports `available > total_supply` (e.g. `py_index < SCALAR_9` or post-maturity appreciation) without stranding SY.
pub fn calculate_pro_rata_share(
    amount: i128,
    available: i128,
    total_supply: i128,
) -> Result<i128, ContractError> {
    if total_supply <= 0 {
        return Err(ContractError::DivisionByZero);
    }
    if available <= 0 || amount <= 0 {
        return Ok(0);
    }
    if amount >= total_supply {
        return Ok(available);
    }
    match (amount as u128).checked_mul(available as u128) {
        Some(prod) => Ok((prod / (total_supply as u128)) as i128),
        None => Ok(wad_mul(amount, wad_div(available, total_supply)?)?.min(available)),
    }
}

pub fn check_market_proportion(pt_reserve: i128, sy_reserve: i128) -> Result<(), ContractError> {
    if pt_reserve <= 0 || sy_reserve <= 0 {
        return Err(ContractError::ProportionOutOfBounds);
    }
    let total = pt_reserve
        .checked_add(sy_reserve)
        .ok_or(ContractError::MathOverflow)?;
    let p = wad_div(pt_reserve, total)?;
    if !(MIN_MARKET_PROPORTION..=MAX_MARKET_PROPORTION).contains(&p) {
        return Err(ContractError::ProportionOutOfBounds);
    }
    Ok(())
}

pub struct SwapResult {
    pub amount_out: i128,
    pub fee: i128,
    pub new_pt_reserve: i128,
    pub new_sy_reserve: i128,
}

pub fn swap_exact_pt_for_sy_math(
    exact_pt_in: i128,
    pt_reserve: i128,
    sy_reserve: i128,
    tau_wad: i128,
    scalar_root: i128,
    rate_anchor: i128,
    fee_rate: i128,
) -> Result<SwapResult, ContractError> {
    if exact_pt_in <= 0 {
        return Err(ContractError::ZeroAmount);
    }
    let new_pt = pt_reserve
        .checked_add(exact_pt_in)
        .ok_or(ContractError::MathOverflow)?;

    let e_trade = get_exchange_rate(new_pt, sy_reserve, tau_wad, scalar_root, rate_anchor)?;
    let gross_sy_out = wad_div(exact_pt_in, e_trade)?;
    let fee = wad_mul(gross_sy_out, fee_rate)?;
    let net_sy_out = gross_sy_out
        .checked_sub(fee)
        .ok_or(ContractError::MathOverflow)?;

    if net_sy_out >= sy_reserve {
        return Err(ContractError::InsufficientBalance);
    }
    let new_sy = sy_reserve
        .checked_sub(net_sy_out)
        .ok_or(ContractError::MathOverflow)?;

    check_market_proportion(new_pt, new_sy)?;
    if new_pt < new_sy {
        return Err(ContractError::NegativeYieldNotSupported);
    }

    Ok(SwapResult {
        amount_out: net_sy_out,
        fee,
        new_pt_reserve: new_pt,
        new_sy_reserve: new_sy,
    })
}

pub fn swap_exact_sy_for_pt_math(
    exact_sy_in: i128,
    pt_reserve: i128,
    sy_reserve: i128,
    tau_wad: i128,
    scalar_root: i128,
    rate_anchor: i128,
    fee_rate: i128,
) -> Result<SwapResult, ContractError> {
    if exact_sy_in <= 0 {
        return Err(ContractError::ZeroAmount);
    }
    let new_sy = sy_reserve
        .checked_add(exact_sy_in)
        .ok_or(ContractError::MathOverflow)?;

    let e_trade = get_exchange_rate(pt_reserve, new_sy, tau_wad, scalar_root, rate_anchor)?;
    let gross_pt_out = wad_mul(exact_sy_in, e_trade)?;
    let fee = wad_mul(gross_pt_out, fee_rate)?;
    let net_pt_out = gross_pt_out
        .checked_sub(fee)
        .ok_or(ContractError::MathOverflow)?;

    if net_pt_out >= pt_reserve {
        return Err(ContractError::InsufficientBalance);
    }
    let new_pt = pt_reserve
        .checked_sub(net_pt_out)
        .ok_or(ContractError::MathOverflow)?;

    check_market_proportion(new_pt, new_sy)?;
    if new_pt < new_sy {
        return Err(ContractError::NegativeYieldNotSupported);
    }

    Ok(SwapResult {
        amount_out: net_pt_out,
        fee,
        new_pt_reserve: new_pt,
        new_sy_reserve: new_sy,
    })
}

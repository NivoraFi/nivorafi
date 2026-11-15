#![no_std]

pub mod errors;
pub mod events;
pub mod fixed_point;
pub mod governance;
#[allow(clippy::too_many_arguments)]
pub mod interfaces;
pub mod reentrancy;
pub mod storage_keys;
pub mod transcendental;
pub mod ttl;
pub mod yield_math;

#[cfg(test)]
mod test;

// Re-exports
pub use errors::ContractError;
pub use events::*;
pub use fixed_point::{wad_div, wad_mul, HALF_WAD, SCALAR_9, WAD};
pub use governance::*;
pub use interfaces::*;
pub use reentrancy::with_non_reentrant;
pub use storage_keys::*;
pub use transcendental::{exp_wad, ln_wad, LN_2, MAX_EXP_INPUT};
pub use ttl::{
    bump_instance_ttl, bump_persistent_ttl, calculate_bump_threshold, calculate_bump_to,
};
pub use yield_math::{
    calculate_fee_rate, calculate_haircut, calculate_tau_wad, get_exchange_rate,
    swap_exact_pt_for_sy_math, swap_exact_sy_for_pt_math, SwapResult,
};

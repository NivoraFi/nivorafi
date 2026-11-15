use crate::errors::ContractError;
use crate::fixed_point::{wad_div, wad_mul, WAD};

pub const LN_2: i128 = 693_147_180_559_945_309; // ln(2) in WAD
pub const MAX_EXP_INPUT: i128 = 46_440_000_000_000_000_000; // 46.44 WAD

pub fn ln_wad(x: i128) -> Result<i128, ContractError> {
    if x <= 0 {
        return Err(ContractError::NegativeLogarithmInput);
    }
    if x == WAD {
        return Ok(0);
    }

    let mut k: i32 = 0;
    let mut m = x;
    while m >= 2 * WAD {
        m >>= 1;
        k += 1;
    }
    while m < WAD {
        m <<= 1;
        k -= 1;
    }

    let num = m - WAD;
    let den = m + WAD;
    let z = wad_div(num, den)?;
    let z2 = wad_mul(z, z)?;

    let term3 = z2 / 3;
    let z4 = wad_mul(z2, z2)?;
    let term5 = z4 / 5;
    let z6 = wad_mul(z4, z2)?;
    let term7 = z6 / 7;

    let poly = WAD + term3 + term5 + term7;
    let ln_m = 2 * wad_mul(z, poly)?;
    let k_term = (k as i128) * LN_2;
    Ok(k_term + ln_m)
}

pub fn exp_wad(x: i128) -> Result<i128, ContractError> {
    if x == 0 {
        return Ok(WAD);
    }
    if x < -41 * WAD {
        return Ok(0);
    }
    if x > MAX_EXP_INPUT {
        return Err(ContractError::MathOverflow);
    }

    let mut q = x / LN_2;
    let mut r = x % LN_2;
    if r < 0 {
        r += LN_2;
        q -= 1;
    }

    let r2 = wad_mul(r, r)?;
    let r3 = wad_mul(r2, r)?;
    let r4 = wad_mul(r3, r)?;
    let r5 = wad_mul(r4, r)?;
    let r6 = wad_mul(r5, r)?;
    let r7 = wad_mul(r6, r)?;

    let term2 = r2 / 2;
    let term3 = r3 / 6;
    let term4 = r4 / 24;
    let term5 = r5 / 120;
    let term6 = r6 / 720;
    let term7 = r7 / 5040;

    let exp_r = WAD + r + term2 + term3 + term4 + term5 + term6 + term7;
    if q >= 0 {
        Ok(exp_r << q)
    } else {
        Ok(exp_r >> (-q))
    }
}

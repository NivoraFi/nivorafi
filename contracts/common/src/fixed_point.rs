use crate::errors::ContractError;

pub const WAD: i128 = 1_000_000_000_000_000_000; // 10^18
pub const HALF_WAD: i128 = 500_000_000_000_000_000;
pub const SCALAR_9: i128 = 1_000_000_000; // 10^9

#[inline]
pub fn pos_sub(a: i128, b: i128) -> i128 {
    if a > b {
        a.saturating_sub(b)
    } else {
        0
    }
}

#[inline(always)]
pub fn wad_mul(a: i128, b: i128) -> Result<i128, ContractError> {
    if a == 0 || b == 0 {
        return Ok(0);
    }
    let sign = (a < 0) ^ (b < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();

    let a_lo = ua as u64 as u128;
    let a_hi = ua >> 64;
    let b_lo = ub as u64 as u128;
    let b_hi = ub >> 64;

    let lolo = a_lo * b_lo;
    let lohi = a_lo * b_hi;
    let hilo = a_hi * b_lo;
    let hihi = a_hi * b_hi;

    let mid = lohi.checked_add(hilo).ok_or(ContractError::MathOverflow)?;
    let carry = ((lolo >> 64) + (mid & 0xFFFFFFFFFFFFFFFF)) >> 64;
    let hi_acc = hihi
        .checked_add(mid >> 64)
        .ok_or(ContractError::MathOverflow)?
        .checked_add(carry)
        .ok_or(ContractError::MathOverflow)?;

    let result_u128 = div_256_by_wad(hi_acc, (mid << 64).wrapping_add(lolo))?;
    if result_u128 > (i128::MAX as u128) {
        return Err(ContractError::MathOverflow);
    }
    let res = result_u128 as i128;
    Ok(if sign { -res } else { res })
}

#[inline(always)]
pub fn wad_div(a: i128, b: i128) -> Result<i128, ContractError> {
    if b == 0 {
        return Err(ContractError::DivisionByZero);
    }
    if a == 0 {
        return Ok(0);
    }
    let sign = (a < 0) ^ (b < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();

    let (res, _) = mul_wad_and_div_rem(ua, ub)?;
    if res > (i128::MAX as u128) {
        return Err(ContractError::MathOverflow);
    }
    let signed_res = res as i128;
    Ok(if sign { -signed_res } else { signed_res })
}

#[inline(always)]
pub fn wad_div_ceil(a: i128, b: i128) -> Result<i128, ContractError> {
    if b == 0 {
        return Err(ContractError::DivisionByZero);
    }
    if a == 0 {
        return Ok(0);
    }
    let sign = (a < 0) ^ (b < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();

    let (q, rem) = mul_wad_and_div_rem(ua, ub)?;
    if sign {
        if q > (i128::MAX as u128) {
            return Err(ContractError::MathOverflow);
        }
        Ok(-(q as i128))
    } else {
        let res = if rem > 0 {
            q.checked_add(1).ok_or(ContractError::MathOverflow)?
        } else {
            q
        };
        if res > (i128::MAX as u128) {
            return Err(ContractError::MathOverflow);
        }
        Ok(res as i128)
    }
}

fn mul_wad_and_div_rem(ua: u128, ub: u128) -> Result<(u128, u128), ContractError> {
    let a_lo = (ua as u64) as u128;
    let a_hi = ua >> 64;
    let w = WAD as u128;

    let p0 = a_lo * w;
    let p1 = a_hi * w;

    let mid = (p0 >> 64) + (p1 & 0xFFFFFFFFFFFFFFFF);
    let hi = (p1 >> 64) + (mid >> 64);
    let lo = (mid << 64) | (p0 as u64 as u128);

    div_256_64(hi, lo, ub)
}

fn div_256_by_wad(hi: u128, lo: u128) -> Result<u128, ContractError> {
    let (q, _) = div_256_64(hi, lo, WAD as u128)?;
    Ok(q)
}

pub fn div_256_64(hi: u128, lo: u128, d: u128) -> Result<(u128, u128), ContractError> {
    if d == 0 {
        return Err(ContractError::DivisionByZero);
    }
    if hi == 0 {
        return Ok((lo / d, lo % d));
    }
    if hi >= d {
        return Err(ContractError::MathOverflow);
    }

    let mut q: u128 = 0;
    let mut rem = hi;
    for i in (0..128).rev() {
        let msb = (rem >> 127) != 0;
        rem = (rem << 1) | ((lo >> i) & 1);
        if msb || rem >= d {
            rem = rem.wrapping_sub(d);
            q |= 1 << i;
        }
    }
    Ok((q, rem))
}

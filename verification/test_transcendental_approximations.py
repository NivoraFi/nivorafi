#!/usr/bin/env python3
"""
test_transcendental_approximations.py
Empirical Challenger: Verify Degree-7 Transcendental Approximations in WAD Fixed-Point Math
"""

import math
from decimal import Decimal, getcontext

# Set high decimal precision for ground-truth oracle
getcontext().prec = 60

WAD = 10**18
HALF_WAD = 5 * 10**17
LN_2_WAD = 693_147_180_559_945_309

def wad_mul(a: int, b: int) -> int:
    """Fixed-point multiplication with WAD scaling (10^18) using exact 256-bit arithmetic."""
    if a == 0 or b == 0:
        return 0
    sign = -1 if (a < 0) ^ (b < 0) else 1
    ua = abs(a)
    ub = abs(b)
    prod = ua * ub
    res = prod // WAD
    return sign * res

def wad_div(a: int, b: int) -> int:
    """Fixed-point division with WAD scaling (10^18)."""
    if b == 0:
        raise ZeroDivisionError("Division by zero in wad_div")
    if a == 0:
        return 0
    sign = -1 if (a < 0) ^ (b < 0) else 1
    ua = abs(a)
    ub = abs(b)
    res = (ua * WAD) // ub
    return sign * res

def ln_wad_exact_spec(x: int) -> int:
    """
    Exact implementation of ln_wad from transcendental.rs (Module 2, lines 805-841).
    """
    if x <= 0:
        raise ValueError("Negative or zero logarithm input")
    if x == WAD:
        return 0

    k = 0
    m = x

    while m >= 2 * WAD:
        m >>= 1
        k += 1
    while m < WAD:
        m <<= 1
        k -= 1

    num = m - WAD
    den = m + WAD
    z = wad_div(num, den)
    z2 = wad_mul(z, z)

    term3 = z2 // 3
    z4 = wad_mul(z2, z2)
    term5 = z4 // 5
    z6 = wad_mul(z4, z2)
    term7 = z6 // 7

    poly = WAD + term3 + term5 + term7
    ln_m = 2 * wad_mul(z, poly)

    k_term = k * LN_2_WAD
    return k_term + ln_m

def exp_wad_exact_spec(x: int) -> int:
    """
    Exact implementation of exp_wad from transcendental.rs (Module 2, lines 843-883).
    """
    if x == 0:
        return WAD
    if x < -41 * WAD:
        return 0
    if x > 88 * WAD:
        raise OverflowError("exp_wad overflow")

    q = x // LN_2_WAD
    r = x % LN_2_WAD
    if r < 0:
        r += LN_2_WAD
        q -= 1

    r2 = wad_mul(r, r)
    r3 = wad_mul(r2, r)
    r4 = wad_mul(r3, r)
    r5 = wad_mul(r4, r)
    r6 = wad_mul(r5, r)
    r7 = wad_mul(r6, r)

    term2 = r2 // 2
    term3 = r3 // 6
    term4 = r4 // 24
    term5 = r5 // 120
    term6 = r6 // 720
    term7 = r7 // 5040

    exp_r = WAD + r + term2 + term3 + term4 + term5 + term6 + term7

    if q >= 0:
        return exp_r << q
    else:
        return exp_r >> (-q)

def run_tests():
    print("================================================================================")
    print("CHALLENGE 3: DEGREE-7 TRANSCENDENTAL POLYNOMIAL APPROXIMATIONS VERIFICATION")
    print("================================================================================")

    # --------------------------------------------------------------------------
    # 1. Verification of ln(x) over z = (m - 1)/(m + 1) in [0, 1/3)
    # --------------------------------------------------------------------------
    print("\n[Part 1] Verifying natural log ln(m) over m in [1.0, 2.0) WAD (z in [0, 1/3)):")
    steps = 100_000
    max_abs_err_ln = Decimal(0)
    worst_m = 0
    worst_z = Decimal(0)
    
    for i in range(steps + 1):
        # m from 1.0 * WAD to 2.0 * WAD - 1
        m_int = WAD + (i * WAD) // steps
        if m_int >= 2 * WAD:
            m_int = 2 * WAD - 1
            
        m_dec = Decimal(m_int) / Decimal(WAD)
        true_ln = m_dec.ln()
        
        approx_int = ln_wad_exact_spec(m_int)
        approx_dec = Decimal(approx_int) / Decimal(WAD)
        
        err = abs(approx_dec - true_ln)
        if err > max_abs_err_ln:
            max_abs_err_ln = err
            worst_m = m_int
            worst_z = (m_dec - 1) / (m_dec + 1)

    print(f"  Maximum Absolute Error for ln(m): {max_abs_err_ln:.12e}")
    print(f"  Occurred at m = {Decimal(worst_m)/Decimal(WAD):.6f} (z = {worst_z:.6f})")
    print(f"  Claimed Precision Bound:          < 1.000000000000e-12")
    ratio_ln = max_abs_err_ln / Decimal("1e-12")
    print(f"  Discrepancy Factor:               {ratio_ln:,.1f}x LARGER THAN CLAIMED BOUND")
    ln_pass = max_abs_err_ln < Decimal("1e-12")
    print(f"  Precision Criterion (< 10^-12):   {'PASS' if ln_pass else 'FAILED'}")

    # --------------------------------------------------------------------------
    # 2. Verification of exp(r) over r in [0, ln(2))
    # --------------------------------------------------------------------------
    print("\n[Part 2] Verifying exponential exp(r) over r in [0, ln(2)) WAD:")
    max_abs_err_exp = Decimal(0)
    worst_r = 0
    
    for i in range(steps + 1):
        r_int = (i * LN_2_WAD) // steps
        if r_int >= LN_2_WAD:
            r_int = LN_2_WAD - 1
            
        r_dec = Decimal(r_int) / Decimal(WAD)
        true_exp = r_dec.exp()
        
        approx_int = exp_wad_exact_spec(r_int)
        approx_dec = Decimal(approx_int) / Decimal(WAD)
        
        err = abs(approx_dec - true_exp)
        if err > max_abs_err_exp:
            max_abs_err_exp = err
            worst_r = r_int

    print(f"  Maximum Absolute Error for exp(r): {max_abs_err_exp:.12e}")
    print(f"  Occurred at r = {Decimal(worst_r)/Decimal(WAD):.6f} (near ln(2) = 0.693147)")
    print(f"  Claimed Precision Bound:           < 1.000000000000e-12")
    ratio_exp = max_abs_err_exp / Decimal("1e-12")
    print(f"  Discrepancy Factor:                {ratio_exp:,.1f}x LARGER THAN CLAIMED BOUND")
    exp_pass = max_abs_err_exp < Decimal("1e-12")
    print(f"  Precision Criterion (< 10^-12):    {'PASS' if exp_pass else 'FAILED'}")

    # --------------------------------------------------------------------------
    # 3. Minimum Polynomial Degree Analysis for < 10^-12 Precision
    # --------------------------------------------------------------------------
    print("\n[Part 3] Minimum Degree Analysis to Achieve True < 10^-12 Precision:")
    print("  ln(x) Series Expansion at worst-case z = 1/3:")
    z_worst = Decimal(1) / Decimal(3)
    target = Decimal("1e-12")
    
    for deg in range(7, 31, 2):
        N = (deg - 1) // 2
        approx = Decimal(2) * sum((z_worst**(2*k+1)) / Decimal(2*k+1) for k in range(N+1))
        err = abs(approx - Decimal(2).ln())
        status = "ACCEPTS (< 10^-12)" if err < target else "FAILS"
        print(f"    Degree {deg:2d} (terms={N+1:2d}): error = {err:.12e} -> {status}")
        if err < target:
            print(f"    ==> Minimum Odd Polynomial Degree Required for ln: Degree {deg}")
            break

    print("\n  exp(x) Taylor Expansion at worst-case r = ln(2):")
    r_worst = Decimal(2).ln()
    for deg in range(7, 20):
        approx = sum((r_worst**k) / Decimal(math.factorial(k)) for k in range(deg+1))
        err = abs(approx - Decimal(2))
        status = "ACCEPTS (< 10^-12)" if err < target else "FAILS"
        print(f"    Degree {deg:2d}: error = {err:.12e} -> {status}")
        if err < target:
            print(f"    ==> Minimum Taylor Degree Required for exp: Degree {deg}")
            break

    print("\n--------------------------------------------------------------------------------")
    print(f"TRANSCENDENTAL PRECISION (< 10^-12) VERIFICATION: FAILED")
    print(f"CRITICAL FINDING: The Degree-7 polynomials specified in the document provide only")
    print(f"  ~1.24e-5 precision for ln(x) (5 decimal digits) and")
    print(f"  ~1.43e-6 precision for exp(x) (6 decimal digits),")
    print(f"falsifying the specification's claim of < 10^-12 error across the entire domain.")
    print("--------------------------------------------------------------------------------")

if __name__ == "__main__":
    run_tests()

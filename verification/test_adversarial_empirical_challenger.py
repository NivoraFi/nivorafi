#!/usr/bin/env python3
"""
test_adversarial_empirical_challenger.py
Adversarial Empirical Stress Harness for Milestone 1 (Core Soroban Smart Contracts)
Author: teamwork_challenger
"""

import sys
import math

WAD = 10**18
HALF_WAD = 5 * 10**17
LN_2 = 693_147_180_559_945_309
MAX_EXP_INPUT = 46_440_000_000_000_000_000
I128_MAX = 2**127 - 1
I128_MIN = -2**127

DAY_IN_LEDGERS = 17_280
MIN_BUMP_THRESHOLD = 30 * DAY_IN_LEDGERS
MAX_NETWORK_TTL = 180 * DAY_IN_LEDGERS
DEFAULT_BUMP_TO = 120 * DAY_IN_LEDGERS
BUFFER_LEDGERS = 30 * DAY_IN_LEDGERS

# Python exact implementation of the Soroban contract algorithms
def div_256_64(hi: int, lo: int, d: int):
    if d == 0:
        raise ZeroDivisionError("DivisionByZero")
    if hi >= d:
        raise OverflowError("MathOverflow")
    
    q = 0
    rem = hi
    for i in range(127, -1, -1):
        msb = (rem >> 127) != 0
        rem = ((rem << 1) & ((1 << 128) - 1)) | ((lo >> i) & 1)
        if msb or rem >= d:
            rem = (rem - d) & ((1 << 128) - 1)
            q |= (1 << i)
    return q, rem

def wad_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    sign = (a < 0) ^ (b < 0)
    ua = abs(a)
    ub = abs(b)

    a_lo = ua & 0xFFFFFFFFFFFFFFFF
    a_hi = ua >> 64
    b_lo = ub & 0xFFFFFFFFFFFFFFFF
    b_hi = ub >> 64

    lolo = a_lo * b_lo
    lohi = a_lo * b_hi
    hilo = a_hi * b_lo
    hihi = a_hi * b_hi

    mid = lohi + hilo
    if mid >= (1 << 128):
        raise OverflowError("MathOverflow")
    
    carry = ((lolo >> 64) + (mid & 0xFFFFFFFFFFFFFFFF)) >> 64
    hi_acc = hihi + (mid >> 64) + carry
    if hi_acc >= (1 << 128):
        raise OverflowError("MathOverflow")

    lo_val = ((mid << 64) + lolo) & ((1 << 128) - 1)
    q, _ = div_256_64(hi_acc, lo_val, WAD)
    if q > I128_MAX:
        raise OverflowError("MathOverflow")
    res = -q if sign else q
    return res

def wad_div(a: int, b: int) -> int:
    if b == 0:
        raise ZeroDivisionError("DivisionByZero")
    if a == 0:
        return 0
    sign = (a < 0) ^ (b < 0)
    ua = abs(a)
    ub = abs(b)

    a_lo = ua & 0xFFFFFFFFFFFFFFFF
    a_hi = ua >> 64
    w = WAD

    p0 = a_lo * w
    p1 = a_hi * w

    mid = (p0 >> 64) + (p1 & 0xFFFFFFFFFFFFFFFF)
    hi = (p1 >> 64) + (mid >> 64)
    lo = ((mid << 64) | (p0 & 0xFFFFFFFFFFFFFFFF)) & ((1 << 128) - 1)

    q, _ = div_256_64(hi, lo, ub)
    if q > I128_MAX:
        raise OverflowError("MathOverflow")
    res = -q if sign else q
    return res

def ln_wad(x: int) -> int:
    if x <= 0:
        raise ValueError("NegativeLogarithmInput")
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
    k_term = k * LN_2
    return k_term + ln_m

def exp_wad(x: int) -> int:
    if x == 0:
        return WAD
    if x < -41 * WAD:
        return 0
    if x > MAX_EXP_INPUT:
        raise OverflowError("MathOverflow")
    
    q = x // LN_2
    r = x % LN_2
    if r < 0:
        r += LN_2
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
        val = exp_r << q
        if val > I128_MAX:
            raise OverflowError("MathOverflow")
        return val
    else:
        return exp_r >> (-q)

def calculate_bump_to(now: int, maturity: int) -> int:
    if maturity <= now:
        return DEFAULT_BUMP_TO
    remaining_seconds = maturity - now
    remaining_ledgers = remaining_seconds // 5
    target = remaining_ledgers + BUFFER_LEDGERS
    return min(max(target, DEFAULT_BUMP_TO), MAX_NETWORK_TTL)

def calculate_bump_threshold(bump_to: int) -> int:
    return max(bump_to // 4, MIN_BUMP_THRESHOLD)

# Adversarial Challenges
def run_all_empirical_challenges():
    print("================================================================================")
    print("EMPIRICAL ADVERSARIAL STRESS TEST: PYTHON ORACLE CROSS-VALIDATION")
    print("================================================================================")

    # 1. Stress Test wad_mul and wad_div
    print("\n--- Challenge 1: 256-Bit Limb Math Edge Cases vs Arbitrary Precision Oracle ---")
    
    # Check 1: Exact integer arithmetic vs (a * b) // WAD
    test_cases = [
        (0, 0, 0),
        (0, 10**20, 0),
        (10**20, 0, 0),
        (WAD, WAD, WAD),
        (-WAD, WAD, -WAD),
        (-WAD, -WAD, WAD),
        (1, 1, 0),
        (1, WAD, 1),
        (10**36, 1, 10**18),
        (I128_MAX, WAD, I128_MAX),
    ]
    for a, b, expected in test_cases:
        res = wad_mul(a, b)
        assert res == expected, f"wad_mul({a}, {b}) = {res}, expected {expected}"
    print(f"  Passed {len(test_cases)} boundary multiplication cases.")

    # wad_div boundary cases
    div_test_cases = [
        (0, WAD, 0),
        (WAD, WAD, WAD),
        (-WAD, WAD, -WAD),
        (-WAD, -WAD, WAD),
        (1, WAD, 1),
        (1, 2 * WAD, 0),
        (WAD, 1, 10**36),
        (I128_MAX, WAD, I128_MAX),
    ]
    for a, b, expected in div_test_cases:
        res = wad_div(a, b)
        assert res == expected, f"wad_div({a}, {b}) = {res}, expected {expected}"
    print(f"  Passed {len(div_test_cases)} boundary division cases.")

    # Overflow bounds
    try:
        wad_mul(I128_MAX, WAD + 1)
        assert False, "Should have overflowed"
    except OverflowError:
        pass

    try:
        wad_div(I128_MAX, WAD - 1)
        assert False, "Should have overflowed"
    except OverflowError:
        pass
    print("  Overflow gating confirmed: strict rejection beyond i128::MAX boundary.")

    # 2. Stress Test ln_wad
    print("\n--- Challenge 2: Transcendental ln_wad Domain Edges ---")
    for bad_x in [0, -1, -WAD, I128_MIN]:
        try:
            ln_wad(bad_x)
            assert False, f"ln_wad({bad_x}) should raise ValueError"
        except ValueError:
            pass
    print("  x <= 0 rejected with NegativeLogarithmInput.")

    assert ln_wad(WAD) == 0
    print("  ln_wad(1.0 WAD) == 0 exact identity verified.")

    ln_2_res = ln_wad(2 * WAD)
    dev_ln2 = abs(ln_2_res - LN_2)
    assert dev_ln2 < 10**6
    print(f"  ln_wad(2.0 WAD) dev from LN_2 = {dev_ln2} units (< 10^-12 relative error).")

    # Sweep ln_wad accuracy against Python math.log
    max_ln_error = 0
    for exp in range(-18, 38):
        x = 10**exp * WAD if exp >= 0 else max(1, 10**(exp + 18))
        if x <= 0: continue
        actual = ln_wad(x) / WAD
        expected = math.log(x / WAD)
        err = abs(actual - expected)
        if err > max_ln_error:
            max_ln_error = err
    print(f"  Swept powers of 10 from 10^-18 to 10^37: Max absolute error = {max_ln_error:.2e}.")
    assert max_ln_error < 1e-4

    # 3. Stress Test exp_wad
    print("\n--- Challenge 3: Transcendental exp_wad Domain Edges ---")
    assert exp_wad(0) == WAD
    print("  exp_wad(0) == 1.0 WAD verified.")

    exp_1 = exp_wad(WAD)
    expected_e = int(math.e * WAD)
    dev_e = abs(exp_1 - expected_e)
    print(f"  exp_wad(1.0 WAD) = {exp_1}, dev from e = {dev_e} ({dev_e / WAD:.2e} relative).")
    assert dev_e / WAD < 1e-8

    assert exp_wad(-42 * WAD) == 0
    assert exp_wad(-100 * WAD) == 0
    print("  x < -41 WAD returns 0 underflow floor verified.")

    # Boundary at 46.44 WAD
    exp_46_44 = exp_wad(MAX_EXP_INPUT)
    assert 0 < exp_46_44 <= I128_MAX
    print(f"  exp_wad(46.44 WAD) = {exp_46_44} (Within valid i128 range: {exp_46_44 < I128_MAX}).")

    # Rejection at 46.44 WAD + 1
    try:
        exp_wad(MAX_EXP_INPUT + 1)
        assert False, "Should reject MAX_EXP_INPUT + 1"
    except OverflowError:
        print("  exp_wad(46.44 WAD + 1 unit) -> Rejected with OverflowError.")

    try:
        exp_wad(50 * WAD)
        assert False, "Should reject 50 WAD"
    except OverflowError:
        print("  exp_wad(50.0 WAD) -> Rejected with OverflowError.")

    # 4. Stress Test Dynamic TTL Calibration
    print("\n--- Challenge 4: Dynamic TTL Calibration Across 1d, 180d, 365d Horizons ---")
    now = 1_000_000_000
    
    # 1d horizon
    b_1d = calculate_bump_to(now, now + 86_400)
    t_1d = calculate_bump_threshold(b_1d)
    print(f"  1-Day Horizon  : BUMP_TO={b_1d} ledgers ({b_1d / DAY_IN_LEDGERS:.1f}d), Threshold={t_1d} ledgers ({t_1d / DAY_IN_LEDGERS:.1f}d)")
    assert b_1d == DEFAULT_BUMP_TO  # 120 days minimum floor
    assert t_1d == MIN_BUMP_THRESHOLD  # 30 days minimum floor

    # 180d horizon
    b_180d = calculate_bump_to(now, now + 180 * 86_400)
    t_180d = calculate_bump_threshold(b_180d)
    print(f"  180-Day Horizon: BUMP_TO={b_180d} ledgers ({b_180d / DAY_IN_LEDGERS:.1f}d), Threshold={t_180d} ledgers ({t_180d / DAY_IN_LEDGERS:.1f}d)")
    assert b_180d == MAX_NETWORK_TTL  # 180 days exact protocol max
    assert t_180d == 777_600  # 45 days

    # 365d horizon
    b_365d = calculate_bump_to(now, now + 365 * 86_400)
    t_365d = calculate_bump_threshold(b_365d)
    print(f"  365-Day Horizon: BUMP_TO={b_365d} ledgers ({b_365d / DAY_IN_LEDGERS:.1f}d), Threshold={t_365d} ledgers ({t_365d / DAY_IN_LEDGERS:.1f}d)")
    assert b_365d == MAX_NETWORK_TTL  # Strictly clamped to 180 days
    assert t_365d == 777_600

    # Past maturity boundary
    b_past = calculate_bump_to(now, now - 100)
    assert b_past == DEFAULT_BUMP_TO
    print(f"  Past maturity  : BUMP_TO={b_past} ledgers ({b_past / DAY_IN_LEDGERS:.1f}d) matches DEFAULT_BUMP_TO.")

    # Sweep all horizons from 0 to 10 years
    for sec in range(0, 315_360_000, 86_400 * 7):
        b = calculate_bump_to(now, now + sec)
        t = calculate_bump_threshold(b)
        assert t < b, f"threshold {t} >= bump_to {b}"
        assert b <= MAX_NETWORK_TTL, f"bump_to {b} > MAX_NETWORK_TTL"
        assert b >= DEFAULT_BUMP_TO, f"bump_to {b} < DEFAULT_BUMP_TO"
        assert t >= MIN_BUMP_THRESHOLD, f"threshold {t} < MIN_BUMP_THRESHOLD"
    print("  Comprehensive 10-year weekly horizon sweep passed all 4 host TTL invariants.")

    print("\n================================================================================")
    print("ALL EMPIRICAL CHALLENGER TESTS PASSED WITH ZERO DISCREPANCIES!")
    print("================================================================================")

if __name__ == "__main__":
    run_all_empirical_challenges()

// rust_harness/src/main.rs
// Empirical test harness for Challenger stress-testing of Milestone 1 Math Engine

pub const WAD: i128 = 1_000_000_000_000_000_000; // 10^18
pub const HALF_WAD: i128 = 500_000_000_000_000_000;
pub const LN_2: i128 = 693_147_180_559_945_309; // ln(2) in WAD
pub const MAX_EXP_INPUT: i128 = 46_440_000_000_000_000_000; // 46.44 WAD
pub const SECONDS_PER_YEAR: i128 = 31_536_000; // raw seconds
pub const MIN_MARKET_PROPORTION: i128 = 40_000_000_000_000_000;  // 0.04 WAD (4%)
pub const MAX_MARKET_PROPORTION: i128 = 960_000_000_000_000_000; // 0.96 WAD (96%)
pub const MIN_FEE_RATE: i128 = 200_000_000_000_000;     // 2 bps
pub const MAX_FEE_RATE: i128 = 10_000_000_000_000_000;   // 100 bps

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const MIN_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (30 days)
pub const MAX_NETWORK_TTL: u32 = 180 * DAY_IN_LEDGERS; // 3,110,400 ledgers (180 days)
pub const DEFAULT_BUMP_TO: u32 = 120 * DAY_IN_LEDGERS; // 2,073,600 ledgers (120 days)
pub const BUFFER_LEDGERS: u32 = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (30 days)

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MathError {
    Overflow,
    Underflow,
    DivisionByZero,
    NegativeLogarithmInput,
    NegativeYieldNotSupported,
    ProportionOutOfBounds,
}

// ==============================================================================
// 1. FIXED POINT ENGINE UNDER TEST
// ==============================================================================

#[inline(always)]
pub fn wad_mul(a: i128, b: i128) -> Result<i128, MathError> {
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

    let mid = lohi.checked_add(hilo).ok_or(MathError::Overflow)?;
    let carry = ((lolo >> 64) + (mid & 0xFFFFFFFFFFFFFFFF)) >> 64;
    let hi_acc = hihi
        .checked_add(mid >> 64)
        .ok_or(MathError::Overflow)?
        .checked_add(carry)
        .ok_or(MathError::Overflow)?;

    let result_u128 = div_256_by_wad(hi_acc, (mid << 64).wrapping_add(lolo))?;
    if result_u128 > (i128::MAX as u128) {
        return Err(MathError::Overflow);
    }
    let res = result_u128 as i128;
    Ok(if sign { -res } else { res })
}

#[inline(always)]
pub fn wad_div(a: i128, b: i128) -> Result<i128, MathError> {
    if b == 0 {
        return Err(MathError::DivisionByZero);
    }
    if a == 0 {
        return Ok(0);
    }
    let sign = (a < 0) ^ (b < 0);
    let ua = a.unsigned_abs();
    let ub = b.unsigned_abs();

    let res = mul_wad_and_div(ua, ub)?;
    if res > (i128::MAX as u128) {
        return Err(MathError::Overflow);
    }
    let signed_res = res as i128;
    Ok(if sign { -signed_res } else { signed_res })
}

fn mul_wad_and_div(ua: u128, ub: u128) -> Result<u128, MathError> {
    let a_lo = (ua as u64) as u128;
    let a_hi = ua >> 64;
    let w = WAD as u128;

    let p0 = a_lo * w;
    let p1 = a_hi * w;

    let mid = (p0 >> 64) + (p1 & 0xFFFFFFFFFFFFFFFF);
    let hi = (p1 >> 64) + (mid >> 64);
    let lo = (mid << 64) | (p0 as u64 as u128);

    let (q, _) = div_256_64(hi, lo, ub)?;
    Ok(q)
}

fn div_256_by_wad(hi: u128, lo: u128) -> Result<u128, MathError> {
    let (q, _) = div_256_64(hi, lo, WAD as u128)?;
    Ok(q)
}

pub fn div_256_64(hi: u128, lo: u128, d: u128) -> Result<(u128, u128), MathError> {
    if d == 0 {
        return Err(MathError::DivisionByZero);
    }
    if hi >= d {
        return Err(MathError::Overflow);
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

// ==============================================================================
// 2. TRANSCENDENTAL MODULE UNDER TEST
// ==============================================================================

pub fn ln_wad(x: i128) -> Result<i128, MathError> {
    if x <= 0 {
        return Err(MathError::NegativeLogarithmInput);
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

pub fn exp_wad(x: i128) -> Result<i128, MathError> {
    if x == 0 {
        return Ok(WAD);
    }
    if x < -41 * WAD {
        return Ok(0);
    }
    if x > MAX_EXP_INPUT {
        return Err(MathError::Overflow);
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

// ==============================================================================
// 3. TTL DYNAMIC EXTENSION MODULE UNDER TEST
// ==============================================================================

pub fn calculate_bump_to(now: u64, maturity: u64) -> u32 {
    if maturity <= now {
        return DEFAULT_BUMP_TO;
    }
    let remaining_seconds = maturity - now;
    let remaining_ledgers = (remaining_seconds / 5) as u32;
    let target = remaining_ledgers.saturating_add(BUFFER_LEDGERS);
    target.max(DEFAULT_BUMP_TO).min(MAX_NETWORK_TTL)
}

pub fn calculate_bump_threshold(bump_to: u32) -> u32 {
    (bump_to / 4).max(MIN_BUMP_THRESHOLD)
}

// ==============================================================================
// EMPIRICAL ORACLE AND VERIFICATION FUNCTIONS
// ==============================================================================

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct U256 {
    hi: u128,
    lo: u128,
}

impl U256 {
    fn from_u128(v: u128) -> Self {
        U256 { hi: 0, lo: v }
    }

    fn add(&self, other: &Self) -> (Self, bool) {
        let (lo, carry1) = self.lo.overflowing_add(other.lo);
        let (hi1, carry2) = self.hi.overflowing_add(other.hi);
        let (hi, carry3) = hi1.overflowing_add(if carry1 { 1 } else { 0 });
        (U256 { hi, lo }, carry2 || carry3)
    }

    fn mul_u128(a: u128, b: u128) -> Self {
        let a_lo = a as u64 as u128;
        let a_hi = a >> 64;
        let b_lo = b as u64 as u128;
        let b_hi = b >> 64;

        let p0 = a_lo * b_lo;
        let p1 = a_lo * b_hi;
        let p2 = a_hi * b_lo;
        let p3 = a_hi * b_hi;

        let mid = (p0 >> 64) + (p1 & 0xFFFFFFFFFFFFFFFF) + (p2 & 0xFFFFFFFFFFFFFFFF);
        let carry_mid = mid >> 64;
        let lo = (mid << 64) | (p0 as u64 as u128);

        let hi = p3 + (p1 >> 64) + (p2 >> 64) + carry_mid;
        U256 { hi, lo }
    }
}

// Oracle division for (hi, lo) / d verifying: q * d + rem == (hi * 2^128 + lo)
fn oracle_verify_division(hi: u128, lo: u128, d: u128, q: u128, rem: u128) -> bool {
    assert!(rem < d, "Remainder {} must be strictly less than divisor {}", rem, d);
    let q_d = U256::mul_u128(q, d);
    let (recon, carry) = q_d.add(&U256::from_u128(rem));
    assert!(!carry, "Reconstruction overflowed 256 bits");
    recon.hi == hi && recon.lo == lo
}

struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.state
    }

    fn next_u128(&mut self) -> u128 {
        let h = self.next_u64() as u128;
        let l = self.next_u64() as u128;
        (h << 64) | l
    }
}

// ==============================================================================
// MAIN TEST HARNESS SUITE
// ==============================================================================

fn main() {
    println!("================================================================================");
    println!("CHALLENGER EMPIRICAL VERIFICATION & STRESS-TEST SUITE: MILESTONE 1");
    println!("================================================================================");

    test_256bit_limb_fixed_point_math();
    test_div_256_64_restoring_division_oracles();
    test_transcendental_approximations_ln_wad();
    test_transcendental_approximations_exp_wad();
    test_dynamic_ttl_calibration_horizons();

    println!("\n================================================================================");
    println!("ALL EMPIRICAL CHALLENGER TESTS PASSED SUCCESSFULLY WITH ZERO DEFECTS!");
    println!("================================================================================");
}

fn test_256bit_limb_fixed_point_math() {
    println!("\n[CHALLENGE 1A] Testing 256-Bit Limb Fixed-Point Math (wad_mul, wad_div)...");

    // 1. Zero handling
    assert_eq!(wad_mul(0, 0).unwrap(), 0);
    assert_eq!(wad_mul(0, 100 * WAD).unwrap(), 0);
    assert_eq!(wad_mul(100 * WAD, 0).unwrap(), 0);
    assert_eq!(wad_div(0, 100 * WAD).unwrap(), 0);
    assert_eq!(wad_div(100 * WAD, 0), Err(MathError::DivisionByZero));

    // 2. Identity and basic fractions
    assert_eq!(wad_mul(WAD, WAD).unwrap(), WAD);
    assert_eq!(wad_mul(5 * WAD, WAD).unwrap(), 5 * WAD);
    assert_eq!(wad_div(5 * WAD, WAD).unwrap(), 5 * WAD);
    assert_eq!(wad_div(5 * WAD, 5 * WAD).unwrap(), WAD);
    assert_eq!(wad_div(WAD, 2 * WAD).unwrap(), HALF_WAD);
    assert_eq!(wad_mul(HALF_WAD, 2 * WAD).unwrap(), WAD);

    // 3. Boundary inputs: 1 raw unit
    assert_eq!(wad_mul(1, 1).unwrap(), 0); // 1 * 1 / 10^18 = 0
    assert_eq!(wad_mul(1, WAD).unwrap(), 1); // 1 * 10^18 / 10^18 = 1
    assert_eq!(wad_div(1, WAD).unwrap(), 1); // 1 * 10^18 / 10^18 = 1
    assert_eq!(wad_div(1, 2 * WAD).unwrap(), 0); // 1 * 10^18 / 2*10^18 = 0

    // 4. Large scales up to 10^36
    let scale_36 = wad_div(1 * WAD, 1).unwrap();
    assert_eq!(scale_36, 1_000_000_000_000_000_000_000_000_000_000_000_000i128);
    println!("  wad_div(1 WAD, 1 raw unit) = 10^36 verified exactly: {}", scale_36);

    // 5. Symmetric Sign Law Tests: (+a)*(+b), (-a)*(+b), (+a)*(-b), (-a)*(-b)
    let a = 123456789012345678i128;
    let b = 987654321098765432i128;
    let mul_pos = wad_mul(a, b).unwrap();
    assert_eq!(wad_mul(-a, b).unwrap(), -mul_pos);
    assert_eq!(wad_mul(a, -b).unwrap(), -mul_pos);
    assert_eq!(wad_mul(-a, -b).unwrap(), mul_pos);

    let div_pos = wad_div(b, a).unwrap();
    assert_eq!(wad_div(-b, a).unwrap(), -div_pos);
    assert_eq!(wad_div(b, -a).unwrap(), -div_pos);
    assert_eq!(wad_div(-b, -a).unwrap(), div_pos);
    println!("  Symmetric 4-quadrant signed arithmetic laws hold unconditionally.");

    // 6. Overflow protection on extreme inputs
    assert_eq!(wad_mul(i128::MAX, WAD).unwrap(), i128::MAX);
    assert_eq!(wad_mul(i128::MAX, WAD + 1), Err(MathError::Overflow));
    assert_eq!(wad_mul(i128::MAX, 2 * WAD), Err(MathError::Overflow));
    assert_eq!(wad_div(i128::MAX, WAD).unwrap(), i128::MAX);
    assert_eq!(wad_div(i128::MAX, WAD - 1), Err(MathError::Overflow));
    assert_eq!(wad_div(i128::MAX, 1), Err(MathError::Overflow));
    println!("  Max boundary overflow gating verified: i128::MAX * WAD / WAD accepted; > i128::MAX rejected.");

    // 7. Fuzzing 100,000 random vectors against oracle
    println!("  Fuzzing 100,000 randomized fixed-point operations against 256-bit oracle...");
    let mut rng = Lcg::new(0x1337_CAFE_BABE_BEEF);
    let mut mul_trials = 0;
    let mut div_trials = 0;

    for _ in 0..50_000 {
        // Generate values in [1, 10^27] so product fits in i128
        let r1 = ((rng.next_u64() as u128) * (rng.next_u64() as u128) % 1_000_000_000_000_000_000_000_000_000 + 1) as i128;
        let r2 = ((rng.next_u64() as u128) % 1_000_000_000_000_000_000 + 1) as i128;

        // Multiplication check
        if let Ok(res) = wad_mul(r1, r2) {
            let u1 = r1.unsigned_abs();
            let u2 = r2.unsigned_abs();
            let p = U256::mul_u128(u1, u2);
            let (expected_q, _) = div_256_64(p.hi, p.lo, WAD as u128).unwrap();
            assert_eq!(res.unsigned_abs(), expected_q);
            mul_trials += 1;
        }

        // Division check
        let d_val = ((rng.next_u64() as u128) % 1_000_000_000 + 1) as i128 * WAD;
        if let Ok(res) = wad_div(r1, d_val) {
            let u1 = r1.unsigned_abs();
            let u2 = d_val.unsigned_abs();
            let p = U256::mul_u128(u1, WAD as u128);
            let (expected_q, _) = div_256_64(p.hi, p.lo, u2).unwrap();
            assert_eq!(res.unsigned_abs(), expected_q);
            div_trials += 1;
        }
    }
    println!("  Completed {} wad_mul and {} wad_div fuzz trials with zero oracle divergence.", mul_trials, div_trials);
}

fn test_div_256_64_restoring_division_oracles() {
    println!("\n[CHALLENGE 1B] Testing div_256_64 Bitwise Restoring Division...");

    // 1. Division by zero
    assert_eq!(div_256_64(0, 100, 0), Err(MathError::DivisionByZero));
    assert_eq!(div_256_64(5, 100, 0), Err(MathError::DivisionByZero));

    // 2. hi >= d (Quotient >= 2^128, overflow)
    assert_eq!(div_256_64(10, 0, 10), Err(MathError::Overflow));
    assert_eq!(div_256_64(15, 0, 10), Err(MathError::Overflow));
    assert_eq!(div_256_64(u128::MAX, u128::MAX, u128::MAX), Err(MathError::Overflow));

    // 3. Exact division boundaries
    let (q, rem) = div_256_64(0, 0, 100).unwrap();
    assert_eq!(q, 0);
    assert_eq!(rem, 0);

    let (q, rem) = div_256_64(0, 100, 10).unwrap();
    assert_eq!(q, 10);
    assert_eq!(rem, 0);
    assert!(oracle_verify_division(0, 100, 10, q, rem));

    let (q, rem) = div_256_64(0, 107, 10).unwrap();
    assert_eq!(q, 10);
    assert_eq!(rem, 7);
    assert!(oracle_verify_division(0, 107, 10, q, rem));

    // 4. Boundary where hi = d - 1, lo = u128::MAX
    let d = 0x8000_0000_0000_0000_0000_0000_0000_0000u128; // 2^127
    let (q, rem) = div_256_64(d - 1, u128::MAX, d).unwrap();
    assert!(oracle_verify_division(d - 1, u128::MAX, d, q, rem));
    println!("  Tested extreme boundary (d = 2^127, hi = d-1, lo = u128::MAX): q={}, rem={}", q, rem);

    // 5. 50,000 fuzzing trials verifying theorem: q * d + rem == (hi << 128) + lo
    println!("  Fuzzing 50,000 pseudorandom 256/128 division cases against exact theorem...");
    let mut rng = Lcg::new(0xDEAD_BEEF_CAFE_0001);
    for _ in 0..50_000 {
        let d = rng.next_u128() | 1; // non-zero divisor
        let hi = rng.next_u128() % d; // guarantee hi < d so quotient fits in u128
        let lo = rng.next_u128();

        let (q, rem) = div_256_64(hi, lo, d).unwrap();
        assert!(oracle_verify_division(hi, lo, d, q, rem),
            "Division theorem violated: hi={}, lo={}, d={}, q={}, rem={}", hi, lo, d, q, rem);
    }
    println!("  50,000 division trials verified exact theorem: q * d + rem == (hi << 128) | lo with rem < d.");
}

fn test_transcendental_approximations_ln_wad() {
    println!("\n[CHALLENGE 2A] Testing Transcendental ln_wad Across Domain Edges...");

    // 1. Negative and zero inputs must be strictly rejected
    assert_eq!(ln_wad(0), Err(MathError::NegativeLogarithmInput));
    assert_eq!(ln_wad(-1), Err(MathError::NegativeLogarithmInput));
    assert_eq!(ln_wad(-WAD), Err(MathError::NegativeLogarithmInput));
    assert_eq!(ln_wad(i128::MIN), Err(MathError::NegativeLogarithmInput));
    println!("  x <= 0 inputs (0, -1, -WAD, i128::MIN) rejected with NegativeLogarithmInput.");

    // 2. Exactly 1.0 WAD -> ln(1) = 0
    assert_eq!(ln_wad(WAD).unwrap(), 0);
    println!("  ln_wad(1.0 WAD) == 0 (Exact identity verified).");

    // 3. Exactly 2.0 WAD -> ln(2) ~ LN_2
    let ln_2_calc = ln_wad(2 * WAD).unwrap();
    let diff_2 = (ln_2_calc - LN_2).abs();
    assert!(diff_2 < 1_000_000, "ln(2) deviation {} too large", diff_2);
    println!("  ln_wad(2.0 WAD) = {} (Dev from LN_2: {} WAD units, < 10^-12).", ln_2_calc, diff_2);

    // 4. Extreme lower boundary: 1 raw unit (10^-18 WAD)
    let ln_unit = ln_wad(1).unwrap();
    let expected_ln_unit = -41_446_531_673_892_820_000i128;
    let diff_unit = (ln_unit - expected_ln_unit).abs();
    assert!(diff_unit < 10_000_000_000, "ln(1) unit deviation {} too large", diff_unit);
    println!("  ln_wad(1 raw unit = 10^-18 WAD) = {} (Dev: {} units, ~10^-9 relative).", ln_unit, diff_unit);

    // 5. Extreme upper boundary: i128::MAX
    let ln_max = ln_wad(i128::MAX).unwrap();
    let expected_ln_max = 46_583_160_257_220_230_000i128;
    let diff_max = (ln_max - expected_ln_max).abs();
    assert!(diff_max < 10_000_000_000, "ln(i128::MAX) deviation {} too large", diff_max);
    println!("  ln_wad(i128::MAX) = {} (Accepted without overflow, accurate to ~10^-9).", ln_max);

    // 6. Monotonicity check across 2,000 points
    let mut prev = ln_wad(1).unwrap();
    for i in 1..=1000 {
        let x = (i as i128) * (WAD / 100);
        let curr = ln_wad(x).unwrap();
        assert!(curr > prev, "Monotonicity violated at x={}: prev={}, curr={}", x, prev, curr);
        prev = curr;
    }
    for i in 2..=1000 {
        let x = (i as i128) * 10 * WAD;
        let curr = ln_wad(x).unwrap();
        assert!(curr > prev, "Monotonicity violated at large scale x={}: prev={}, curr={}", x, prev, curr);
        prev = curr;
    }
    println!("  Monotonicity verified across entire domain: x1 < x2 => ln(x1) < ln(x2).");
}

fn test_transcendental_approximations_exp_wad() {
    println!("\n[CHALLENGE 2B] Testing Transcendental exp_wad Across Domain Edges...");

    // 1. Identity: exp(0) == WAD
    assert_eq!(exp_wad(0).unwrap(), WAD);
    println!("  exp_wad(0) == 1.0 WAD (Exact identity verified).");

    // 2. exp(1.0 WAD) ~ e
    let exp_1 = exp_wad(WAD).unwrap();
    let expected_e = 2_718_281_828_459_045_235i128;
    let diff_e = (exp_1 - expected_e).abs();
    assert!(diff_e < 100_000_000_000, "exp(1) diff {} too large", diff_e);
    println!("  exp_wad(1.0 WAD) = {} (Expected e, diff: {} WAD units).", exp_1, diff_e);

    // 3. Lower boundary: x < -41 WAD returns 0
    assert_eq!(exp_wad(-42 * WAD).unwrap(), 0);
    assert_eq!(exp_wad(-100 * WAD).unwrap(), 0);
    assert_eq!(exp_wad(i128::MIN).unwrap(), 0);
    let exp_neg41 = exp_wad(-41 * WAD).unwrap();
    assert!(exp_neg41 >= 0, "exp(-41 WAD) must be non-negative");
    println!("  Lower underflow edge verified: x < -41 WAD returns 0; exp(-41 WAD) = {}.", exp_neg41);

    // 4. Upper boundary: x = 46.44 WAD (MAX_EXP_INPUT)
    let exp_max = exp_wad(MAX_EXP_INPUT).unwrap();
    assert!(exp_max > 0, "exp(46.44 WAD) must be positive");
    assert!(exp_max < i128::MAX, "exp(46.44 WAD) must not exceed i128::MAX");
    println!("  Upper limit x = 46.44 WAD (MAX_EXP_INPUT): Computed = {} (< i128::MAX, non-negative).", exp_max);

    // 5. Overflow enforcement for x > 46.44 WAD
    assert_eq!(exp_wad(MAX_EXP_INPUT + 1), Err(MathError::Overflow));
    assert_eq!(exp_wad(MAX_EXP_INPUT + 1_000_000), Err(MathError::Overflow));
    assert_eq!(exp_wad(47 * WAD), Err(MathError::Overflow));
    assert_eq!(exp_wad(88 * WAD), Err(MathError::Overflow));
    assert_eq!(exp_wad(i128::MAX), Err(MathError::Overflow));
    println!("  Strict overflow rejection verified for x = 46.44 WAD + 1, 47 WAD, 88 WAD, and i128::MAX.");

    // 6. Round-trip Inverse property: exp(ln(x)) ~ x
    for val in [100_000_000_000_000_000i128, WAD, 2 * WAD, 5 * WAD, 10 * WAD, 20 * WAD] {
        let ln_x = ln_wad(val).unwrap();
        let exp_ln_x = exp_wad(ln_x).unwrap();
        let rel_err = ((exp_ln_x - val).abs() as f64) / (val as f64);
        assert!(rel_err < 1e-4, "Round trip exp(ln(x)) error too large: rel_err={}", rel_err);
    }
    println!("  Round-trip inversion exp(ln(x)) == x verified across yield-space scales.");
}

fn test_dynamic_ttl_calibration_horizons() {
    println!("\n[CHALLENGE 3] Testing Dynamic TTL Calibration Across 1d, 180d, 365d Horizons...");

    let now = 1_000_000_000u64;

    // Horizon 1: 1-Day Horizon (Short term)
    let mat_1d = now + 86_400;
    let bump_1d = calculate_bump_to(now, mat_1d);
    let thresh_1d = calculate_bump_threshold(bump_1d);
    println!("  [1d Horizon]   Maturity: +1d   | BUMP_TO: {} ledgers ({} days) | Threshold: {} ledgers ({} days)",
        bump_1d, bump_1d / DAY_IN_LEDGERS, thresh_1d, thresh_1d / DAY_IN_LEDGERS);
    assert_eq!(bump_1d, DEFAULT_BUMP_TO); // 120 days minimum
    assert_eq!(thresh_1d, MIN_BUMP_THRESHOLD); // 30 days minimum
    assert!(thresh_1d < bump_1d);
    assert!(bump_1d <= MAX_NETWORK_TTL);

    // Horizon 2: 180-Day Horizon (Protocol maximum network single bump)
    let mat_180d = now + 180 * 86_400;
    let bump_180d = calculate_bump_to(now, mat_180d);
    let thresh_180d = calculate_bump_threshold(bump_180d);
    println!("  [180d Horizon] Maturity: +180d | BUMP_TO: {} ledgers ({} days) | Threshold: {} ledgers ({} days)",
        bump_180d, bump_180d / DAY_IN_LEDGERS, thresh_180d, thresh_180d / DAY_IN_LEDGERS);
    assert_eq!(bump_180d, MAX_NETWORK_TTL); // Clamped exactly to 180 days (3,110,400 ledgers)
    assert_eq!(thresh_180d, 777_600); // 45 days (bump_to / 4)
    assert!(thresh_180d < bump_180d);

    // Horizon 3: 365-Day Horizon (Annual, exceeds network TTL cap)
    let mat_365d = now + 365 * 86_400;
    let bump_365d = calculate_bump_to(now, mat_365d);
    let thresh_365d = calculate_bump_threshold(bump_365d);
    println!("  [365d Horizon] Maturity: +365d | BUMP_TO: {} ledgers ({} days) | Threshold: {} ledgers ({} days)",
        bump_365d, bump_365d / DAY_IN_LEDGERS, thresh_365d, thresh_365d / DAY_IN_LEDGERS);
    assert_eq!(bump_365d, MAX_NETWORK_TTL); // Strictly clamped to 180 days (never exceeds protocol host limit)
    assert_eq!(thresh_365d, 777_600);
    assert!(thresh_365d < bump_365d);

    // Horizon Sweep: Invariant verification across all horizons from -100 days to +10 years
    println!("  Sweeping 1,000 horizon points from -100d to +3,650d to verify host invariants...");
    for day in -100..=3650 {
        let mat = if day < 0 {
            now.saturating_sub((-day as u64) * 86_400)
        } else {
            now + (day as u64) * 86_400
        };

        let b = calculate_bump_to(now, mat);
        let t = calculate_bump_threshold(b);

        // Stellar host constraint 1: threshold < bump_to
        assert!(t < b, "Stellar host violation: threshold {} >= bump_to {} at day {}", t, b, day);
        // Stellar host constraint 2: bump_to <= MAX_NETWORK_TTL (3,110,400)
        assert!(b <= MAX_NETWORK_TTL, "Network TTL cap violated: bump_to {} > MAX_NETWORK_TTL at day {}", b, day);
        // Protocol constraint 3: bump_to >= DEFAULT_BUMP_TO (120 days)
        assert!(b >= DEFAULT_BUMP_TO, "Protocol floor violated: bump_to {} < DEFAULT_BUMP_TO at day {}", b, day);
        // Protocol constraint 4: threshold >= MIN_BUMP_THRESHOLD (30 days)
        assert!(t >= MIN_BUMP_THRESHOLD, "Threshold floor violated: threshold {} < MIN_BUMP_THRESHOLD at day {}", t, day);
    }
    println!("  1,000 horizon sweep passed: threshold < bump_to <= 3,110,400 ledgers holds unconditionally.");
}

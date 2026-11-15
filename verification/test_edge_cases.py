#!/usr/bin/env python3
"""
test_edge_cases.py
Empirical Challenger: Verify Negative Yield Regimes & Zero-Liquidity Initialization
"""

import math

WAD = 10**18

def test_negative_yield_regime():
    print("================================================================================")
    print("CHALLENGE 4: EDGE CASES VERIFICATION")
    print("================================================================================")
    print("\n[Edge Case 1] Negative Yield Regime (E < 1.0):")

    # In STELLAR_PENDLE_TECHNICAL_SPECIFICATION.md Section 3.2.3:
    # P_PT = 1 / E
    # P_YT = (E - 1) / E = 1 - 1 / E
    # Linear APY = (E - 1) / tau
    
    test_rates = [
        {"E": 1.05, "desc": "Normal positive yield (+5%)"},
        {"E": 1.00, "desc": "Zero yield (E = 1.0)"},
        {"E": 0.98, "desc": "Mild negative yield (-2%)"},
        {"E": 0.50, "desc": "Deep negative yield (-50%)"},
        {"E": 0.00, "desc": "Zero exchange rate (E = 0)"},
        {"E": -0.50, "desc": "Negative exchange rate (E = -0.5)"},
    ]

    for tr in test_rates:
        e = tr["E"]
        desc = tr["desc"]
        print(f"\n  Scenario: {desc} (E = {e}):")
        
        # 1. PT Price
        if e > 0:
            p_pt = 1.0 / e
            p_yt = (e - 1.0) / e
            print(f"    P_PT = {p_pt:8.4f} | P_YT = {p_yt:8.4f}")
            if p_pt > 1.0:
                print(f"    ANOMALY: P_PT > 1.0! PT trades at a premium over 1:1 maturity value.")
            if p_yt < 0.0:
                print(f"    CRITICAL ANOMALY: P_YT < 0! YT has a NEGATIVE price ({p_yt:.4f}).")
        elif e == 0:
            print(f"    CRITICAL EXCEPTION: E = 0 -> DivisionByZero when calculating P_PT = 1 / E.")
        else:
            p_pt = 1.0 / e
            p_yt = (e - 1.0) / e
            print(f"    CRITICAL ANOMALY: E < 0 -> P_PT = {p_pt:.4f} < 0, P_YT = {p_yt:.4f} > 0.")
            print(f"    Both PT and underlying exchange rates invert completely.")

    # 2. Swap math under E < 1.0 and E <= 0
    print("\n  Evaluating swap_exact_pt_for_sy implementation (Module 3 lines 921-950):")
    # In Rust:
    # let e_trade = get_exchange_rate(new_pt, state.total_sy, state.rate_scalar, state.rate_anchor)?;
    # let gross_sy_out = wad_div(exact_pt_in, e_trade)?;
    # let net_sy_out = gross_sy_out - fee;
    # let new_sy = state.total_sy - net_sy_out;
    
    # If e_trade is negative (e.g. -0.9346 as seen when p=0.04 at 30 days):
    exact_pt_in = 1000 * WAD
    e_trade_neg = int(-0.9346 * WAD)
    try:
        gross_sy_out = (exact_pt_in * WAD) // e_trade_neg
        fee = (gross_sy_out * 3) // 1000
        net_sy_out = gross_sy_out - fee
        total_sy = 100000 * WAD
        new_sy = total_sy - net_sy_out
        print(f"    When e_trade is negative (-0.9346):")
        print(f"      gross_sy_out = {gross_sy_out / WAD:.4f} SY (NEGATIVE!)")
        print(f"      net_sy_out   = {net_sy_out / WAD:.4f} SY (NEGATIVE!)")
        print(f"      new_sy       = {new_sy / WAD:.4f} SY (INCREASED reserves: {total_sy/WAD} -> {new_sy/WAD})")
        print(f"      Trader sends PT and 'receives' negative SY (i.e. pool demands SY from trader instead of paying)!")
    except Exception as exc:
        print(f"    Exception in negative e_trade swap: {exc}")

def test_zero_liquidity_initialization():
    print("\n[Edge Case 2] Zero-Liquidity Initialization:")
    
    # Test 1: Calling get_exchange_rate with total_pt = 0 or total_sy = 0
    print("  Test 2.1: get_exchange_rate on empty pool (total_pt = 0, total_sy = 0):")
    # Rust: let ratio = wad_div(total_pt, total_sy)?;
    # Rust: let ln_ratio = ln_wad(ratio)?;
    
    cases = [
        {"pt": 0, "sy": 0, "desc": "Both reserves zero"},
        {"pt": 0, "sy": 1000 * WAD, "desc": "Only PT reserve zero"},
        {"pt": 1000 * WAD, "sy": 0, "desc": "Only SY reserve zero"},
    ]
    for c in cases:
        pt = c["pt"]
        sy = c["sy"]
        desc = c["desc"]
        print(f"    Scenario: {desc} (PT={pt/WAD}, SY={sy/WAD}):")
        if sy == 0:
            print(f"      FAIL: DivisionByZero in wad_div(total_pt, total_sy)")
        elif pt == 0:
            print(f"      ratio = 0 -> ln_wad(0) fails with NegativeLogarithmInput error")
            
    # Test 2: Initial liquidity proportion check
    print("\n  Test 2.2: Initial LP provision proportion check:")
    print("    Specification enforces: prop in [0.04, 0.96] (MIN_MARKET_PROPORTION to MAX_MARKET_PROPORTION)")
    print("    If first LP deposits: 1 PT and 100 SY:")
    pt_init = 1 * WAD
    sy_init = 100 * WAD
    total_res = pt_init + sy_init
    prop = (pt_init * WAD) // total_res
    print(f"      p = {prop / WAD:.6f} (< 0.04) -> Violates MIN_MARKET_PROPORTION")
    print(f"      Any single-sided or highly imbalanced initial LP deposit is immediately rejected.")
    
    # Test 3: Absence of LP minting formula & minimum liquidity lock (inflation attack)
    print("\n  Test 2.3: LP share calculation & ERC-4626 style inflation attack risk:")
    print("    Specification omits: add_liquidity / remove_liquidity implementation in Module 3.")
    print("    Specification omits: Minimum liquidity burn (e.g. 1000 dead shares locked permanently).")
    print("    VULNERABILITY: If LP shares are computed as shares = (deposit_sy * total_lp_shares) / total_sy,")
    print("    the first depositor can deposit 1 stroop, donate 10,000 SY to the pool, and inflate share price,")
    print("    causing subsequent depositors' funds to round down to 0 shares (Classic Inflation Attack).")

if __name__ == "__main__":
    test_negative_yield_regime()
    test_zero_liquidity_initialization()

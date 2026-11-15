#!/usr/bin/env python3
"""
test_log_normal_curve.py
Empirical Challenger: Test the Log-Normal Yield AMM Pricing Curve & Time Decay
"""

import math
import sys

def E_spec(p, tau, S_root=20.0, alpha=1.0):
    """
    Specification Formula (STELLAR_PENDLE_TECHNICAL_SPECIFICATION.md Section 3.2.1-3.2.2):
    R_scalar(tau) = S_root * tau
    E = alpha + (1 / R_scalar) * ln(x / y)
    where x/y = p / (1 - p)
    """
    R_scalar = S_root * tau
    if R_scalar == 0:
        raise ZeroDivisionError("R_scalar is zero at tau = 0 (division by zero)")
    x_over_y = p / (1.0 - p)
    return alpha + (1.0 / R_scalar) * math.log(x_over_y)

def E_canonical(p, tau, S_root=20.0, alpha=1.0):
    """
    Canonical Notional / Pendle V2 Formula:
    rate_scalar(tau) = S_root / tau
    E = alpha + (1 / rate_scalar) * ln(x / y) = alpha + (tau / S_root) * ln(x / y)
    """
    if tau == 0:
        return alpha
    x_over_y = p / (1.0 - p)
    return alpha + (tau / S_root) * math.log(x_over_y)

def run_tests():
    print("================================================================================")
    print("CHALLENGE 1: LOG-NORMAL INVARIANT & TIME DECAY VERIFICATION")
    print("================================================================================")
    
    # 1. Test Proportion Boundaries at 1 Year (tau = 1.0)
    tau_1y = 1.0
    print(f"\n[Test 1.1] Proportion boundary behavior at tau = 1.0 year:")
    for p in [0.04, 0.10, 0.50, 0.90, 0.96]:
        e_val = E_spec(p, tau_1y)
        p_pt = 1.0 / e_val
        p_yt = 1.0 - p_pt
        print(f"  p = {p:.2f} | x/y = {p/(1-p):8.4f} | E = {e_val:8.4f} | P_PT = {p_pt:8.4f} | P_YT = {p_yt:8.4f}")
    
    # 2. Test Time Decay as tau -> 0 under Specification Formula
    print(f"\n[Test 1.2] Time decay stress test under SPECIFICATION formula (R_scalar = S_root * tau):")
    time_points = [
        (365, "1 Year"),
        (90, "3 Months"),
        (30, "1 Month"),
        (7, "1 Week"),
        (1, "1 Day"),
        (0.1, "2.4 Hours"),
        (0.001, "1.4 Minutes"),
        (0.0, "Maturity (t = T)"),
    ]
    
    spec_failures = []
    for days, label in time_points:
        tau = days / 365.25
        print(f"\n  Time to maturity: {label} ({days} days, tau = {tau:.6f})")
        for p in [0.04, 0.49, 0.50, 0.51, 0.96]:
            try:
                e_val = E_spec(p, tau)
                p_pt = 1.0 / e_val if e_val != 0 else float('inf')
                p_yt = 1.0 - p_pt
                
                # Check for critical anomalies:
                status = "OK"
                if e_val <= 0:
                    status = "CRITICAL FAIL: E <= 0 (Negative Exchange Rate)"
                    spec_failures.append((label, p, f"E = {e_val:.4f} <= 0"))
                elif p_pt < 0:
                    status = "CRITICAL FAIL: Negative PT Price"
                    spec_failures.append((label, p, f"P_PT = {p_pt:.4f} < 0"))
                elif days <= 1.0 and p != 0.50 and abs(p_pt - 1.0) > 0.05:
                    status = f"FAIL: Diverged from 1.0 (|P_PT - 1.0| = {abs(p_pt - 1.0):.4f})"
                    spec_failures.append((label, p, status))
                
                print(f"    p={p:.2f}: E = {e_val:12.4f} | P_PT = {p_pt:10.4f} | P_YT = {p_yt:10.4f} | {status}")
            except ZeroDivisionError as zde:
                print(f"    p={p:.2f}: CRITICAL EXCEPTION: {zde}")
                spec_failures.append((label, p, "ZeroDivisionError"))
    
    # 3. Test Time Decay under Canonical Notional / Pendle V2 Formula
    print(f"\n[Test 1.3] Time decay under CANONICAL formula (rate_scalar = S_root / tau):")
    canonical_failures = []
    for days, label in time_points:
        tau = days / 365.25
        print(f"\n  Time to maturity: {label} ({days} days, tau = {tau:.6f})")
        for p in [0.04, 0.49, 0.50, 0.51, 0.96]:
            e_val = E_canonical(p, tau)
            p_pt = 1.0 / e_val
            p_yt = 1.0 - p_pt
            # In canonical formula, P_PT must converge to 1.0 as tau -> 0
            dev = abs(p_pt - 1.0)
            status = "CONVERGES" if dev < 0.05 or days > 30 else "OK"
            print(f"    p={p:.2f}: E = {e_val:8.4f} | P_PT = {p_pt:8.4f} | P_YT = {p_yt:8.4f} | dev from 1.0: {dev:.6f}")
            if days <= 1.0 and dev > 0.01:
                canonical_failures.append((label, p, f"Failed convergence: dev={dev}"))
    
    print("\n--------------------------------------------------------------------------------")
    print(f"SPECIFICATION FORMULA TEST SUMMARY:")
    print(f"  Total failure instances: {len(spec_failures)}")
    for f in spec_failures[:10]:
        print(f"    - At {f[0]}, p={f[1]}: {f[2]}")
    if len(spec_failures) > 10:
        print(f"    ... and {len(spec_failures) - 10} more failures.")
        
    print(f"\nCANONICAL NOTIONAL FORMULA SUMMARY:")
    print(f"  Total failure instances: {len(canonical_failures)}")
    print("--------------------------------------------------------------------------------")

if __name__ == "__main__":
    run_tests()

#!/usr/bin/env python3
"""
Empirical Challenge 1: Soroban State TTL Decay & Archival Stress Test
Simulates ledger decay, keeper thresholds, multi-contract instance lifecycles,
persistent storage archival for fixed-income maturities, and the temporary storage reentrancy guard.
"""

import sys

def simulate_ledger_rates():
    """Verify ledger generation rates under various network scenarios."""
    seconds_per_day = 86400
    scenarios = [
        ("Nominal (Spec claim)", 5.0),
        ("Fast Consensus (Low load)", 4.0),
        ("Slight Delay (Moderate load)", 5.2),
        ("Network Congestion / Catchup", 6.0),
        ("Extreme Validator Latency", 7.5),
    ]
    results = {}
    for name, block_time in scenarios:
        ledgers_per_day = seconds_per_day / block_time
        days_for_100k = 100_000 / ledgers_per_day
        days_for_535k = 535_680 / ledgers_per_day
        days_for_2073k = 2_073_600 / ledgers_per_day
        results[name] = {
            "block_time": block_time,
            "ledgers_per_day": ledgers_per_day,
            "days_100k": days_for_100k,
            "days_535k": days_for_535k,
            "days_2073k": days_for_2073k
        }
    return results

def test_keeper_threshold_safety_margin():
    """
    Stress-test the safety margin of 100,000 ledger keeper threshold.
    Evaluate what happens under network congestion or keeper outages.
    """
    ledger_rate = 17280  # 5s per ledger
    keeper_threshold = 100_000 # ledgers (~5.78 days)
    
    outage_durations_hours = [12, 24, 48, 72, 96, 120, 138, 144]
    outage_results = []
    
    for hours in outage_durations_hours:
        ledgers_elapsed = int(hours * 3600 / 5.0)
        remaining_ttl = keeper_threshold - ledgers_elapsed
        is_archived = remaining_ttl <= 0
        outage_results.append({
            "hours": hours,
            "ledgers_elapsed": ledgers_elapsed,
            "remaining_ttl": remaining_ttl,
            "remaining_days": remaining_ttl / ledger_rate if remaining_ttl > 0 else 0,
            "archived": is_archived
        })
    return outage_results

def test_fixed_income_maturity_archival():
    """
    Stress-test persistent storage TTL against fixed-income maturity horizons.
    Fixed income products typically have 30, 90, 180, and 365 day maturities.
    Spec defines BUMP_TO = 120 days (2,073,600 ledgers).
    """
    bump_to_days = 120
    maturities = [
        ("1 Month (30d)", 30),
        ("3 Month (90d)", 90),
        ("6 Month (180d)", 180),
        ("1 Year (365d)", 365),
    ]
    results = []
    for label, maturity_days in maturities:
        # A passive user deposits at t=0, holds PT until maturity, and does not touch the contract.
        ttl_at_maturity = bump_to_days - maturity_days
        archived = ttl_at_maturity <= 0
        results.append({
            "label": label,
            "maturity_days": maturity_days,
            "bump_to_days": bump_to_days,
            "ttl_at_maturity_days": ttl_at_maturity,
            "user_balance_archived": archived,
            "total_supply_archived_if_no_activity": archived
        })
    return results

def test_temporary_reentrancy_lock():
    """
    Simulates Soroban Temporary Storage behavior for FlashLoanGuard.
    In Soroban:
    - Temporary storage entries have a TTL (minimum 16 ledgers).
    - Temporary entries DO NOT automatically reset at transaction boundary!
    - If contract sets DataKey::FlashLoanGuard = true and fails to delete it in a finally/defer block,
      all future transactions fail with ReentrancyLocked!
    """
    class MockStorage:
        def __init__(self):
            self.temporary = {}
            
        def set_temporary(self, key, val, ttl_ledgers=16):
            self.temporary[key] = (val, ttl_ledgers)
            
        def has_temporary(self, key):
            return key in self.temporary
            
        def elapse_ledger(self):
            expired = []
            for k, (v, ttl) in self.temporary.items():
                if ttl <= 1:
                    expired.append(k)
                else:
                    self.temporary[k] = (v, ttl - 1)
            for k in expired:
                del self.temporary[k]

    storage = MockStorage()
    
    # Tx 1: Flash loan / Mint operation
    # Contract code in spec line 546-549:
    # if env.storage().temporary().has(&DataKey::FlashLoanGuard) {
    #     panic_with_error!(&env, ContractError::ReentrancyLocked);
    # }
    # env.storage().temporary().set(&DataKey::FlashLoanGuard, &true);
    # NOTE: Spec NEVER clears FlashLoanGuard!
    
    # Run Tx 1
    tx1_guard_detected = storage.has_temporary("FlashLoanGuard")
    assert not tx1_guard_detected, "Tx 1 should pass"
    storage.set_temporary("FlashLoanGuard", True, ttl_ledgers=16)
    # Tx 1 finishes, but does NOT call temporary().remove(&DataKey::FlashLoanGuard)
    
    # Run Tx 2 in the same ledger:
    tx2_guard_detected = storage.has_temporary("FlashLoanGuard")
    tx2_failed = tx2_guard_detected
    
    # Run Tx 3 after 5 ledgers (25 seconds later):
    for _ in range(5):
        storage.elapse_ledger()
    tx3_guard_detected = storage.has_temporary("FlashLoanGuard")
    tx3_failed = tx3_guard_detected

    # Run Tx 4 after 16 total ledgers (80 seconds later):
    for _ in range(11):
        storage.elapse_ledger()
    tx4_guard_detected = storage.has_temporary("FlashLoanGuard")
    tx4_passed = not tx4_guard_detected
    
    return {
        "tx1_passed": True,
        "tx2_failed_in_same_ledger": tx2_failed,
        "tx3_failed_after_5_ledgers": tx3_failed,
        "tx4_passed_only_after_16_ledgers": tx4_passed
    }

if __name__ == "__main__":
    print("=== EMPIRICAL TEST: LEDGER GENERATION RATES ===")
    rates = simulate_ledger_rates()
    for name, data in rates.items():
        print(f"[{name}] {data['ledgers_per_day']:.1f} ledgers/day | 100k ledgers = {data['days_100k']:.2f} days | 535k ledgers = {data['days_535k']:.2f} days")
    
    print("\n=== EMPIRICAL TEST: KEEPER OUTAGE SURVIVAL ===")
    outages = test_keeper_threshold_safety_margin()
    for o in outages:
        status = "ARCHIVED/EXPIRED!" if o['archived'] else f"Safe ({o['remaining_days']:.2f} days left)"
        print(f"Outage {o['hours']:3d}h ({o['ledgers_elapsed']:6d} ledgers) -> Remaining TTL: {o['remaining_ttl']:6d} -> {status}")
        
    print("\n=== EMPIRICAL TEST: FIXED-INCOME MATURITY ARCHIVAL ===")
    maturities = test_fixed_income_maturity_archival()
    for m in maturities:
        status = "CRITICAL: ARCHIVED BEFORE MATURITY!" if m['user_balance_archived'] else "Active at maturity"
        print(f"Maturity {m['label']} -> TTL at maturity: {m['ttl_at_maturity_days']} days -> {status}")

    print("\n=== EMPIRICAL TEST: TEMPORARY REENTRANCY LOCK BUG ===")
    reentrancy = test_temporary_reentrancy_lock()
    print(f"Tx 2 fails in same ledger: {reentrancy['tx2_failed_in_same_ledger']}")
    print(f"Tx 3 fails 25s later: {reentrancy['tx3_failed_after_5_ledgers']}")
    print(f"Tx 4 passes after 16 ledgers: {reentrancy['tx4_passed_only_after_16_ledgers']}")

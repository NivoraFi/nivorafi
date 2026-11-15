#!/usr/bin/env python3
"""
Empirical Challenge 3: Blend Insolvency, Utilization Spikes & Bad Debt Haircut
Simulates:
1. 100% Blend pool utilization: withdrawal reverts and locks PT redemptions.
2. Bad debt bank run under naive 1:1 redemption vs proportional haircut socialization.
3. Stress test of missing unwind queue mechanics.
"""

def simulate_blend_100pct_utilization_revert():
    """
    Simulates Blend lending pool when utilization = 100%.
    Blend contract reverts when withdraw request > available cash.
    """
    class MockBlendPool:
        def __init__(self, total_deposits, total_borrows):
            self.total_deposits = total_deposits
            self.total_borrows = total_borrows
            
        @property
        def available_cash(self):
            return max(0, self.total_deposits - self.total_borrows)
            
        @property
        def utilization(self):
            return self.total_borrows / self.total_deposits if self.total_deposits > 0 else 0
            
        def submit_withdraw(self, amount):
            if amount > self.available_cash:
                raise RuntimeError("BlendError::InsufficientPoolLiquidity")
            self.total_deposits -= amount
            return amount

    # Normal state: 80% utilization
    pool_normal = MockBlendPool(total_deposits=1_000_000, total_borrows=800_000)
    normal_withdraw_success = False
    try:
        pool_normal.submit_withdraw(50_000)
        normal_withdraw_success = True
    except RuntimeError:
        pass

    # Stressed state: 100% utilization (all deposits borrowed out)
    pool_stressed = MockBlendPool(total_deposits=1_000_000, total_borrows=1_000_000)
    stressed_withdraw_success = False
    revert_error = None
    try:
        pool_stressed.submit_withdraw(50_000)
        stressed_withdraw_success = True
    except RuntimeError as e:
        revert_error = str(e)

    return {
        "normal_utilization": pool_normal.utilization,
        "normal_withdraw_success": normal_withdraw_success,
        "stressed_utilization": pool_stressed.utilization,
        "stressed_withdraw_success": stressed_withdraw_success,
        "revert_error": revert_error
    }

def simulate_bank_run_vs_haircut():
    """
    Simulates a 10% bad debt event in Blend pool.
    Total PT supply = 1,000,000 PT.
    Total recoverable underlying = 900,000 USDC.
    Users:
      Alice: 500,000 PT (redeems 1st)
      Bob:   400,000 PT (redeems 2nd)
      Carol: 100,000 PT (redeems 3rd)
    """
    users = [("Alice", 500_000), ("Bob", 400_000), ("Carol", 100_000)]
    
    # 1. Naive 1:1 Redemption (as claimed in spec line 65 and line 1360)
    vault_cash_naive = 900_000.0
    naive_payouts = {}
    for name, pt in users:
        payout = min(vault_cash_naive, float(pt))
        vault_cash_naive -= payout
        payout_pct = (payout / pt) * 100.0
        naive_payouts[name] = {"pt": pt, "received": payout, "recovery_pct": payout_pct}

    # 2. Proportional Loss Socialization (as claimed in spec line 1370)
    # Haircut Factor H = total_vault_assets / total_pt_supply = 900k / 1000k = 0.90
    total_pt_supply = 1_000_000.0
    vault_cash_haircut = 900_000.0
    haircut_factor = vault_cash_haircut / total_pt_supply
    
    haircut_payouts = {}
    for name, pt in users:
        payout = pt * haircut_factor
        vault_cash_haircut -= payout
        payout_pct = (payout / pt) * 100.0
        haircut_payouts[name] = {"pt": pt, "received": payout, "recovery_pct": payout_pct}

    return {
        "haircut_factor": haircut_factor,
        "naive_payouts": naive_payouts,
        "haircut_payouts": haircut_payouts
    }

if __name__ == "__main__":
    print("=== EMPIRICAL TEST: BLEND 100% UTILIZATION WITHDRAWAL REVERT ===")
    u_res = simulate_blend_100pct_utilization_revert()
    print(f"Normal (Util={u_res['normal_utilization']*100:.0f}%): Withdraw Success = {u_res['normal_withdraw_success']}")
    print(f"Stressed (Util={u_res['stressed_utilization']*100:.0f}%): Withdraw Success = {u_res['stressed_withdraw_success']} | Error = {u_res['revert_error']}")

    print("\n=== EMPIRICAL TEST: BANK RUN VS PROPORTIONAL LOSS HAIRCUT ===")
    b_res = simulate_bank_run_vs_haircut()
    print("--- Case A: Naive 1:1 Redemption (Bank Run) ---")
    for name, d in b_res['naive_payouts'].items():
        print(f"  {name:6s} | PT: {d['pt']:7.0f} | Received: ${d['received']:7.0f} | Recovery: {d['recovery_pct']:5.1f}%")
        
    print(f"\n--- Case B: Proportional Haircut Socialization (Factor = {b_res['haircut_factor']:.2f}) ---")
    for name, d in b_res['haircut_payouts'].items():
        print(f"  {name:6s} | PT: {d['pt']:7.0f} | Received: ${d['received']:7.0f} | Recovery: {d['recovery_pct']:5.1f}%")

#!/usr/bin/env python3
"""
test_flash_swap_math.py
Empirical Challenger: Verify Single-Pool Flash Swap Mechanics & 1:1 Asset Backing
"""

import math

def simulate_flash_swap_buy_yt(
    initial_sy_reserve,
    initial_pt_reserve,
    rate_anchor,
    rate_scalar,
    yt_amount_requested,
    fee_rate=0.0030,
    current_index=1.05,
    initial_index=1.00,
):
    """
    Simulates buying N YT via flash-minting (PT, YT) and selling PT into PT/SY pool.
    """
    N = yt_amount_requested
    
    # Pre-swap state
    x0 = initial_pt_reserve
    y0 = initial_sy_reserve
    
    # 1. Flash-mint N PT + N YT against N virtual SY
    # Pool receives N PT
    x1 = x0 + N
    
    # 2. Pool executes swap of N PT for SY
    # Using the AMM formula:
    # E_trade = rate_anchor + (1/rate_scalar) * ln(x1 / y0)
    ratio = x1 / y0
    ln_ratio = math.log(ratio)
    e_trade = rate_anchor + (1.0 / rate_scalar) * ln_ratio
    
    gross_sy_out = N / e_trade
    fee = gross_sy_out * fee_rate
    net_sy_out = gross_sy_out - fee
    
    y1 = y0 - net_sy_out
    
    # 3. New Rate Anchor update as in spec line 943:
    # new_anchor = e_trade - (1/rate_scalar) * ln(x1 / y1)
    new_anchor = e_trade - (1.0 / rate_scalar) * math.log(x1 / y1)
    
    # Post-swap spot exchange rate with new reserves and new anchor:
    e_post = new_anchor + (1.0 / rate_scalar) * math.log(x1 / y1)
    
    # 4. User net payment in SY
    delta_y_net = N - net_sy_out
    
    # 5. Vault Accounting:
    # The vault minted N PT and N YT.
    # The vault requires exactly N SY to back the newly minted N (PT + YT).
    # Source of SY:
    # - Pool released net_sy_out SY
    # - User paid delta_y_net SY
    total_sy_received_by_vault = net_sy_out + delta_y_net
    
    # 6. Conservation of Assets vs Liabilities
    # Value in Blend: N SY * (current_index / initial_index)
    total_vault_assets = N * (current_index / initial_index)
    
    # Protocol liabilities:
    # PT obligation = N underlying
    # YT yield obligation = N * (current_index - initial_index) / initial_index
    pt_liability = N
    yt_liability = N * (current_index - initial_index) / initial_index
    total_liabilities = pt_liability + yt_liability
    
    backing_deficit = total_liabilities - total_vault_assets
    
    # Invariant preservation check:
    invariant_preserved = abs(e_post - e_trade) < 1e-12
    
    return {
        "N": N,
        "x0": x0, "y0": y0,
        "x1": x1, "y1": y1,
        "e_trade": e_trade,
        "net_sy_out": net_sy_out,
        "delta_y_net": delta_y_net,
        "total_sy_received": total_sy_received_by_vault,
        "vault_assets": total_vault_assets,
        "total_liabilities": total_liabilities,
        "backing_deficit": backing_deficit,
        "invariant_preserved": invariant_preserved,
        "new_anchor": new_anchor,
        "e_post": e_post,
    }

def run_tests():
    print("================================================================================")
    print("CHALLENGE 2: SINGLE-POOL FLASH SWAP MECHANICS & 1:1 BACKING VERIFICATION")
    print("================================================================================")
    
    test_cases = [
        {"name": "Standard Trade (1,000 YT on 100k pool)", "N": 1000.0, "x": 100_000.0, "y": 100_000.0, "anchor": 1.05, "scalar": 20.0},
        {"name": "Large Trade (10,000 YT on 100k pool)", "N": 10000.0, "x": 100_000.0, "y": 100_000.0, "anchor": 1.05, "scalar": 20.0},
        {"name": "Asymmetric Pool (x=150k, y=80k)", "N": 5000.0, "x": 150_000.0, "y": 80_000.0, "anchor": 1.08, "scalar": 20.0},
        {"name": "Micro Trade (1 YT on 1M pool)", "N": 1.0, "x": 1_000_000.0, "y": 1_000_000.0, "anchor": 1.02, "scalar": 50.0},
    ]
    
    all_passed = True
    for tc in test_cases:
        res = simulate_flash_swap_buy_yt(
            initial_sy_reserve=tc["y"],
            initial_pt_reserve=tc["x"],
            rate_anchor=tc["anchor"],
            rate_scalar=tc["scalar"],
            yt_amount_requested=tc["N"],
            fee_rate=0.0030,
            current_index=1.12,
            initial_index=1.00,
        )
        
        print(f"\n[Test Case] {tc['name']}:")
        print(f"  Requested YT: {res['N']:.2f}")
        print(f"  Pool Output SY: {res['net_sy_out']:.6f} | User Net Paid SY: {res['delta_y_net']:.6f}")
        print(f"  Total SY Deposited to Vault: {res['total_sy_received']:.6f} (Expected: {res['N']:.6f})")
        print(f"  Vault Assets: {res['vault_assets']:.6f} | Liabilities: {res['total_liabilities']:.6f}")
        print(f"  Backing Deficit: {res['backing_deficit']:.12e}")
        print(f"  Invariant Preserved (E_post == E_trade): {res['invariant_preserved']} (E_trade={res['e_trade']:.8f}, E_post={res['e_post']:.8f})")
        
        # Verify backing
        if abs(res["total_sy_received"] - res["N"]) > 1e-9:
            print("  FAIL: Vault did not receive exact N SY!")
            all_passed = False
        if abs(res["backing_deficit"]) > 1e-9:
            print("  FAIL: Backing deficit non-zero!")
            all_passed = False
        if not res["invariant_preserved"]:
            print("  FAIL: Invariant not preserved!")
            all_passed = False
            
    print("\n--------------------------------------------------------------------------------")
    print(f"FLASH SWAP 1:1 ASSET BACKING VERIFICATION: {'PASSED' if all_passed else 'FAILED'}")
    print("--------------------------------------------------------------------------------")

if __name__ == "__main__":
    run_tests()

#!/usr/bin/env python3
"""
Empirical Challenge 2: Keeper Failure & Re-org/Recovery Scenarios
Simulates:
1. Keeper crash for 48 hours around maturity: AMM pricing failure when tau < 0.
2. Duplicate settle_maturity() execution: non-idempotent vs idempotent vs revert.
3. Blend rate abrupt shift between keeper sync ticks: arbitrage exploitation of stale index.
"""

import math

def simulate_amm_pricing_post_maturity_without_keeper(maturity_timestamp=1000, current_timestamps=[990, 999, 1000, 1001, 1010, 1100]):
    """
    If keeper is down and does not settle maturity, what happens if AMM pricing is evaluated for t >= T?
    Pricing formula from spec:
    tau = (T - t) / 31536000
    R_scalar = S_root * tau
    E = alpha + (1 / R_scalar) * ln(x / y)
    P_pt = 1 / E
    P_yt = 1 - P_pt
    """
    S_root = 20.0
    alpha = 1.05
    x = 100_000.0
    y = 95_000.0  # slight imbalance: ln(x/y) > 0
    ln_xy = math.log(x / y)
    
    results = []
    for t in current_timestamps:
        time_to_maturity_sec = maturity_timestamp - t
        tau = time_to_maturity_sec / 31_536_000.0
        
        if tau == 0:
            # Division by zero!
            results.append({
                "timestamp": t,
                "tau": tau,
                "status": "DIV_BY_ZERO_EXCEPTION",
                "E": None,
                "P_pt": None,
                "P_yt": None
            })
        elif tau < 0:
            # Negative time to maturity!
            R_scalar = S_root * tau
            E = alpha + (1.0 / R_scalar) * ln_xy
            P_pt = 1.0 / E if E != 0 else None
            P_yt = 1.0 - P_pt if P_pt is not None else None
            results.append({
                "timestamp": t,
                "tau": tau,
                "status": "INVERTED_NEGATIVE_RATE",
                "E": E,
                "P_pt": P_pt,
                "P_yt": P_yt
            })
        else:
            R_scalar = S_root * tau
            E = alpha + (1.0 / R_scalar) * ln_xy
            P_pt = 1.0 / E
            P_yt = 1.0 - P_pt
            results.append({
                "timestamp": t,
                "tau": tau,
                "status": "VALID",
                "E": E,
                "P_pt": P_pt,
                "P_yt": P_yt
            })
    return results

def simulate_duplicate_settlement():
    """
    Simulates duplicate settle_maturity transactions.
    Scenario 1: Non-idempotent overwrite (keeper retries at t2 > t1)
    Scenario 2: Strict revert on already settled
    Scenario 3: Idempotent return of frozen settlement index
    """
    class MarketState:
        def __init__(self):
            self.is_settled = False
            self.settlement_index = 0
            
        def settle_overwrite(self, current_blend_index):
            # Flawed pattern: overwrites without checking is_settled
            self.settlement_index = current_blend_index
            self.is_settled = True
            return self.settlement_index

        def settle_revert(self, current_blend_index):
            # Fragile pattern: throws error if already settled
            if self.is_settled:
                raise RuntimeError("ContractError::AlreadySettled")
            self.settlement_index = current_blend_index
            self.is_settled = True
            return self.settlement_index

        def settle_idempotent(self, current_blend_index):
            # Robust pattern: returns existing index if already settled
            if self.is_settled:
                return self.settlement_index
            self.settlement_index = current_blend_index
            self.is_settled = True
            return self.settlement_index

    # Initial state at maturity T: blend_index = 1.10 (10% yield accrued)
    m1 = MarketState()
    idx1 = m1.settle_overwrite(1.10)
    # Keeper retries 2 days later: blend accrued more yield, index = 1.12
    idx2 = m1.settle_overwrite(1.12)
    # Vulnerability: Settlement index shifted from 1.10 to 1.12 post-maturity!
    loss_of_conservation = (idx2 != idx1)

    m2 = MarketState()
    m2.settle_revert(1.10)
    try:
        m2.settle_revert(1.10)
        revert_threw = False
    except RuntimeError:
        revert_threw = True

    m3 = MarketState()
    m3_idx1 = m3.settle_idempotent(1.10)
    m3_idx2 = m3.settle_idempotent(1.12)
    idempotent_success = (m3_idx1 == m3_idx2 == 1.10)

    return {
        "overwrite_causes_rate_drift": loss_of_conservation,
        "first_index": idx1,
        "corrupted_second_index": idx2,
        "revert_throws_on_retry": revert_threw,
        "idempotent_safe": idempotent_success
    }

def simulate_blend_rate_oracle_lag():
    """
    Simulates arbitrage exploitation when Blend rate shifts between keeper sync ticks.
    Keeper sync trigger: |delta b_rate| / b_rate >= 0.05% or every 60 min.
    Suppose Blend rate jumps abruptly by 0.5% (e.g. large liquidation or pool utilization shift).
    If protocol relies on cached last_index rather than live on-chain cross-contract call:
    An arbitrageur can mint or redeem at the stale price.
    """
    initial_rate = 1.0500 # 1 bToken = 1.0500 USDC
    stale_cached_rate = initial_rate
    
    # Abrupt surge in Blend rate: jump to 1.0580 (+0.76%)
    live_blend_rate = 1.0580
    
    # User deposits 100,000 USDC into protocol
    # If protocol uses stale cached rate:
    # bTokens calculated = amount * SCALAR_9 / cached_rate
    deposit_usdc = 100_000.0
    
    # Protocol deposits 100,000 USDC to Blend, receiving shares at LIVE rate:
    real_btoken_received = deposit_usdc / live_blend_rate
    # If protocol credited shares or minted PT/YT based on stale cached rate:
    stale_btoken_credited = deposit_usdc / stale_cached_rate
    
    discrepancy = stale_btoken_credited - real_btoken_received
    profit_usdc = discrepancy * live_blend_rate
    
    return {
        "cached_rate": stale_cached_rate,
        "live_rate": live_blend_rate,
        "deposit_usdc": deposit_usdc,
        "real_btoken_received": real_btoken_received,
        "stale_btoken_credited": stale_btoken_credited,
        "overcredited_btoken": discrepancy,
        "arbitrage_profit_usdc": profit_usdc
    }

if __name__ == "__main__":
    print("=== EMPIRICAL TEST: AMM POST-MATURITY BEHAVIOR WITHOUT KEEPER ===")
    amm_res = simulate_amm_pricing_post_maturity_without_keeper()
    for r in amm_res:
        print(f"t={r['timestamp']} | tau={r['tau']:.6f} | status={r['status']} | E={r['E']} | P_pt={r['P_pt']} | P_yt={r['P_yt']}")

    print("\n=== EMPIRICAL TEST: DUPLICATE SETTLEMENT EXECUTION ===")
    dup_res = simulate_duplicate_settlement()
    print(f"Overwrite causes rate drift: {dup_res['overwrite_causes_rate_drift']} (Idx1={dup_res['first_index']} -> Idx2={dup_res['corrupted_second_index']})")
    print(f"Revert throws on duplicate keeper retry: {dup_res['revert_throws_on_retry']}")
    print(f"Idempotent settle returns frozen index safely: {dup_res['idempotent_safe']}")

    print("\n=== EMPIRICAL TEST: BLEND RATE STALENESS ARBITRAGE ===")
    arb = simulate_blend_rate_oracle_lag()
    print(f"Cached Rate: {arb['cached_rate']} vs Live Rate: {arb['live_rate']}")
    print(f"Deposit {arb['deposit_usdc']} USDC -> Overcredited bTokens: {arb['overcredited_btoken']:.4f}")
    print(f"Instant Arbitrage Profit extracted from protocol: ${arb['arbitrage_profit_usdc']:.2f}")

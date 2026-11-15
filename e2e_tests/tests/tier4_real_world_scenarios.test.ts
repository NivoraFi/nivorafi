// e2e_tests/tests/tier4_real_world_scenarios.test.ts
// Tier 4: Real-World Application Scenarios

import { describe, it, expect, beforeEach } from "bun:test";
import {
  WAD,
  MAX_NETWORK_TTL,
  DEFAULT_BUMP_TO,
  calculateBumpTo,
  calculateHaircut
} from "../src/math-oracle.ts";
import {
  MockBlendPool,
  SYBlendWrapper,
  YieldMarket,
  B_RATE_SCALE,
  ContractError
} from "../src/protocol-simulator.ts";

describe("Tier 4: Real-World Production Scenarios", () => {
  let blendPool: MockBlendPool;
  let syWrapper: SYBlendWrapper;
  let market: YieldMarket;

  const t0 = 1_000_000_000n;
  const maturity180d = t0 + 180n * 86400n;
  const maturity365d = t0 + 365n * 86400n;

  beforeEach(() => {
    blendPool = new MockBlendPool("ADMIN", "USDC_ADDRESS", B_RATE_SCALE);
    syWrapper = new SYBlendWrapper("ADMIN", "USDC_ADDRESS", blendPool);
    market = new YieldMarket("ADMIN", syWrapper, maturity180d, 20n * WAD, (106n * WAD) / 100n, t0);

    // Provide test users with capital
    blendPool.underlyingBalances.set("TreasuryInvestor", 5_000_000n * WAD);
    blendPool.underlyingBalances.set("YieldSpeculator", 5_000_000n * WAD);
    blendPool.underlyingBalances.set("Alice", 5_000_000n * WAD);
    blendPool.underlyingBalances.set("Bob", 5_000_000n * WAD);
    blendPool.underlyingBalances.set("Carol", 5_000_000n * WAD);
    blendPool.underlyingBalances.set("MarketMaker", 10_000_000n * WAD);

    // Seed AMM with deep liquidity
    syWrapper.deposit("MarketMaker", "MarketMaker", 500_000n * WAD);
    market.mint_py("MarketMaker", "MarketMaker", 250_000n * WAD);
    market.add_liquidity("MarketMaker", "MarketMaker", 200_000n * WAD, 200_000n * WAD, 1n);
  });

  // ===========================================================================
  // Scenario 4.1: Retail & Institutional Fixed-Yield Investor Journey
  // ===========================================================================
  it("Scenario 4.1: Institutional Treasury Fixed-Yield Investor Journey (Lock upfront yield & redeem par at maturity)", () => {
    const principal = 100_000n * WAD; // 100,000 USDC

    // 1. Treasury deposits 100k USDC into SY wrapper
    syWrapper.deposit("TreasuryInvestor", "TreasuryInvestor", principal);
    expect(syWrapper.balanceOf("TreasuryInvestor")).toBe(principal);

    // 2. Mints 100,000 PT and 100,000 YT
    const [ptMinted, ytMinted] = market.mint_py("TreasuryInvestor", "TreasuryInvestor", principal);
    expect(ptMinted).toBe(principal);
    expect(ytMinted).toBe(principal);

    // 3. Treasury locks in guaranteed upfront fixed yield by immediately selling 100,000 YT on the AMM
    const [upfrontYieldReceived, swapFee] = market.swap_exact_yt_for_sy("TreasuryInvestor", "TreasuryInvestor", ytMinted, 1n);
    expect(upfrontYieldReceived).toBeGreaterThan(0n);
    expect(swapFee).toBeGreaterThan(0n);

    // Treasury now holds 100,000 PT and upfront cash yield
    expect(market.ptToken.balanceOf("TreasuryInvestor")).toBe(principal);
    expect(market.ytToken.balanceOf("TreasuryInvestor")).toBe(0n);
    expect(syWrapper.balanceOf("TreasuryInvestor")).toBe(upfrontYieldReceived);

    // 4. Time advances 180 days to maturity
    market.currentTimestamp = maturity180d;
    blendPool.setBRate(1_120_000_000n); // Variable Blend rate jumped during period

    // 5. At maturity, Treasury redeems 100,000 PT for exactly 100,000 USDC equivalent
    const redeemedCash = market.redeem_pt_post_maturity("TreasuryInvestor", "TreasuryInvestor", principal);
    expect(redeemedCash).toBe(principal);

    // Total net assets: 100,000 principal + upfront cash yield
    expect(syWrapper.balanceOf("TreasuryInvestor")).toBe(principal + upfrontYieldReceived);
    expect(market.ptToken.balanceOf("TreasuryInvestor")).toBe(0n);
  });

  // ===========================================================================
  // Scenario 4.2: Yield Speculator Arbitrageur Loop
  // ===========================================================================
  it("Scenario 4.2: Yield Speculator Arbitrageur Loop (Leveraged variable yield capture without liquidation risk)", () => {
    const speculativeCapital = 10_000n * WAD;

    // Speculator deposits 10,000 USDC to buy YT exposure
    syWrapper.deposit("YieldSpeculator", "YieldSpeculator", speculativeCapital);

    // Speculator flash buys YT from AMM with 10,000 SY
    const [ytAcquired, sySpent] = market.swap_exact_sy_for_yt("YieldSpeculator", "YieldSpeculator", speculativeCapital, 1n);
    expect(ytAcquired).toBeGreaterThan(speculativeCapital); // High leverage: YT received > SY spent
    expect(sySpent).toBe(speculativeCapital);

    // Blend lending rate surges from 1.00 to 1.25 (+25% rate spike)
    blendPool.setBRate(1_250_000_000n);
    syWrapper.balances.set("YIELD_MARKET_VAULT", syWrapper.balances.get("YIELD_MARKET_VAULT")! + 50_000n * WAD);

    // Speculator harvests amplified streaming yield on leveraged YT
    const harvestedYield = market.claim_yield("YieldSpeculator", "YieldSpeculator");
    expect(harvestedYield).toBeGreaterThan(0n);

    // Speculator exits remaining YT position for SY profit
    const [syFromSale] = market.swap_exact_yt_for_sy("YieldSpeculator", "YieldSpeculator", ytAcquired, 1n);

    const totalExtracted = harvestedYield + syFromSale;
    expect(totalExtracted).toBeGreaterThan(speculativeCapital); // Net profitable arbitrage!
  });

  // ===========================================================================
  // Scenario 4.3: Emergency 100% Blend Utilization Raw bToken Exit (Track A)
  // ===========================================================================
  it("Scenario 4.3: Emergency 100% Blend Pool Utilization (Track A raw bToken redemption bypasses empty cash pool)", () => {
    const ptAmount = 50_000n * WAD;

    // Alice deposits and mints
    syWrapper.deposit("Alice", "Alice", ptAmount);
    market.mint_py("Alice", "Alice", ptAmount);

    // Market reaches maturity
    market.currentTimestamp = maturity180d;

    // Extreme market distress: Blend borrowers borrow 100% of USDC pool cash (cash = 0)
    blendPool.setUtilization(1.0);
    blendPool.setPoolCash(0n);
    blendPool.setBRate(1_200_000_000n); // b_rate = 1.20

    // Synchronous underlying cash withdrawal to Blend reverts with InsufficientPoolLiquidity
    expect(() => {
      blendPool.withdrawCollateral("SY_WRAPPER_VAULT", "Alice", 100n * WAD);
    }).toThrow(ContractError.InsufficientPoolLiquidity);

    // Alice invokes Track A: redeem_pt_to_btoken to directly claim interest-bearing bTokens
    const bTokensReceived = market.redeem_pt_to_btoken("Alice", "Alice", ptAmount);
    // bTokens = (50,000 * 10^9) / 1.20*10^9 = 41,666.66 bUSDC
    const expectedBTokens = (ptAmount * B_RATE_SCALE) / 1_200_000_000n;
    expect(bTokensReceived).toBe(expectedBTokens);

    // Alice now holds bTokens directly, continuing to accrue Blend interest, completely avoiding protocol lockup!
    expect(blendPool.bTokenBalances.get("Alice")).toBe(expectedBTokens);
    expect(market.ptToken.balanceOf("Alice")).toBe(0n);
  });

  // ===========================================================================
  // Scenario 4.4: Blend Protocol Insolvency & Bad Debt Socialization
  // ===========================================================================
  it("Scenario 4.4: Blend Insolvency Bad Debt Socialization (Equal recovery rate eliminates bank-run panic)", () => {
    // Isolated market with exactly 1,000,000 PT total supply
    const insolvencyMarket = new YieldMarket("ADMIN", syWrapper, maturity180d, 20n * WAD, (105n * WAD) / 100n, t0);

    // Three users deposit and hold PT:
    // Alice holds 500,000 PT, Bob holds 300,000 PT, Carol holds 200,000 PT (Total = 1,000,000 PT)
    syWrapper.deposit("Alice", "Alice", 500_000n * WAD);
    syWrapper.deposit("Bob", "Bob", 300_000n * WAD);
    syWrapper.deposit("Carol", "Carol", 200_000n * WAD);

    insolvencyMarket.mint_py("Alice", "Alice", 500_000n * WAD);
    insolvencyMarket.mint_py("Bob", "Bob", 300_000n * WAD);
    insolvencyMarket.mint_py("Carol", "Carol", 200_000n * WAD);

    expect(insolvencyMarket.ptToken.totalSupply).toBe(1_000_000n * WAD);

    insolvencyMarket.currentTimestamp = maturity180d;

    // Blend Protocol suffers 20% collateral liquidation shortfall:
    // Vault balance drops to 800,000 SY (Total PT liabilities = 1,000,000 PT, deficit = 200,000)
    syWrapper.balances.set("YIELD_MARKET_VAULT", 800_000n * WAD);

    // Calculate haircut H = min(1.0, 800k / 1M) = 0.80
    const h = calculateHaircut(800_000n * WAD, 1_000_000n * WAD);
    expect(h).toBe(800_000_000_000_000_000n); // 0.80 WAD

    // Alice redeems FIRST
    const aliceReceived = insolvencyMarket.redeem_pt_post_maturity("Alice", "Alice", 500_000n * WAD);
    expect(aliceReceived).toBe(400_000n * WAD); // 80% recovery

    // Bob redeems SECOND (Remaining vault 400,000 for remaining 500,000 PT -> still H = 0.80)
    syWrapper.balances.set("YIELD_MARKET_VAULT", 400_000n * WAD);
    const bobReceived = insolvencyMarket.redeem_pt_post_maturity("Bob", "Bob", 300_000n * WAD);
    expect(bobReceived).toBe(240_000n * WAD); // 80% recovery

    // Carol redeems LAST
    syWrapper.balances.set("YIELD_MARKET_VAULT", 160_000n * WAD);
    const carolReceived = insolvencyMarket.redeem_pt_post_maturity("Carol", "Carol", 200_000n * WAD);
    expect(carolReceived).toBe(160_000n * WAD); // 80% recovery

    // Total distributed = 400k + 240k + 160k = 800k (Exact conservation, zero bank run advantage!)
    expect(aliceReceived + bobReceived + carolReceived).toBe(800_000n * WAD);
  });

  // ===========================================================================
  // Scenario 4.5: Passive 365-Day Bond Holder & Keeper Sweep
  // ===========================================================================
  it("Scenario 4.5: Passive 365-Day Bond Holder & Keeper Sweep (Storage surviving 180-day network TTL ceiling)", () => {
    // Instantiate 365-day market
    const annualMarket = new YieldMarket("ADMIN", syWrapper, maturity365d, 20n * WAD, (105n * WAD) / 100n, t0);

    // Investor deposits on Day 1
    syWrapper.deposit("Alice", "Alice", 100_000n * WAD);
    annualMarket.mint_py("Alice", "Alice", 100_000n * WAD);

    // Day 1 TTL is clamped to MAX_NETWORK_TTL (180 days = 3,110,400 ledgers)
    expect(annualMarket.instanceTtl).toBe(MAX_NETWORK_TTL);

    // Time elapses 90 days (777,600 ledgers) without Alice touching contract
    const day90 = t0 + 90n * 86400n;
    annualMarket.currentTimestamp = day90;

    // Autonomous Keeper or touch routine sweeps contract on Day 90
    annualMarket.bumpInstanceTtl();
    // BUMP_TO refreshed back to MAX_NETWORK_TTL!
    expect(annualMarket.instanceTtl).toBe(MAX_NETWORK_TTL);

    // Time elapses to Day 250 (another keeper sweep)
    const day250 = t0 + 250n * 86400n;
    annualMarket.currentTimestamp = day250;
    annualMarket.bumpInstanceTtl();
    // BUMP_TO remaining days: 115 days + 30d buffer = 145 days (clamped to max or default)
    expect(annualMarket.instanceTtl).toBeGreaterThanOrEqual(DEFAULT_BUMP_TO);

    // Time reaches Day 365 (maturity)
    annualMarket.currentTimestamp = maturity365d;
    // Alice redeems successfully because storage was never archived!
    const redeemed = annualMarket.redeem_pt_post_maturity("Alice", "Alice", 100_000n * WAD);
    expect(redeemed).toBe(100_000n * WAD);
    expect(annualMarket.ptToken.balanceOf("Alice")).toBe(0n);
  });
});

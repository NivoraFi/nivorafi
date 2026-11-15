import { StellarPendleAgentClient, formatUnits, loadDeploymentManifest, parseUnits } from "./client.js";

async function main() {
  const manifest = loadDeploymentManifest();
  const client = new StellarPendleAgentClient(manifest);

  console.log("=== Stellar Pendle Autonomous Agent Strategy Runner (Testnet) ===");
  console.log(`YieldPool Contract : ${manifest.contracts.yield_pool.contractId}`);
  console.log(`Observer / Deployer: ${manifest.deployer}`);

  const snapshot = await client.getMarketSnapshot();
  console.log("\n[1] Live Market State:");
  console.log({
    daysToMaturity: snapshot.daysToMaturity,
    ptReserve: `${formatUnits(snapshot.ptReserve)} PT-bUSDC-90D`,
    syReserve: `${formatUnits(snapshot.syReserve)} sy-bUSDC`,
    ammExchangeRate: (Number(snapshot.ammExchangeRateWad) / 1e18).toFixed(6),
    impliedFixedApy: `${snapshot.impliedFixedApyPct.toFixed(2)}%`,
    blendIndexRate: (Number(snapshot.blendExchangeRate) / 1e9).toFixed(6),
    ptPriceInSy: snapshot.ptPriceInSy.toFixed(4),
    ytPriceInSy: snapshot.ytPriceInSy.toFixed(4),
  });

  const portfolio = await client.getUserPortfolio(manifest.deployer);
  console.log("\n[2] Account Portfolio:");
  console.log({
    xlm: portfolio.xlmBalance,
    usdc: portfolio.usdcBalance,
    sy: formatUnits(portfolio.syBalance),
    pt: formatUnits(portfolio.ptBalance),
    yt: formatUnits(portfolio.ytBalance),
    lp: formatUnits(portfolio.lpBalance),
    estimatedPendingYieldSy: formatUnits(portfolio.estimatedPendingYieldSy),
  });

  const fixedQuote = await client.quoteAction("sy_for_pt", parseUnits("0.5", 7), 50);
  console.log("\n[3] Simulated Strategy Quote (Lock Fixed Yield: 0.50 SY -> PT):");
  console.log({
    expectedPtOut: formatUnits(fixedQuote.estimatedOut),
    minPtOut: formatUnits(fixedQuote.minOutWithSlippage),
    impliedApyAfterPct: `${fixedQuote.impliedApyAfterPct.toFixed(2)}%`,
  });

  const prep = await client.buildDepositSyTx(manifest.deployer, parseUnits("0.25", 7));
  console.log("\n[4] Simulated Unsigned XDR (Deposit 0.25 USDC -> sy-bUSDC):");
  console.log({
    method: prep.method,
    contractId: prep.contractId,
    minResourceFeeStroops: prep.minResourceFeeStroops,
    simulatedReturnValue: prep.simulatedReturnValue,
    unsignedXdrPreview: `${prep.unsignedXdr.slice(0, 48)}... (${prep.unsignedXdr.length} chars)`,
  });
}

main().catch((err) => {
  console.error("Agent demo failed:", err);
  process.exit(1);
});

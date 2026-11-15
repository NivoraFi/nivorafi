# NivoraFi AI Agent SDK & MCP Server

Model Context Protocol (`@modelcontextprotocol/sdk`) server and typed TypeScript Soroban client (`@stellar/stellar-sdk` v17) enabling autonomous yield-rate evaluation, fixed-income PT locking, flash YT trading, and non-custodial unsigned XDR construction on Stellar Testnet.

## Capabilities

- **MCP Tools (`src/mcp-server.ts`)**:
  - `get_market_state`: Live Soroban `YieldPool` + `SY_Blend_Wrapper` reserves, PT/YT pricing, Blend `bRate`, and Implied Fixed APY.
  - `get_portfolio`: Queries XLM, USDC, `sy-bUSDC`, `PT-bUSDC-90D`, `YT-bUSDC-90D`, LP shares, and accrued yield.
  - `quote_yield_strategy`: Exact BigInt fixed-point AMM pricing (`ln_wad` / `wad_div`) with fee and post-trade APY impact.
  - `build_deposit_sy_xdr`, `build_mint_py_xdr`, `build_swap_xdr`, `build_claim_and_redeem_xdr`, `build_liquidity_xdr`: Prepares and simulates footprint/fee-complete unsigned XDRs ready for Freighter, Passkey, or hardware signing.
- **MCP Resources**:
  - `stellar-pendle://deployment`: Live Testnet `deployed_contracts.json` manifest.
  - `stellar-pendle://stellar-agent-ecosystem`: Companion topology integrating **Stellar Raven** (`https://raven.stellar.buzz/mcp`), **`stellar-devkit-mcp`** (`stellar-agent-kit`), and **OpenZeppelin Relayer Channels** (`https://channels.openzeppelin.com/testnet`) for gasless x402/agent execution.

## Commands (Bun)

```bash
bun install
bun run demo         # Inspect live Testnet market + build simulated XDR
bun run mcp          # Start stdio MCP server
bun test             # Run math, MCP in-memory protocol, and live Testnet simulation tests
bun run typecheck    # Strict TypeScript check
```

# NivoraFi

Fixed-yield tokenization and time-decaying log-normal AMM built natively in `#![no_std]` Soroban Rust on Stellar.

**Status:** Active on Stellar Testnet ([nivorafi.xyz](https://www.nivorafi.xyz)) — unaudited for Mainnet.  
**Links:** [App](https://www.nivorafi.xyz) · [X (@NivoraFi)](https://x.com/NivoraFi) · [License](LICENSE) · [Security](SECURITY.md)

---

## Why NivoraFi

Variable lending APYs on Stellar shift continuously. NivoraFi wraps yield-bearing positions (such as Blend `bUSDC` and `XLM`) into Standardized Yield (`SY`) and splits them into two SEP-41 tokens:

- **Principal Token (`PT`):** Trades at a discount before maturity and redeems 1:1 for `SY` at maturity, locking in a fixed APY.
- **Yield Token (`YT`):** Captures 100% of the variable yield accrued by the underlying `SY` until maturity.

Instead of splitting liquidity across separate `PT/SY` and `YT/SY` pools, NivoraFi routes both `PT` and `YT` trades through a **single unified `PT/SY` log-normal AMM pool** using 2-step Picard iteration flash swaps, and supports **1-click atomic rollover** from matured `PT` into active maturity pools.

**Scope & Non-Goals:** Currently deployed on Stellar Testnet only (`mock_blend` + Circle Testnet USDC). Do not use with Mainnet funds.

---

## Live Stellar Testnet Deployment

- **Network:** Stellar Testnet (`Test SDF Network ; September 2015`)
- **RPC:** `https://soroban-testnet.stellar.org`
- **Active Markets:** `usdc-90d`, `usdc-30d`, `xlm-90d`, `usdc-matured`
- **Primary Series:** `PT-bUSDC-90D` / `YT-bUSDC-90D` (Maturity: `2027-02-06T10:17:35Z`)

| Contract | Role | Testnet Contract ID |
|---|---|---|
| `mock_blend` | Simulated Blend pool & `bRate` vault | `CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6` |
| `sy_blend_wrapper` | Standardized Yield (`sy-bUSDC`) wrapper | `CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5` |
| `pt_token` | SEP-41 Principal Token (`PT-bUSDC-90D`) | `CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A` |
| `yt_token` | SEP-41 Yield Token (`YT-bUSDC-90D`) | `CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73` |
| `yield_pool` | PT/YT minter, redeemer & log-normal AMM | `CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF` |

Full deployment manifest: [`deployed_contracts.json`](deployed_contracts.json).

---

## Repository Structure

- [`contracts/`](contracts/) — Soroban Rust workspace (`common`, `mock_blend`, `sy_blend_wrapper`, `pt_token`, `yt_token`, `yield_pool`, `market_factory`)
- [`tests/`](tests/) — Rust unit, invariant, and security regression tests
- [`e2e_tests/`](e2e_tests/) — TypeScript mathematical & property-based oracle tests
- [`frontend/`](frontend/) — Next.js 15 App Router DApp + Stellar Wallets Kit + BFF proxy
- [`indexer/`](indexer/) — Persistent SQLite Soroban event indexer
- [`agent/`](agent/) — Typed `@stellar/stellar-sdk` client & MCP server

---

## Quickstart

### Prerequisites
- Rust toolchain + `wasm32v1-none` target + Stellar CLI
- [Bun](https://bun.sh) >= 1.1

### Run Tests & Build

```bash
# 1. Soroban contracts & Rust test suite
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings

# 2. E2E mathematical equivalence suite
cd e2e_tests && bun install && bun test

# 3. AI Agent SDK & MCP server
cd ../agent && bun install && bun run typecheck && bun test

# 4. Next.js frontend
cd ../frontend
cp .env.example .env.local
bun install && bun run typecheck && bun run build
bun run dev
```

Open `http://localhost:3000` and switch Freighter or LOBSTR to **Stellar Testnet**, or use **Inspect Testnet Pool** in read-only mode.

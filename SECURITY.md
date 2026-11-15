# Security Policy

## Scope & Status

NivoraFi is currently deployed on **Stellar Testnet** and has not undergone a third-party Mainnet security audit. Do not deploy or interact with Mainnet funds using these contracts without an independent audit.

## Internal Hardening Summary

Prior to Testnet deployment, the Soroban workspace (`common`, `mock_blend`, `sy_blend_wrapper`, `pt_token`, `yt_token`, `yield_pool`) was audited against Soroban-specific vulnerability classes (auth, storage/TTL, checked arithmetic, reentrancy, and bad-debt haircuts):

- **Self-transfer short-circuit:** Prevented balance inflation on `from == to` token transfers.
- **Protocol fee solvency:** Deducted protocol fees from `TotalSyReserve` under Checks-Effects-Interactions before external transfers.
- **Pro-rata bad-debt haircut:** Enforced `calculate_haircut` consistently across both post-maturity and emergency `redeem_pt_to_btoken` paths.
- **Storage TTL & Auth:** Added `extend_ttl` across persistent/instance storage and `admin.require_auth()` on `initialize` entrypoints.
- **Checked arithmetic & events:** Enabled `overflow-checks = true` in `[profile.release]` and pinned `soroban-sdk = "=28.0.0"`.

## Reporting a Vulnerability

If you discover a security vulnerability in NivoraFi's contracts, indexer, or frontend, please **do not open a public GitHub issue**.

Report privately via:
- **GitHub Security Advisories:** Use the **Security → Advisories → Report a vulnerability** tab on `NivoraFi/nivorafi`
- **X (Direct Message):** [@NivoraFi](https://x.com/NivoraFi)

Include a minimal reproduction or failing test case when possible.

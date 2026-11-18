#!/usr/bin/env bash
# ==============================================================================
# Stellar Pendle - Milestone M6 Testnet Deployment & Registration Script
# ==============================================================================
# Deploys market_factory, initializes governance, and registers active markets
# (USDC 90D, USDC 30D, and XLM 90D) on Stellar Testnet.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

NETWORK="testnet"
SOURCE_ACCOUNT="stellar_pendle_testnet"
ADMIN_ADDRESS="$(stellar keys address ${SOURCE_ACCOUNT})"
GUARDIAN_ADDRESS="$(stellar keys address deployer 2>/dev/null || echo "${ADMIN_ADDRESS}")"

WASM_DIR="${ROOT_DIR}/target/wasm32v1-none/release"
DEPLOYED_JSON="${ROOT_DIR}/deployed_contracts.json"

# Standard Testnet SAC token addresses
USDC_SAC="CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
XLM_SAC="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
EURC_SAC="CCUUDM434BMZMYWYDITHFXHDMIVTGGD6T2I5UKNX5BSLXLW7HVR4MCGZ"

echo "=========================================================="
echo "Stellar Pendle Testnet Deployment Pipeline"
echo "Network:        ${NETWORK}"
echo "Deployer/Admin: ${ADMIN_ADDRESS}"
echo "Guardian:       ${GUARDIAN_ADDRESS}"
echo "=========================================================="

# ------------------------------------------------------------------------------
# 1. Build and Verify WASM Binaries
# ------------------------------------------------------------------------------
echo "==> Step 1: Building and verifying contract WASMs..."
cd "${ROOT_DIR}"

RUSTC_BIN="$(rustup which rustc 2>/dev/null || which rustc)"
RUSTC="${RUSTC_BIN}" stellar contract build --profile release

test -f "${WASM_DIR}/market_factory.wasm" || { echo "Error: market_factory.wasm missing"; exit 1; }
test -f "${WASM_DIR}/mock_blend.wasm" || { echo "Error: mock_blend.wasm missing"; exit 1; }
test -f "${WASM_DIR}/sy_blend_wrapper.wasm" || { echo "Error: sy_blend_wrapper.wasm missing"; exit 1; }
test -f "${WASM_DIR}/mock_slender.wasm" || { echo "Error: mock_slender.wasm missing"; exit 1; }
test -f "${WASM_DIR}/sy_slender_wrapper.wasm" || { echo "Error: sy_slender_wrapper.wasm missing"; exit 1; }
test -f "${WASM_DIR}/pt_token.wasm" || { echo "Error: pt_token.wasm missing"; exit 1; }
test -f "${WASM_DIR}/yt_token.wasm" || { echo "Error: yt_token.wasm missing"; exit 1; }
test -f "${WASM_DIR}/yield_pool.wasm" || { echo "Error: yield_pool.wasm missing"; exit 1; }

echo "Contract WASMs verified in ${WASM_DIR}"

# ------------------------------------------------------------------------------
# 2. Upload WASMs to Testnet Ledger
# ------------------------------------------------------------------------------
echo "==> Step 2: Uploading contract WASMs to Testnet ledger..."

upload_wasm() {
    local wasm_path="$1"
    local name="$2"
    echo "Uploading ${name}..."
    local wasm_hash
    wasm_hash="$(stellar contract upload \
        --wasm "${wasm_path}" \
        --network "${NETWORK}" \
        --source-account "${SOURCE_ACCOUNT}" \
        --quiet 2>/dev/null || stellar contract upload \
        --wasm "${wasm_path}" \
        --network "${NETWORK}" \
        --source-account "${SOURCE_ACCOUNT}")"
    # Extract last line (hash)
    wasm_hash="$(echo "${wasm_hash}" | tail -n 1)"
    echo "  ${name} WASM Hash: ${wasm_hash}"
    echo "${wasm_hash}"
}

PT_WASM_HASH="$(upload_wasm "${WASM_DIR}/pt_token.wasm" "pt_token")"
YT_WASM_HASH="$(upload_wasm "${WASM_DIR}/yt_token.wasm" "yt_token")"
POOL_WASM_HASH="$(upload_wasm "${WASM_DIR}/yield_pool.wasm" "yield_pool")"
SY_WASM_HASH="$(upload_wasm "${WASM_DIR}/sy_blend_wrapper.wasm" "sy_blend_wrapper")"
SY_SLENDER_WASM_HASH="$(upload_wasm "${WASM_DIR}/sy_slender_wrapper.wasm" "sy_slender_wrapper")"
MOCK_SLENDER_WASM_HASH="$(upload_wasm "${WASM_DIR}/mock_slender.wasm" "mock_slender")"
FACTORY_WASM_HASH="$(upload_wasm "${WASM_DIR}/market_factory.wasm" "market_factory")"

# ------------------------------------------------------------------------------
# 3. Deploy & Initialize market_factory
# ------------------------------------------------------------------------------
echo "==> Step 3: Deploying and initializing market_factory..."

FACTORY_CONTRACT_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/market_factory.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/market_factory.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
FACTORY_CONTRACT_ID="$(echo "${FACTORY_CONTRACT_ID}" | tail -n 1)"
echo "market_factory Contract ID: ${FACTORY_CONTRACT_ID}"

echo "Initializing market_factory..."
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --guardian "${GUARDIAN_ADDRESS}" \
    --pt-wasm "${PT_WASM_HASH}" \
    --yt-wasm "${YT_WASM_HASH}" \
    --pool-wasm "${POOL_WASM_HASH}" \
    --sy-wasm "${SY_WASM_HASH}"

echo "market_factory initialized successfully."

# ------------------------------------------------------------------------------
# 4. Register Market 0: Existing USDC 90D Market
# ------------------------------------------------------------------------------
echo "==> Step 4: Registering Market 0 (USDC 90D)..."

USDC_90D_POOL="CBOADRSNADEGKGNGOAVJ2W53PMF5L6TM33RCOTDBREGDWUFMT4JLAGBF"
USDC_90D_SY="CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5"
USDC_90D_PT="CCYQPUI7VI7GJKJM6JZIWVVZPJ4GKZ2ZYQ5FT5JBMSXHZITDOVRMS37A"
USDC_90D_YT="CCH3B54EW4XZKA6IBHJ2XFLDQCAJZWQ2N2ZREZDUNPJLLMOD3E5B7Z73"
USDC_90D_MATURITY=1801909055 # 2027-02-06T10:17:35Z
SCALAR_90D="8000000000000000000" # 8 WAD
ANCHOR_90D="1000000000000000000" # 1 WAD

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send yes \
    -- register_market \
    --caller "${ADMIN_ADDRESS}" \
    --pool "${USDC_90D_POOL}" \
    --sy "${USDC_90D_SY}" \
    --pt "${USDC_90D_PT}" \
    --yt "${USDC_90D_YT}" \
    --asset "${USDC_SAC}" \
    --maturity ${USDC_90D_MATURITY} \
    --scalar-root "${SCALAR_90D}" \
    --initial-anchor "${ANCHOR_90D}"

echo "Market 0 (USDC 90D) registered."

# ------------------------------------------------------------------------------
# 5. Deploy & Register Market 1: Active USDC 30D Market
# ------------------------------------------------------------------------------
echo "==> Step 5: Deploying & Registering Market 1 (USDC 30D)..."

USDC_30D_MATURITY=1796725055
SCALAR_30D="4000000000000000000" # 4 WAD
ANCHOR_30D="1000000000000000000" # 1 WAD

# 5a. Deploy uninitialized YieldPool
POOL_30D_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
POOL_30D_ID="$(echo "${POOL_30D_ID}" | tail -n 1)"
echo "  USDC 30D Pool: ${POOL_30D_ID}"

# 5b. Deploy & initialize PT-bUSDC-30D
PT_30D_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
PT_30D_ID="$(echo "${PT_30D_ID}" | tail -n 1)"
echo "  USDC 30D PT:   ${PT_30D_ID}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${PT_30D_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_30D_ID}" \
    --name "Pendle PT USDC 30D" \
    --symbol "PT-bUSDC-30D" \
    --decimals 7 \
    --maturity ${USDC_30D_MATURITY}

# 5c. Deploy & initialize YT-bUSDC-30D
YT_30D_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
YT_30D_ID="$(echo "${YT_30D_ID}" | tail -n 1)"
echo "  USDC 30D YT:   ${YT_30D_ID}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${YT_30D_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_30D_ID}" \
    --sy-contract "${USDC_90D_SY}" \
    --name "Pendle YT USDC 30D" \
    --symbol "YT-bUSDC-30D" \
    --decimals 7 \
    --maturity ${USDC_30D_MATURITY}

# 5d. Initialize YieldPool with PT, YT, and canonical SY
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${POOL_30D_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --sy "${USDC_90D_SY}" \
    --pt "${PT_30D_ID}" \
    --yt "${YT_30D_ID}" \
    --maturity ${USDC_30D_MATURITY} \
    --scalar-root "${SCALAR_30D}" \
    --initial-anchor "${ANCHOR_30D}"

# 5e. Register in market_factory
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send yes \
    -- register_market \
    --caller "${ADMIN_ADDRESS}" \
    --pool "${POOL_30D_ID}" \
    --sy "${USDC_90D_SY}" \
    --pt "${PT_30D_ID}" \
    --yt "${YT_30D_ID}" \
    --asset "${USDC_SAC}" \
    --maturity ${USDC_30D_MATURITY} \
    --scalar-root "${SCALAR_30D}" \
    --initial-anchor "${ANCHOR_30D}"

echo "Market 1 (USDC 30D) registered."

# ------------------------------------------------------------------------------
# 6. Deploy & Register Market 2: Multi-Asset XLM 90D Market
# ------------------------------------------------------------------------------
echo "==> Step 6: Deploying & Registering Market 2 (XLM 90D)..."

XLM_90D_MATURITY="${XLM_90D_MATURITY:-1801909056}"
SCALAR_XLM="8000000000000000000" # 8 WAD
ANCHOR_XLM="1000000000000000000" # 1 WAD

# 6a. Deploy & initialize SY for XLM
SY_XLM_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/sy_blend_wrapper.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/sy_blend_wrapper.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
SY_XLM_ID="$(echo "${SY_XLM_ID}" | tail -n 1)"
echo "  XLM 90D SY:   ${SY_XLM_ID}"

MOCK_BLEND_XLM_ID="${MOCK_BLEND_XLM_ID:-CAGWGDLWNSSQEYJEE45JEBXAKNJCIHLNUK26TLFFPIWG6PPXHOTJ6DCH}"
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${SY_XLM_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --underlying-asset "${XLM_SAC}" \
    --blend-pool "${MOCK_BLEND_XLM_ID}"

# 6b. Deploy uninitialized YieldPool for XLM
POOL_XLM_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
POOL_XLM_ID="$(echo "${POOL_XLM_ID}" | tail -n 1)"
echo "  XLM 90D Pool: ${POOL_XLM_ID}"

# 6c. Deploy & initialize PT-bXLM-90D
PT_XLM_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
PT_XLM_ID="$(echo "${PT_XLM_ID}" | tail -n 1)"
echo "  XLM 90D PT:   ${PT_XLM_ID}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${PT_XLM_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_XLM_ID}" \
    --name "Pendle PT XLM 90D" \
    --symbol "PT-bXLM-90D" \
    --decimals 7 \
    --maturity ${XLM_90D_MATURITY}

# 6d. Deploy & initialize YT-bXLM-90D
YT_XLM_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
YT_XLM_ID="$(echo "${YT_XLM_ID}" | tail -n 1)"
echo "  XLM 90D YT:   ${YT_XLM_ID}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${YT_XLM_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_XLM_ID}" \
    --sy-contract "${SY_XLM_ID}" \
    --name "Pendle YT XLM 90D" \
    --symbol "YT-bXLM-90D" \
    --decimals 7 \
    --maturity ${XLM_90D_MATURITY}

# 6e. Initialize YieldPool with PT, YT, and SY
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${POOL_XLM_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --sy "${SY_XLM_ID}" \
    --pt "${PT_XLM_ID}" \
    --yt "${YT_XLM_ID}" \
    --maturity ${XLM_90D_MATURITY} \
    --scalar-root "${SCALAR_XLM}" \
    --initial-anchor "${ANCHOR_XLM}"

# 6f. Register in market_factory
stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send yes \
    -- register_market \
    --caller "${ADMIN_ADDRESS}" \
    --pool "${POOL_XLM_ID}" \
    --sy "${SY_XLM_ID}" \
    --pt "${PT_XLM_ID}" \
    --yt "${YT_XLM_ID}" \
    --asset "${XLM_SAC}" \
    --maturity ${XLM_90D_MATURITY} \
    --scalar-root "${SCALAR_XLM}" \
    --initial-anchor "${ANCHOR_XLM}"

echo "Market 2 (XLM 90D) registered."

# ------------------------------------------------------------------------------
# 7. Deploy & Register Slender sUSDC Market (sy-sUSDC, distinct maturity)
# ------------------------------------------------------------------------------
echo "==> Step 7: Deploying & Registering Slender sUSDC Market..."

SUSDC_MATURITY="${SUSDC_MATURITY:-1801909057}"
SCALAR_SUSDC="8000000000000000000"
ANCHOR_SUSDC="1000000000000000000"

if [[ -z "${SLENDER_POOL_ID:-}" ]]; then
    SLENDER_POOL_ID="$(stellar contract deploy \
        --wasm "${WASM_DIR}/mock_slender.wasm" \
        --network "${NETWORK}" \
        --source-account "${SOURCE_ACCOUNT}" \
        --quiet 2>/dev/null || stellar contract deploy \
        --wasm "${WASM_DIR}/mock_slender.wasm" \
        --network "${NETWORK}" \
        --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
    SLENDER_POOL_ID="$(echo "${SLENDER_POOL_ID}" | tail -n 1)"
    echo "  Slender Mock Pool: ${SLENDER_POOL_ID}"
    stellar contract invoke \
        --network "${NETWORK}" \
        --source-account "${SOURCE_ACCOUNT}" \
        --id "${SLENDER_POOL_ID}" \
        --send yes \
        -- initialize \
        --admin "${ADMIN_ADDRESS}" \
        --asset "${USDC_SAC}" \
        --initial-rate 1000000000
fi
S_TOKEN_ID="${S_TOKEN_ID:-${SLENDER_POOL_ID}}"

SY_SUSDC_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/sy_slender_wrapper.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/sy_slender_wrapper.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
SY_SUSDC_ID="$(echo "${SY_SUSDC_ID}" | tail -n 1)"
echo "  sUSDC SY:   ${SY_SUSDC_ID}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${SY_SUSDC_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --underlying-asset "${USDC_SAC}" \
    --slender-pool "${SLENDER_POOL_ID}" \
    --s-token "${S_TOKEN_ID}"

POOL_SUSDC_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yield_pool.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
POOL_SUSDC_ID="$(echo "${POOL_SUSDC_ID}" | tail -n 1)"

PT_SUSDC_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/pt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
PT_SUSDC_ID="$(echo "${PT_SUSDC_ID}" | tail -n 1)"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${PT_SUSDC_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_SUSDC_ID}" \
    --name "Pendle PT sUSDC 90D" \
    --symbol "PT-sUSDC-90D" \
    --decimals 7 \
    --maturity ${SUSDC_MATURITY}

YT_SUSDC_ID="$(stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --quiet 2>/dev/null || stellar contract deploy \
    --wasm "${WASM_DIR}/yt_token.wasm" \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" | tail -n 1)"
YT_SUSDC_ID="$(echo "${YT_SUSDC_ID}" | tail -n 1)"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${YT_SUSDC_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --market "${POOL_SUSDC_ID}" \
    --sy-contract "${SY_SUSDC_ID}" \
    --name "Pendle YT sUSDC 90D" \
    --symbol "YT-sUSDC-90D" \
    --decimals 7 \
    --maturity ${SUSDC_MATURITY}

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${POOL_SUSDC_ID}" \
    --send yes \
    -- initialize \
    --admin "${ADMIN_ADDRESS}" \
    --sy "${SY_SUSDC_ID}" \
    --pt "${PT_SUSDC_ID}" \
    --yt "${YT_SUSDC_ID}" \
    --maturity ${SUSDC_MATURITY} \
    --scalar-root "${SCALAR_SUSDC}" \
    --initial-anchor "${ANCHOR_SUSDC}"

stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send yes \
    -- register_market \
    --caller "${ADMIN_ADDRESS}" \
    --pool "${POOL_SUSDC_ID}" \
    --sy "${SY_SUSDC_ID}" \
    --pt "${PT_SUSDC_ID}" \
    --yt "${YT_SUSDC_ID}" \
    --asset "${USDC_SAC}" \
    --maturity ${SUSDC_MATURITY} \
    --scalar-root "${SCALAR_SUSDC}" \
    --initial-anchor "${ANCHOR_SUSDC}"

echo "Market 5 (Slender sUSDC 90D) registered."

# ------------------------------------------------------------------------------
# 8. Query and Verify Registry from Chain
# ------------------------------------------------------------------------------
echo "==> Step 8: Verifying market_factory on-chain registry..."

MARKET_COUNT="$(stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send no \
    -- market_count)"
echo "Active Markets in Factory: ${MARKET_COUNT}"

REGISTERED_MARKETS="$(stellar contract invoke \
    --network "${NETWORK}" \
    --source-account "${SOURCE_ACCOUNT}" \
    --id "${FACTORY_CONTRACT_ID}" \
    --send no \
    -- list_markets \
    --start-index 0 \
    --limit 10)"
echo "Registry Data: ${REGISTERED_MARKETS}"

echo "=========================================================="
echo "Deployment & Registration Complete!"
echo "Factory:             ${FACTORY_CONTRACT_ID}"
echo "Market 0 (USDC 90D): ${USDC_90D_POOL}"
echo "Market 1 (USDC 30D): ${POOL_30D_ID}"
echo "Market 2 (XLM 90D):  ${POOL_XLM_ID}"
echo "Market 5 (sUSDC 90D):${POOL_SUSDC_ID}"
echo "Manifest target:     ${DEPLOYED_JSON}"
echo "=========================================================="

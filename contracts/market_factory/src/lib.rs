#![no_std]
#![allow(clippy::too_many_arguments)]

mod storage;
#[cfg(test)]
mod test;
pub mod types;

use common::errors::ContractError;
use common::events::{
    MarketCreatedEvent, MarketRegisteredEvent, RolloverExecutedEvent, RolloverPyExecutedEvent,
    SyConfiguredEvent, WasmHashesUpdatedEvent,
};
use common::interfaces::{
    MarketFactoryTrait, MarketKey, MarketMetadata, PrivilegedTokenClient, StandardizedYieldClient,
    YieldMarketClient, YieldTokenClient,
};
use common::reentrancy::with_non_reentrant;
use common::storage_keys::DataKey;
use common::ttl::bump_instance_ttl;
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{
    contract, contractimpl, vec, Address, Bytes, BytesN, ContractExecutable, Env, IntoVal, String,
    Symbol, Vec,
};

fn derive_salt(env: &Env, market_id: u32, tag: &[u8]) -> BytesN<32> {
    let mut data = Bytes::new(env);
    data.append(&Bytes::from_array(env, &market_id.to_be_bytes()));
    data.append(&Bytes::from_slice(env, tag));
    env.crypto().sha256(&data).into()
}

#[contract]
pub struct MarketFactory;

#[contractimpl]
impl MarketFactoryTrait for MarketFactory {
    // === Initialization & WASM Hash Management ===

    fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        pt_wasm: BytesN<32>,
        yt_wasm: BytesN<32>,
        pool_wasm: BytesN<32>,
        sy_wasm: BytesN<32>,
    ) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Initialized) {
            return Err(ContractError::AlreadyInitialized);
        }
        admin.require_auth();

        let zero = [0u8; 32];
        if pt_wasm.to_array() == zero
            || yt_wasm.to_array() == zero
            || pool_wasm.to_array() == zero
            || sy_wasm.to_array() == zero
        {
            return Err(ContractError::InvalidWasmHash);
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Guardian, &guardian);
        env.storage().instance().set(&DataKey::PtWasmHash, &pt_wasm);
        env.storage().instance().set(&DataKey::YtWasmHash, &yt_wasm);
        env.storage()
            .instance()
            .set(&DataKey::PoolWasmHash, &pool_wasm);
        env.storage().instance().set(&DataKey::SyWasmHash, &sy_wasm);
        env.storage().instance().set(&DataKey::MarketCount, &0u32);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage().instance().set(&DataKey::Initialized, &true);

        bump_instance_ttl(&env, 0);
        Ok(())
    }

    fn set_wasm_hashes(
        env: Env,
        caller: Address,
        pt_wasm: Option<BytesN<32>>,
        yt_wasm: Option<BytesN<32>>,
        pool_wasm: Option<BytesN<32>>,
        sy_wasm: Option<BytesN<32>>,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }
        storage::set_wasm_hashes(&env, pt_wasm, yt_wasm, pool_wasm, sy_wasm)?;
        WasmHashesUpdatedEvent { admin }.publish(&env);
        Ok(())
    }

    fn get_wasm_hashes(
        env: Env,
    ) -> Result<(BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>), ContractError> {
        storage::get_wasm_hashes(&env)
    }

    fn set_sy_for_asset(
        env: Env,
        caller: Address,
        asset: Address,
        sy: Address,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }
        storage::set_sy_for_asset(&env, &asset, &sy);
        SyConfiguredEvent { asset, sy }.publish(&env);
        Ok(())
    }

    fn get_sy_for_asset(env: Env, asset: Address) -> Option<Address> {
        storage::get_sy_for_asset(&env, &asset)
    }

    // === Market Creation & Registration ===

    fn create_market(
        env: Env,
        caller: Address,
        asset: Address,
        blend_pool: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<MarketMetadata, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;

        if maturity <= env.ledger().timestamp() {
            return Err(ContractError::InvalidMaturity);
        }
        if scalar_root <= 0 || initial_anchor <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let key = MarketKey {
            asset: asset.clone(),
            maturity,
        };
        if env
            .storage()
            .persistent()
            .has(&DataKey::MarketByKey(key.clone()))
        {
            return Err(ContractError::MarketAlreadyExists);
        }

        let admin = common::governance::get_admin(&env)?;
        let (pt_wasm, yt_wasm, pool_wasm, sy_wasm) = storage::get_wasm_hashes(&env)?;
        let market_id = storage::get_market_count(&env);

        // 1. Get or deploy canonical SY vault
        let sy_address = match storage::get_sy_for_asset(&env, &asset) {
            Some(sy) => sy,
            None => {
                let salt_sy = derive_salt(&env, market_id, b"SY");
                let deployed_sy = env
                    .deployer()
                    .with_current_contract(salt_sy)
                    .deploy_contract(ContractExecutable::Wasm(sy_wasm), ());
                let sy_client = StandardizedYieldClient::new(&env, &deployed_sy);
                sy_client.initialize(&admin, &asset, &blend_pool);
                storage::set_sy_for_asset(&env, &asset, &deployed_sy);
                deployed_sy
            }
        };

        // 2. Deploy uninitialized YieldPool
        let salt_pool = derive_salt(&env, market_id, b"POOL");
        let pool_address = env
            .deployer()
            .with_current_contract(salt_pool)
            .deploy_contract(ContractExecutable::Wasm(pool_wasm), ());

        // 3. Deploy & initialize PT and YT tokens
        let salt_pt = derive_salt(&env, market_id, b"PT");
        let pt_address = env
            .deployer()
            .with_current_contract(salt_pt)
            .deploy_contract(ContractExecutable::Wasm(pt_wasm), ());
        let pt_client = PrivilegedTokenClient::new(&env, &pt_address);
        let pt_name = String::from_str(&env, "Pendle PT");
        let pt_symbol = String::from_str(&env, "PT");
        pt_client.initialize(
            &admin,
            &pool_address,
            &pt_name,
            &pt_symbol,
            &7u32,
            &maturity,
        );

        let salt_yt = derive_salt(&env, market_id, b"YT");
        let yt_address = env
            .deployer()
            .with_current_contract(salt_yt)
            .deploy_contract(ContractExecutable::Wasm(yt_wasm), ());
        let yt_client = YieldTokenClient::new(&env, &yt_address);
        let yt_name = String::from_str(&env, "Pendle YT");
        let yt_symbol = String::from_str(&env, "YT");
        yt_client.initialize(
            &admin,
            &pool_address,
            &sy_address,
            &yt_name,
            &yt_symbol,
            &7u32,
            &maturity,
        );

        // 4. Initialize YieldPool with PT, YT, and SY
        let pool_client = YieldMarketClient::new(&env, &pool_address);
        pool_client.initialize(
            &admin,
            &sy_address,
            &pt_address,
            &yt_address,
            &maturity,
            &scalar_root,
            &initial_anchor,
        );

        // 5. Index and persist market metadata
        let metadata = MarketMetadata {
            id: market_id,
            asset: asset.clone(),
            maturity,
            sy: sy_address.clone(),
            pt: pt_address.clone(),
            yt: yt_address.clone(),
            pool: pool_address.clone(),
            scalar_root,
            initial_anchor,
            created_at: env.ledger().timestamp(),
            is_active: true,
        };

        storage::save_market(&env, &metadata);
        storage::increment_market_count(&env);

        MarketCreatedEvent {
            id: market_id,
            pool: pool_address,
            asset,
            sy: sy_address,
            pt: pt_address,
            yt: yt_address,
            maturity,
            scalar_root,
            initial_anchor,
        }
        .publish(&env);

        Ok(metadata)
    }

    fn register_market(
        env: Env,
        caller: Address,
        pool: Address,
        sy: Address,
        pt: Address,
        yt: Address,
        asset: Address,
        maturity: u64,
        scalar_root: i128,
        initial_anchor: i128,
    ) -> Result<MarketMetadata, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;

        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }

        if maturity <= env.ledger().timestamp() {
            return Err(ContractError::InvalidMaturity);
        }
        if scalar_root <= 0 || initial_anchor <= 0 {
            return Err(ContractError::ZeroAmount);
        }

        let key = MarketKey {
            asset: asset.clone(),
            maturity,
        };
        if env
            .storage()
            .persistent()
            .has(&DataKey::MarketByKey(key.clone()))
        {
            return Err(ContractError::MarketAlreadyExists);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::MarketByPool(pool.clone()))
        {
            return Err(ContractError::MarketAlreadyExists);
        }

        let market_id = storage::get_market_count(&env);

        let metadata = MarketMetadata {
            id: market_id,
            asset: asset.clone(),
            maturity,
            sy: sy.clone(),
            pt: pt.clone(),
            yt: yt.clone(),
            pool: pool.clone(),
            scalar_root,
            initial_anchor,
            created_at: env.ledger().timestamp(),
            is_active: true,
        };

        storage::save_market(&env, &metadata);
        storage::increment_market_count(&env);

        if storage::get_sy_for_asset(&env, &asset).is_none() {
            storage::set_sy_for_asset(&env, &asset, &sy);
        }

        MarketRegisteredEvent {
            id: market_id,
            pool: pool.clone(),
            asset: asset.clone(),
            maturity,
        }
        .publish(&env);

        MarketCreatedEvent {
            id: market_id,
            pool,
            asset,
            sy,
            pt,
            yt,
            maturity,
            scalar_root,
            initial_anchor,
        }
        .publish(&env);

        Ok(metadata)
    }

    // === Queries & Indexing ===

    fn get_market(env: Env, id: u32) -> Result<MarketMetadata, ContractError> {
        storage::get_market(&env, id)
    }

    fn get_market_by_asset_maturity(
        env: Env,
        asset: Address,
        maturity: u64,
    ) -> Option<MarketMetadata> {
        storage::get_market_by_asset_maturity(&env, &asset, maturity)
    }

    fn get_market_by_pool(env: Env, pool: Address) -> Option<MarketMetadata> {
        storage::get_market_by_pool(&env, &pool)
    }

    fn list_markets(env: Env, start_index: u32, limit: u32) -> Vec<MarketMetadata> {
        storage::list_markets(&env, start_index, limit)
    }

    fn market_count(env: Env) -> u32 {
        storage::get_market_count(&env)
    }

    // === Atomic Rollover Routers ===

    fn rollover_to_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        source_pool: Address,
        target_pool: Address,
        pt_amount: i128,
        min_target_pt: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;

        if pt_amount <= 0 || min_target_pt < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if source_pool == target_pool {
            return Err(ContractError::IdenticalAddresses);
        }

        with_non_reentrant(&env, || {
            let source_meta = storage::get_market_by_pool(&env, &source_pool)
                .ok_or(ContractError::MarketNotFound)?;
            let target_meta = storage::get_market_by_pool(&env, &target_pool)
                .ok_or(ContractError::MarketNotFound)?;

            if source_meta.asset != target_meta.asset {
                return Err(ContractError::InvalidAsset);
            }

            let now = env.ledger().timestamp();
            if now < source_meta.maturity {
                return Err(ContractError::MarketNotYetMatured);
            }
            if now >= target_meta.maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            // 1. Redeem matured PT from source pool
            let source_client = YieldMarketClient::new(&env, &source_pool);
            let sy_payout = source_client.redeem_pt_post_maturity(
                &caller,
                &env.current_contract_address(),
                &pt_amount,
            );

            if sy_payout <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // 2. Authorize sub-invocation for target_pool to pull sy_payout SY from factory
            let sy_client = StandardizedYieldClient::new(&env, &target_meta.sy);
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: target_meta.sy.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: vec![
                            &env,
                            env.current_contract_address().into_val(&env),
                            target_pool.into_val(&env),
                            sy_payout.into_val(&env),
                        ],
                    },
                    sub_invocations: vec![&env],
                }),
            ]);

            // 3. Swap SY for PT in target pool
            let target_client = YieldMarketClient::new(&env, &target_pool);
            let (pt_out, _fee) = target_client.swap_exact_sy_for_pt(
                &env.current_contract_address(),
                &receiver,
                &sy_payout,
                &min_target_pt,
            );

            if pt_out < min_target_pt {
                return Err(ContractError::SlippageExceeded);
            }

            // 4. Ensure zero residual SY balance in factory router
            let residual_sy = sy_client.balance(&env.current_contract_address());
            if residual_sy > 0 {
                sy_client.transfer(&env.current_contract_address(), &receiver, &residual_sy);
            }

            RolloverExecutedEvent {
                user: caller,
                source_pool,
                target_pool,
                pt_burned: pt_amount,
                sy_received: sy_payout,
                target_pt_minted: pt_out,
            }
            .publish(&env);

            Ok((sy_payout, pt_out))
        })
    }

    fn rollover_to_py(
        env: Env,
        caller: Address,
        receiver: Address,
        source_pool: Address,
        target_pool: Address,
        pt_amount: i128,
        min_new_shares: i128,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;

        if pt_amount <= 0 || min_new_shares < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if source_pool == target_pool {
            return Err(ContractError::IdenticalAddresses);
        }

        with_non_reentrant(&env, || {
            let source_meta = storage::get_market_by_pool(&env, &source_pool)
                .ok_or(ContractError::MarketNotFound)?;
            let target_meta = storage::get_market_by_pool(&env, &target_pool)
                .ok_or(ContractError::MarketNotFound)?;

            if source_meta.asset != target_meta.asset {
                return Err(ContractError::InvalidAsset);
            }

            let now = env.ledger().timestamp();
            if now < source_meta.maturity {
                return Err(ContractError::MarketNotYetMatured);
            }
            if now >= target_meta.maturity {
                return Err(ContractError::MarketAlreadyMatured);
            }

            // 1. Redeem matured PT from source pool
            let source_client = YieldMarketClient::new(&env, &source_pool);
            let sy_payout = source_client.redeem_pt_post_maturity(
                &caller,
                &env.current_contract_address(),
                &pt_amount,
            );

            if sy_payout <= 0 {
                return Err(ContractError::ZeroAmount);
            }
            if sy_payout < min_new_shares {
                return Err(ContractError::SlippageExceeded);
            }

            // 2. Authorize sub-invocation for target_pool to pull sy_payout SY from factory
            let sy_client = StandardizedYieldClient::new(&env, &target_meta.sy);
            env.authorize_as_current_contract(vec![
                &env,
                InvokerContractAuthEntry::Contract(SubContractInvocation {
                    context: ContractContext {
                        contract: target_meta.sy.clone(),
                        fn_name: Symbol::new(&env, "transfer"),
                        args: vec![
                            &env,
                            env.current_contract_address().into_val(&env),
                            target_pool.into_val(&env),
                            sy_payout.into_val(&env),
                        ],
                    },
                    sub_invocations: vec![&env],
                }),
            ]);

            // 3. Mint PY in target pool
            let target_client = YieldMarketClient::new(&env, &target_pool);
            let (minted_pt, _minted_yt) =
                target_client.mint_py(&env.current_contract_address(), &receiver, &sy_payout);

            // 4. Ensure zero residual SY balance in factory router
            let residual_sy = sy_client.balance(&env.current_contract_address());
            if residual_sy > 0 {
                sy_client.transfer(&env.current_contract_address(), &receiver, &residual_sy);
            }

            RolloverPyExecutedEvent {
                user: caller,
                source_pool,
                target_pool,
                pt_burned: pt_amount,
                sy_received: sy_payout,
                py_minted: minted_pt,
            }
            .publish(&env);

            Ok((sy_payout, minted_pt))
        })
    }

    // === Enterprise Governance & Pause Guardian ===

    fn propose_admin(env: Env, caller: Address, new_admin: Address) -> Result<(), ContractError> {
        common::governance::propose_admin(&env, &caller, &new_admin)
    }

    fn accept_admin(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::accept_admin(&env, &caller)
    }

    fn get_admin(env: Env) -> Result<Address, ContractError> {
        common::governance::get_admin(&env)
    }

    fn get_pending_admin(env: Env) -> Option<Address> {
        common::governance::get_pending_admin(&env)
    }

    fn set_guardian(env: Env, caller: Address, new_guardian: Address) -> Result<(), ContractError> {
        common::governance::set_guardian(&env, &caller, &new_guardian)
    }

    fn get_guardian(env: Env) -> Option<Address> {
        common::governance::get_guardian(&env)
    }

    fn pause(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::pause(&env, &caller)
    }

    fn unpause(env: Env, caller: Address) -> Result<(), ContractError> {
        common::governance::unpause(&env, &caller)
    }

    fn is_paused(env: Env) -> bool {
        common::governance::is_paused(&env)
    }

    fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) -> Result<(), ContractError> {
        common::governance::upgrade(&env, &caller, &new_wasm_hash)
    }
}

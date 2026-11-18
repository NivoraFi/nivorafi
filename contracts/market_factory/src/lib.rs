#![no_std]
#![allow(clippy::too_many_arguments)]

mod storage;
#[cfg(test)]
mod test;
pub mod types;

use common::errors::ContractError;
use common::events::{
    CreatorWhitelistUpdatedEvent, MarketCreatedEvent, MarketRegisteredEvent, RolloverExecutedEvent,
    RolloverPyExecutedEvent, SyConfiguredEvent, WasmHashesUpdatedEvent, ZapInEvent,
};
use common::fixed_point::{div_256_64, SCALAR_9, WAD};
use common::interfaces::{
    MarketFactoryTrait, MarketKey, MarketMetadata, PrivilegedTokenClient, StandardizedYieldClient,
    YieldMarketClient, YieldTokenClient,
};
use common::reentrancy::with_non_reentrant;
use common::storage_keys::DataKey;
use common::ttl::{bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation};
use soroban_sdk::{
    contract, contractimpl, token, vec, Address, Bytes, BytesN, ContractExecutable, Env, IntoVal,
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

impl MarketFactory {
    fn transfer_auth_entry(
        env: &Env,
        token: &Address,
        from: &Address,
        to: &Address,
        amount: i128,
    ) -> InvokerContractAuthEntry {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: token.clone(),
                fn_name: Symbol::new(env, "transfer"),
                args: vec![
                    env,
                    from.clone().into_val(env),
                    to.clone().into_val(env),
                    amount.into_val(env),
                ],
            },
            sub_invocations: vec![env],
        })
    }

    fn auth_transfer(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) {
        let entry = Self::transfer_auth_entry(env, token, from, to, amount);
        env.authorize_as_current_contract(vec![env, entry]);
    }

    fn auth_two_transfers(
        env: &Env,
        tok1: &Address,
        amt1: i128,
        tok2: &Address,
        amt2: i128,
        from: &Address,
        to: &Address,
    ) {
        let e1 = Self::transfer_auth_entry(env, tok1, from, to, amt1);
        let e2 = Self::transfer_auth_entry(env, tok2, from, to, amt2);
        env.authorize_as_current_contract(vec![env, e1, e2]);
    }

    fn mul_div_u128(a: u128, b: u128, d: u128, round_up: bool) -> Result<u128, ContractError> {
        if d == 0 {
            return Err(ContractError::DivisionByZero);
        }
        if a == 0 || b == 0 {
            return Ok(0);
        }
        let a_lo = (a as u64) as u128;
        let a_hi = a >> 64;
        let b_lo = (b as u64) as u128;
        let b_hi = b >> 64;

        let lolo = a_lo * b_lo;
        let lohi = a_lo * b_hi;
        let hilo = a_hi * b_lo;
        let hihi = a_hi * b_hi;

        let mid = (lolo >> 64) + (lohi & 0xFFFF_FFFF_FFFF_FFFF) + (hilo & 0xFFFF_FFFF_FFFF_FFFF);
        let lo = (mid << 64) | (lolo & 0xFFFF_FFFF_FFFF_FFFF);
        let hi = hihi + (lohi >> 64) + (hilo >> 64) + (mid >> 64);
        let (q, rem) = div_256_64(hi, lo, d)?;
        if round_up && rem > 0 {
            q.checked_add(1).ok_or(ContractError::MathOverflow)
        } else {
            Ok(q)
        }
    }

    fn sweep_zap_dust(env: &Env, meta: &MarketMetadata, receiver: &Address) -> i128 {
        let factory = env.current_contract_address();
        let tokens = [
            &meta.asset,
            &meta.sy,
            &meta.pt,
            &meta.yt,
            &meta.pool,
        ];
        let mut residual_sy = 0i128;
        for (idx, tok) in tokens.iter().enumerate() {
            let client = token::Client::new(env, tok);
            let bal = client.balance(&factory);
            if idx == 1 {
                residual_sy = bal;
            }
            if bal > 0 && *receiver != factory {
                client.transfer(&factory, receiver, &bal);
            }
        }
        residual_sy
    }

    fn zap_prepare_sy_inner(
        env: &Env,
        caller: &Address,
        pool: &Address,
        underlying_amount: i128,
    ) -> Result<(MarketMetadata, i128), ContractError> {
        let meta =
            storage::get_market_by_pool(env, pool).ok_or(ContractError::MarketNotFound)?;
        if env.ledger().timestamp() >= meta.maturity {
            return Err(ContractError::MarketAlreadyMatured);
        }

        let factory = env.current_contract_address();
        token::Client::new(env, &meta.asset).transfer(caller, &factory, &underlying_amount);

        Self::auth_transfer(env, &meta.asset, &factory, &meta.sy, underlying_amount);
        let sy_amount = StandardizedYieldClient::new(env, &meta.sy).deposit(
            &factory,
            &factory,
            &underlying_amount,
        );
        if sy_amount <= 0 {
            return Err(ContractError::ZeroAmount);
        }
        Ok((meta, sy_amount))
    }

    fn zap_in_swap_internal(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_out: i128,
        deadline: u64,
        is_yt: bool,
    ) -> Result<i128, ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if underlying_amount <= 0 || min_out < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if receiver == env.current_contract_address() {
            return Err(ContractError::IdenticalAddresses);
        }

        with_non_reentrant(&env, || {
            let (meta, sy_amount) =
                Self::zap_prepare_sy_inner(&env, &caller, &pool, underlying_amount)?;
            let factory = env.current_contract_address();

            Self::auth_transfer(&env, &meta.sy, &factory, &pool, sy_amount);
            let pool_client = YieldMarketClient::new(&env, &pool);
            let (out, _fee) = if is_yt {
                pool_client.swap_exact_sy_for_yt(
                    &factory,
                    &receiver,
                    &sy_amount,
                    &min_out,
                    &deadline,
                )
            } else {
                pool_client.swap_exact_sy_for_pt(
                    &factory,
                    &receiver,
                    &sy_amount,
                    &min_out,
                    &deadline,
                )
            };

            if out < min_out {
                return Err(ContractError::SlippageExceeded);
            }

            let residual_sy = Self::sweep_zap_dust(&env, &meta, &receiver);
            bump_instance_ttl(&env, 0);

            ZapInEvent {
                caller,
                receiver,
                pool,
                mode: u32::from(is_yt),
                underlying_amount,
                sy_amount,
                out_amount: out,
                residual_sy,
            }
            .publish(&env);

            Ok(out)
        })
    }

    fn convert_sy_if_cross_adapter(
        env: &Env,
        source_meta: &MarketMetadata,
        target_meta: &MarketMetadata,
        source_sy_payout: i128,
    ) -> Result<i128, ContractError> {
        if source_meta.sy == target_meta.sy {
            return Ok(source_sy_payout);
        }
        let factory = env.current_contract_address();
        let source_sy_client = StandardizedYieldClient::new(env, &source_meta.sy);
        let underlying_out = source_sy_client.redeem(&factory, &factory, &source_sy_payout);
        if underlying_out <= 0 {
            return Err(ContractError::RolloverFailed);
        }

        Self::auth_transfer(
            env,
            &source_meta.asset,
            &factory,
            &target_meta.sy,
            underlying_out,
        );

        let target_sy_client = StandardizedYieldClient::new(env, &target_meta.sy);
        let target_sy_payout = target_sy_client.deposit(&factory, &factory, &underlying_out);
        if target_sy_payout <= 0 {
            return Err(ContractError::RolloverFailed);
        }
        Ok(target_sy_payout)
    }

    fn sweep_rollover_dust(
        env: &Env,
        source_meta: &MarketMetadata,
        target_meta: &MarketMetadata,
        receiver: &Address,
    ) {
        let factory = env.current_contract_address();
        let target_sy_client = StandardizedYieldClient::new(env, &target_meta.sy);
        let residual_target_sy = target_sy_client.balance(&factory);
        if residual_target_sy > 0 {
            target_sy_client.transfer(&factory, receiver, &residual_target_sy);
        }
        if source_meta.sy != target_meta.sy {
            let source_sy_client = StandardizedYieldClient::new(env, &source_meta.sy);
            let residual_source_sy = source_sy_client.balance(&factory);
            if residual_source_sy > 0 {
                source_sy_client.transfer(&factory, receiver, &residual_source_sy);
            }
            let asset_client = token::Client::new(env, &source_meta.asset);
            let residual_asset = asset_client.balance(&factory);
            if residual_asset > 0 {
                asset_client.transfer(&factory, receiver, &residual_asset);
            }
        }
    }
}

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

    fn set_creator_whitelist(
        env: Env,
        caller: Address,
        creator: Address,
        allowed: bool,
    ) -> Result<(), ContractError> {
        caller.require_auth();
        let admin = common::governance::get_admin(&env)?;
        if caller != admin {
            return Err(ContractError::Unauthorized);
        }
        storage::set_creator_whitelist(&env, &creator, allowed);
        bump_instance_ttl(&env, 0);
        CreatorWhitelistUpdatedEvent {
            admin,
            creator,
            allowed,
        }
        .publish(&env);
        Ok(())
    }

    fn is_whitelisted_creator(env: Env, creator: Address) -> bool {
        storage::is_whitelisted_creator(&env, &creator)
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

        let admin = common::governance::get_admin(&env)?;
        if caller != admin && !storage::is_whitelisted_creator(&env, &caller) {
            return Err(ContractError::Unauthorized);
        }
        if caller != admin {
            bump_persistent_ttl(&env, &DataKey::WhitelistedCreator(caller.clone()), 0);
        }

        let now = env.ledger().timestamp();
        if maturity <= now {
            return Err(ContractError::InvalidMaturity);
        }
        if scalar_root <= 0 || initial_anchor <= 0 {
            return Err(ContractError::ZeroAmount);
        }
        if blend_pool == asset || blend_pool == env.current_contract_address() {
            return Err(ContractError::IdenticalAddresses);
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

        let (pt_wasm, yt_wasm, pool_wasm, sy_wasm) = storage::get_wasm_hashes(&env)?;
        let market_id = storage::get_market_count(&env);
        let factory_addr = env.current_contract_address();

        let (decimals, sym_buf, sym_len) =
            common::metadata::resolve_token_metadata(&env, &asset);
        let sym_slice = &sym_buf[..sym_len];
        let mut days_buf = [0u8; 16];
        let days_len = common::metadata::format_days_suffix(now, maturity, &mut days_buf);
        let days_slice = &days_buf[..days_len];

        // 1. Get or deploy canonical SY vault
        let sy_address = match storage::get_sy_for_asset(&env, &asset) {
            Some(sy) => {
                common::ttl::bump_persistent_ttl(&env, &DataKey::SyByAsset(asset.clone()), maturity);
                sy
            }
            None => {
                let salt_sy = derive_salt(&env, market_id, b"SY");
                let deployed_sy = env
                    .deployer()
                    .with_current_contract(salt_sy)
                    .deploy_contract(ContractExecutable::Wasm(sy_wasm), ());
                let sy_client = StandardizedYieldClient::new(&env, &deployed_sy);
                sy_client.initialize_from_factory(&factory_addr, &admin, &asset, &blend_pool);
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
        let pt_name = common::metadata::join4(&env, b"PT ", sym_slice, b" ", days_slice);
        let pt_symbol = common::metadata::join4(&env, b"PT-", sym_slice, b"-", days_slice);
        pt_client.initialize_from_factory(
            &factory_addr,
            &admin,
            &pool_address,
            &pt_name,
            &pt_symbol,
            &decimals,
            &maturity,
        );

        let salt_yt = derive_salt(&env, market_id, b"YT");
        let yt_address = env
            .deployer()
            .with_current_contract(salt_yt)
            .deploy_contract(ContractExecutable::Wasm(yt_wasm), ());
        let yt_client = YieldTokenClient::new(&env, &yt_address);
        let yt_name = common::metadata::join4(&env, b"YT ", sym_slice, b" ", days_slice);
        let yt_symbol = common::metadata::join4(&env, b"YT-", sym_slice, b"-", days_slice);
        yt_client.initialize_from_factory(
            &factory_addr,
            &admin,
            &pool_address,
            &sy_address,
            &yt_name,
            &yt_symbol,
            &decimals,
            &maturity,
        );

        // 4. Initialize YieldPool with PT, YT, and SY
        let pool_client = YieldMarketClient::new(&env, &pool_address);
        pool_client.initialize_from_factory(
            &factory_addr,
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
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }

        if pt_amount <= 0 || min_target_pt < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if source_pool == target_pool || receiver == env.current_contract_address() {
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
            let source_sy_payout = source_client.redeem_pt_post_maturity(
                &caller,
                &env.current_contract_address(),
                &pt_amount,
            );

            if source_sy_payout <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // 2. If rolling across different SY adapters (e.g., bUSDC <-> sUSDC), unwrap & rewrap
            let target_sy_payout = Self::convert_sy_if_cross_adapter(
                &env,
                &source_meta,
                &target_meta,
                source_sy_payout,
            )?;

            // 3. Authorize sub-invocation for target_pool to pull target_sy_payout SY from factory
            let factory = env.current_contract_address();
            Self::auth_transfer(&env, &target_meta.sy, &factory, &target_pool, target_sy_payout);

            // 4. Swap SY for PT in target pool
            let target_client = YieldMarketClient::new(&env, &target_pool);
            let (pt_out, _fee) = target_client.swap_exact_sy_for_pt(
                &factory,
                &receiver,
                &target_sy_payout,
                &min_target_pt,
                &deadline,
            );

            if pt_out < min_target_pt {
                return Err(ContractError::SlippageExceeded);
            }

            // 5. Ensure zero residual balance in factory router
            Self::sweep_rollover_dust(&env, &source_meta, &target_meta, &receiver);

            RolloverExecutedEvent {
                user: caller,
                source_pool,
                target_pool,
                pt_burned: pt_amount,
                sy_received: target_sy_payout,
                target_pt_minted: pt_out,
            }
            .publish(&env);

            Ok((target_sy_payout, pt_out))
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
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }

        if pt_amount <= 0 || min_new_shares < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if source_pool == target_pool || receiver == env.current_contract_address() {
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
            let source_sy_payout = source_client.redeem_pt_post_maturity(
                &caller,
                &env.current_contract_address(),
                &pt_amount,
            );

            if source_sy_payout <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            // 2. If rolling across different SY adapters (e.g., bUSDC <-> sUSDC), unwrap & rewrap
            let target_sy_payout = Self::convert_sy_if_cross_adapter(
                &env,
                &source_meta,
                &target_meta,
                source_sy_payout,
            )?;

            // 3. Authorize sub-invocation for target_pool to pull target_sy_payout SY from factory
            let factory = env.current_contract_address();
            Self::auth_transfer(&env, &target_meta.sy, &factory, &target_pool, target_sy_payout);

            // 4. Mint PY in target pool
            let target_client = YieldMarketClient::new(&env, &target_pool);
            let (minted_pt, minted_yt) = target_client.mint_py(
                &factory,
                &receiver,
                &target_sy_payout,
                &deadline,
            );
            if minted_pt < min_new_shares || minted_yt < min_new_shares {
                return Err(ContractError::SlippageExceeded);
            }

            // 5. Ensure zero residual balance in factory router
            Self::sweep_rollover_dust(&env, &source_meta, &target_meta, &receiver);

            RolloverPyExecutedEvent {
                user: caller,
                source_pool,
                target_pool,
                pt_burned: pt_amount,
                sy_received: target_sy_payout,
                py_minted: minted_pt,
            }
            .publish(&env);

            Ok((target_sy_payout, minted_pt))
        })
    }

    // === Single-Tx Zap-In Routers ===

    fn zap_in_pt(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_pt_out: i128,
        deadline: u64,
    ) -> Result<i128, ContractError> {
        Self::zap_in_swap_internal(
            env,
            caller,
            receiver,
            pool,
            underlying_amount,
            min_pt_out,
            deadline,
            false,
        )
    }

    fn zap_in_yt(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_yt_out: i128,
        deadline: u64,
    ) -> Result<i128, ContractError> {
        Self::zap_in_swap_internal(
            env,
            caller,
            receiver,
            pool,
            underlying_amount,
            min_yt_out,
            deadline,
            true,
        )
    }

    fn zap_in_lp(
        env: Env,
        caller: Address,
        receiver: Address,
        pool: Address,
        underlying_amount: i128,
        min_lp_out: i128,
        deadline: u64,
    ) -> Result<(i128, i128), ContractError> {
        caller.require_auth();
        common::governance::check_not_paused(&env)?;
        if env.ledger().timestamp() > deadline {
            return Err(ContractError::DeadlineExpired);
        }
        if underlying_amount <= 0 || min_lp_out < 0 {
            return Err(ContractError::ZeroAmount);
        }
        if receiver == env.current_contract_address() {
            return Err(ContractError::IdenticalAddresses);
        }

        with_non_reentrant(&env, || {
            let (meta, sy_amount) =
                Self::zap_prepare_sy_inner(&env, &caller, &pool, underlying_amount)?;
            let factory = env.current_contract_address();
            let pool_client = YieldMarketClient::new(&env, &pool);
            let state = pool_client.get_market_state();

            let (pt_to_add, sy_to_add) = if state.total_lp_supply > 0
                && state.total_pt_reserve > 0
                && state.total_sy_reserve > 0
            {
                let pt_res = state.total_pt_reserve;
                let sy_res = state.total_sy_reserve;
                let py_index = YieldTokenClient::new(&env, &meta.yt).get_py_index();
                if py_index <= 0 {
                    return Err(ContractError::InvalidRate);
                }
                let e0 = pool_client.get_exchange_rate();
                if e0 <= 0 {
                    return Err(ContractError::InvalidRate);
                }

                let sy_sum = (sy_res as u128)
                    .checked_add(sy_amount as u128)
                    .ok_or(ContractError::MathOverflow)?;
                let asset_sum_ceil =
                    Self::mul_div_u128(sy_sum, py_index as u128, SCALAR_9 as u128, true)?;
                let k_sy_sum_ceil =
                    Self::mul_div_u128(asset_sum_ceil, e0 as u128, WAD as u128, true)?;
                let denom = (pt_res as u128)
                    .checked_add(k_sy_sum_ceil)
                    .ok_or(ContractError::MathOverflow)?;
                let x_max =
                    Self::mul_div_u128(sy_amount as u128, pt_res as u128, denom, false)?;

                let sy_for_swap_u128 = if x_max >= 2 {
                    let margin = (x_max / 200).max(1);
                    x_max - margin
                } else {
                    x_max
                };
                if sy_for_swap_u128 == 0 || sy_for_swap_u128 >= (sy_amount as u128) {
                    return Err(ContractError::ZeroAmount);
                }
                let sy_for_swap = i128::try_from(sy_for_swap_u128)
                    .map_err(|_| ContractError::MathOverflow)?;

                Self::auth_transfer(&env, &meta.sy, &factory, &pool, sy_for_swap);
                let (pt_bought, _fee) = pool_client.swap_exact_sy_for_pt(
                    &factory,
                    &factory,
                    &sy_for_swap,
                    &1,
                    &deadline,
                );
                if pt_bought <= 0 {
                    return Err(ContractError::ZeroAmount);
                }

                let (pt_res_post, sy_res_post) = pool_client.get_reserves();
                if pt_res_post <= 0 || sy_res_post <= 0 {
                    return Err(ContractError::InsufficientBalance);
                }
                let sy_rem = sy_amount - sy_for_swap;
                let sy_needed_u128 = Self::mul_div_u128(
                    pt_bought as u128,
                    sy_res_post as u128,
                    pt_res_post as u128,
                    true,
                )?;

                if sy_needed_u128 <= (sy_rem as u128) {
                    let sy_needed = i128::try_from(sy_needed_u128)
                        .map_err(|_| ContractError::MathOverflow)?;
                    (pt_bought, sy_needed)
                } else {
                    let pt_clamped = Self::mul_div_u128(
                        sy_rem as u128,
                        pt_res_post as u128,
                        sy_res_post as u128,
                        false,
                    )?;
                    let pt_clamped_i128 = i128::try_from(pt_clamped)
                        .map_err(|_| ContractError::MathOverflow)?;
                    (pt_clamped_i128, sy_rem)
                }
            } else if state.total_lp_supply == 0
                && state.total_pt_reserve == 0
                && state.total_sy_reserve == 0
            {
                let sy_for_lp = sy_amount / 2;
                let sy_for_py = sy_amount - sy_for_lp;
                if sy_for_lp <= 0 || sy_for_py <= 0 {
                    return Err(ContractError::ZeroAmount);
                }

                Self::auth_transfer(&env, &meta.sy, &factory, &pool, sy_for_py);
                let (pt_minted, _yt_minted) =
                    pool_client.mint_py(&factory, &factory, &sy_for_py, &deadline);
                (pt_minted, sy_for_lp)
            } else {
                return Err(ContractError::InsufficientBalance);
            };

            if pt_to_add <= 0 || sy_to_add <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            Self::auth_two_transfers(
                &env,
                &meta.pt,
                pt_to_add,
                &meta.sy,
                sy_to_add,
                &factory,
                &pool,
            );
            let lp_out =
                pool_client.add_liquidity(&factory, &receiver, &pt_to_add, &sy_to_add, &min_lp_out);

            if lp_out < min_lp_out {
                return Err(ContractError::SlippageExceeded);
            }
            if lp_out <= 0 {
                return Err(ContractError::ZeroAmount);
            }

            let residual_sy = Self::sweep_zap_dust(&env, &meta, &receiver);
            bump_instance_ttl(&env, 0);

            ZapInEvent {
                caller,
                receiver,
                pool,
                mode: 2,
                underlying_amount,
                sy_amount,
                out_amount: lp_out,
                residual_sy,
            }
            .publish(&env);

            Ok((lp_out, residual_sy))
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

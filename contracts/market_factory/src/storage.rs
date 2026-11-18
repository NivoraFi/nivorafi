use common::errors::ContractError;
use common::interfaces::{MarketKey, MarketMetadata};
use common::storage_keys::DataKey;
use common::ttl::{bump_instance_ttl, bump_persistent_ttl};
use soroban_sdk::{Address, BytesN, Env, Vec};

pub fn get_market_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MarketCount)
        .unwrap_or(0)
}

pub fn increment_market_count(env: &Env) -> u32 {
    let count = get_market_count(env);
    let next = count.saturating_add(1);
    env.storage().instance().set(&DataKey::MarketCount, &next);
    bump_instance_ttl(env, 0);
    count
}

pub fn get_wasm_hashes(
    env: &Env,
) -> Result<(BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>), ContractError> {
    let pt: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::PtWasmHash)
        .ok_or(ContractError::NotInitialized)?;
    let yt: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::YtWasmHash)
        .ok_or(ContractError::NotInitialized)?;
    let pool: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::PoolWasmHash)
        .ok_or(ContractError::NotInitialized)?;
    let sy: BytesN<32> = env
        .storage()
        .instance()
        .get(&DataKey::SyWasmHash)
        .ok_or(ContractError::NotInitialized)?;
    Ok((pt, yt, pool, sy))
}

pub fn set_wasm_hashes(
    env: &Env,
    pt_wasm: Option<BytesN<32>>,
    yt_wasm: Option<BytesN<32>>,
    pool_wasm: Option<BytesN<32>>,
    sy_wasm: Option<BytesN<32>>,
) -> Result<(), ContractError> {
    let zero = [0u8; 32];
    if let Some(ref h) = pt_wasm {
        if h.to_array() == zero {
            return Err(ContractError::InvalidWasmHash);
        }
        env.storage().instance().set(&DataKey::PtWasmHash, h);
    }
    if let Some(ref h) = yt_wasm {
        if h.to_array() == zero {
            return Err(ContractError::InvalidWasmHash);
        }
        env.storage().instance().set(&DataKey::YtWasmHash, h);
    }
    if let Some(ref h) = pool_wasm {
        if h.to_array() == zero {
            return Err(ContractError::InvalidWasmHash);
        }
        env.storage().instance().set(&DataKey::PoolWasmHash, h);
    }
    if let Some(ref h) = sy_wasm {
        if h.to_array() == zero {
            return Err(ContractError::InvalidWasmHash);
        }
        env.storage().instance().set(&DataKey::SyWasmHash, h);
    }
    bump_instance_ttl(env, 0);
    Ok(())
}

pub fn get_sy_for_asset(env: &Env, asset: &Address) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::SyByAsset(asset.clone()))
}

pub fn set_sy_for_asset(env: &Env, asset: &Address, sy: &Address) {
    let key = DataKey::SyByAsset(asset.clone());
    env.storage().persistent().set(&key, sy);
    bump_persistent_ttl(env, &key, 0);
}

pub fn is_whitelisted_creator(env: &Env, creator: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::WhitelistedCreator(creator.clone()))
        .unwrap_or(false)
}

pub fn set_creator_whitelist(env: &Env, creator: &Address, allowed: bool) {
    let key = DataKey::WhitelistedCreator(creator.clone());
    if allowed {
        env.storage().persistent().set(&key, &true);
        bump_persistent_ttl(env, &key, 0);
    } else {
        env.storage().persistent().remove(&key);
    }
}

pub fn save_market(env: &Env, meta: &MarketMetadata) {
    let id_key = DataKey::MarketById(meta.id);
    let key_key = DataKey::MarketByKey(MarketKey {
        asset: meta.asset.clone(),
        maturity: meta.maturity,
    });
    let pool_key = DataKey::MarketByPool(meta.pool.clone());
    let data_key = DataKey::MarketData(meta.pool.clone());

    env.storage().persistent().set(&id_key, meta);
    env.storage().persistent().set(&key_key, &meta.id);
    env.storage().persistent().set(&pool_key, &meta.id);
    env.storage().persistent().set(&data_key, meta);

    bump_persistent_ttl(env, &id_key, meta.maturity);
    bump_persistent_ttl(env, &key_key, meta.maturity);
    bump_persistent_ttl(env, &pool_key, meta.maturity);
    bump_persistent_ttl(env, &data_key, meta.maturity);
}

pub fn get_market(env: &Env, id: u32) -> Result<MarketMetadata, ContractError> {
    env.storage()
        .persistent()
        .get::<DataKey, MarketMetadata>(&DataKey::MarketById(id))
        .ok_or(ContractError::MarketNotFound)
}

pub fn get_market_by_asset_maturity(
    env: &Env,
    asset: &Address,
    maturity: u64,
) -> Option<MarketMetadata> {
    let key = MarketKey {
        asset: asset.clone(),
        maturity,
    };
    let id: u32 = env.storage().persistent().get(&DataKey::MarketByKey(key))?;
    env.storage()
        .persistent()
        .get::<DataKey, MarketMetadata>(&DataKey::MarketById(id))
}

pub fn get_market_by_pool(env: &Env, pool: &Address) -> Option<MarketMetadata> {
    if let Some(meta) = env
        .storage()
        .persistent()
        .get::<DataKey, MarketMetadata>(&DataKey::MarketData(pool.clone()))
    {
        return Some(meta);
    }
    let id: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::MarketByPool(pool.clone()))?;
    env.storage()
        .persistent()
        .get::<DataKey, MarketMetadata>(&DataKey::MarketById(id))
}

pub fn list_markets(env: &Env, start_index: u32, limit: u32) -> Vec<MarketMetadata> {
    let count = get_market_count(env);
    if start_index >= count {
        return Vec::new(env);
    }
    let safe_limit = limit.min(50);
    let end = start_index.saturating_add(safe_limit).min(count);
    let mut list = Vec::new(env);
    for id in start_index..end {
        if let Some(meta) = env
            .storage()
            .persistent()
            .get::<DataKey, MarketMetadata>(&DataKey::MarketById(id))
        {
            bump_persistent_ttl(env, &DataKey::MarketById(id), meta.maturity);
            list.push_back(meta);
        }
    }
    list
}

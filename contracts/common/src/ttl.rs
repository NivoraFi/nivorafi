use crate::storage_keys::DataKey;
use soroban_sdk::Env;

pub const DAY_IN_LEDGERS: u32 = 17_280;
pub const MIN_BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (30 days)
pub const MAX_NETWORK_TTL: u32 = 180 * DAY_IN_LEDGERS; // 3,110,400 ledgers (180 days)
pub const DEFAULT_BUMP_TO: u32 = 120 * DAY_IN_LEDGERS; // 2,073,600 ledgers (120 days)
pub const BUFFER_LEDGERS: u32 = 30 * DAY_IN_LEDGERS; // 518,400 ledgers (30 days)

pub fn calculate_bump_to(now: u64, maturity: u64) -> u32 {
    if maturity <= now {
        return DEFAULT_BUMP_TO;
    }
    let remaining_seconds = maturity - now;
    let remaining_ledgers = (remaining_seconds / 5) as u32;
    let target = remaining_ledgers.saturating_add(BUFFER_LEDGERS);
    target.clamp(DEFAULT_BUMP_TO, MAX_NETWORK_TTL)
}

pub fn calculate_bump_threshold(bump_to: u32) -> u32 {
    (bump_to / 4).max(MIN_BUMP_THRESHOLD)
}

pub fn bump_instance_ttl(env: &Env, maturity: u64) {
    let now = env.ledger().timestamp();
    let bump_to = calculate_bump_to(now, maturity);
    let threshold = calculate_bump_threshold(bump_to);
    env.storage().instance().extend_ttl(threshold, bump_to);
}

pub fn bump_persistent_ttl(env: &Env, key: &DataKey, maturity: u64) {
    let now = env.ledger().timestamp();
    let bump_to = calculate_bump_to(now, maturity);
    let threshold = calculate_bump_threshold(bump_to);
    env.storage()
        .persistent()
        .extend_ttl(key, threshold, bump_to);
}

pub fn bump_allowance_ttl(env: &Env, key: &DataKey, expiration_ledger: u32) {
    let current_seq = env.ledger().sequence();
    if expiration_ledger > current_seq {
        let live_for = (expiration_ledger - current_seq).min(MAX_NETWORK_TTL);
        if live_for > 0 {
            env.storage()
                .temporary()
                .extend_ttl(key, live_for, live_for);
        }
    }
}

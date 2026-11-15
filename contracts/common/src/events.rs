use soroban_sdk::{contractevent, Address, BytesN};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TransferEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApproveEvent {
    #[topic]
    pub from: Address,
    #[topic]
    pub spender: Address,
    pub amount: i128,
    pub expiration_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintEvent {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BurnEvent {
    #[topic]
    pub from: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RateUpdatedEvent {
    pub new_rate: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DepositEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub underlying_amount: i128,
    pub shares_minted: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedeemEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub shares_burned: i128,
    pub assets_out: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MintPyEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub sy_in: i128,
    pub py_out: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedeemPyEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub py_burned: i128,
    pub sy_out: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RedeemPtEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub pt_burned: i128,
    pub payout: i128,
    pub is_btoken: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldClaimedEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub receiver: Address,
    pub yield_out: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaturitySettledEvent {
    pub maturity: u64,
    pub settled_index: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub direction: u32, // 0=PT->SY, 1=SY->PT, 2=SY->YT, 3=YT->SY
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiquidityEvent {
    #[topic]
    pub caller: Address,
    #[topic]
    pub receiver: Address,
    pub is_add: bool,
    pub pt_amount: i128,
    pub sy_amount: i128,
    pub lp_amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeRecipientEvent {
    #[topic]
    pub admin: Address,
    #[topic]
    pub new_recipient: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposedEvent {
    #[topic]
    pub current_admin: Address,
    #[topic]
    pub proposed_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminAcceptedEvent {
    #[topic]
    pub old_admin: Address,
    #[topic]
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianUpdatedEvent {
    #[topic]
    pub admin: Address,
    #[topic]
    pub new_guardian: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractPausedEvent {
    #[topic]
    pub caller: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUnpausedEvent {
    #[topic]
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpgradedEvent {
    #[topic]
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketCreatedEvent {
    #[topic]
    pub id: u32,
    #[topic]
    pub pool: Address,
    #[topic]
    pub asset: Address,
    pub sy: Address,
    pub pt: Address,
    pub yt: Address,
    pub maturity: u64,
    pub scalar_root: i128,
    pub initial_anchor: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketRegisteredEvent {
    #[topic]
    pub id: u32,
    #[topic]
    pub pool: Address,
    #[topic]
    pub asset: Address,
    pub maturity: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WasmHashesUpdatedEvent {
    #[topic]
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyConfiguredEvent {
    #[topic]
    pub asset: Address,
    #[topic]
    pub sy: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RolloverExecutedEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub source_pool: Address,
    #[topic]
    pub target_pool: Address,
    pub pt_burned: i128,
    pub sy_received: i128,
    pub target_pt_minted: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RolloverPyExecutedEvent {
    #[topic]
    pub user: Address,
    #[topic]
    pub source_pool: Address,
    #[topic]
    pub target_pool: Address,
    pub pt_burned: i128,
    pub sy_received: i128,
    pub py_minted: i128,
}

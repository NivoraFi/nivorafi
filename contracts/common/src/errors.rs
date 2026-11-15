use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ZeroAmount = 4,
    InsufficientBalance = 5,
    InsufficientAllowance = 6,
    MarketAlreadyMatured = 7,
    MarketNotYetMatured = 8,
    SlippageExceeded = 9,
    DeadlineExpired = 10,
    InvalidMaturity = 11,
    BlendPoolError = 12,
    MathOverflow = 13,
    ProportionOutOfBounds = 14,
    IdenticalAddresses = 15,
    MarketSettled = 16,
    ReentrancyLocked = 17,
    NegativeYieldNotSupported = 18,
    NegativeLogarithmInput = 19,
    DivisionByZero = 20,
    InvalidAsset = 21,
    InvalidRate = 22,
    ContractPaused = 23,
    NoPendingAdmin = 24,
    MarketAlreadyExists = 25,
    MarketNotFound = 26,
    InvalidMarketParameters = 27,
    RolloverFailed = 28,
    ContractNotPaused = 29,
    InvalidAdmin = 30,
    InvalidWasmHash = 31,
}

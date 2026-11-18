use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use soroban_sdk::testutils::{
    Address as _, AuthorizedFunction, AuthorizedInvocation, EnvTestConfig, Ledger as _,
    MockAuthContract,
};
use soroban_sdk::xdr::{self, Limits, ReadXdr};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec as SorobanVec};
use std::collections::HashMap;
use std::io::{self, BufRead, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::rc::Rc;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    #[default]
    MockAll,
    MockNonRoot,
    None,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMode {
    #[default]
    Unlimited,
    Default,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MockAuthInvokeSpec {
    pub contract: String,
    pub fn_name: String,
    #[serde(default)]
    pub args: Vec<TypedArg>,
    #[serde(default)]
    pub sub_invokes: Vec<MockAuthInvokeSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MockAuthSignerSpec {
    pub address: String,
    pub invoke: MockAuthInvokeSpec,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum AuthOverride {
    Mode(AuthMode),
    Signers { signers: Vec<MockAuthSignerSpec> },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TypedArg {
    #[serde(rename = "type")]
    pub arg_type: String,
    #[serde(default)]
    pub value: JsonValue,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RequestEnvelope {
    #[serde(default)]
    pub id: Option<JsonValue>,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum Command {
    InitEnv {
        timestamp: Option<u64>,
        sequence: Option<u32>,
        auth_mode: Option<AuthMode>,
        budget_mode: Option<BudgetMode>,
    },
    Reset {
        timestamp: Option<u64>,
        sequence: Option<u32>,
        auth_mode: Option<AuthMode>,
        budget_mode: Option<BudgetMode>,
    },
    SetLedger {
        timestamp: Option<u64>,
        sequence: Option<u32>,
    },
    GetLedger,
    SetAuthMode {
        mode: AuthMode,
    },
    SetBudget {
        mode: BudgetMode,
    },
    GenAddress {
        name: Option<String>,
    },
    GenAccount {
        name: Option<String>,
        native_balance: Option<String>,
    },
    CreateSac {
        symbol: String,
        admin: Option<String>,
        name: Option<String>,
    },
    SacMint {
        token: String,
        to: String,
        amount: String,
    },
    UploadWasm {
        path: String,
        var_name: Option<String>,
    },
    DeployWasm {
        path: String,
        var_name: Option<String>,
        #[serde(default)]
        constructor_args: Vec<TypedArg>,
    },
    Invoke {
        contract: String,
        method: String,
        #[serde(default)]
        args: Vec<TypedArg>,
        auth: Option<AuthOverride>,
        save_as: Option<String>,
    },
    BurnAsHolder {
        token: String,
        holder: String,
        amount: String,
    },
    GetEvents {
        contract: Option<String>,
    },
    GetAuths,
    Batch {
        steps: Vec<RequestEnvelope>,
        #[serde(default = "default_true")]
        stop_on_error: bool,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sc_error_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sc_error_code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<JsonValue>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<JsonValue>,
}

impl Response {
    fn success(id: Option<JsonValue>, data: JsonValue) -> Self {
        Self {
            id,
            ok: true,
            error: None,
            data: Some(data),
        }
    }

    fn err(id: Option<JsonValue>, error: ErrorPayload) -> Self {
        Self {
            id,
            ok: false,
            error: Some(error),
            data: None,
        }
    }
}

fn contract_error_name(code: u32) -> Option<&'static str> {
    match code {
        1 => Some("NotInitialized"),
        2 => Some("AlreadyInitialized"),
        3 => Some("Unauthorized"),
        4 => Some("ZeroAmount"),
        5 => Some("InsufficientBalance"),
        6 => Some("InsufficientAllowance"),
        7 => Some("MarketAlreadyMatured"),
        8 => Some("MarketNotYetMatured"),
        9 => Some("SlippageExceeded"),
        10 => Some("DeadlineExpired"),
        11 => Some("InvalidMaturity"),
        12 => Some("BlendPoolError"),
        13 => Some("MathOverflow"),
        14 => Some("ProportionOutOfBounds"),
        15 => Some("IdenticalAddresses"),
        16 => Some("MarketSettled"),
        17 => Some("ReentrancyLocked"),
        18 => Some("NegativeYieldNotSupported"),
        19 => Some("NegativeLogarithmInput"),
        20 => Some("DivisionByZero"),
        21 => Some("InvalidAsset"),
        22 => Some("InvalidRate"),
        23 => Some("ContractPaused"),
        24 => Some("NoPendingAdmin"),
        25 => Some("MarketAlreadyExists"),
        26 => Some("MarketNotFound"),
        27 => Some("InvalidMarketParameters"),
        28 => Some("RolloverFailed"),
        29 => Some("ContractNotPaused"),
        30 => Some("InvalidAdmin"),
        31 => Some("InvalidWasmHash"),
        _ => None,
    }
}

fn invalid_arg(message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        kind: "InvalidArg".to_string(),
        code: None,
        name: None,
        sc_error_type: None,
        sc_error_code: None,
        message: message.into(),
    }
}

fn missing_wasm(message: impl Into<String>) -> ErrorPayload {
    ErrorPayload {
        kind: "MissingWasm".to_string(),
        code: None,
        name: None,
        sc_error_type: None,
        sc_error_code: None,
        message: message.into(),
    }
}

fn is_sac_diagnostic(debug_msg: &str) -> bool {
    let lower = debug_msg.to_ascii_lowercase();
    lower.contains("trustline")
        || lower.contains("clawback")
        || lower.contains("deauthorize")
        || lower.contains("account entry is missing")
        || lower.contains("balance is not sufficient")
        || lower.contains("resulting balance is not within")
        || lower.contains("operation invalid on native asset")
}

fn classify_sc_host_error(err: &soroban_sdk::Error, debug_msg: String) -> ErrorPayload {
    let (sc_type, sc_code) = match xdr::ScError::try_from(*err) {
        Ok(sc) => {
            let t = format!("{:?}", sc.discriminant());
            let c = match sc {
                xdr::ScError::Contract(u) => format!("Contract({})", u),
                xdr::ScError::WasmVm(c)
                | xdr::ScError::Context(c)
                | xdr::ScError::Storage(c)
                | xdr::ScError::Object(c)
                | xdr::ScError::Crypto(c)
                | xdr::ScError::Events(c)
                | xdr::ScError::Budget(c)
                | xdr::ScError::Value(c)
                | xdr::ScError::Auth(c) => format!("{:?}", c),
            };
            (t, c)
        }
        Err(_) => ("Unknown".to_string(), format!("0x{:x}", err.to_val().get_payload())),
    };
    match err {
        e if e.is_type(xdr::ScErrorType::Contract) => {
            let code = e.get_code();
            let name = if is_sac_diagnostic(&debug_msg) {
                None
            } else {
                contract_error_name(code).map(str::to_string)
            };
            ErrorPayload {
                kind: "ContractError".to_string(),
                code: Some(code),
                name,
                sc_error_type: Some(sc_type),
                sc_error_code: Some(sc_code),
                message: debug_msg,
            }
        }
        e if e.is_type(xdr::ScErrorType::Auth) => ErrorPayload {
            kind: "AuthError".to_string(),
            code: None,
            name: None,
            sc_error_type: Some(sc_type),
            sc_error_code: Some(sc_code),
            message: debug_msg,
        },
        e if e.is_type(xdr::ScErrorType::WasmVm)
            && e.is_code(xdr::ScErrorCode::MissingValue)
            && debug_msg.contains("non-existent contract function") =>
        {
            ErrorPayload {
                kind: "MissingMethod".to_string(),
                code: None,
                name: None,
                sc_error_type: Some(sc_type),
                sc_error_code: Some(sc_code),
                message: debug_msg,
            }
        }
        _ => ErrorPayload {
            kind: "InvokeError".to_string(),
            code: None,
            name: None,
            sc_error_type: Some(sc_type),
            sc_error_code: Some(sc_code),
            message: debug_msg,
        },
    }
}

fn apply_budget_mode(env: &Env, mode: &BudgetMode) {
    match mode {
        BudgetMode::Unlimited => {
            env.cost_estimate().budget().reset_unlimited();
        }
        BudgetMode::Default => {
            env.cost_estimate().budget().reset_default();
        }
    }
}

fn new_env(
    timestamp: Option<u64>,
    sequence: Option<u32>,
    auth_mode: &AuthMode,
    budget_mode: &BudgetMode,
) -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    if let Some(ts) = timestamp {
        env.ledger().set_timestamp(ts);
    }
    if let Some(seq) = sequence {
        env.ledger().set_sequence_number(seq);
    }
    apply_auth_mode(&env, auth_mode);
    apply_budget_mode(&env, budget_mode);
    env
}

fn apply_auth_mode(env: &Env, mode: &AuthMode) {
    match mode {
        AuthMode::MockAll => env.mock_all_auths(),
        AuthMode::MockNonRoot => env.mock_all_auths_allowing_non_root_auth(),
        AuthMode::None => env.set_auths(&[]),
    }
}

pub struct SessionState {
    env: Env,
    wasm_dir: PathBuf,
    vars: HashMap<String, String>,
    auth_mode: AuthMode,
    budget_mode: BudgetMode,
    account_seq: u64,
    auth_nonce: i64,
}

impl SessionState {
    pub fn new(wasm_dir: PathBuf) -> Self {
        let auth_mode = AuthMode::MockAll;
        let budget_mode = BudgetMode::Unlimited;
        let env = new_env(None, None, &auth_mode, &budget_mode);
        Self {
            env,
            wasm_dir,
            vars: HashMap::new(),
            auth_mode,
            budget_mode,
            account_seq: 1,
            auth_nonce: 1,
        }
    }

    fn resolve_var(&self, raw: &str) -> Result<String, ErrorPayload> {
        if let Some(key) = raw.strip_prefix('$') {
            self.vars
                .get(key)
                .cloned()
                .ok_or_else(|| invalid_arg(format!("Unknown variable reference: {}", raw)))
        } else {
            Ok(raw.to_string())
        }
    }

    fn resolve_address(&self, raw: &str) -> Result<Address, ErrorPayload> {
        let s = self.resolve_var(raw)?;
        match stellar_strkey::Strkey::from_string(&s) {
            Ok(stellar_strkey::Strkey::Contract(_))
            | Ok(stellar_strkey::Strkey::PublicKeyEd25519(_)) => {
                Ok(Address::from_str(&self.env, &s))
            }
            _ => Err(invalid_arg(format!("Invalid Stellar strkey address: {}", s))),
        }
    }

    fn resolve_wasm_path(&self, raw: &str) -> PathBuf {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            self.wasm_dir.join(p)
        }
    }

    fn read_wasm_bytes(&self, raw: &str) -> Result<std::vec::Vec<u8>, ErrorPayload> {
        let path = self.resolve_wasm_path(raw);
        if !path.is_file() {
            return Err(missing_wasm(format!(
                "WASM file not found at {}",
                path.display()
            )));
        }
        std::fs::read(&path)
            .map_err(|e| missing_wasm(format!("Failed reading WASM {}: {}", path.display(), e)))
    }

    fn parse_i128(v: &JsonValue) -> Result<i128, ErrorPayload> {
        match v {
            JsonValue::Number(n) => n
                .as_i64()
                .map(|x| x as i128)
                .or_else(|| n.to_string().parse::<i128>().ok())
                .ok_or_else(|| invalid_arg(format!("Invalid i128 number: {}", n))),
            JsonValue::String(s) => s
                .trim()
                .parse::<i128>()
                .map_err(|_| invalid_arg(format!("Invalid i128 string: {}", s))),
            _ => Err(invalid_arg(format!("Expected i128 number/string, got {}", v))),
        }
    }

    fn parse_u128(v: &JsonValue) -> Result<u128, ErrorPayload> {
        match v {
            JsonValue::Number(n) => n
                .as_u64()
                .map(|x| x as u128)
                .or_else(|| n.to_string().parse::<u128>().ok())
                .ok_or_else(|| invalid_arg(format!("Invalid u128 number: {}", n))),
            JsonValue::String(s) => s
                .trim()
                .parse::<u128>()
                .map_err(|_| invalid_arg(format!("Invalid u128 string: {}", s))),
            _ => Err(invalid_arg(format!("Expected u128 number/string, got {}", v))),
        }
    }

    fn parse_u64(v: &JsonValue) -> Result<u64, ErrorPayload> {
        match v {
            JsonValue::Number(n) => n
                .as_u64()
                .ok_or_else(|| invalid_arg(format!("Invalid u64 number: {}", n))),
            JsonValue::String(s) => s
                .trim()
                .parse::<u64>()
                .map_err(|_| invalid_arg(format!("Invalid u64 string: {}", s))),
            _ => Err(invalid_arg(format!("Expected u64 number/string, got {}", v))),
        }
    }

    fn parse_i64(v: &JsonValue) -> Result<i64, ErrorPayload> {
        match v {
            JsonValue::Number(n) => n
                .as_i64()
                .ok_or_else(|| invalid_arg(format!("Invalid i64 number: {}", n))),
            JsonValue::String(s) => s
                .trim()
                .parse::<i64>()
                .map_err(|_| invalid_arg(format!("Invalid i64 string: {}", s))),
            _ => Err(invalid_arg(format!("Expected i64 number/string, got {}", v))),
        }
    }

    fn encode_arg(&self, arg: &TypedArg) -> Result<Val, ErrorPayload> {
        match arg.arg_type.as_str() {
            "void" => Ok(Val::VOID.into()),
            "bool" => arg
                .value
                .as_bool()
                .map(|b| b.into_val(&self.env))
                .ok_or_else(|| invalid_arg("Expected boolean value for bool")),
            "u32" => arg
                .value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .map(|n| n.into_val(&self.env))
                .ok_or_else(|| invalid_arg(format!("Invalid u32 value: {}", arg.value))),
            "i32" => arg
                .value
                .as_i64()
                .and_then(|n| i32::try_from(n).ok())
                .map(|n| n.into_val(&self.env))
                .ok_or_else(|| invalid_arg(format!("Invalid i32 value: {}", arg.value))),
            "u64" => Self::parse_u64(&arg.value).map(|n| n.into_val(&self.env)),
            "i64" => Self::parse_i64(&arg.value).map(|n| n.into_val(&self.env)),
            "u128" => Self::parse_u128(&arg.value).map(|n| n.into_val(&self.env)),
            "i128" => Self::parse_i128(&arg.value).map(|n| n.into_val(&self.env)),
            "symbol" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected string value for symbol"))?;
                if s.len() > 32 {
                    return Err(invalid_arg(format!("Symbol too long (>32 bytes): {}", s)));
                }
                Ok(Symbol::new(&self.env, s).into_val(&self.env))
            }
            "string" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected string value for string"))?;
                Ok(soroban_sdk::String::from_str(&self.env, s).into_val(&self.env))
            }
            "address" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected string value for address"))?;
                let addr = self.resolve_address(s)?;
                Ok(addr.into_val(&self.env))
            }
            "bytes" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected hex string value for bytes"))?;
                let raw = hex::decode(s.trim_start_matches("0x"))
                    .map_err(|e| invalid_arg(format!("Invalid hex in bytes: {}", e)))?;
                Ok(Bytes::from_slice(&self.env, &raw).into_val(&self.env))
            }
            "bytes_n32" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected hex string or $var for bytes_n32"))?;
                let resolved = self.resolve_var(s)?;
                let raw = hex::decode(resolved.trim_start_matches("0x"))
                    .map_err(|e| invalid_arg(format!("Invalid hex in bytes_n32: {}", e)))?;
                if raw.len() != 32 {
                    return Err(invalid_arg(format!(
                        "bytes_n32 must be 32 bytes, got {}",
                        raw.len()
                    )));
                }
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&raw);
                Ok(BytesN::<32>::from_array(&self.env, &arr).into_val(&self.env))
            }
            "vec" => {
                let items: Vec<TypedArg> = serde_json::from_value(arg.value.clone())
                    .map_err(|e| invalid_arg(format!("Invalid vec TypedArg[]: {}", e)))?;
                let mut out = SorobanVec::<Val>::new(&self.env);
                for item in items.iter() {
                    out.push_back(self.encode_arg(item)?);
                }
                Ok(out.into_val(&self.env))
            }
            "option" => {
                if arg.value.is_null() {
                    Ok(Val::VOID.into())
                } else {
                    let inner: TypedArg = serde_json::from_value(arg.value.clone())
                        .map_err(|e| invalid_arg(format!("Invalid option inner TypedArg: {}", e)))?;
                    self.encode_arg(&inner)
                }
            }
            "map" => {
                let obj = arg
                    .value
                    .as_object()
                    .ok_or_else(|| invalid_arg("Expected object for map"))?;
                let mut m = Map::<Val, Val>::new(&self.env);
                for (k, v) in obj.iter() {
                    let inner: TypedArg = serde_json::from_value(v.clone()).map_err(|e| {
                        invalid_arg(format!("Invalid map value TypedArg for '{}': {}", k, e))
                    })?;
                    let key_val = Symbol::new(&self.env, k).into_val(&self.env);
                    let val_val = self.encode_arg(&inner)?;
                    m.set(key_val, val_val);
                }
                Ok(m.into_val(&self.env))
            }
            "scval_xdr_hex" => {
                let s = arg
                    .value
                    .as_str()
                    .ok_or_else(|| invalid_arg("Expected hex string for scval_xdr_hex"))?;
                let raw = hex::decode(s.trim_start_matches("0x"))
                    .map_err(|e| invalid_arg(format!("Invalid hex in scval_xdr_hex: {}", e)))?;
                xdr::ScVal::from_xdr(&raw, Limits::none())
                    .map_err(|e| invalid_arg(format!("Invalid ScVal XDR: {}", e)))?;
                let b = Bytes::from_slice(&self.env, &raw);
                <Val as soroban_sdk::xdr::FromXdr>::from_xdr(&self.env, &b)
                    .map_err(|e| invalid_arg(format!("Failed decoding ScVal into Val: {:?}", e)))
            }
            other => Err(invalid_arg(format!("Unsupported TypedArg type: {}", other))),
        }
    }

    fn encode_args(&self, args: &[TypedArg]) -> Result<std::vec::Vec<Val>, ErrorPayload> {
        let mut out = std::vec::Vec::with_capacity(args.len());
        for a in args {
            out.push(self.encode_arg(a)?);
        }
        Ok(out)
    }

    fn val_to_xdr(&self, val: Val) -> Result<xdr::ScVal, ErrorPayload> {
        xdr::ScVal::try_from_val(&self.env, &val)
            .map_err(|e| invalid_arg(format!("Failed converting Val to ScVal: {:?}", e)))
    }

    fn vals_to_xdr(&self, vals: &[Val]) -> Result<std::vec::Vec<xdr::ScVal>, ErrorPayload> {
        let mut out = std::vec::Vec::with_capacity(vals.len());
        for v in vals {
            out.push(self.val_to_xdr(*v)?);
        }
        Ok(out)
    }

    fn build_mock_invocation(
        &self,
        spec: &MockAuthInvokeSpec,
    ) -> Result<xdr::SorobanAuthorizedInvocation, ErrorPayload> {
        let contract = self.resolve_address(&spec.contract)?;
        let sc_contract: xdr::ScAddress = (&contract)
            .try_into()
            .map_err(|_| invalid_arg("Failed converting contract Address to ScAddress"))?;
        let args = self.encode_args(&spec.args)?;
        let sc_args = self.vals_to_xdr(&args)?;
        let mut subs = Vec::with_capacity(spec.sub_invokes.len());
        for sub in &spec.sub_invokes {
            subs.push(self.build_mock_invocation(sub)?);
        }
        Ok(xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: sc_contract,
                function_name: spec
                    .fn_name
                    .as_str()
                    .try_into()
                    .map_err(|_| invalid_arg(format!("Invalid fn_name: {}", spec.fn_name)))?,
                args: sc_args
                    .try_into()
                    .map_err(|_| invalid_arg("Too many args in MockAuthInvokeSpec"))?,
            }),
            sub_invocations: subs
                .try_into()
                .map_err(|_| invalid_arg("Too many sub_invokes in MockAuthInvokeSpec"))?,
        })
    }

    fn apply_auth_override(&mut self, auth: &AuthOverride) -> Result<(), ErrorPayload> {
        match auth {
            AuthOverride::Mode(m) => {
                apply_auth_mode(&self.env, m);
                Ok(())
            }
            AuthOverride::Signers { signers } => {
                let curr_ledger = self.env.ledger().sequence();
                let max_ttl = self.env.storage().max_ttl();
                let mut resolved = std::vec::Vec::with_capacity(signers.len());
                for s in signers {
                    let addr = self.resolve_address(&s.address)?;
                    let addr_str = addr.to_string().to_string();
                    match stellar_strkey::Strkey::from_string(&addr_str) {
                        Ok(stellar_strkey::Strkey::Contract(_)) => {}
                        Ok(stellar_strkey::Strkey::PublicKeyEd25519(_)) => {
                            return Err(invalid_arg(
                                "AuthOverride::Signers requires a C... address from gen_address; G... accounts cannot use MockAuthContract signatures",
                            ));
                        }
                        _ => {
                            return Err(invalid_arg(format!(
                                "Unsupported signer address in AuthOverride::Signers: {}",
                                addr_str
                            )));
                        }
                    }
                    let sc_addr: xdr::ScAddress = (&addr)
                        .try_into()
                        .map_err(|_| invalid_arg("Failed converting signer Address to ScAddress"))?;
                    let root_invocation = self.build_mock_invocation(&s.invoke)?;
                    resolved.push((addr, sc_addr, root_invocation));
                }

                let mut entries = std::vec::Vec::with_capacity(resolved.len());
                for (addr, sc_addr, root_invocation) in resolved {
                    // Only register MockAuthContract if no contract instance already exists at addr
                    let inst_key = Rc::new(xdr::LedgerKey::ContractData(xdr::LedgerKeyContractData {
                        contract: sc_addr.clone(),
                        key: xdr::ScVal::LedgerKeyContractInstance,
                        durability: xdr::ContractDataDurability::Persistent,
                    }));
                    if self
                        .env
                        .host()
                        .get_ledger_entry(&inst_key)
                        .map_err(|e| invalid_arg(format!("Ledger check failed: {:?}", e)))?
                        .is_none()
                    {
                        self.env.register_at(&addr, MockAuthContract, ());
                    }

                    let nonce = self.auth_nonce;
                    self.auth_nonce += 1;
                    entries.push(xdr::SorobanAuthorizationEntry {
                        root_invocation,
                        credentials: xdr::SorobanCredentials::Address(
                            xdr::SorobanAddressCredentials {
                                address: sc_addr,
                                nonce,
                                signature_expiration_ledger: curr_ledger.saturating_add(max_ttl),
                                signature: xdr::ScVal::Void,
                            },
                        ),
                    });
                }
                self.env.set_auths(&entries);
                Ok(())
            }
        }
    }

    fn invoke_contract_raw(
        &self,
        contract: &Address,
        method: &str,
        vals: &[Val],
    ) -> Result<xdr::ScVal, ErrorPayload> {
        apply_budget_mode(&self.env, &self.budget_mode);
        let sc_args = self.vals_to_xdr(vals)?;
        let sc_addr: xdr::ScAddress = contract
            .try_into()
            .map_err(|_| invalid_arg("Failed converting contract Address to ScAddress"))?;
        let fn_sym: xdr::ScSymbol = method
            .try_into()
            .map_err(|_| invalid_arg(format!("Invalid contract method symbol: {}", method)))?;
        let hf = xdr::HostFunction::InvokeContract(xdr::InvokeContractArgs {
            contract_address: sc_addr,
            function_name: fn_sym,
            args: sc_args
                .try_into()
                .map_err(|_| invalid_arg("Too many invoke arguments"))?,
        });

        match self.env.host().invoke_function(hf) {
            Ok(sc_val) => Ok(sc_val),
            Err(host_err) => Err(classify_sc_host_error(
                &host_err.error,
                format!("{:?}", host_err),
            )),
        }
    }

    fn create_account_entry(&mut self, balance: i64) -> (xdr::AccountId, String) {
        let idx = self.account_seq;
        self.account_seq += 1;
        let mut pk = [0u8; 32];
        pk[0..8].copy_from_slice(b"E2EACCT\0");
        pk[24..32].copy_from_slice(&idx.to_be_bytes());
        let account_id =
            xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(pk)));
        let strkey =
            stellar_strkey::Strkey::PublicKeyEd25519(stellar_strkey::ed25519::PublicKey(pk))
                .to_string()
                .as_str()
                .to_string();

        let key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
            account_id: account_id.clone(),
        }));
        if self.env.host().get_ledger_entry(&key).unwrap().is_none() {
            let entry = Rc::new(xdr::LedgerEntry {
                data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
                    account_id: account_id.clone(),
                    balance,
                    flags: 0,
                    home_domain: Default::default(),
                    inflation_dest: None,
                    num_sub_entries: 0,
                    seq_num: xdr::SequenceNumber(0),
                    thresholds: xdr::Thresholds([1; 4]),
                    signers: xdr::VecM::default(),
                    ext: xdr::AccountEntryExt::V0,
                }),
                last_modified_ledger_seq: 0,
                ext: xdr::LedgerEntryExt::V0,
            });
            self.env.host().add_ledger_entry(&key, &entry, None).unwrap();
        }
        (account_id, strkey)
    }

    fn sc_address_to_string(addr: &xdr::ScAddress) -> String {
        match addr {
            xdr::ScAddress::Contract(xdr::ContractId(xdr::Hash(bytes))) => {
                stellar_strkey::Strkey::Contract(stellar_strkey::Contract(*bytes))
                    .to_string()
                    .as_str()
                    .to_string()
            }
            xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
                xdr::Uint256(bytes),
            ))) => stellar_strkey::Strkey::PublicKeyEd25519(
                stellar_strkey::ed25519::PublicKey(*bytes),
            )
            .to_string()
            .as_str()
            .to_string(),
            other => format!("{:?}", other),
        }
    }

    fn scval_to_json(val: &xdr::ScVal) -> JsonValue {
        match val {
            xdr::ScVal::Void => JsonValue::Null,
            xdr::ScVal::Bool(b) => JsonValue::Bool(*b),
            xdr::ScVal::Error(e) => {
                let mut m = JsonMap::new();
                m.insert("error".to_string(), JsonValue::String(format!("{:?}", e)));
                JsonValue::Object(m)
            }
            xdr::ScVal::U32(n) => JsonValue::Number((*n).into()),
            xdr::ScVal::I32(n) => JsonValue::Number((*n).into()),
            xdr::ScVal::U64(n) => JsonValue::String(n.to_string()),
            xdr::ScVal::I64(n) => JsonValue::String(n.to_string()),
            xdr::ScVal::Timepoint(t) => JsonValue::String(t.0.to_string()),
            xdr::ScVal::Duration(d) => JsonValue::String(d.0.to_string()),
            xdr::ScVal::U128(parts) => {
                let v = ((parts.hi as u128) << 64) | (parts.lo as u128);
                JsonValue::String(v.to_string())
            }
            xdr::ScVal::I128(parts) => {
                let v = ((parts.hi as i128) << 64) | (parts.lo as i128);
                JsonValue::String(v.to_string())
            }
            xdr::ScVal::U256(parts) => JsonValue::String(format!(
                "0x{:016x}{:016x}{:016x}{:016x}",
                parts.hi_hi, parts.hi_lo, parts.lo_hi, parts.lo_lo
            )),
            xdr::ScVal::I256(parts) => JsonValue::String(format!(
                "0x{:016x}{:016x}{:016x}{:016x}",
                parts.hi_hi as u64, parts.hi_lo, parts.lo_hi, parts.lo_lo
            )),
            xdr::ScVal::Bytes(b) => JsonValue::String(hex::encode(b.as_slice())),
            xdr::ScVal::String(s) => {
                JsonValue::String(String::from_utf8_lossy(s.as_slice()).into_owned())
            }
            xdr::ScVal::Symbol(s) => {
                JsonValue::String(String::from_utf8_lossy(s.as_slice()).into_owned())
            }
            xdr::ScVal::Vec(Some(v)) => {
                JsonValue::Array(v.iter().map(Self::scval_to_json).collect())
            }
            xdr::ScVal::Vec(None) => JsonValue::Array(std::vec::Vec::new()),
            xdr::ScVal::Map(Some(m)) => {
                let all_string_keys = m
                    .iter()
                    .all(|entry| matches!(entry.key, xdr::ScVal::Symbol(_) | xdr::ScVal::String(_)));
                if all_string_keys {
                    let mut obj = JsonMap::new();
                    for entry in m.iter() {
                        let k = match &entry.key {
                            xdr::ScVal::Symbol(s) => {
                                String::from_utf8_lossy(s.as_slice()).into_owned()
                            }
                            xdr::ScVal::String(s) => {
                                String::from_utf8_lossy(s.as_slice()).into_owned()
                            }
                            _ => unreachable!(),
                        };
                        obj.insert(k, Self::scval_to_json(&entry.val));
                    }
                    JsonValue::Object(obj)
                } else {
                    JsonValue::Array(
                        m.iter()
                            .map(|entry| {
                                JsonValue::Array(std::vec![
                                    Self::scval_to_json(&entry.key),
                                    Self::scval_to_json(&entry.val)
                                ])
                            })
                            .collect(),
                    )
                }
            }
            xdr::ScVal::Map(None) => JsonValue::Object(JsonMap::new()),
            xdr::ScVal::Address(addr) => JsonValue::String(Self::sc_address_to_string(addr)),
            other => JsonValue::String(format!("{:?}", other)),
        }
    }

    fn authorized_invocation_to_json(&self, inv: &AuthorizedInvocation) -> JsonValue {
        let mut obj = JsonMap::new();
        let fn_json = match &inv.function {
            AuthorizedFunction::Contract((addr, fn_sym, args)) => {
                let mut f = JsonMap::new();
                f.insert("type".to_string(), JsonValue::String("contract".to_string()));
                f.insert(
                    "contract".to_string(),
                    JsonValue::String(addr.to_string().to_string()),
                );
                let sym_sc = xdr::ScVal::try_from_val(&self.env, &fn_sym.to_val())
                    .map(|v| Self::scval_to_json(&v))
                    .unwrap_or(JsonValue::String("".to_string()));
                f.insert("fn_name".to_string(), sym_sc);
                let mut decoded_args = std::vec::Vec::with_capacity(args.len() as usize);
                for v in args.iter() {
                    if let Ok(sc) = xdr::ScVal::try_from_val(&self.env, &v) {
                        decoded_args.push(Self::scval_to_json(&sc));
                    }
                }
                f.insert("args".to_string(), JsonValue::Array(decoded_args));
                JsonValue::Object(f)
            }
            AuthorizedFunction::CreateContractHostFn(c) => {
                let mut f = JsonMap::new();
                f.insert(
                    "type".to_string(),
                    JsonValue::String("create_contract".to_string()),
                );
                f.insert("detail".to_string(), JsonValue::String(format!("{:?}", c)));
                JsonValue::Object(f)
            }
            AuthorizedFunction::CreateContractV2HostFn(c) => {
                let mut f = JsonMap::new();
                f.insert(
                    "type".to_string(),
                    JsonValue::String("create_contract_v2".to_string()),
                );
                f.insert("detail".to_string(), JsonValue::String(format!("{:?}", c)));
                JsonValue::Object(f)
            }
        };
        obj.insert("function".to_string(), fn_json);
        obj.insert(
            "sub_invocations".to_string(),
            JsonValue::Array(
                inv.sub_invocations
                    .iter()
                    .map(|s| self.authorized_invocation_to_json(s))
                    .collect(),
            ),
        );
        JsonValue::Object(obj)
    }

    pub fn execute(&mut self, envelope: RequestEnvelope) -> Response {
        let id = envelope.id.clone();
        let res = catch_unwind(AssertUnwindSafe(|| self.execute_inner(envelope.command)));
        match res {
            Ok(Ok(data)) => Response::success(id, data),
            Ok(Err(err)) => Response::err(id, err),
            Err(panic_payload) => {
                let msg = if let Some(s) = panic_payload.downcast_ref::<&str>() {
                    (*s).to_string()
                } else if let Some(s) = panic_payload.downcast_ref::<String>() {
                    s.clone()
                } else {
                    "Unknown panic inside soroban_runner".to_string()
                };
                Response::err(
                    id,
                    ErrorPayload {
                        kind: "RunnerPanic".to_string(),
                        code: None,
                        name: None,
                        sc_error_type: None,
                        sc_error_code: None,
                        message: msg,
                    },
                )
            }
        }
    }

    fn execute_inner(&mut self, cmd: Command) -> Result<JsonValue, ErrorPayload> {
        match cmd {
            Command::InitEnv {
                timestamp,
                sequence,
                auth_mode,
                budget_mode,
            }
            | Command::Reset {
                timestamp,
                sequence,
                auth_mode,
                budget_mode,
            } => {
                let mode = auth_mode.unwrap_or(AuthMode::MockAll);
                let b_mode = budget_mode.unwrap_or(BudgetMode::Unlimited);
                self.auth_mode = mode.clone();
                self.budget_mode = b_mode.clone();
                self.vars.clear();
                self.account_seq = 1;
                self.auth_nonce = 1;
                self.env = new_env(timestamp, sequence, &mode, &b_mode);
                let mut obj = JsonMap::new();
                obj.insert(
                    "timestamp".to_string(),
                    JsonValue::String(self.env.ledger().timestamp().to_string()),
                );
                obj.insert(
                    "sequence".to_string(),
                    JsonValue::Number(self.env.ledger().sequence().into()),
                );
                Ok(JsonValue::Object(obj))
            }
            Command::SetLedger {
                timestamp,
                sequence,
            } => {
                if let Some(ts) = timestamp {
                    self.env.ledger().set_timestamp(ts);
                }
                if let Some(seq) = sequence {
                    self.env.ledger().set_sequence_number(seq);
                }
                let mut obj = JsonMap::new();
                obj.insert(
                    "timestamp".to_string(),
                    JsonValue::String(self.env.ledger().timestamp().to_string()),
                );
                obj.insert(
                    "sequence".to_string(),
                    JsonValue::Number(self.env.ledger().sequence().into()),
                );
                Ok(JsonValue::Object(obj))
            }
            Command::GetLedger => {
                let mut obj = JsonMap::new();
                obj.insert(
                    "timestamp".to_string(),
                    JsonValue::String(self.env.ledger().timestamp().to_string()),
                );
                obj.insert(
                    "sequence".to_string(),
                    JsonValue::Number(self.env.ledger().sequence().into()),
                );
                Ok(JsonValue::Object(obj))
            }
            Command::SetAuthMode { mode } => {
                self.auth_mode = mode.clone();
                apply_auth_mode(&self.env, &mode);
                Ok(serde_json::to_value(&mode).unwrap())
            }
            Command::SetBudget { mode } => {
                self.budget_mode = mode.clone();
                apply_budget_mode(&self.env, &mode);
                Ok(serde_json::to_value(&mode).unwrap())
            }
            Command::GenAddress { name } => {
                let addr = Address::generate(&self.env);
                let strkey = addr.to_string().to_string();
                if let Some(var_name) = name {
                    self.vars.insert(var_name, strkey.clone());
                }
                Ok(JsonValue::String(strkey))
            }
            Command::GenAccount {
                name,
                native_balance,
            } => {
                let bal = match native_balance {
                    Some(raw) => raw
                        .trim()
                        .parse::<i64>()
                        .map_err(|_| invalid_arg(format!("Invalid native_balance: {}", raw)))?,
                    None => 10_000_0000000i64,
                };
                let (_acct, strkey) = self.create_account_entry(bal);
                if let Some(var_name) = name {
                    self.vars.insert(var_name, strkey.clone());
                }
                Ok(JsonValue::String(strkey))
            }
            Command::CreateSac {
                symbol,
                admin,
                name,
            } => {
                let asset = if symbol == "native" {
                    xdr::Asset::Native
                } else {
                    let bytes = symbol.as_bytes();
                    if bytes.is_empty() || bytes.len() > 12 || !bytes.iter().all(|b| b.is_ascii_alphanumeric()) {
                        return Err(invalid_arg(format!(
                            "Invalid Stellar asset symbol (must be 'native' or 1-12 ASCII alphanumeric): {}",
                            symbol
                        )));
                    }
                    let (issuer_id, _) = self.create_account_entry(0);
                    if bytes.len() <= 4 {
                        let mut code = [0u8; 4];
                        code[..bytes.len()].copy_from_slice(bytes);
                        xdr::Asset::CreditAlphanum4(xdr::AlphaNum4 {
                            asset_code: xdr::AssetCode4(code),
                            issuer: issuer_id,
                        })
                    } else {
                        let mut code = [0u8; 12];
                        code[..bytes.len()].copy_from_slice(bytes);
                        xdr::Asset::CreditAlphanum12(xdr::AlphaNum12 {
                            asset_code: xdr::AssetCode12(code),
                            issuer: issuer_id,
                        })
                    }
                };

                let create = xdr::HostFunction::CreateContract(xdr::CreateContractArgs {
                    contract_id_preimage: xdr::ContractIdPreimage::Asset(asset),
                    executable: xdr::ContractExecutable::StellarAsset,
                });

                let token_sc = self.env.host().invoke_function(create).map_err(|he| {
                    classify_sc_host_error(&he.error, format!("{:?}", he))
                })?;

                let token_str = match &token_sc {
                    xdr::ScVal::Address(a) => Self::sc_address_to_string(a),
                    other => {
                        return Err(invalid_arg(format!(
                            "CreateContract did not return address: {:?}",
                            other
                        )))
                    }
                };
                let token_addr = Address::from_str(&self.env, &token_str);

                if symbol != "native" {
                    if let Some(admin_ref) = admin {
                        let admin_addr = self.resolve_address(&admin_ref)?;
                        let prev = self.env.host().snapshot_auth_manager().unwrap();
                        self.env.mock_all_auths();
                        let res = self.invoke_contract_raw(
                            &token_addr,
                            "set_admin",
                            &[admin_addr.into_val(&self.env)],
                        );
                        self.env.host().set_auth_manager(prev).unwrap();
                        res?;
                    }
                }

                if let Some(var_name) = name {
                    self.vars.insert(var_name, token_str.clone());
                }
                Ok(JsonValue::String(token_str))
            }
            Command::SacMint { token, to, amount } => {
                let token_addr = self.resolve_address(&token)?;
                let to_addr = self.resolve_address(&to)?;
                let amt = amount
                    .trim()
                    .parse::<i128>()
                    .map_err(|_| invalid_arg(format!("Invalid sac_mint amount: {}", amount)))?;
                let _ = self.invoke_contract_raw(
                    &token_addr,
                    "mint",
                    &[to_addr.into_val(&self.env), amt.into_val(&self.env)],
                )?;
                Ok(JsonValue::Null)
            }
            Command::UploadWasm { path, var_name } => {
                apply_budget_mode(&self.env, &self.budget_mode);
                let bytes = self.read_wasm_bytes(&path)?;
                let hash = self.env.deployer().upload_contract_wasm(bytes.as_slice());
                let hex_hash = hex::encode(hash.to_array());
                if let Some(var) = var_name {
                    self.vars.insert(var, hex_hash.clone());
                }
                Ok(JsonValue::String(hex_hash))
            }
            Command::DeployWasm {
                path,
                var_name,
                constructor_args,
            } => {
                apply_budget_mode(&self.env, &self.budget_mode);
                let bytes = self.read_wasm_bytes(&path)?;
                let vals = self.encode_args(&constructor_args)?;
                let mut vec_vals = SorobanVec::<Val>::new(&self.env);
                for v in vals {
                    vec_vals.push_back(v);
                }
                let addr = self.env.register(bytes.as_slice(), vec_vals);
                let strkey = addr.to_string().to_string();
                if let Some(var) = var_name {
                    self.vars.insert(var, strkey.clone());
                }
                Ok(JsonValue::String(strkey))
            }
            Command::Invoke {
                contract,
                method,
                args,
                auth,
                save_as,
            } => {
                let contract_addr = self.resolve_address(&contract)?;
                let vals = self.encode_args(&args)?;
                if let Some(ref auth_override) = auth {
                    self.apply_auth_override(auth_override)?;
                }
                let res = self.invoke_contract_raw(&contract_addr, &method, &vals);
                if auth.is_some() {
                    apply_auth_mode(&self.env, &self.auth_mode);
                }
                let sc_val = res?;
                let json = Self::scval_to_json(&sc_val);
                if let Some(prefix) = save_as {
                    match &json {
                        JsonValue::String(s) => {
                            self.vars.insert(prefix, s.clone());
                        }
                        JsonValue::Object(map) => {
                            for (k, v) in map {
                                if let JsonValue::String(s) = v {
                                    self.vars.insert(format!("{}.{}", prefix, k), s.clone());
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(json)
            }
            Command::BurnAsHolder {
                token,
                holder,
                amount,
            } => {
                let token_addr = self.resolve_address(&token)?;
                let holder_addr = self.resolve_address(&holder)?;
                let amt = amount
                    .trim()
                    .parse::<i128>()
                    .map_err(|_| invalid_arg(format!("Invalid burn_as_holder amount: {}", amount)))?;

                let holder_str = holder_addr.to_string().to_string();
                let sc_val = match stellar_strkey::Strkey::from_string(&holder_str) {
                    Ok(stellar_strkey::Strkey::Contract(_)) => {
                        let holder_sc: xdr::ScAddress = (&holder_addr)
                            .try_into()
                            .map_err(|_| invalid_arg("Failed converting holder Address to ScAddress"))?;
                        let inst_key = Rc::new(xdr::LedgerKey::ContractData(xdr::LedgerKeyContractData {
                            contract: holder_sc,
                            key: xdr::ScVal::LedgerKeyContractInstance,
                            durability: xdr::ContractDataDurability::Persistent,
                        }));
                        if self
                            .env
                            .host()
                            .get_ledger_entry(&inst_key)
                            .map_err(|e| invalid_arg(format!("Ledger check failed: {:?}", e)))?
                            .is_none()
                        {
                            self.env.register_at(&holder_addr, MockAuthContract, ());
                        }

                        self.env.as_contract(&holder_addr, || {
                            self.invoke_contract_raw(
                                &token_addr,
                                "burn",
                                &[holder_addr.clone().into_val(&self.env), amt.into_val(&self.env)],
                            )
                        })?
                    }
                    Ok(stellar_strkey::Strkey::PublicKeyEd25519(_)) => {
                        let prev = self.env.host().snapshot_auth_manager().unwrap();
                        self.env.mock_all_auths();
                        let res = self.invoke_contract_raw(
                            &token_addr,
                            "burn",
                            &[holder_addr.clone().into_val(&self.env), amt.into_val(&self.env)],
                        );
                        self.env.host().set_auth_manager(prev).unwrap();
                        res?
                    }
                    _ => {
                        return Err(invalid_arg(format!(
                            "Unsupported holder address for burn_as_holder: {}",
                            holder_str
                        )));
                    }
                };
                Ok(Self::scval_to_json(&sc_val))
            }
            Command::GetEvents { contract } => {
                let filter_addr = match contract {
                    Some(c) => Some(self.resolve_address(&c)?.to_string().to_string()),
                    None => None,
                };
                let events = self
                    .env
                    .host()
                    .get_events()
                    .map_err(|e| invalid_arg(format!("Failed getting events: {:?}", e)))?;
                let mut out = std::vec::Vec::new();
                for host_ev in events.0 {
                    if host_ev.failed_call || host_ev.event.type_ != xdr::ContractEventType::Contract
                    {
                        continue;
                    }
                    let Some(ref cid) = host_ev.event.contract_id else {
                        continue;
                    };
                    let cid_str = stellar_strkey::Strkey::Contract(stellar_strkey::Contract(
                        cid.0.clone().into(),
                    ))
                    .to_string()
                    .as_str()
                    .to_string();
                    if let Some(ref f) = filter_addr {
                        if &cid_str != f {
                            continue;
                        }
                    }
                    let xdr::ContractEventBody::V0(v0) = host_ev.event.body;
                    let topics: std::vec::Vec<JsonValue> =
                        v0.topics.iter().map(Self::scval_to_json).collect();
                    let data = Self::scval_to_json(&v0.data);
                    let mut obj = JsonMap::new();
                    obj.insert("contract_id".to_string(), JsonValue::String(cid_str));
                    obj.insert("topics".to_string(), JsonValue::Array(topics));
                    obj.insert("data".to_string(), data);
                    out.push(JsonValue::Object(obj));
                }
                Ok(JsonValue::Array(out))
            }
            Command::GetAuths => {
                let auths = self.env.auths();
                let mut out = std::vec::Vec::with_capacity(auths.len());
                for (addr, inv) in auths {
                    let mut obj = JsonMap::new();
                    obj.insert(
                        "address".to_string(),
                        JsonValue::String(addr.to_string().to_string()),
                    );
                    obj.insert(
                        "invocation".to_string(),
                        self.authorized_invocation_to_json(&inv),
                    );
                    out.push(JsonValue::Object(obj));
                }
                Ok(JsonValue::Array(out))
            }
            Command::Batch {
                steps,
                stop_on_error,
            } => {
                let mut results = std::vec::Vec::with_capacity(steps.len());
                let mut all_ok = true;
                for step in steps {
                    let resp = self.execute(step);
                    let ok = resp.ok;
                    results.push(resp);
                    if !ok {
                        all_ok = false;
                        if stop_on_error {
                            break;
                        }
                    }
                }
                if all_ok {
                    Ok(serde_json::json!({ "results": results }))
                } else {
                    // Return batch failure carrying per-step results
                    let last_err = results
                        .iter()
                        .rev()
                        .find_map(|r| r.error.clone())
                        .unwrap_or_else(|| invalid_arg("Batch step failed"));
                    Err(ErrorPayload {
                        kind: last_err.kind,
                        code: last_err.code,
                        name: last_err.name,
                        sc_error_type: last_err.sc_error_type,
                        sc_error_code: last_err.sc_error_code,
                        message: serde_json::to_string(&results).unwrap_or(last_err.message),
                    })
                }
            }
        }
    }
}

fn default_wasm_dir() -> PathBuf {
    let candidates = [
        PathBuf::from("target/wasm32v1-none/release"),
        PathBuf::from("../target/wasm32v1-none/release"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm32v1-none/release"),
    ];
    for c in candidates {
        if c.is_dir() {
            return c.canonicalize().unwrap_or(c);
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm32v1-none/release")
}

fn main() {
    let args: std::vec::Vec<String> = std::env::args().collect();
    let mut oneshot = false;
    let mut wasm_dir: Option<PathBuf> = None;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--oneshot" | "--once" => oneshot = true,
            "--ndjson" => oneshot = false,
            "--wasm-dir" => {
                i += 1;
                if i < args.len() {
                    wasm_dir = Some(PathBuf::from(&args[i]));
                }
            }
            _ => {}
        }
        i += 1;
    }

    let resolved_wasm_dir = wasm_dir.unwrap_or_else(default_wasm_dir);
    let mut session = SessionState::new(resolved_wasm_dir);

    if oneshot {
        let mut buf = String::new();
        if let Err(e) = io::stdin().read_to_string(&mut buf) {
            let resp = Response::err(None, invalid_arg(format!("Failed reading stdin: {}", e)));
            println!("{}", serde_json::to_string(&resp).unwrap());
            return;
        }
        let resp = match serde_json::from_str::<RequestEnvelope>(&buf) {
            Ok(env_req) => session.execute(env_req),
            Err(e) => Response::err(None, invalid_arg(format!("Invalid JSON request: {}", e))),
        };
        println!("{}", serde_json::to_string(&resp).unwrap());
        return;
    }

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line_res in stdin.lock().lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(e) => {
                let resp = Response::err(None, invalid_arg(format!("Stdin read error: {}", e)));
                let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
                let _ = out.flush();
                break;
            }
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let id_hint = serde_json::from_str::<JsonValue>(trimmed)
            .ok()
            .and_then(|v| v.get("id").cloned());

        let resp = match serde_json::from_str::<RequestEnvelope>(trimmed) {
            Ok(env_req) => session.execute(env_req),
            Err(e) => Response::err(id_hint, invalid_arg(format!("Invalid JSON request: {}", e))),
        };
        if writeln!(out, "{}", serde_json::to_string(&resp).unwrap()).is_err() {
            break;
        }
        if out.flush().is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::xdr::ToXdr;

    fn repo_wasm_dir() -> PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/wasm32v1-none/release")
    }

    fn exec_json(session: &mut SessionState, val: JsonValue) -> Response {
        let req: RequestEnvelope = serde_json::from_value(val).expect("valid test request");
        session.execute(req)
    }

    #[test]
    fn test_wasm_lifecycle_metadata_errors_and_xdr() {
        let wasm_dir = repo_wasm_dir();
        assert!(
            wasm_dir.join("market_factory.wasm").is_file(),
            "release WASMs must be built in {}",
            wasm_dir.display()
        );

        let mut session = SessionState::new(wasm_dir);

        // 1. init_env + id echo + gen_address + gen_account
        let r = exec_json(
            &mut session,
            serde_json::json!({ "id": 1, "cmd": "init_env", "timestamp": 1700000000u64, "sequence": 100u32 }),
        );
        assert!(r.ok, "init_env failed: {:?}", r.error);
        assert_eq!(r.id, Some(serde_json::json!(1)));

        let r_admin = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "gen_address", "name": "admin" }),
        );
        assert!(r_admin.ok);
        let admin_str = r_admin.data.unwrap().as_str().unwrap().to_string();
        assert!(admin_str.starts_with('C'));

        let r_user = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "gen_address", "name": "user" }),
        );
        assert!(r_user.ok);

        let r_acct = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "gen_account", "name": "acct1" }),
        );
        assert!(r_acct.ok);
        assert!(r_acct.data.unwrap().as_str().unwrap().starts_with('G'));

        // 2. create_sac "USDC" and "native"
        let r_usdc = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "create_sac", "symbol": "USDC", "admin": "$admin", "name": "usdc" }),
        );
        assert!(r_usdc.ok, "create_sac USDC failed: {:?}", r_usdc.error);

        let r_native = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "create_sac", "symbol": "native", "name": "native_xlm" }),
        );
        assert!(r_native.ok, "create_sac native failed: {:?}", r_native.error);

        let sym_usdc = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$usdc", "method": "symbol" }),
        );
        assert_eq!(sym_usdc.data.unwrap(), serde_json::json!("USDC"));

        let sym_native = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$native_xlm", "method": "symbol" }),
        );
        assert_eq!(sym_native.data.unwrap(), serde_json::json!("native"));

        // 3. sac_mint + burn_as_holder
        let r_mint = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "sac_mint", "token": "$usdc", "to": "$user", "amount": "5000000000" }),
        );
        assert!(r_mint.ok, "sac_mint failed: {:?}", r_mint.error);

        let r_burn = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "burn_as_holder", "token": "$usdc", "holder": "$user", "amount": "1000000000" }),
        );
        assert!(r_burn.ok, "burn_as_holder failed: {:?}", r_burn.error);

        let r_bal = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$usdc",
                "method": "balance",
                "args": [{ "type": "address", "value": "$user" }]
            }),
        );
        assert_eq!(r_bal.data.unwrap(), serde_json::json!("4000000000"));

        // 4. MissingWasm
        let r_missing_wasm = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "upload_wasm", "path": "does_not_exist.wasm" }),
        );
        assert!(!r_missing_wasm.ok);
        assert_eq!(r_missing_wasm.error.unwrap().kind, "MissingWasm");

        // 5. upload_wasm + deploy_wasm (market_factory, sy_blend_wrapper, pt_token)
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "upload_wasm", "path": "pt_token.wasm", "var_name": "pt_hash" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "upload_wasm", "path": "yt_token.wasm", "var_name": "yt_hash" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "upload_wasm", "path": "yield_pool.wasm", "var_name": "pool_hash" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "upload_wasm", "path": "sy_blend_wrapper.wasm", "var_name": "sy_hash" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "market_factory.wasm", "var_name": "factory" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "mock_blend.wasm", "var_name": "blend" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "sy_blend_wrapper.wasm", "var_name": "sy" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "pt_token.wasm", "var_name": "pt" })
        ).ok);

        // 6. MissingMethod on real market_factory.wasm
        let r_missing_method = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$factory", "method": "no_such_method_xyz" }),
        );
        assert!(!r_missing_method.ok);
        assert_eq!(
            r_missing_method.error.as_ref().unwrap().kind,
            "MissingMethod",
            "Expected MissingMethod, got {:?}",
            r_missing_method.error
        );

        // 7. ContractError numeric code on uninitialized market_factory / pt_token
        let r_contract_err = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "mint",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "i128", "value": "100" }
                ]
            }),
        );
        assert!(!r_contract_err.ok);
        let ce = r_contract_err.error.unwrap();
        assert_eq!(ce.kind, "ContractError");
        assert_eq!(ce.code, Some(1));
        assert_eq!(ce.name.as_deref(), Some("NotInitialized"));

        // 8. Initialize market_factory + sy_blend_wrapper + pt_token + verify AuthError with auth="none"
        let r_init_factory = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "bytes_n32", "value": "$pt_hash" },
                    { "type": "bytes_n32", "value": "$yt_hash" },
                    { "type": "bytes_n32", "value": "$pool_hash" },
                    { "type": "bytes_n32", "value": "$sy_hash" }
                ]
            }),
        );
        assert!(r_init_factory.ok, "factory initialize failed: {:?}", r_init_factory.error);

        // AuthError when calling pause(admin) with auth="none"
        let r_auth_err = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "pause",
                "args": [{ "type": "address", "value": "$admin" }],
                "auth": "none"
            }),
        );
        assert!(!r_auth_err.ok);
        assert_eq!(
            r_auth_err.error.as_ref().unwrap().kind,
            "AuthError",
            "Expected AuthError, got {:?}",
            r_auth_err.error
        );

        // Initialize sy_blend_wrapper with USDC and check dynamic symbol
        let r_init_sy = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "address", "value": "$blend" }
                ]
            }),
        );
        assert!(r_init_sy.ok, "sy initialize failed: {:?}", r_init_sy.error);

        let r_sy_sym = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$sy", "method": "symbol" }),
        );
        assert!(r_sy_sym.ok);
        assert_eq!(r_sy_sym.data.unwrap(), serde_json::json!("sy-bUSDC"));

        // 9. scval_xdr_hex arg decoding check
        let sample_amt: i128 = 1234567;
        let xdr_bytes = sample_amt.to_xdr(&session.env);
        let mut raw_vec = std::vec![0u8; xdr_bytes.len() as usize];
        xdr_bytes.copy_into_slice(&mut raw_vec);
        let xdr_hex = hex::encode(raw_vec);

        // Initialize pt_token and test mint with scval_xdr_hex amount
        let r_init_pt = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "string", "value": "PT Test" },
                    { "type": "string", "value": "PT-TEST" },
                    { "type": "u32", "value": 7 },
                    { "type": "u64", "value": "1800000000" }
                ]
            }),
        );
        assert!(r_init_pt.ok, "pt initialize failed: {:?}", r_init_pt.error);

        let r_mint_pt = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "mint",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "scval_xdr_hex", "value": xdr_hex }
                ]
            }),
        );
        assert!(r_mint_pt.ok, "pt mint with scval_xdr_hex failed: {:?}", r_mint_pt.error);

        // 10. get_events + get_auths (immediately after pt.mint)
        let r_ev = exec_json(&mut session, serde_json::json!({ "cmd": "get_events" }));
        assert!(r_ev.ok);
        assert!(
            !r_ev.data.unwrap().as_array().unwrap().is_empty(),
            "expected MintEvent from pt.mint"
        );

        let r_auths = exec_json(&mut session, serde_json::json!({ "cmd": "get_auths" }));
        assert!(r_auths.ok);
        assert!(!r_auths.data.unwrap().as_array().unwrap().is_empty());

        let r_pt_bal = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "balance",
                "args": [{ "type": "address", "value": "$user" }]
            }),
        );
        assert_eq!(r_pt_bal.data.unwrap(), serde_json::json!("1234567"));

        // 11. verify yield_pool.wasm deploys cleanly
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "yield_pool.wasm", "var_name": "pool" })
        ).ok);
    }

    #[test]
    fn test_ledger_batch_and_explicit_mock_auth_signers() {
        let wasm_dir = repo_wasm_dir();
        let mut session = SessionState::new(wasm_dir);

        let r_batch = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "batch",
                "steps": [
                    { "cmd": "init_env", "timestamp": 1700001000u64, "sequence": 42u32 },
                    { "cmd": "gen_address", "name": "admin" },
                    { "cmd": "gen_address", "name": "user" },
                    { "cmd": "create_sac", "symbol": "USDC", "admin": "$admin", "name": "usdc" },
                    { "cmd": "set_ledger", "timestamp": 1700002000u64, "sequence": 43u32 },
                    { "cmd": "get_ledger" }
                ]
            }),
        );
        assert!(r_batch.ok, "batch failed: {:?}", r_batch.error);
        let ledger = exec_json(&mut session, serde_json::json!({ "cmd": "get_ledger" }));
        assert_eq!(
            ledger.data.unwrap(),
            serde_json::json!({ "timestamp": "1700002000", "sequence": 43 })
        );

        // Explicit MockAuth signers test for sac_mint -> usdc.mint(user, 1000)
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "deploy_wasm", "path": "pt_token.wasm", "var_name": "pt" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "string", "value": "PT" },
                    { "type": "string", "value": "PT" },
                    { "type": "u32", "value": 7 },
                    { "type": "u64", "value": "1800000000" }
                ]
            }),
        ).ok);

        let r_explicit = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "mint",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "i128", "value": "500" }
                ],
                "auth": {
                    "signers": [{
                        "address": "$admin",
                        "invoke": {
                            "contract": "$pt",
                            "fn_name": "mint",
                            "args": [
                                { "type": "address", "value": "$user" },
                                { "type": "i128", "value": "500" }
                            ],
                            "sub_invokes": []
                        }
                    }]
                }
            }),
        );
        assert!(r_explicit.ok, "explicit mock_auths failed: {:?}", r_explicit.error);

        // Verify session auth mode was restored to mock_all after explicit auth override
        let r_after = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "mint",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "i128", "value": "250" }
                ]
            }),
        );
        assert!(r_after.ok, "session auth mode should be restored: {:?}", r_after.error);
    }

    #[test]
    fn test_sequential_mock_auth_same_sequence_and_deployed_contract_guard() {
        let wasm_dir = repo_wasm_dir();
        let mut session = SessionState::new(wasm_dir);

        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "init_env", "timestamp": 1700001000u64, "sequence": 77u32 })
        ).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "admin" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "user" })).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "create_sac", "symbol": "USDC", "admin": "$admin", "name": "usdc" })
        ).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "mock_blend.wasm", "var_name": "blend" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "sy_blend_wrapper.wasm", "var_name": "sy" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "pt_token.wasm", "var_name": "pt" })).ok);

        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$blend",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "i128", "value": "1000000000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "address", "value": "$blend" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "string", "value": "PT" },
                    { "type": "string", "value": "PT" },
                    { "type": "u32", "value": 7 },
                    { "type": "u64", "value": "1800000000" }
                ]
            })
        ).ok);

        // 1. Sequential strict MockAuth calls in the exact same ledger sequence (nonce must advance)
        for i in 1..=3 {
            let amt = format!("{}", i * 100);
            let r_seq = exec_json(
                &mut session,
                serde_json::json!({
                    "cmd": "invoke",
                    "contract": "$pt",
                    "method": "mint",
                    "args": [
                        { "type": "address", "value": "$user" },
                        { "type": "i128", "value": amt }
                    ],
                    "auth": {
                        "signers": [{
                            "address": "$admin",
                            "invoke": {
                                "contract": "$pt",
                                "fn_name": "mint",
                                "args": [
                                    { "type": "address", "value": "$user" },
                                    { "type": "i128", "value": amt }
                                ],
                                "sub_invokes": []
                            }
                        }]
                    }
                }),
            );
            assert!(r_seq.ok, "sequential strict MockAuth call #{} failed: {:?}", i, r_seq.error);
        }

        let r_bal = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "balance",
                "args": [{ "type": "address", "value": "$user" }]
            }),
        );
        assert_eq!(r_bal.data.unwrap(), serde_json::json!("600"));

        // 2. Passing an already-deployed contract ($sy) as a signer must NEVER overwrite $sy's WASM
        let _r_clobber_attempt = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$pt",
                "method": "balance",
                "args": [{ "type": "address", "value": "$user" }],
                "auth": {
                    "signers": [{
                        "address": "$sy",
                        "invoke": {
                            "contract": "$pt",
                            "fn_name": "balance",
                            "args": [{ "type": "address", "value": "$user" }],
                            "sub_invokes": []
                        }
                    }]
                }
            }),
        );
        let r_sy_sym = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$sy", "method": "symbol" }),
        );
        assert!(r_sy_sym.ok, "deployed $sy was clobbered: {:?}", r_sy_sym.error);
        assert_eq!(r_sy_sym.data.unwrap(), serde_json::json!("sy-bUSDC"));
    }

    #[test]
    fn test_g_account_burn_and_signer_handling_and_sac_error_label() {
        let wasm_dir = repo_wasm_dir();
        let mut session = SessionState::new(wasm_dir);

        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "init_env", "timestamp": 1700001000u64, "sequence": 10u32 })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "admin" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "c_holder" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_account", "name": "g_holder", "native_balance": "2000" })).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "create_sac", "symbol": "USDC", "admin": "$admin", "name": "usdc" })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "sac_mint", "token": "$usdc", "to": "$c_holder", "amount": "5000" })
        ).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "mock_blend.wasm", "var_name": "blend" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "sy_blend_wrapper.wasm", "var_name": "sy" })).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$blend",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "i128", "value": "1000000000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "address", "value": "$blend" }
                ]
            })
        ).ok);

        // Deposit into sy_blend_wrapper for C... and G... holders
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "deposit",
                "args": [
                    { "type": "address", "value": "$c_holder" },
                    { "type": "address", "value": "$c_holder" },
                    { "type": "i128", "value": "1000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "deposit",
                "args": [
                    { "type": "address", "value": "$c_holder" },
                    { "type": "address", "value": "$g_holder" },
                    { "type": "i128", "value": "1000" }
                ]
            })
        ).ok);

        // Burn holder-authorized SY balance from both C... and G... holders cleanly (no RunnerPanic)
        let r_burn_c = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "burn_as_holder", "token": "$sy", "holder": "$c_holder", "amount": "400" }),
        );
        assert!(r_burn_c.ok, "burn_as_holder C... failed: {:?}", r_burn_c.error);

        let r_burn_g = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "burn_as_holder", "token": "$sy", "holder": "$g_holder", "amount": "350" }),
        );
        assert!(r_burn_g.ok, "burn_as_holder G... failed: {:?}", r_burn_g.error);

        let bal_c = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$sy", "method": "balance", "args": [{ "type": "address", "value": "$c_holder" }] }),
        );
        assert_eq!(bal_c.data.unwrap(), serde_json::json!("600"));

        let bal_g = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$sy", "method": "balance", "args": [{ "type": "address", "value": "$g_holder" }] }),
        );
        assert_eq!(bal_g.data.unwrap(), serde_json::json!("650"));

        // AuthOverride::Signers with G... address returns clear InvalidArg
        let r_g_signer = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$sy",
                "method": "transfer",
                "args": [
                    { "type": "address", "value": "$g_holder" },
                    { "type": "address", "value": "$c_holder" },
                    { "type": "i128", "value": "100" }
                ],
                "auth": {
                    "signers": [{
                        "address": "$g_holder",
                        "invoke": {
                            "contract": "$sy",
                            "fn_name": "transfer",
                            "args": [
                                { "type": "address", "value": "$g_holder" },
                                { "type": "address", "value": "$c_holder" },
                                { "type": "i128", "value": "100" }
                            ],
                            "sub_invokes": []
                        }
                    }]
                }
            }),
        );
        assert!(!r_g_signer.ok);
        assert_eq!(r_g_signer.error.as_ref().unwrap().kind, "InvalidArg");

        // SAC missing trustline error on G... account must NOT be mislabeled MathOverflow
        let r_sac_err = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "sac_mint", "token": "$usdc", "to": "$g_holder", "amount": "1000" }),
        );
        assert!(!r_sac_err.ok);
        let sac_err = r_sac_err.error.unwrap();
        assert_eq!(sac_err.kind, "ContractError");
        assert_ne!(sac_err.name.as_deref(), Some("MathOverflow"));
    }

    #[test]
    fn test_budget_mode_unlimited_for_unsettled_rollover_and_default_switch() {
        let wasm_dir = repo_wasm_dir();
        let mut session = SessionState::new(wasm_dir);

        let t0: u64 = 1_700_000_000;
        let mat1: u64 = t0 + 30 * 86_400;
        let mat2: u64 = t0 + 90 * 86_400;

        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "init_env", "timestamp": t0, "sequence": 100u32 })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "admin" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "gen_address", "name": "user" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "create_sac", "symbol": "USDC", "admin": "$admin", "name": "usdc" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "sac_mint", "token": "$usdc", "to": "$user", "amount": "50000000000" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "sac_mint", "token": "$usdc", "to": "$admin", "amount": "50000000000" })).ok);

        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "upload_wasm", "path": "pt_token.wasm", "var_name": "pt_hash" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "upload_wasm", "path": "yt_token.wasm", "var_name": "yt_hash" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "upload_wasm", "path": "yield_pool.wasm", "var_name": "pool_hash" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "upload_wasm", "path": "sy_blend_wrapper.wasm", "var_name": "sy_hash" })).ok);

        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "mock_blend.wasm", "var_name": "blend" })).ok);
        assert!(exec_json(&mut session, serde_json::json!({ "cmd": "deploy_wasm", "path": "market_factory.wasm", "var_name": "factory" })).ok);

        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$blend",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "i128", "value": "1000000000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "initialize",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "bytes_n32", "value": "$pt_hash" },
                    { "type": "bytes_n32", "value": "$yt_hash" },
                    { "type": "bytes_n32", "value": "$pool_hash" },
                    { "type": "bytes_n32", "value": "$sy_hash" }
                ]
            })
        ).ok);

        let scalar_root = "10000000000000000000";
        let initial_anchor = "1100000000000000000";

        let r_m1 = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "create_market",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "address", "value": "$blend" },
                    { "type": "u64", "value": mat1.to_string() },
                    { "type": "i128", "value": scalar_root },
                    { "type": "i128", "value": initial_anchor }
                ],
                "save_as": "m1"
            }),
        );
        assert!(r_m1.ok, "create_market m1 failed: {:?}", r_m1.error);

        let r_m2 = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "create_market",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$usdc" },
                    { "type": "address", "value": "$blend" },
                    { "type": "u64", "value": mat2.to_string() },
                    { "type": "i128", "value": scalar_root },
                    { "type": "i128", "value": initial_anchor }
                ],
                "save_as": "m2"
            }),
        );
        assert!(r_m2.ok, "create_market m2 failed: {:?}", r_m2.error);

        // User deposits SY, mints PY on m1, and admin seeds m2 liquidity
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$m1.sy",
                "method": "deposit",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "address", "value": "$user" },
                    { "type": "i128", "value": "1000000000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$m1.pool",
                "method": "mint_py",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "address", "value": "$user" },
                    { "type": "i128", "value": "500000000" },
                    { "type": "u64", "value": (t0 + 1000).to_string() }
                ]
            })
        ).ok);

        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$m2.sy",
                "method": "deposit",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "i128", "value": "10000000000" }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$m2.pool",
                "method": "mint_py",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "i128", "value": "5000000000" },
                    { "type": "u64", "value": (t0 + 1000).to_string() }
                ]
            })
        ).ok);
        assert!(exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$m2.pool",
                "method": "add_liquidity",
                "args": [
                    { "type": "address", "value": "$admin" },
                    { "type": "address", "value": "$admin" },
                    { "type": "i128", "value": "5000000000" },
                    { "type": "i128", "value": "4500000000" },
                    { "type": "i128", "value": "1" }
                ]
            })
        ).ok);

        // Advance past m1 maturity WITHOUT calling m1.pool.settle_maturity()
        assert!(exec_json(
            &mut session,
            serde_json::json!({ "cmd": "set_ledger", "timestamp": mat1 + 10 })
        ).ok);

        // Un-settled multi-hop rollover_to_pt must succeed under default Unlimited budget mode
        let r_roll = exec_json(
            &mut session,
            serde_json::json!({
                "cmd": "invoke",
                "contract": "$factory",
                "method": "rollover_to_pt",
                "args": [
                    { "type": "address", "value": "$user" },
                    { "type": "address", "value": "$user" },
                    { "type": "address", "value": "$m1.pool" },
                    { "type": "address", "value": "$m2.pool" },
                    { "type": "i128", "value": "100000000" },
                    { "type": "i128", "value": "1" },
                    { "type": "u64", "value": (mat1 + 1000).to_string() }
                ]
            }),
        );
        assert!(r_roll.ok, "un-settled rollover_to_pt should succeed under Unlimited budget mode: {:?}", r_roll.error);

        // Verify set_budget("default") switches cleanly and normal single-hop calls still succeed
        let r_set_def = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "set_budget", "mode": "default" }),
        );
        assert!(r_set_def.ok);
        assert_eq!(r_set_def.data.unwrap(), serde_json::json!("default"));

        let r_count = exec_json(
            &mut session,
            serde_json::json!({ "cmd": "invoke", "contract": "$factory", "method": "market_count" }),
        );
        assert!(r_count.ok);
        assert_eq!(r_count.data.unwrap(), serde_json::json!(2));
    }
}

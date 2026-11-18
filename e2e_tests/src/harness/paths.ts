import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const HARNESS_DIR = import.meta.dir;
export const E2E_ROOT = resolve(HARNESS_DIR, "../..");
export const REPO_ROOT = resolve(E2E_ROOT, "..");

export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");
export const FRONTEND_DIR = join(REPO_ROOT, "frontend");
export const INDEXER_DIR = join(REPO_ROOT, "indexer");
export const AGENT_DIR = join(REPO_ROOT, "agent");
export const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

export const DEPLOYED_CONTRACTS_PATH = join(REPO_ROOT, "deployed_contracts.json");
export const CARGO_TOML_PATH = join(REPO_ROOT, "Cargo.toml");
export const TARGET_DIR = join(REPO_ROOT, "target");
export const WASM_RELEASE_DIR = join(TARGET_DIR, "wasm32v1-none", "release");

export const SOROBAN_RUNNER_DIR = join(E2E_ROOT, "soroban_runner");
export const SOROBAN_RUNNER_MANIFEST = join(SOROBAN_RUNNER_DIR, "Cargo.toml");
export const SOROBAN_RUNNER_BIN = join(
  SOROBAN_RUNNER_DIR,
  "target",
  "release",
  process.platform === "win32" ? "soroban_runner.exe" : "soroban_runner"
);

export const RUSTUP_BIN = "/Users/goktus/.rustup/toolchains/stable-aarch64-apple-darwin/bin";

export function buildRustupEnv(
  extra: Record<string, string | undefined> = {}
): Record<string, string> {
  const basePath = process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
  const path =
    basePath === RUSTUP_BIN || basePath.startsWith(`${RUSTUP_BIN}:`)
      ? basePath
      : `${RUSTUP_BIN}:${basePath}`;

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) {
      delete out[k];
    } else {
      out[k] = v;
    }
  }
  out.PATH = path;
  return out;
}

export const LOCKED_SHA256 = {
  "frontend/src/lib/indexer.ts":
    "db7e0e05b43cd379f00e419feb0ee5535828d2a1dff69cdf078dafd37ca8545c",
  "frontend/src/hooks/useEventIndexer.ts":
    "b97b562eb81a85a4a9512aa6f3331cff37caf1b5da8e0c875932866622123e4c",
} as const;

export const LOCKED_CONTRACT_KEYS = [
  "mock_blend",
  "sy_blend_wrapper",
  "pt_token",
  "yt_token",
  "yield_pool",
] as const;

export const EXPECTED_MCP_TOOLS = [
  "build_claim_and_redeem_xdr",
  "build_deposit_sy_xdr",
  "build_liquidity_xdr",
  "build_mint_py_xdr",
  "build_swap_xdr",
  "get_market_state",
  "get_portfolio",
  "quote_yield_strategy",
] as const;

export const EXPECTED_MCP_RESOURCES = [
  "stellar-pendle://deployment",
  "stellar-pendle://stellar-agent-ecosystem",
] as const;

export const CANONICAL_INDEXER_PORT = 8765;
export const CANONICAL_XLM_PRICE_USD = 0.12;

export const CANONICAL_XLM_90D = {
  id: "xlm-90d",
  factoryId: 3,
  maturity: 1801909056,
  poolId: "CAQ24DFWIZ4GHS6ES6DX236R5EYMMS3DF3BBZE63NKEDGRGO4B7IRTZ4",
  syId: "CAOUCLCZGM3WHGQ5S653WQHAMAMPP3UW4IC5VPUIW2XFVDAR3NFJ6B3W",
  ptId: "CCDD5IJCCNLAR2F5Y4663LFKKSQ32QMWGILFXY46E2SQ4SC3IKAZKRD3",
  ytId: "CC6VG5R454INCUWAS7K37H5H35Q4WNLH5Y72J4GLXRZ5R225XOFPD4ET",
  blendPoolId: "CAGWGDLWNSSQEYJEE45JEBXAKNJCIHLNUK26TLFFPIWG6PPXHOTJ6DCH",
} as const;

export const CANONICAL_USDC_MATURED = {
  id: "usdc-matured",
  factoryId: 4,
  maturity: 1794455723,
  poolId: "CASJWZ7LPCGL2QRVOQNXLH4NYX556XW5GB5BX73K6VC7M2L354DQOMH5",
  syId: "CCOOCS3PQPCKGUHQU2HELFUQ6Y7VRNKFMCJIAIG4S2FSUGTRSKYQLWP5",
  ptId: "CDO45MQP43VNVBF5QAU6ORKDVEV4D5RM2EUIBUVORGBUCGABT23JSKQW",
  ytId: "CDKFTNVVAVU5CSRX3V7GOJYS53MBF52MBRB26M2S4Y34JZWOH7YJQOBY",
  blendPoolId: "CC7Q7FZ5YLBP3EOH635VYRC4EZDVTXVOMYZVP55Q6YIUSIXVHCJXETK6",
} as const;

interface LockOwner {
  pid: number;
  startedAt: number;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means process exists under another user; ESRCH means dead
    return code === "EPERM";
  }
}

export async function withProcessLock<T>(
  lockName: string,
  fn: () => Promise<T>,
  timeoutMs = 180_000
): Promise<T> {
  const safeName = lockName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const lockDir = join(tmpdir(), `nivorafi-e2e-${safeName}.lock`);
  const ownerPath = join(lockDir, "owner.json");
  const deadline = Date.now() + timeoutMs;
  let firstEexistAt: number | null = null;

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        ownerPath,
        JSON.stringify({ pid: process.pid, startedAt: Date.now() } satisfies LockOwner),
        "utf8"
      );
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;

      const now = Date.now();
      if (firstEexistAt === null) firstEexistAt = now;

      let stale = false;
      if (existsSync(ownerPath)) {
        try {
          const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<LockOwner>;
          if (
            typeof parsed.pid !== "number" ||
            !isPidAlive(parsed.pid) ||
            typeof parsed.startedAt !== "number" ||
            now - parsed.startedAt > timeoutMs
          ) {
            stale = true;
          }
        } catch {
          if (now - firstEexistAt > 2_000) stale = true;
        }
      } else if (now - firstEexistAt > 2_000) {
        stale = true;
      }

      if (stale) {
        rmSync(lockDir, { recursive: true, force: true });
        firstEexistAt = null;
        continue;
      }

      if (now >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for process lock '${lockName}'`);
      }
      await Bun.sleep(100);
    }
  }

  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

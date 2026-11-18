import { existsSync } from "node:fs";
import {
  REPO_ROOT,
  SOROBAN_RUNNER_BIN,
  SOROBAN_RUNNER_MANIFEST,
  WASM_RELEASE_DIR,
  buildRustupEnv,
  withProcessLock,
} from "./paths.ts";

export type AuthMode = "mock_all" | "mock_non_root" | "none";
export type BudgetMode = "unlimited" | "default";

export interface MockAuthInvokeSpec {
  contract: string;
  fn_name: string;
  args?: TypedArg[];
  sub_invokes?: MockAuthInvokeSpec[];
}

export interface MockAuthSignerSpec {
  address: string;
  invoke: MockAuthInvokeSpec;
}

export type AuthOverride = AuthMode | { signers: MockAuthSignerSpec[] };

export type TypedArg =
  | { type: "void"; value?: null }
  | { type: "bool"; value: boolean }
  | { type: "u32"; value: number }
  | { type: "i32"; value: number }
  | { type: "u64"; value: number | string }
  | { type: "i64"; value: number | string }
  | { type: "u128"; value: string | number }
  | { type: "i128"; value: string | number }
  | { type: "symbol"; value: string }
  | { type: "string"; value: string }
  | { type: "address"; value: string }
  | { type: "bytes"; value: string }
  | { type: "bytes_n32"; value: string }
  | { type: "vec"; value: TypedArg[] }
  | { type: "option"; value: TypedArg | null }
  | { type: "map"; value: Record<string, TypedArg> }
  | { type: "scval_xdr_hex"; value: string };

export type SorobanCommand =
  | {
      id?: string | number;
      cmd: "init_env" | "reset";
      timestamp?: number;
      sequence?: number;
      auth_mode?: AuthMode;
      budget_mode?: BudgetMode;
    }
  | {
      id?: string | number;
      cmd: "set_ledger";
      timestamp?: number;
      sequence?: number;
    }
  | {
      id?: string | number;
      cmd: "get_ledger";
    }
  | {
      id?: string | number;
      cmd: "set_auth_mode";
      mode: AuthMode;
    }
  | {
      id?: string | number;
      cmd: "set_budget";
      mode: BudgetMode;
    }
  | {
      id?: string | number;
      cmd: "gen_address";
      name?: string;
    }
  | {
      id?: string | number;
      cmd: "gen_account";
      name?: string;
      native_balance?: string;
    }
  | {
      id?: string | number;
      cmd: "create_sac";
      symbol: string;
      admin?: string;
      name?: string;
    }
  | {
      id?: string | number;
      cmd: "sac_mint";
      token: string;
      to: string;
      amount: string;
    }
  | {
      id?: string | number;
      cmd: "upload_wasm";
      path: string;
      var_name?: string;
    }
  | {
      id?: string | number;
      cmd: "deploy_wasm";
      path: string;
      var_name?: string;
      constructor_args?: TypedArg[];
    }
  | {
      id?: string | number;
      cmd: "invoke";
      contract: string;
      method: string;
      args?: TypedArg[];
      auth?: AuthOverride;
      save_as?: string;
    }
  | {
      id?: string | number;
      cmd: "burn_as_holder";
      token: string;
      holder: string;
      amount: string;
    }
  | {
      id?: string | number;
      cmd: "get_events";
      contract?: string;
    }
  | {
      id?: string | number;
      cmd: "get_auths";
    }
  | {
      id?: string | number;
      cmd: "batch";
      steps: SorobanCommand[];
      stop_on_error?: boolean;
    };

export interface SorobanErrorPayload {
  kind:
    | "MissingWasm"
    | "MissingMethod"
    | "ContractError"
    | "AuthError"
    | "InvalidArg"
    | "InvokeError"
    | "RunnerPanic"
    | string;
  code?: number;
  name?: string;
  sc_error_type?: string;
  sc_error_code?: string;
  message: string;
}

export interface SorobanResponse<T = unknown> {
  id?: string | number;
  ok: boolean;
  error?: SorobanErrorPayload;
  data?: T;
}

export interface SorobanLedgerInfo {
  timestamp: string;
  sequence: number;
}

export interface SorobanEventRecord {
  contract_id: string;
  topics: unknown[];
  data: unknown;
}

export interface SorobanBuildResult {
  skipped: boolean;
  wasmDir: string;
  runnerBin: string;
}

let cachedBuildPromise: Promise<SorobanBuildResult> | null = null;

function decodeText(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

export async function ensureSorobanBuilt(opts?: {
  force?: boolean;
}): Promise<SorobanBuildResult> {
  if (!opts?.force && cachedBuildPromise) {
    return cachedBuildPromise;
  }

  const runBuild = async (): Promise<SorobanBuildResult> =>
    withProcessLock("soroban-build", async () => {
      if (process.env.SKIP_WASM_BUILD === "1" && !opts?.force) {
        if (!existsSync(SOROBAN_RUNNER_BIN)) {
          throw new Error(
            `SKIP_WASM_BUILD=1 is set, but soroban_runner binary is missing at ${SOROBAN_RUNNER_BIN}`
          );
        }
        if (!existsSync(WASM_RELEASE_DIR)) {
          throw new Error(
            `SKIP_WASM_BUILD=1 is set, but WASM release directory is missing at ${WASM_RELEASE_DIR}`
          );
        }
        return {
          skipped: true,
          wasmDir: WASM_RELEASE_DIR,
          runnerBin: SOROBAN_RUNNER_BIN,
        };
      }

      const env = buildRustupEnv();

      const wasmBuild = Bun.spawnSync(["stellar", "contract", "build", "--profile", "release"], {
        cwd: REPO_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (wasmBuild.exitCode !== 0) {
        throw new Error(
          `stellar contract build --profile release failed (exit ${wasmBuild.exitCode}):\n${decodeText(
            wasmBuild.stdout
          )}\n${decodeText(wasmBuild.stderr)}`
        );
      }

      const runnerBuild = Bun.spawnSync(
        ["cargo", "build", "--release", "--manifest-path", SOROBAN_RUNNER_MANIFEST],
        {
          cwd: REPO_ROOT,
          env,
          stdout: "pipe",
          stderr: "pipe",
        }
      );
      if (runnerBuild.exitCode !== 0) {
        throw new Error(
          `cargo build --release for soroban_runner failed (exit ${runnerBuild.exitCode}):\n${decodeText(
            runnerBuild.stdout
          )}\n${decodeText(runnerBuild.stderr)}`
        );
      }

      if (!existsSync(SOROBAN_RUNNER_BIN)) {
        throw new Error(`soroban_runner build completed, but binary missing at ${SOROBAN_RUNNER_BIN}`);
      }

      return {
        skipped: false,
        wasmDir: WASM_RELEASE_DIR,
        runnerBin: SOROBAN_RUNNER_BIN,
      };
    });

  if (opts?.force) {
    cachedBuildPromise = runBuild();
    return cachedBuildPromise;
  }

  cachedBuildPromise = runBuild().catch((err) => {
    cachedBuildPromise = null;
    throw err;
  });
  return cachedBuildPromise;
}

export class SorobanRunnerSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = "";
  private mutex: Promise<void> = Promise.resolve();
  private seqId = 1;
  private closed = false;
  private stderrChunks: string[] = [];

  private constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
    const stdout = proc.stdout;
    if (!stdout || typeof stdout === "number") {
      throw new Error("soroban_runner stdout is not a ReadableStream");
    }
    this.reader = stdout.getReader();

    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      void this.drainStderr(stderr);
    }

    process.once("exit", () => {
      try {
        if (!this.closed) {
          this.proc.kill("SIGKILL");
        }
      } catch {
        // Ignore cleanup failures at process exit
      }
    });
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const r = stream.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await r.read();
        if (done) break;
        if (value) this.stderrChunks.push(dec.decode(value, { stream: true }));
      }
    } catch {
      // Ignore stream close
    } finally {
      r.releaseLock();
    }
  }

  static async start(opts?: { wasmDir?: string }): Promise<SorobanRunnerSession> {
    const build = await ensureSorobanBuilt();
    const wasmDir = opts?.wasmDir ?? build.wasmDir;
    const proc = Bun.spawn([build.runnerBin, "--ndjson", "--wasm-dir", wasmDir], {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new SorobanRunnerSession(proc);
  }

  private async readLine(): Promise<string> {
    while (true) {
      const nlIdx = this.buffer.indexOf("\n");
      if (nlIdx !== -1) {
        const line = this.buffer.slice(0, nlIdx).trim();
        this.buffer = this.buffer.slice(nlIdx + 1);
        if (line.length > 0) return line;
        continue;
      }

      const { done, value } = await this.reader.read();
      if (done) {
        const rem = this.buffer.trim();
        this.buffer = "";
        if (rem.length > 0) return rem;
        const stderrText = this.stderrChunks.join("");
        throw new Error(
          `soroban_runner exited unexpectedly (exitCode=${this.proc.exitCode}): ${stderrText}`
        );
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((res) => {
      release = res;
    });
    return prev.then(fn).finally(release);
  }

  async send<T = unknown>(command: SorobanCommand): Promise<SorobanResponse<T>> {
    if (this.closed) {
      throw new Error("SorobanRunnerSession is already closed");
    }
    return this.withLock(async () => {
      const stdin = this.proc.stdin;
      if (!stdin || typeof stdin === "number") {
        throw new Error("soroban_runner stdin is not writable");
      }
      const id = command.id ?? this.seqId++;
      const payload = JSON.stringify({ ...command, id }) + "\n";
      stdin.write(payload);
      await stdin.flush();

      while (true) {
        const line = await this.readLine();
        const parsed = JSON.parse(line) as SorobanResponse<T>;
        if (parsed.id === undefined || parsed.id === id) {
          return parsed;
        }
      }
    });
  }

  async sendOrThrow<T = unknown>(command: SorobanCommand): Promise<T> {
    const resp = await this.send<T>(command);
    if (!resp.ok) {
      throw new Error(
        `soroban_runner ${command.cmd} failed (${resp.error?.kind ?? "Unknown"}` +
          `${resp.error?.code !== undefined ? ` #${resp.error.code}` : ""}` +
          `${resp.error?.name ? ` ${resp.error.name}` : ""}): ${resp.error?.message ?? "unknown error"}`
      );
    }
    return resp.data as T;
  }

  initEnv(opts?: {
    timestamp?: number;
    sequence?: number;
    auth_mode?: AuthMode;
    budget_mode?: BudgetMode;
  }) {
    return this.sendOrThrow<SorobanLedgerInfo>({ cmd: "init_env", ...opts });
  }

  reset(opts?: {
    timestamp?: number;
    sequence?: number;
    auth_mode?: AuthMode;
    budget_mode?: BudgetMode;
  }) {
    return this.sendOrThrow<SorobanLedgerInfo>({ cmd: "reset", ...opts });
  }

  setLedger(opts: { timestamp?: number; sequence?: number }) {
    return this.sendOrThrow<SorobanLedgerInfo>({ cmd: "set_ledger", ...opts });
  }

  getLedger() {
    return this.sendOrThrow<SorobanLedgerInfo>({ cmd: "get_ledger" });
  }

  setAuthMode(mode: AuthMode) {
    return this.sendOrThrow<string>({ cmd: "set_auth_mode", mode });
  }

  setBudget(mode: BudgetMode) {
    return this.sendOrThrow<BudgetMode>({ cmd: "set_budget", mode });
  }

  genAddress(name?: string) {
    return this.sendOrThrow<string>({ cmd: "gen_address", name });
  }

  genAccount(name?: string, native_balance?: string) {
    return this.sendOrThrow<string>({ cmd: "gen_account", name, native_balance });
  }

  createSac(symbol: string, opts?: { admin?: string; name?: string }) {
    return this.sendOrThrow<string>({ cmd: "create_sac", symbol, ...opts });
  }

  sacMint(token: string, to: string, amount: string | bigint | number) {
    return this.sendOrThrow<null>({ cmd: "sac_mint", token, to, amount: String(amount) });
  }

  uploadWasm(path: string, var_name?: string) {
    return this.sendOrThrow<string>({ cmd: "upload_wasm", path, var_name });
  }

  deployWasm(path: string, opts?: { var_name?: string; constructor_args?: TypedArg[] }) {
    return this.sendOrThrow<string>({ cmd: "deploy_wasm", path, ...opts });
  }

  invoke<T = unknown>(
    contract: string,
    method: string,
    args: TypedArg[] = [],
    opts?: { auth?: AuthOverride; save_as?: string }
  ): Promise<SorobanResponse<T>> {
    return this.send<T>({ cmd: "invoke", contract, method, args, ...opts });
  }

  burnAsHolder(token: string, holder: string, amount: string | bigint | number) {
    return this.send<null>({ cmd: "burn_as_holder", token, holder, amount: String(amount) });
  }

  getEvents(contract?: string) {
    return this.sendOrThrow<SorobanEventRecord[]>({ cmd: "get_events", contract });
  }

  getAuths() {
    return this.sendOrThrow<unknown[]>({ cmd: "get_auths" });
  }

  batch(steps: SorobanCommand[], stop_on_error = true) {
    return this.send<{ results: SorobanResponse[] }>({
      cmd: "batch",
      steps,
      stop_on_error,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const stdin = this.proc.stdin;
      if (stdin && typeof stdin !== "number") {
        await stdin.end();
      }
      const exited = await Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(1000).then(() => false),
      ]);
      if (!exited) {
        this.proc.kill("SIGKILL");
        await this.proc.exited;
      }
    } finally {
      try {
        this.reader.releaseLock();
      } catch {
        // Ignore
      }
    }
  }
}

export async function runSorobanOnce<T = unknown>(
  command: SorobanCommand,
  opts?: { wasmDir?: string }
): Promise<SorobanResponse<T>> {
  const build = await ensureSorobanBuilt();
  const wasmDir = opts?.wasmDir ?? build.wasmDir;
  const proc = Bun.spawn([build.runnerBin, "--oneshot", "--wasm-dir", wasmDir], {
    cwd: REPO_ROOT,
    stdin: new Response(JSON.stringify(command)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0 && stdoutText.trim() === "") {
    throw new Error(`soroban_runner --oneshot failed (exit ${exitCode}): ${stderrText}`);
  }
  return JSON.parse(stdoutText.trim()) as SorobanResponse<T>;
}

let sharedSession: SorobanRunnerSession | null = null;
let sharedSessionPromise: Promise<SorobanRunnerSession> | null = null;

export async function getSharedSorobanSession(): Promise<SorobanRunnerSession> {
  if (sharedSession) return sharedSession;
  if (!sharedSessionPromise) {
    sharedSessionPromise = SorobanRunnerSession.start()
      .then((s) => {
        sharedSession = s;
        return s;
      })
      .catch((err) => {
        sharedSessionPromise = null;
        throw err;
      });
  }
  return sharedSessionPromise;
}

export async function runSorobanCommand<T = unknown>(
  command: SorobanCommand
): Promise<SorobanResponse<T>> {
  const session = await getSharedSorobanSession();
  return session.send<T>(command);
}

export async function closeSharedSorobanSession(): Promise<void> {
  const current = sharedSession;
  sharedSession = null;
  sharedSessionPromise = null;
  if (current) {
    await current.close();
  }
}

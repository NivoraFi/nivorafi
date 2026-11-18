import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecodedEvent, EventStorage } from "../../../indexer/index.ts";
import { CANONICAL_INDEXER_PORT, INDEXER_DIR } from "./paths.ts";

export type IndexerHarnessMode = "auto" | "subprocess" | "isolated-worker";

export interface IndexerHarnessOptions {
  secret?: string;
  mode?: IndexerHarnessMode;
  disablePoll?: boolean;
  readyTimeoutMs?: number;
  seed?: (storage: EventStorage) => void;
}

export interface IndexerHarness {
  readonly port: number;
  readonly baseUrl: string;
  readonly tmpDir: string;
  readonly dbPath: string;
  readonly secret: string;
  readonly modeUsed: "subprocess" | "isolated-worker";
  fetch(pathAndQuery: string, init?: RequestInit): Promise<Response>;
  seedEvents(events: DecodedEvent[]): number;
  withStorage<T>(fn: (storage: EventStorage) => T): T;
  stop(): Promise<void>;
}

async function loadEventStorageClass(): Promise<typeof EventStorage> {
  const mod = await import("../../../indexer/index.ts");
  return mod.EventStorage;
}

export async function allocateFreePort(): Promise<number> {
  const tryBind = () =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close((err) => {
          if (err) return reject(err);
          resolve(port);
        });
      });
    });

  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await tryBind();
    if (port > 0 && port !== CANONICAL_INDEXER_PORT) {
      return port;
    }
  }
  throw new Error(`Failed to allocate valid ephemeral port !== ${CANONICAL_INDEXER_PORT}`);
}

export function detectIndexerSubprocessCapabilities(indexerFilePath: string): {
  supportsPortEnv: boolean;
  supportsDbPathEnv: boolean;
  supportsDisablePollEnv: boolean;
} {
  const src = readFileSync(indexerFilePath, "utf8");
  return {
    supportsPortEnv: src.includes("INDEXER_PORT"),
    supportsDbPathEnv: src.includes("INDEXER_DB_PATH"),
    supportsDisablePollEnv: src.includes("INDEXER_DISABLE_POLL"),
  };
}

export async function startIndexerHarness(
  opts: IndexerHarnessOptions = {}
): Promise<IndexerHarness> {
  const indexerEntry = join(INDEXER_DIR, "index.ts");
  const selfWorkerEntry = import.meta.path;

  const caps = detectIndexerSubprocessCapabilities(indexerEntry);
  const fullSubprocessSafe =
    caps.supportsPortEnv && caps.supportsDbPathEnv && caps.supportsDisablePollEnv;

  const requestedMode = opts.mode ?? "auto";
  if (requestedMode === "subprocess" && !fullSubprocessSafe) {
    throw new Error(
      `Cannot safely run raw indexer/index.ts subprocess: missing env support (${JSON.stringify(caps)}).`
    );
  }
  const modeUsed: "subprocess" | "isolated-worker" =
    requestedMode === "auto"
      ? fullSubprocessSafe
        ? "subprocess"
        : "isolated-worker"
      : requestedMode;

  if (!caps.supportsPortEnv) {
    throw new Error(
      `indexer/index.ts does not support INDEXER_PORT; refusing to bind port ${CANONICAL_INDEXER_PORT}.`
    );
  }

  const port = await allocateFreePort();
  const tmpDir = mkdtempSync(join(tmpdir(), "nivora-e2e-indexer-"));
  const dbPath = join(tmpDir, "events.db");
  const secret = (opts.secret ?? "").trim();
  const disablePoll = opts.disablePoll ?? true;
  const baseUrl = `http://127.0.0.1:${port}`;

  let EventStorageClass: typeof EventStorage;
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  try {
    EventStorageClass = await loadEventStorageClass();

    if (opts.seed) {
      const seeder = new EventStorageClass(dbPath);
      try {
        opts.seed(seeder);
      } finally {
        seeder.close();
      }
    } else {
      const initDb = new EventStorageClass(dbPath);
      initDb.close();
    }

    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") childEnv[k] = v;
    }
    childEnv.INDEXER_PORT = String(port);
    childEnv.PORT = String(port);
    childEnv.INDEXER_DB_PATH = dbPath;
    childEnv.INDEXER_API_SECRET = secret;
    childEnv.INDEXER_DISABLE_POLL = disablePoll ? "1" : "0";

    const cmd =
      modeUsed === "subprocess"
        ? [process.execPath, "run", indexerEntry]
        : [process.execPath, "run", selfWorkerEntry, dbPath, String(port), disablePoll ? "1" : "0"];

    const spawned = Bun.spawn(cmd, {
      cwd: INDEXER_DIR,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    proc = spawned;

    const timeoutMs = opts.readyTimeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    let lastErr: unknown = null;

    while (Date.now() < deadline) {
      if (spawned.exitCode !== null) {
        const stderrText = await new Response(spawned.stderr).text().catch(() => "");
        throw new Error(
          `Indexer ${modeUsed} exited prematurely with code ${spawned.exitCode}: ${stderrText}`
        );
      }
      try {
        const res = await globalThis.fetch(`${baseUrl}/health`, {
          headers: secret ? { "x-indexer-secret": secret } : undefined,
          signal: AbortSignal.timeout(500),
        });
        if (res.status === 200) {
          ready = true;
          break;
        }
      } catch (err) {
        lastErr = err;
      }
      await Bun.sleep(40);
    }

    if (!ready) {
      const stderrText = await new Response(spawned.stderr).text().catch(() => "");
      throw new Error(
        `Timed out waiting for indexer at ${baseUrl}/health (${timeoutMs}ms): ${String(lastErr)} ${stderrText}`
      );
    }
  } catch (err) {
    if (proc) {
      try {
        proc.kill("SIGKILL");
        await proc.exited;
      } catch {
        // Ignore
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  const runningProc = proc;

  let stopped = false;

  return {
    port,
    baseUrl,
    tmpDir,
    dbPath,
    secret,
    modeUsed,
    fetch(pathAndQuery: string, init: RequestInit = {}) {
      const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
      const headers = new Headers(init.headers);
      if (secret && !headers.has("x-indexer-secret")) {
        headers.set("x-indexer-secret", secret);
      }
      return globalThis.fetch(`${baseUrl}${path}`, { ...init, headers });
    },
    seedEvents(events: DecodedEvent[]): number {
      const storage = new EventStorageClass(dbPath);
      try {
        return storage.saveEvents(events);
      } finally {
        storage.close();
      }
    },
    withStorage<T>(fn: (storage: EventStorage) => T): T {
      const storage = new EventStorageClass(dbPath);
      try {
        return fn(storage);
      } finally {
        storage.close();
      }
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      try {
        runningProc.kill("SIGTERM");
        const exited = await Promise.race([
          runningProc.exited.then(() => true),
          Bun.sleep(1500).then(() => false),
        ]);
        if (!exited) {
          runningProc.kill("SIGKILL");
          await runningProc.exited;
        }
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  };
}

// Self-hosted isolated worker entrypoint (executes ONLY when spawned as child process)
if (import.meta.main) {
  const [, , dbPath, expectedPortRaw, disablePollRaw] = process.argv;
  if (!dbPath || !expectedPortRaw) {
    console.error("Usage: indexer-harness.ts <dbPath> <expectedPort> <disablePoll>");
    process.exit(2);
  }

  const expectedPort = Number.parseInt(expectedPortRaw, 10);
  if (
    !Number.isSafeInteger(expectedPort) ||
    expectedPort <= 0 ||
    expectedPort === CANONICAL_INDEXER_PORT
  ) {
    console.error(`Refusing unsafe ephemeral port: ${expectedPortRaw}`);
    process.exit(2);
  }

  const { EventStorage: WorkerStorage, HTTP_PORT, PersistentIndexer, startHttpServer } =
    await import("../../../indexer/index.ts");

  if (HTTP_PORT !== expectedPort || HTTP_PORT === CANONICAL_INDEXER_PORT) {
    console.error(
      `indexer/index.ts resolved HTTP_PORT=${HTTP_PORT} instead of expected ephemeral port ${expectedPort}`
    );
    process.exit(3);
  }

  const storage = new WorkerStorage(dbPath);
  const indexer = new PersistentIndexer(storage);
  const server = startHttpServer(storage, indexer);

  if (disablePollRaw === "0") {
    await indexer.start();
  }

  const shutdown = () => {
    try {
      indexer.stop();
      server.stop(true);
      storage.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

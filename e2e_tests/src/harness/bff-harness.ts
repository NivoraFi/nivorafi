import { AsyncLocalStorage } from "node:async_hooks";
import { NextRequest } from "../../../frontend/node_modules/next/server.js";
import { GET } from "../../../frontend/src/app/api/indexer/[...path]/route.ts";
import { allocateFreePort } from "./indexer-harness.ts";

export interface BffEnvConfig {
  indexerInternalUrl?: string;
  indexerApiSecret?: string;
}

export interface BffInvokeOptions extends BffEnvConfig {
  /** Path segments after /api/indexer/, e.g. ["charts"] or ["analytics", "sparkline"] */
  path?: string[];
  /** Raw pathname + query string starting with / or /api/indexer/..., e.g. "/api/indexer/charts?market=xlm-90d" */
  url?: string;
  headers?: HeadersInit;
}

let envMutex: Promise<void> = Promise.resolve();
const bffEnvScopeStorage = new AsyncLocalStorage<boolean>();

async function withEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = envMutex;
  let release!: () => void;
  envMutex = new Promise<void>((res) => {
    release = res;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function setOrDeleteEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Runs an async callback (including parallel Promise.all GET requests)
 * with process.env.INDEXER_INTERNAL_URL and INDEXER_API_SECRET scoped & restored in finally.
 */
export async function withBffEnv<T>(
  config: BffEnvConfig,
  fn: () => Promise<T>
): Promise<T> {
  if (bffEnvScopeStorage.getStore()) {
    throw new Error(
      "Nested withBffEnv() or env-overriding invokeBffGet() inside an active withBffEnv() scope is not allowed (would deadlock envMutex). Use callBffGetRaw() inside withBffEnv()."
    );
  }
  return withEnvLock(async () => {
    const prevUrl = process.env.INDEXER_INTERNAL_URL;
    const prevSecret = process.env.INDEXER_API_SECRET;
    try {
      if ("indexerInternalUrl" in config) {
        setOrDeleteEnv("INDEXER_INTERNAL_URL", config.indexerInternalUrl);
      }
      if ("indexerApiSecret" in config) {
        setOrDeleteEnv("INDEXER_API_SECRET", config.indexerApiSecret);
      }
      return await bffEnvScopeStorage.run(true, fn);
    } finally {
      setOrDeleteEnv("INDEXER_INTERNAL_URL", prevUrl);
      setOrDeleteEnv("INDEXER_API_SECRET", prevSecret);
    }
  });
}

function normalizePathAndRequest(opts: BffInvokeOptions): {
  req: NextRequest;
  pathSegments: string[];
} {
  let fullUrl: string;
  let pathSegments: string[];

  if (opts.url) {
    fullUrl = opts.url.startsWith("http")
      ? opts.url
      : `http://localhost:3000${opts.url.startsWith("/") ? "" : "/"}${opts.url}`;
    const parsed = new URL(fullUrl);
    if (opts.path) {
      pathSegments = opts.path;
    } else {
      const stripped = parsed.pathname.replace(/^\/api\/indexer\/?/, "");
      pathSegments = stripped === "" ? [] : stripped.split("/");
    }
  } else {
    pathSegments = opts.path ?? ["health"];
    fullUrl = `http://localhost:3000/api/indexer/${pathSegments.join("/")}`;
  }

  const req = new NextRequest(fullUrl, opts.headers ? { headers: opts.headers } : undefined);
  return { req, pathSegments };
}

/**
 * Invokes the real Next.js GET handler in route.ts with zero fetch mocking.
 * Automatically scopes and restores process.env in finally.
 */
export async function invokeBffGet(opts: BffInvokeOptions): Promise<Response> {
  const { req, pathSegments } = normalizePathAndRequest(opts);
  const envConfig: BffEnvConfig = {};
  if ("indexerInternalUrl" in opts) envConfig.indexerInternalUrl = opts.indexerInternalUrl;
  if ("indexerApiSecret" in opts) envConfig.indexerApiSecret = opts.indexerApiSecret;

  if (Object.keys(envConfig).length === 0) {
    return GET(req, { params: Promise.resolve({ path: pathSegments }) });
  }

  return withBffEnv(envConfig, () =>
    GET(req, { params: Promise.resolve({ path: pathSegments }) })
  );
}

/**
 * Invokes GET directly inside an existing withBffEnv() scope (safe for Promise.all concurrency tests).
 */
export async function callBffGetRaw(
  opts: Omit<BffInvokeOptions, keyof BffEnvConfig>
): Promise<Response> {
  const { req, pathSegments } = normalizePathAndRequest(opts);
  return GET(req, { params: Promise.resolve({ path: pathSegments }) });
}

/**
 * Allocates and immediately closes an ephemeral localhost port so 127.0.0.1:<port>
 * deterministically refuses connections for 502 offline tests.
 */
export async function getClosedLocalUrl(): Promise<string> {
  const port = await allocateFreePort();
  return `http://127.0.0.1:${port}`;
}

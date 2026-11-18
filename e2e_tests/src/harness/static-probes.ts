import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type ReactType from "react";
import type { Root } from "react-dom/client";
import {
  AGENT_DIR,
  CONTRACTS_DIR,
  E2E_ROOT,
  FRONTEND_DIR,
  INDEXER_DIR,
  LOCKED_CONTRACT_KEYS,
  LOCKED_SHA256,
  REPO_ROOT,
  SCRIPTS_DIR,
  withProcessLock,
} from "./paths.ts";

const frontendRequire = createRequire(join(FRONTEND_DIR, "package.json"));

export const React = frontendRequire("react") as typeof ReactType;
const ReactDomServer = frontendRequire("react-dom/server") as typeof import("react-dom/server");
const ReactDomClient = frontendRequire("react-dom/client") as typeof import("react-dom/client");

export const renderToStaticMarkup = ReactDomServer.renderToStaticMarkup;
export const renderToString = ReactDomServer.renderToString;
export const createRoot = ReactDomClient.createRoot;
export const act = React.act;

export function renderFrontendHtml(element: ReactType.ReactElement): string {
  return renderToStaticMarkup(element);
}

export interface MountedFrontendDom {
  container: HTMLElement;
  window: Window & typeof globalThis;
  unmount: () => Promise<void>;
}

let domMountCount = 0;

async function teardownHappyDomIfLast(): Promise<void> {
  if (domMountCount === 0 && GlobalRegistrator.isRegistered) {
    const happyDOM = (
      globalThis as unknown as {
        happyDOM?: { abort?: () => Promise<void> };
      }
    ).happyDOM;
    try {
      await happyDOM?.abort?.();
    } catch {
      // Ignore abort errors during teardown
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (GlobalRegistrator.isRegistered) {
      await GlobalRegistrator.unregister();
    }
  }
}

export async function mountFrontendDom(
  element: ReactType.ReactElement
): Promise<MountedFrontendDom> {
  if (domMountCount === 0 && !GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
  }
  domMountCount += 1;

  const g = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    matchMedia?: (query: string) => MediaQueryList;
  };
  g.IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof g.matchMedia !== "function") {
    g.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  try {
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
  } catch (err) {
    try {
      if (root) {
        await act(async () => {
          (root as Root).unmount();
        });
      }
    } catch {
      // Ignore unmount errors during failed render cleanup
    }
    container.remove();
    domMountCount = Math.max(0, domMountCount - 1);
    await teardownHappyDomIfLast();
    throw err;
  }

  let unmounted = false;
  return {
    container,
    window: globalThis as unknown as Window & typeof globalThis,
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      try {
        if (root) {
          await act(async () => {
            root?.unmount();
          });
        }
        container.remove();
      } finally {
        domMountCount = Math.max(0, domMountCount - 1);
        await teardownHappyDomIfLast();
      }
    },
  };
}

export interface BuildCheckResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

let frontendBuildPromise: Promise<BuildCheckResult> | null = null;

function decodeText(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

export async function runFrontendBuildOnce(opts?: {
  force?: boolean;
}): Promise<BuildCheckResult> {
  if (!opts?.force && frontendBuildPromise) {
    return frontendBuildPromise;
  }

  const run = () =>
    withProcessLock("frontend-next-build", async () => {
      const start = performance.now();
      const proc = Bun.spawnSync(["bun", "run", "build"], {
        cwd: FRONTEND_DIR,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const durationMs = performance.now() - start;
      const result: BuildCheckResult = {
        ok: proc.exitCode === 0,
        exitCode: proc.exitCode,
        stdout: decodeText(proc.stdout),
        stderr: decodeText(proc.stderr),
        durationMs,
      };
      if (!result.ok) {
        throw new Error(
          `frontend bun run build failed (exit ${result.exitCode}):\n${result.stdout}\n${result.stderr}`
        );
      }
      return result;
    });

  if (opts?.force) {
    frontendBuildPromise = run();
    return frontendBuildPromise;
  }

  frontendBuildPromise = run().catch((err) => {
    frontendBuildPromise = null;
    throw err;
  });
  return frontendBuildPromise;
}

export interface TscCheckResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  errors: string[];
}

export async function runTscCheck(
  target: "indexer" | "frontend" | "agent" | "e2e_tests" | string
): Promise<TscCheckResult> {
  const dirMap: Record<string, string> = {
    indexer: INDEXER_DIR,
    frontend: FRONTEND_DIR,
    agent: AGENT_DIR,
    e2e_tests: E2E_ROOT,
  };
  const cwd = dirMap[target] ?? (isAbsolute(target) ? target : resolve(REPO_ROOT, target));
  const pkgPath = join(cwd, "package.json");
  let cmd = ["bunx", "tsc", "--noEmit"];
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.typecheck) {
        cmd = ["bun", "run", "typecheck"];
      }
    } catch {
      // Fallback to bunx tsc --noEmit
    }
  }

  const proc = Bun.spawnSync(cmd, {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = decodeText(proc.stdout);
  const stderr = decodeText(proc.stderr);
  const combined = `${stdout}\n${stderr}`;
  const errors = combined
    .split("\n")
    .filter((line) => /error TS\d+/.test(line))
    .map((line) => line.trim());

  return {
    ok: proc.exitCode === 0 && errors.length === 0,
    exitCode: proc.exitCode,
    stdout,
    stderr,
    errors,
  };
}

export interface SecretScanMatch {
  file: string;
  pattern: string;
  excerpt: string;
}

export interface SecretScanResult {
  filesScanned: number;
  matches: SecretScanMatch[];
}

const DEFAULT_FORBIDDEN_BUNDLE_PATTERNS: readonly string[] = [
  "INDEXER_API_SECRET",
  "INDEXER_INTERNAL_URL",
  "trycloudflare.com",
  "c62f0b839f5d4c81c7d5e75ef60a2d7bb65de9980eb01661195fd45df2a7b4fe",
  "VERCEL_OIDC_TOKEN",
];

function walkFiles(
  rootDir: string,
  opts: {
    skipDirs?: Set<string>;
    includeExts?: Set<string>;
    skipTestFiles?: boolean;
  } = {}
): string[] {
  const results: string[] = [];
  if (!existsSync(rootDir)) return results;

  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (opts.skipDirs?.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        if (
          opts.skipTestFiles &&
          (/\.test\.[jt]sx?$/.test(entry) || /\.spec\.[jt]sx?$/.test(entry))
        ) {
          continue;
        }
        if (opts.includeExts) {
          const dot = entry.lastIndexOf(".");
          const ext = dot >= 0 ? entry.slice(dot) : "";
          if (!opts.includeExts.has(ext)) continue;
        }
        results.push(full);
      }
    }
  }
  return results;
}

export async function scanNextStaticForSecrets(opts?: {
  forbiddenPatterns?: (string | RegExp)[];
}): Promise<SecretScanResult> {
  const staticDir = join(FRONTEND_DIR, ".next", "static");
  if (!existsSync(staticDir)) {
    throw new Error(
      `Missing ${staticDir}. Call runFrontendBuildOnce() before scanNextStaticForSecrets().`
    );
  }

  const files = walkFiles(staticDir, {
    includeExts: new Set([".js", ".mjs"]),
  });
  const patterns = opts?.forbiddenPatterns ?? [...DEFAULT_FORBIDDEN_BUNDLE_PATTERNS];
  const matches: SecretScanMatch[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const pat of patterns) {
      if (typeof pat === "string") {
        const idx = content.indexOf(pat);
        if (idx !== -1) {
          matches.push({
            file,
            pattern: pat,
            excerpt: content.slice(Math.max(0, idx - 32), idx + pat.length + 32),
          });
        }
      } else {
        const rx = new RegExp(pat.source, pat.flags.replace("g", ""));
        const m = rx.exec(content);
        if (m) {
          matches.push({
            file,
            pattern: pat.toString(),
            excerpt: content.slice(Math.max(0, m.index - 32), m.index + m[0].length + 32),
          });
        }
      }
    }
  }

  return { filesScanned: files.length, matches };
}

function resolveRepoPath(relOrAbsPath: string): string {
  return isAbsolute(relOrAbsPath) ? relOrAbsPath : resolve(REPO_ROOT, relOrAbsPath);
}

export async function computeFileSha256(relOrAbsPath: string): Promise<string> {
  const abs = resolveRepoPath(relOrAbsPath);
  const data = readFileSync(abs);
  return createHash("sha256").update(data).digest("hex");
}

export async function verifyLockedSha256(): Promise<{
  ok: boolean;
  results: Array<{ file: string; expected: string; actual: string; match: boolean }>;
}> {
  const results: Array<{ file: string; expected: string; actual: string; match: boolean }> = [];
  for (const [file, expected] of Object.entries(LOCKED_SHA256)) {
    const actual = await computeFileSha256(file);
    results.push({
      file,
      expected,
      actual,
      match: actual === expected,
    });
  }
  return {
    ok: results.every((r) => r.match),
    results,
  };
}

export async function verifyContractsConfigLock(): Promise<{
  ok: boolean;
  keys: string[];
}> {
  const abs = join(FRONTEND_DIR, "src", "lib", "contracts.ts");
  const mod = (await import(pathToFileURL(abs).href)) as {
    STELLAR_PENDLE_CONFIG?: { contracts?: Record<string, unknown> };
  };
  const keys = Object.keys(mod.STELLAR_PENDLE_CONFIG?.contracts ?? {});
  const ok =
    keys.length === LOCKED_CONTRACT_KEYS.length &&
    LOCKED_CONTRACT_KEYS.every((k, i) => keys[i] === k);
  return { ok, keys };
}

export async function readModuleExports(relOrAbsPath: string): Promise<string[]> {
  const abs = resolveRepoPath(relOrAbsPath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  return Object.keys(mod);
}

export async function hasModuleExport(
  relOrAbsPath: string,
  exportName: string
): Promise<boolean> {
  const abs = resolveRepoPath(relOrAbsPath);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  return exportName in mod;
}

export function readFileText(relOrAbsPath: string): string {
  return readFileSync(resolveRepoPath(relOrAbsPath), "utf8");
}

export interface SourceMatch {
  pattern: string;
  line: number;
  text: string;
}

export function scanSourceForIdentifiers(
  relOrAbsPath: string,
  patterns: (string | RegExp)[]
): SourceMatch[] {
  const content = readFileText(relOrAbsPath);
  const lines = content.split("\n");
  const matches: SourceMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!;
    for (const pat of patterns) {
      const hit =
        typeof pat === "string"
          ? lineText.includes(pat)
          : new RegExp(pat.source, pat.flags.replace("g", "")).test(lineText);
      if (hit) {
        matches.push({
          pattern: typeof pat === "string" ? pat : pat.toString(),
          line: i + 1,
          text: lineText.trim(),
        });
      }
    }
  }
  return matches;
}

export interface R5ScanMatch {
  file: string;
  pattern: string;
  line: number;
  text: string;
}

export interface R5ScanResult {
  ok: boolean;
  filesScanned: number;
  matches: R5ScanMatch[];
}

const DEFAULT_R5_PATTERNS: readonly string[] = [
  "place_limit_order",
  "cancel_limit_order",
  "limit_order",
  "auto_rollover",
  "enable_auto_rollover",
  "schedule_rollover",
  "reflector_oracle",
  "pyth_oracle",
  "band_oracle",
];

export function scanR5OutOfScopeSymbols(
  patterns: readonly string[] = DEFAULT_R5_PATTERNS
): R5ScanResult {
  const roots = [
    CONTRACTS_DIR,
    join(FRONTEND_DIR, "src"),
    INDEXER_DIR,
    join(AGENT_DIR, "src"),
    SCRIPTS_DIR,
  ];
  const skipDirs = new Set(["node_modules", ".next", "target", "dist", "__tests__", "e2e"]);
  const includeExts = new Set([".rs", ".ts", ".tsx", ".js", ".mjs"]);

  const files: string[] = [];
  for (const r of roots) {
    files.push(...walkFiles(r, { skipDirs, includeExts, skipTestFiles: true }));
  }

  const matches: R5ScanMatch[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i]!;
      for (const pat of patterns) {
        if (lineText.includes(pat)) {
          matches.push({
            file,
            pattern: pat,
            line: i + 1,
            text: lineText.trim(),
          });
        }
      }
    }
  }

  return {
    ok: matches.length === 0,
    filesScanned: files.length,
    matches,
  };
}

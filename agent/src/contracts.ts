import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeploymentManifest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the deployed_contracts.json manifest from explicit path, env var,
 * or default project root location.
 */
export function loadDeploymentManifest(explicitPath?: string): DeploymentManifest {
  const candidates = [
    explicitPath,
    process.env.STELLAR_PENDLE_MANIFEST,
    resolve(process.cwd(), "deployed_contracts.json"),
    resolve(process.cwd(), "../deployed_contracts.json"),
    resolve(__dirname, "../../deployed_contracts.json"),
  ].filter((p): p is string => Boolean(p));

  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      return JSON.parse(raw) as DeploymentManifest;
    }
  }

  throw new Error(
    `Could not locate deployed_contracts.json. Checked: ${candidates.join(", ")}`
  );
}

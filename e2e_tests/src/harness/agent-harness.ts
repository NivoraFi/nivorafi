import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Address,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { createStellarPendleMcpServer } from "../../../agent/src/mcp-server.ts";
import {
  AGENT_DIR,
  EXPECTED_MCP_RESOURCES,
  EXPECTED_MCP_TOOLS,
} from "./paths.ts";

export { EXPECTED_MCP_RESOURCES, EXPECTED_MCP_TOOLS };

export interface AgentMcpSession {
  client: Client;
  listToolNames(): Promise<string[]>;
  listResourceUris(): Promise<string[]>;
  readResourceText(uri: string): Promise<string>;
  callToolJson<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

function wrapSession(client: Client, onClose: () => Promise<void>): AgentMcpSession {
  return {
    client,
    async listToolNames(): Promise<string[]> {
      const res = await client.listTools();
      return res.tools.map((t) => t.name).sort();
    },
    async listResourceUris(): Promise<string[]> {
      const res = await client.listResources();
      return res.resources.map((r) => r.uri).sort();
    },
    async readResourceText(uri: string): Promise<string> {
      const res = await client.readResource({ uri });
      const first = res.contents[0];
      if (!first || !("text" in first) || typeof first.text !== "string") {
        throw new Error(`Resource ${uri} returned no text content`);
      }
      return first.text;
    },
    async callToolJson<T = unknown>(
      name: string,
      args: Record<string, unknown> = {}
    ): Promise<T> {
      const res = await client.callTool({ name, arguments: args });
      if ("isError" in res && res.isError) {
        const text =
          "content" in res &&
          Array.isArray(res.content) &&
          res.content[0]?.type === "text" &&
          typeof res.content[0].text === "string"
            ? res.content[0].text
            : JSON.stringify(res);
        throw new Error(`MCP tool ${name} failed: ${text}`);
      }
      if (!("content" in res) || !Array.isArray(res.content)) {
        throw new Error(`Unexpected MCP callTool response for ${name}`);
      }
      const first = res.content[0];
      if (!first || first.type !== "text" || typeof first.text !== "string") {
        throw new Error(`MCP tool ${name} returned non-text content`);
      }
      return JSON.parse(first.text) as T;
    },
    close: onClose,
  };
}

export async function connectAgentMcpStdio(
  opts: {
    manifestPath?: string;
    env?: Record<string, string>;
  } = {}
): Promise<AgentMcpSession> {
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    ...(opts.env ?? {}),
  };
  if (opts.manifestPath) {
    env.STELLAR_PENDLE_MANIFEST = opts.manifestPath;
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/mcp-server.ts"],
    cwd: AGENT_DIR,
    env,
    stderr: "pipe",
  });

  const client = new Client(
    { name: "e2e-mcp-stdio-client", version: "0.1.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  return wrapSession(client, async () => {
    await client.close();
  });
}

export async function connectAgentMcpInMemory(
  manifestPath?: string
): Promise<AgentMcpSession> {
  const { mcpServer } = createStellarPendleMcpServer(manifestPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "e2e-mcp-inmemory-client", version: "0.1.0" },
    { capabilities: {} }
  );

  await Promise.all([
    mcpServer.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return wrapSession(client, async () => {
    await Promise.all([client.close(), mcpServer.close()]);
  });
}

export interface DecodedScValArg {
  /** Exact XDR ScVal discriminant in @stellar/stellar-sdk@17 / @stellar/js-xdr@5, e.g. "scvU64", "scvI128", "scvAddress" */
  xdrType: xdr.ScVal["type"];
  native: unknown;
  raw: xdr.ScVal;
}

export interface DecodedInvokeContractTx {
  source: string;
  sequence: string;
  contractId: string;
  functionName: string;
  args: DecodedScValArg[];
}

export function inspectScValArgs(args: readonly xdr.ScVal[]): DecodedScValArg[] {
  return args.map((raw) => ({
    xdrType: raw.type,
    native: scValToNative(raw),
    raw,
  }));
}

/**
 * Decodes an unsigned base64 Stellar transaction envelope containing an InvokeHostFunction
 * (InvokeContract) operation, preserving exact ScVal types (e.g. scvU64 vs scvI128 vs scvAddress).
 */
export function decodeUnsignedInvokeContractXdr(
  unsignedXdr: string,
  networkPassphrase = "Test SDF Network ; September 2015"
): DecodedInvokeContractTx {
  const parsed = TransactionBuilder.fromXdr(unsignedXdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) {
    throw new Error("Expected standard Transaction envelope, got FeeBumpTransaction");
  }
  const op = parsed.operations[0];
  if (!op || op.type !== "invokeHostFunction") {
    throw new Error(`Expected invokeHostFunction operation, got ${op?.type ?? "none"}`);
  }
  if (op.func.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`Expected hostFunctionTypeInvokeContract, got ${op.func.type}`);
  }

  const invoke = op.func.value;
  return {
    source: parsed.source,
    sequence: parsed.sequence,
    contractId: Address.fromScAddress(invoke.contractAddress).toString(),
    functionName: invoke.functionName.toString(),
    args: inspectScValArgs(invoke.args),
  };
}

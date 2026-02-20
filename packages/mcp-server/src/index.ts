#!/usr/bin/env node
/**
 * @vaeb/mcp-server — MCP Server for Verified Agent Execution Bundle
 *
 * This is the "front door" of VAEB. Any AI agent (Claude, GPT, custom agent SDK,
 * A2A peer, autonomous trading bot) can discover VAEB's capabilities through
 * standard MCP tool listings.
 *
 * Tools:
 *   Free (no x402 payment):
 *     - read_balance    — Read token balance on any supported chain
 *     - get_price       — Get token price across chains/DEXs
 *     - estimate_gas    — Estimate gas for an operation
 *     - get_receipt     — Get transaction receipt by hash
 *     - discover_agents — Discover agents via ERC-8004 IdentityRegistry
 *     - get_agent_reputation — Query agent reputation from ERC-8004
 *
 *   Paid (x402 micropayment):
 *     - create_intent   — Construct an IntentBundle from high-level actions
 *     - execute_intent  — Execute a signed intent with ZK proof
 *     - simulate_intent — Dry-run an intent via eth_call
 *     - cancel_intent   — Invalidate a nonce
 *     - post_feedback   — Post execution feedback to ERC-8004
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as path from "path";
import { chainTools } from "./tools/chain-tools";
import { intentTools } from "./tools/intent-tools";
import { walletTools } from "./tools/wallet-tools";
import { trustTools } from "./tools/trust-tools";
import { getToolDefinitions } from "./tool-registry";

// ─── Load on-chain deployments (keyed by chain name) ────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEPLOYMENTS = require(
  path.join(__dirname, "../../../contracts/deployments/deployments.json")
);

// ─── Environment Configuration ──────────────────────────────────

const defaultChain    = process.env.DEFAULT_CHAIN || "base_sepolia";
const chainDeployment = DEPLOYMENTS[defaultChain] || {};
const chainContracts  = chainDeployment.contracts  || {};

const config = {
  walletPrivateKey:    process.env.AGENT_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "",
  // Used by post_feedback to sign on-chain ERC-8004 reputation submissions.
  // Can be the same key as WALLET_PRIVATE_KEY or a dedicated agent key.
  signerPrivateKey: process.env.AGENT_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "",
  supportedChains:     (process.env.SUPPORTED_CHAINS || "base_sepolia").split(","),
  defaultChain,
  x402Facilitator:     process.env.X402_FACILITATOR         || "https://x402.coinbase.com",
  maxServiceFeePerTx:  process.env.X402_MAX_SERVICE_FEE_PER_TX || "0.10",
  maxDailySpend:       process.env.X402_MAX_DAILY_SPEND     || "5.00",
  proverEndpoint:      process.env.PROVER_ENDPOINT          || "http://localhost:3001",
  requireManualApproval: process.env.REQUIRE_MANUAL_APPROVAL === "true",
  agentAddress: chainDeployment.wallets?.agent,
  rpcUrl:   process.env.BASE_SEPOLIA_RPC_URL || chainDeployment.rpcUrl || "https://sepolia.base.org",
  chainId:  parseInt(process.env.CHAIN_ID || String(chainDeployment.chainId || 84532)),
  contracts: {
    AgentWallet:            process.env.AGENT_WALLET_ADDRESS || chainContracts.AgentWallet,
    MockUSDC:               process.env.MOCK_USDC_ADDRESS    || chainContracts.MockUSDC,
    AgentWalletFactory:     chainContracts.AgentWalletFactory,
    Groth16Verifier:        chainContracts.Groth16Verifier,
    Groth16VerifierAdapter: chainContracts.Groth16VerifierAdapter,
    MockZKVerifier:         chainContracts.MockZKVerifier,
  },
};

// ─── JSON Schema → Zod shape converter ──────────────────────────

type JsonSchemaProp = {
  type: string;
  description?: string;
  items?: JsonSchemaProp;
  enum?: string[];
};

function jsonPropToZod(prop: JsonSchemaProp, isRequired: boolean): z.ZodTypeAny {
  let zType: z.ZodTypeAny;

  switch (prop.type) {
    case "string":
      zType = prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
      break;
    case "number":
      zType = z.number();
      break;
    case "boolean":
      zType = z.boolean();
      break;
    case "array":
      zType = prop.items ? z.array(jsonPropToZod(prop.items, true)) : z.array(z.any());
      break;
    case "object":
      zType = z.record(z.any());
      break;
    default:
      zType = z.any();
  }

  if (prop.description) zType = zType.describe(prop.description);
  if (!isRequired) zType = zType.optional();

  return zType;
}

function buildZodShape(
  properties: Record<string, JsonSchemaProp>,
  required: string[]
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = jsonPropToZod(prop, required.includes(key));
  }
  return shape;
}

// ─── Tool routing ────────────────────────────────────────────────

async function routeTool(name: string, args: Record<string, unknown>) {
  if (["get_wallet_balance", "check_nonce", "read_balance", "get_price", "estimate_gas", "get_receipt"].includes(name)) {
    return await chainTools.handle(name, args, config);
  }
  if (["create_intent", "execute_intent", "simulate_intent", "cancel_intent"].includes(name)) {
    return await intentTools.handle(name, args, config);
  }
  if (["create_wallet", "predict_wallet", "get_wallets"].includes(name)) {
    return await walletTools.handle(name, args, config);
  }
  if (["discover_agents", "get_agent_reputation", "get_agent_validations", "post_feedback", "compare_agents"].includes(name)) {
    return await trustTools.handle(name, args, config);
  }
  throw new Error(`Unknown tool: ${name}`);
}

// ─── Create MCP Server ──────────────────────────────────────────

const server = new McpServer({
  name: "@vaeb/mcp-agent-execution",
  version: "0.1.0",
});

// ─── Register Tools ─────────────────────────────────────────────

for (const tool of getToolDefinitions()) {
  const properties = (tool.inputSchema.properties || {}) as Record<string, JsonSchemaProp>;
  const required   = (tool.inputSchema.required   || []) as string[];
  const hasParams  = Object.keys(properties).length > 0;

  const makeHandler = (name: string, hasArgs: boolean) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (args: any) => {
      try {
        const result = await routeTool(name, hasArgs ? (args as Record<string, unknown>) : {});
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text" as const, text: `Error: ${error.message}` }], isError: true };
      }
    };

  if (hasParams) {
    const zodShape = buildZodShape(properties, required);
    server.registerTool(
      tool.name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { description: tool.description, inputSchema: zodShape as any },
      makeHandler(tool.name, true),
    );
  } else {
    server.registerTool(
      tool.name,
      { description: tool.description },
      makeHandler(tool.name, false),
    );
  }
}

// ─── Start Server ───────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("VAEB MCP Server running (stdio transport)");
  console.error(`   Chain: ${config.defaultChain}`);
  console.error(`   Tools: ${getToolDefinitions().length} available`);
}

main().catch((error) => {
  console.error("Failed to start VAEB MCP Server:", error);
  process.exit(1);
});

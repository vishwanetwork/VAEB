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
 *
 *   Marketplace (Rent a Human):
 *     - search_marketplace — Search for available humans
 *     - hire_human         — Create a payment intent to hire someone
 *     - get_wallet_balance — Check agent wallet balance
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getToolDefinitions } from "./tool-registry";
import { handleToolCall, MCPConfig } from "./handlers";

// ─── Environment Configuration ──────────────────────────────────

const config: MCPConfig = {
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || "",
  supportedChains: (process.env.SUPPORTED_CHAINS || "base_sepolia").split(","),
  defaultChain: process.env.DEFAULT_CHAIN || "base_sepolia",
  proverEndpoint: process.env.PROVER_ENDPOINT || "http://localhost:3001",
  requireManualApproval: process.env.REQUIRE_MANUAL_APPROVAL === "true",
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  chainId: parseInt(process.env.CHAIN_ID || "84532"),
  contracts: {
    AgentWallet: process.env.AGENT_WALLET_ADDRESS || "",
    MockUSDC: process.env.MOCK_USDC_ADDRESS || "",
  },
};

// ─── Create MCP Server ──────────────────────────────────────────

const server = new Server(
  {
    name: "@vaeb/mcp-agent-execution",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ─── Tool Discovery (MCP: tools/list) ───────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: getToolDefinitions(),
  };
});

// ─── Tool Invocation (MCP: tools/call) ──────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    const toolResult = await handleToolCall(name, args || {}, config);

    return {
      content: [{ type: "text", text: JSON.stringify(toolResult.result, null, 2) }],
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

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

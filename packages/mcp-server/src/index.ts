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

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { chainTools } from "./tools/chain-tools";
import { intentTools } from "./tools/intent-tools";
import { trustTools } from "./tools/trust-tools";
import { getToolDefinitions } from "./tool-registry";

// ─── Environment Configuration ──────────────────────────────────

const config = {
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || "",
  supportedChains: (process.env.SUPPORTED_CHAINS || "base_sepolia").split(","),
  defaultChain: process.env.DEFAULT_CHAIN || "base_sepolia",
  x402Facilitator: process.env.X402_FACILITATOR || "https://x402.coinbase.com",
  maxServiceFeePerTx: process.env.X402_MAX_SERVICE_FEE_PER_TX || "0.10",
  maxDailySpend: process.env.X402_MAX_DAILY_SPEND || "5.00",
  proverEndpoint: process.env.PROVER_ENDPOINT || "http://localhost:3001",
  requireManualApproval: process.env.REQUIRE_MANUAL_APPROVAL === "true",
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
    // Route to appropriate tool handler
    let result: any;

    // Chain Tools (free)
    if (["read_balance", "get_price", "estimate_gas", "get_receipt"].includes(name)) {
      result = await chainTools.handle(name, args || {}, config);
    }
    // Intent Tools (paid via x402)
    else if (["create_intent", "execute_intent", "simulate_intent", "cancel_intent"].includes(name)) {
      result = await intentTools.handle(name, args || {}, config);
    }
    // Trust Tools (free — queries ERC-8004)
    else if (["discover_agents", "get_agent_reputation", "get_agent_validations", "post_feedback", "compare_agents"].includes(name)) {
      result = await trustTools.handle(name, args || {}, config);
    }
    else {
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
  console.error("🚀 VAEB MCP Server running (stdio transport)");
  console.error(`   Chain: ${config.defaultChain}`);
  console.error(`   Tools: ${getToolDefinitions().length} available`);
}

main().catch((error) => {
  console.error("Failed to start VAEB MCP Server:", error);
  process.exit(1);
});

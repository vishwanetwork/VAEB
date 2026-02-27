/**
 * MCP Tool Handlers — Shared routing function for both stdio server and Express bridge
 *
 * This module consolidates tool routing so that both:
 *   1. The standalone MCP server (stdio transport) — index.ts
 *   2. The Express server (HTTP bridge to DeepSeek) — packages/server/chat.ts
 * can call the same tool handlers.
 */

import { chainTools } from "./tools/chain-tools";
import { intentTools } from "./tools/intent-tools";
import { trustTools } from "./tools/trust-tools";
import { marketplaceTools } from "./tools/marketplace-tools";
import { verifyTools } from "./tools/verify-tools";
import { cantonTools } from "./tools/canton-tools";
import { btcTools } from "./tools/btc-tools";

// ─── Config type (superset of all tool handler needs) ────────

export interface MCPConfig {
  walletPrivateKey: string;
  supportedChains: string[];
  defaultChain: string;
  proverEndpoint: string;
  requireManualApproval: boolean;
  providerFactory?: (chainKey: string, rpcOverride?: string) => any;
  contractFactory?: (address: string, abi: any, providerOrSigner: any) => any;
  fetchFn?: typeof fetch;
  // Express-server specific (for marketplace tools)
  contracts?: {
    AgentWallet: string;
    MockUSDC: string;
    [key: string]: string;
  };
  rpcUrl?: string;
  chainId?: number;
  ownerAddress?: string;
  explorer?: string;
}

// ─── Result type ─────────────────────────────────────────────

export interface ToolCallResult {
  result: any;
  intent?: any;
  toolMeta: {
    tool: string;
    args: Record<string, any>;
    durationMs: number;
  };
}

// ─── Tool categories ─────────────────────────────────────────

const CHAIN_TOOLS = ["read_balance", "get_price", "estimate_gas", "get_receipt"];
const INTENT_TOOLS = ["create_intent", "execute_intent", "simulate_intent", "cancel_intent"];
const TRUST_TOOLS = ["discover_agents", "get_agent_reputation", "get_agent_validations", "post_feedback", "compare_agents"];
const MARKETPLACE_TOOLS = ["search_marketplace", "hire_human", "get_wallet_balance", "execute_payment"];
const VERIFY_TOOLS = ["check_nonce", "prove_intent", "verify_proof"];
const CANTON_TOOLS = ["canton_health", "query_attestations", "query_settlements", "prepare_settlement"];
const BTC_TOOLS = ["init_btc_payment", "confirm_btc_transfer", "get_btc_payment_status", "broadcast_btc_transaction", "connect_btc_wallet", "send_btc_transfer", "prepare_stake_btc"];

// ─── Main routing function ───────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, any>,
  config: MCPConfig
): Promise<ToolCallResult> {
  const start = Date.now();
  let result: any;
  let intent: any;

  if (CHAIN_TOOLS.includes(name)) {
    result = await chainTools.handle(name, args, config);
  } else if (INTENT_TOOLS.includes(name)) {
    const out = await intentTools.handle(name, args, config);
    result = out.result;
    intent = out.intent;
  } else if (TRUST_TOOLS.includes(name)) {
    result = await trustTools.handle(name, args, config);
  } else if (MARKETPLACE_TOOLS.includes(name)) {
    const out = await marketplaceTools.handle(name, args, config);
    result = out.result;
    intent = out.intent;
  } else if (VERIFY_TOOLS.includes(name)) {
    result = await verifyTools.handle(name, args, config);
  } else if (CANTON_TOOLS.includes(name)) {
    result = await cantonTools.handle(name, args, config);
  } else if (BTC_TOOLS.includes(name)) {
    const out = await btcTools.handle(name, args, config);
    result = out.result;
    if (out.intent) {
      intent = out.intent;
    }
  } else {
    throw new Error(`Unknown tool: ${name}`);
  }

  return {
    result,
    intent,
    toolMeta: {
      tool: name,
      args,
      durationMs: Date.now() - start,
    },
  };
}

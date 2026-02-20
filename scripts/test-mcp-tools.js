#!/usr/bin/env node
/**
 * VAEB MCP Server — Tool Integration Test
 *
 * Tests the full tool pipeline by calling handleToolCall() directly,
 * the same function used by both the stdio MCP server and Express bridge.
 *
 * Covers all 20 tools in a realistic demo sequence:
 *   Phase 1 — Recon:      get_wallet_balance, read_balance, get_price
 *   Phase 2 — Agents:     discover_agents, get_agent_reputation, get_agent_validations, compare_agents
 *   Phase 3 — Marketplace: search_marketplace, hire_human
 *   Phase 4 — ZK Pipeline: simulate_intent, estimate_gas, check_nonce, prove_intent, verify_proof, execute_payment
 *   Phase 5 — Trust:       post_feedback, get_receipt
 *   Phase 6 — DeFi:        create_intent, cancel_intent, (execute_intent)
 *
 * Run:
 *   node -r ts-node/register scripts/test-mcp-tools.js
 *   OR after building:
 *   node scripts/test-mcp-tools.js
 */

require("dotenv").config();

// Use ts-node if running from source, dist if built
let handleToolCall;
try {
  ({ handleToolCall } = require("../packages/mcp-server/dist/handlers"));
} catch {
  require("ts-node").register({ project: "../packages/mcp-server/tsconfig.json", transpileOnly: true });
  ({ handleToolCall } = require("../packages/mcp-server/src/handlers"));
}

// ─── Config (mirrors packages/server/src/config.ts) ──────────────────────────

const config = {
  walletPrivateKey: process.env.AGENT_PRIVATE_KEY || "",
  supportedChains: ["base_sepolia"],
  defaultChain: "base_sepolia",
  proverEndpoint: process.env.PROVER_ENDPOINT || "http://localhost:3001",
  requireManualApproval: false,
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  chainId: 84532,
  contracts: {
    AgentWallet: process.env.AGENT_WALLET_ADDRESS || "0x4D7c95c0dd8840CD597DF7D75fb2D7ADc08bA0AA",
    MockUSDC: "0xE66D20A340e3F45C55d3A7cfB6b25458d9b0d193",
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function call(label, tool, args = {}) {
  process.stdout.write(`  ${label.padEnd(40)}`);
  try {
    const out = await handleToolCall(tool, args, config);
    console.log(`✅  [${out.toolMeta.durationMs}ms]`);
    if (process.env.VERBOSE) console.log(JSON.stringify(out.result, null, 2));
    passed++;
    return out;
  } catch (err) {
    console.log(`❌  ${err.message}`);
    failed++;
    return null;
  }
}

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═".repeat(60));
  console.log("  VAEB MCP Server — Tool Integration Test");
  console.log("═".repeat(60));
  console.log(`  RPC:     ${config.rpcUrl}`);
  console.log(`  Wallet:  ${config.contracts.AgentWallet}`);
  console.log(`  Prover:  ${config.proverEndpoint}`);
  console.log(`  Tip: set VERBOSE=1 to print full tool output`);

  // ── Phase 1: Recon ────────────────────────────────────────────
  section("Phase 1 — Recon");

  await call("get_wallet_balance", "get_wallet_balance");

  await call("read_balance (AgentWallet USDC)", "read_balance", {
    wallet_address: config.contracts.AgentWallet,
    token_address: config.contracts.MockUSDC,
    chain: "base_sepolia",
  });

  await call("get_price (ETH/USDC)", "get_price", {
    from_token: "ETH",
    to_token: "USDC",
    chain: "base_sepolia",
  });

  // ── Phase 2: Agent Discovery ──────────────────────────────────
  section("Phase 2 — Agent Discovery");

  const agents = await call("discover_agents", "discover_agents", { chain: "base_sepolia" });

  const agentId = agents?.result?.agents?.[0]?.agentId ?? 1;

  await call("get_agent_reputation", "get_agent_reputation", { agent_id: agentId });
  await call("get_agent_validations", "get_agent_validations", { agent_id: agentId });
  await call("compare_agents", "compare_agents", { agent_ids: [1, 2] });

  // ── Phase 3: Marketplace ──────────────────────────────────────
  section("Phase 3 — Marketplace");

  await call("search_marketplace (dog walker)", "search_marketplace", { query: "dog walker" });

  const hire = await call("hire_human (dave, 15 USDC)", "hire_human", {
    human_id: "dave",
    task_description: "Walk my dog for 30 minutes",
    amount: "15",
  });

  const intentId = hire?.intent?.intentId ?? hire?.intent?.reviewId;

  // ── Phase 4: ZK Execution Pipeline ───────────────────────────
  section("Phase 4 — ZK Execution Pipeline");

  if (intentId) {
    await call("simulate_intent", "simulate_intent", { intent_id: intentId });
  } else {
    console.log("  simulate_intent             skipped (no intent_id)");
  }

  await call("estimate_gas", "estimate_gas", {
    action: "TRANSFER",
    token: config.contracts.MockUSDC,
    amount: 15,
    chain: "base_sepolia",
  });

  // check_nonce needs a nonce — use one from the hire intent if available
  const intentNonce = hire?.intent?.nonce ?? "0x" + "00".repeat(32);
  await call("check_nonce", "check_nonce", { nonce: intentNonce });

  // prove_intent — will call prover service (may fail if not running)
  if (intentId) {
    const stored = hire?.intent;
    await call("prove_intent", "prove_intent", {
      intent_bundle: stored?.bundle,
      derived_calldata: stored?.derivedCalldata,
      public_inputs: {
        commitment: stored?.bundle?.nonce ?? "0x" + "00".repeat(32),
        chainId: config.chainId,
        signerAddress: config.contracts.AgentWallet,
        multicallDataHash: "0x" + "00".repeat(32),
        nonce: intentNonce,
        expiry: Math.floor(Date.now() / 1000) + 600,
      },
    });
  } else {
    console.log("  prove_intent                skipped (no intent)");
  }

  // verify_proof — dummy signals (will fail without real proof, that's expected)
  await call("verify_proof (dummy — expect fail)", "verify_proof", {
    proof: "0x" + "00".repeat(256),
    public_signals: ["0", "0", "0", "0", "0", "0", "0"],
  });

  // execute_payment requires a real signature — skip in test
  console.log(`  ${"execute_payment".padEnd(40)}⏭️   skipped (requires wallet signature)`);

  // ── Phase 5: Trust & Receipt ──────────────────────────────────
  section("Phase 5 — Trust & Receipt");

  await call("post_feedback (agent 1, score 9)", "post_feedback", {
    agent_id: agentId,
    score: 9,
    tags: ["fast", "reliable"],
    comment: "Executed the intent perfectly",
  });

  await call("get_receipt (dummy hash)", "get_receipt", {
    tx_hash: "0x" + "ab".repeat(32),
    chain: "base_sepolia",
  });

  // ── Phase 6: DeFi Intent Flow ─────────────────────────────────
  section("Phase 6 — DeFi Intent (create → cancel)");

  const defi = await call("create_intent (50 USDC transfer)", "create_intent", {
    actions: [{
      type: "TRANSFER",
      token: config.contracts.MockUSDC,
      amount: 50,
      recipient: "0x000000000000000000000000000000000000dEaD",
    }],
    chain_preference: "base_sepolia",
    expiry_minutes: 10,
  });

  const defiIntentId = defi?.result?.intent_id;

  if (defiIntentId) {
    await call("cancel_intent", "cancel_intent", { intent_id: defiIntentId });
  } else {
    console.log("  cancel_intent               skipped (no intent_id)");
  }

  // execute_intent also requires a real signature — note it but skip
  console.log(`  ${"execute_intent".padEnd(40)}⏭️   skipped (requires wallet signature)`);

  // ── Summary ───────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log("═".repeat(60) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌ Test runner failed:", err.message);
  process.exit(1);
});

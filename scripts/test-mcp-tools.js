#!/usr/bin/env node
/**
 * VAEB MCP Server - Tool Coverage Test (Updated)
 *
 * Exercises all current MCP tools defined in tool-registry.ts, with
 * schema-correct arguments and basic output assertions.
 *
 * By default, real on-chain transactions are NOT executed. To enable
 * real txs, set:
 *   RUN_CREATE_WALLET=1      (requires AGENT_PRIVATE_KEY + factory address)
 *   RUN_EXECUTE_INTENT=1     (requires OWNER_PRIVATE_KEY + AGENT_PRIVATE_KEY)
 *
 * Run:
 *   node -r ts-node/register scripts/test-mcp-tools.js
 *   OR after building:
 *   node scripts/test-mcp-tools.js
 */

require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

let chainTools, intentTools, trustTools, walletTools, getToolDefinitions;
let intentSdk;
let tsNodeRegistered = false;

function registerTsNode(tsconfigPath) {
  if (tsNodeRegistered) return;
  require("ts-node").register({ project: tsconfigPath, transpileOnly: true });
  tsNodeRegistered = true;
}

try {
  ({ chainTools } = require("../packages/mcp-server/dist/tools/chain-tools"));
  ({ intentTools } = require("../packages/mcp-server/dist/tools/intent-tools"));
  ({ trustTools } = require("../packages/mcp-server/dist/tools/trust-tools"));
  ({ walletTools } = require("../packages/mcp-server/dist/tools/wallet-tools"));
  ({ getToolDefinitions } = require("../packages/mcp-server/dist/tool-registry"));
} catch {
  registerTsNode(path.join(__dirname, "../packages/mcp-server/tsconfig.json"));
  ({ chainTools } = require("../packages/mcp-server/src/tools/chain-tools"));
  ({ intentTools } = require("../packages/mcp-server/src/tools/intent-tools"));
  ({ trustTools } = require("../packages/mcp-server/src/tools/trust-tools"));
  ({ walletTools } = require("../packages/mcp-server/src/tools/wallet-tools"));
  ({ getToolDefinitions } = require("../packages/mcp-server/src/tool-registry"));
}

try {
  intentSdk = require("../packages/intent-sdk/dist");
} catch {
  registerTsNode(path.join(__dirname, "../packages/intent-sdk/tsconfig.json"));
  intentSdk = require("../packages/intent-sdk/src");
}

const { bundleFromJSON, signIntentBundle } = intentSdk || {};

// -- Config (derived from deployments.json + env overrides) --

const DEPLOYMENTS = require(
  path.join(__dirname, "../contracts/deployments/deployments.json")
);

const defaultChain = process.env.DEFAULT_CHAIN || "base_sepolia";
const chainDeployment = DEPLOYMENTS[defaultChain] || {};
const chainContracts = chainDeployment.contracts || {};
const chainWallets = chainDeployment.wallets || {};

const config = {
  walletPrivateKey: process.env.AGENT_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "",
  supportedChains: [defaultChain],
  defaultChain,
  proverEndpoint: process.env.PROVER_ENDPOINT || "http://localhost:3001",
  requireManualApproval: false,
  rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || chainDeployment.rpcUrl || "https://sepolia.base.org",
  chainId: chainDeployment.chainId || 84532,
  contracts: {
    AgentWallet: process.env.AGENT_WALLET_ADDRESS || chainContracts.AgentWallet,
    MockUSDC: process.env.MOCK_USDC_ADDRESS || chainContracts.MockUSDC,
    AgentWalletFactory: process.env.AGENT_WALLET_FACTORY_ADDRESS || chainContracts.AgentWalletFactory,
    Groth16Verifier: chainContracts.Groth16Verifier,
    Groth16VerifierAdapter: chainContracts.Groth16VerifierAdapter,
    MockZKVerifier: chainContracts.MockZKVerifier,
  },
};

const CHAIN_TOOLS = new Set([
  "get_wallet_balance",
  "check_nonce",
  "read_balance",
  "get_price",
  "estimate_gas",
  "get_receipt",
]);

const INTENT_TOOLS = new Set([
  "create_intent",
  "execute_intent",
  "simulate_intent",
  "cancel_intent",
]);

const WALLET_TOOLS = new Set([
  "create_wallet",
  "predict_wallet",
  "get_wallets",
]);

const TRUST_TOOLS = new Set([
  "discover_agents",
  "get_agent_reputation",
  "get_agent_validations",
  "post_feedback",
  "compare_agents",
]);

async function routeTool(tool, args) {
  if (CHAIN_TOOLS.has(tool)) return chainTools.handle(tool, args, config);
  if (INTENT_TOOLS.has(tool)) return intentTools.handle(tool, args, config);
  if (WALLET_TOOLS.has(tool)) return walletTools.handle(tool, args, config);
  if (TRUST_TOOLS.has(tool)) return trustTools.handle(tool, args, config);
  throw new Error(`Unknown tool: ${tool}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function section(title) {
  console.log(`\n${"-".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("-".repeat(60));
}

function randomNonce() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

let passed = 0;
let failed = 0;
let skipped = 0;
const covered = new Set();
const skippedTools = [];

async function call(label, tool, args = {}, options = {}) {
  if (options.skipReason) {
    console.log(`  ${label.padEnd(44)}SKIP (${options.skipReason})`);
    skipped++;
    skippedTools.push({ tool, reason: options.skipReason });
    return null;
  }

  const start = Date.now();
  process.stdout.write(`  ${label.padEnd(44)}`);
  try {
    const out = await routeTool(tool, args);
    const ms = Date.now() - start;
    if (options.validate) options.validate(out);
    console.log(`PASS [${ms}ms]`);
    if (process.env.VERBOSE) console.log(JSON.stringify(out, null, 2));
    passed++;
    covered.add(tool);
    return out;
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`FAIL [${ms}ms] ${err.message}`);
    failed++;
    return null;
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("  VAEB MCP Server - Tool Coverage Test");
  console.log("=".repeat(60));
  console.log(`  Chain:   ${config.defaultChain}`);
  console.log(`  RPC:     ${config.rpcUrl}`);
  console.log(`  Wallet:  ${config.contracts.AgentWallet || "(not set)"}`);
  console.log(`  Factory: ${config.contracts.AgentWalletFactory || "(not set)"}`);
  console.log(`  Prover:  ${config.proverEndpoint}`);
  console.log(`  Tip: set VERBOSE=1 to print full tool output`);

  // -- Chain Tools --
  section("Chain Tools");

  await call("get_wallet_balance", "get_wallet_balance", {}, {
    skipReason: config.contracts.AgentWallet ? null : "AgentWallet not configured",
    validate: (r) => {
      assert(r.agentWallet, "Missing agentWallet");
      assert(typeof r.eth === "string", "Missing eth balance");
    },
  });

  await call("check_nonce (fresh)", "check_nonce", {
    nonce: randomNonce(),
  }, {
    skipReason: config.contracts.AgentWallet ? null : "AgentWallet not configured",
    validate: (r) => {
      assert(typeof r.used === "boolean", "Missing used flag");
      assert(typeof r.safe_to_use === "boolean", "Missing safe_to_use");
    },
  });

  await call("read_balance (ETH)", "read_balance", {
    chain: defaultChain,
    token: "ETH",
    wallet: config.contracts.AgentWallet,
  }, {
    skipReason: config.contracts.AgentWallet ? null : "AgentWallet not configured",
    validate: (r) => {
      assert(typeof r.balance === "string", "Missing balance");
    },
  });

  await call("read_balance (USDC)", "read_balance", {
    chain: defaultChain,
    token: "USDC",
    wallet: config.contracts.AgentWallet,
  }, {
    skipReason: config.contracts.AgentWallet ? null : "AgentWallet not configured",
  });

  await call("get_price (ETH/USDC)", "get_price", {
    pair: "ETH/USDC",
    chains: [defaultChain],
  }, {
    validate: (r) => {
      assert(r.pair, "Missing pair");
    },
  });

  await call("estimate_gas (transfer)", "estimate_gas", {
    chain: defaultChain,
    operation: "transfer",
  }, {
    validate: (r) => {
      assert(r.estimatedGas, "Missing estimatedGas");
    },
  });

  await call("get_receipt (dummy)", "get_receipt", {
    chain: defaultChain,
    tx_hash: "0x" + "ab".repeat(32),
  }, {
    validate: (r) => {
      assert(r.status !== undefined || r.error, "Missing status");
    },
  });

  // -- Wallet Tools --
  section("Wallet Tools");

  const ownerAddress =
    process.env.OWNER_ADDRESS ||
    chainWallets.owner ||
    "0x77A93ecD2437DA60aAFDBF595e74e0317b0d0B47";

  await call("predict_wallet", "predict_wallet", {
    owner: ownerAddress,
    salt_index: 0,
  }, {
    skipReason: config.contracts.AgentWalletFactory ? null : "AgentWalletFactory not configured",
    validate: (r) => {
      assert(r.predicted_address, "Missing predicted_address");
    },
  });

  await call("get_wallets", "get_wallets", {
    owner: ownerAddress,
  }, {
    skipReason: config.contracts.AgentWalletFactory ? null : "AgentWalletFactory not configured",
  });

  await call("create_wallet", "create_wallet", {
    owner: ownerAddress,
    salt_index: 999,
  }, {
    skipReason: process.env.RUN_CREATE_WALLET === "1"
      ? null
      : "set RUN_CREATE_WALLET=1 to allow real deployment",
  });

  // -- Intent Tools --
  section("Intent Tools");

  let intentId = "";
  let intentBundleJson = null;

  const created = await call("create_intent (TRANSFER)", "create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "USDC",
      amount: 10,
      recipient: ownerAddress,
    }],
    chain_preference: "cheapest_gas",
    expiry_minutes: 10,
  }, {
    validate: (r) => {
      assert(r.intent_id, "Missing intent_id");
    },
  });

  if (created?.intent_id) {
    intentId = created.intent_id;
    intentBundleJson = created.bundle;
  }

  await call("simulate_intent", "simulate_intent", {
    intent_id: intentId,
  }, {
    skipReason: intentId ? null : "create_intent failed",
  });

  let cancelId = "";
  const cancelIntent = await call("create_intent (for cancel)", "create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "ETH",
      amount: 0.01,
      recipient: ownerAddress,
    }],
  });

  if (cancelIntent?.intent_id) cancelId = cancelIntent.intent_id;

  await call("cancel_intent", "cancel_intent", {
    intent_id: cancelId,
  }, {
    skipReason: cancelId ? null : "create_intent failed",
    validate: (r) => {
      assert(r.status === "cancelled", `Expected cancelled, got ${r.status}`);
    },
  });

  await call("cancel_intent (double)", "cancel_intent", {
    intent_id: cancelId,
  }, {
    skipReason: cancelId ? null : "create_intent failed",
    validate: (r) => {
      assert(r.status === "cancelled", `Expected cancelled, got ${r.status}`);
    },
  });

  // Optional: execute_intent - real on-chain tx + signature
  const runExecute = process.env.RUN_EXECUTE_INTENT === "1";
  const ownerKey = process.env.OWNER_PRIVATE_KEY || "";

  if (!runExecute) {
    await call("execute_intent", "execute_intent", {}, {
      skipReason: "set RUN_EXECUTE_INTENT=1 to allow real execution",
    });
  } else if (!ownerKey || !config.walletPrivateKey) {
    await call("execute_intent", "execute_intent", {}, {
      skipReason: "OWNER_PRIVATE_KEY and AGENT_PRIVATE_KEY required",
    });
  } else if (!intentId || !intentBundleJson) {
    await call("execute_intent", "execute_intent", {}, {
      skipReason: "create_intent failed",
    });
  } else if (!bundleFromJSON || !signIntentBundle) {
    await call("execute_intent", "execute_intent", {}, {
      skipReason: "intent-sdk not available",
    });
  } else {
    const owner = new ethers.Wallet(ownerKey);
    if (chainWallets.owner && owner.address.toLowerCase() !== chainWallets.owner.toLowerCase()) {
      await call("execute_intent", "execute_intent", {}, {
        skipReason: `OWNER_PRIVATE_KEY does not match deployments.json owner (${chainWallets.owner})`,
      });
    } else {
      const bundle = bundleFromJSON(intentBundleJson);
      const signature = await signIntentBundle(bundle, owner, config.contracts.AgentWallet);
      await call("execute_intent", "execute_intent", {
        intent_id: intentId,
        signature,
      });
    }
  }

  // -- Trust Tools --
  section("Trust Tools");

  const discovered = await call("discover_agents", "discover_agents", {
    chain: defaultChain,
  });

  const agentId = discovered?.recommended?.agent_id || 42;

  await call("get_agent_reputation", "get_agent_reputation", {
    agent_id: agentId,
  });

  await call("get_agent_validations", "get_agent_validations", {
    agent_id: agentId,
  });

  await call("compare_agents", "compare_agents", {
    agent_ids: [42, 78],
  });

  await call("post_feedback", "post_feedback", {
    agent_id: agentId,
    score: 9,
    tag1: "fast",
    tag2: "transfer",
    receipt_uri: "ipfs://Qm.../receipt.json",
    receipt_hash: "0x" + "00".repeat(32),
  });

  // -- Summary --

  const toolDefs = getToolDefinitions ? getToolDefinitions() : [];
  const toolNames = toolDefs.map((t) => t.name);
  const skippedSet = new Set(skippedTools.map((s) => s.tool));
  const missing = toolNames.filter((name) => !covered.has(name) && !skippedSet.has(name));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);

  if (missing.length > 0) {
    console.log(`  Missing coverage: ${missing.join(", ")}`);
  }

  if (skippedTools.length > 0) {
    console.log("  Skipped:");
    for (const s of skippedTools) {
      console.log(`   - ${s.tool}: ${s.reason}`);
    }
  }

  console.log("=".repeat(60) + "\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFAIL Test runner failed:", err.message);
  process.exit(1);
});

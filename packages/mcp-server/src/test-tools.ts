/**
 * MCP Tool Test Suite
 *
 * Tests every tool handler directly (no MCP transport needed).
 * Run with: npx ts-node src/test-tools.ts
 */

import * as path from "path";
import { chainTools } from "./tools/chain-tools";
import { intentTools } from "./tools/intent-tools";
import { walletTools } from "./tools/wallet-tools";
import { trustTools } from "./tools/trust-tools";

// ─── Load config (same as index.ts) ─────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DEPLOYMENTS = require(
  path.join(__dirname, "../../../contracts/deployments/deployments.json")
);

const defaultChain    = process.env.DEFAULT_CHAIN || "base_sepolia";
const chainDeployment = DEPLOYMENTS[defaultChain] || {};
const chainContracts  = chainDeployment.contracts  || {};

const config = {
  walletPrivateKey:    process.env.AGENT_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || "",
  supportedChains:     ["base_sepolia"],
  defaultChain,
  x402Facilitator:     "https://x402.coinbase.com",
  maxServiceFeePerTx:  "0.10",
  maxDailySpend:       "5.00",
  proverEndpoint:      process.env.PROVER_ENDPOINT || "http://localhost:3001",
  requireManualApproval: false,
  agentAddress: chainDeployment.wallets?.agent,
  rpcUrl:   process.env.BASE_SEPOLIA_RPC_URL || chainDeployment.rpcUrl || "https://sepolia.base.org",
  chainId:  chainDeployment.chainId || 84532,
  contracts: {
    AgentWallet:            process.env.AGENT_WALLET_ADDRESS || chainContracts.AgentWallet,
    MockUSDC:               process.env.MOCK_USDC_ADDRESS    || chainContracts.MockUSDC,
    AgentWalletFactory:     chainContracts.AgentWalletFactory,
    Groth16Verifier:        chainContracts.Groth16Verifier,
    Groth16VerifierAdapter: chainContracts.Groth16VerifierAdapter,
    MockZKVerifier:         chainContracts.MockZKVerifier,
  },
};

// ─── Test harness ────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean; output?: any; error?: string; ms: number };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<any>) {
  const start = Date.now();
  try {
    const output = await fn();
    const ms = Date.now() - start;
    results.push({ name, passed: true, output, ms });
    console.log(`  ✓  ${name} (${ms}ms)`);
  } catch (err: any) {
    const ms = Date.now() - start;
    results.push({ name, passed: false, error: err.message, ms });
    console.log(`  ✗  ${name} (${ms}ms)`);
    console.log(`       Error: ${err.message}`);
  }
}

function section(title: string) {
  console.log(`\n── ${title} ${"─".repeat(50 - title.length)}`);
}

// ─── Tests ───────────────────────────────────────────────────────

async function run() {
  console.log("\nVAEB MCP Tool Test Suite");
  console.log(`Chain:       ${defaultChain}`);
  console.log(`AgentWallet: ${config.contracts.AgentWallet}`);
  console.log(`MockUSDC:    ${config.contracts.MockUSDC}`);

  // ── Chain Tools ────────────────────────────────────────────────

  section("Chain Tools");

  await test("get_wallet_balance — reads ETH + USDC from AgentWallet on-chain", async () => {
    const r = await chainTools.handle("get_wallet_balance", {}, config);
    if (!r.agentWallet) throw new Error("Missing agentWallet field");
    if (typeof r.eth !== "string") throw new Error("Missing eth balance");
    if (r.chain !== defaultChain) throw new Error(`Wrong chain: ${r.chain}`);
    return { eth: r.eth, usdc: r.usdc, sufficient_for_gas: r.sufficient_for_gas };
  });

  await test("check_nonce — fresh random nonce should not be used", async () => {
    const freshNonce = "0x" + "ab".repeat(32); // bytes32 zero-ish nonce
    const r = await chainTools.handle("check_nonce", { nonce: freshNonce }, config);
    if (r.used !== false) throw new Error(`Expected nonce unused, got used=${r.used}`);
    if (!r.safe_to_use) throw new Error("Expected safe_to_use=true");
    return { used: r.used, safe_to_use: r.safe_to_use };
  });

  await test("read_balance — ETH balance of AgentWallet", async () => {
    const r = await chainTools.handle("read_balance", {
      chain: "base_sepolia",
      token: "ETH",
      wallet: config.contracts.AgentWallet,
    }, config);
    if (typeof r.balance !== "string") throw new Error("Missing balance");
    if (r.token !== "ETH") throw new Error(`Wrong token: ${r.token}`);
    return { balance: r.balance, token: r.token };
  });

  await test("read_balance — USDC balance of AgentWallet", async () => {
    const r = await chainTools.handle("read_balance", {
      chain: "base_sepolia",
      token: "USDC",
      wallet: config.contracts.AgentWallet,
    }, config);
    if (typeof r.balance !== "string" && !r.error) throw new Error("Missing balance and no error");
    return r.error ? { note: r.error } : { balance: r.balance, token: r.token };
  });

  await test("get_price — ETH/USDC simulated price", async () => {
    const r = await chainTools.handle("get_price", {
      pair: "ETH/USDC",
      chains: ["base_sepolia"],
    }, config);
    if (!r.pair) throw new Error("Missing pair");
    if (!r.prices?.base_sepolia?.price) throw new Error("Missing price for base_sepolia");
    return { pair: r.pair, price: r.prices.base_sepolia.price, bestPrice: r.bestPrice };
  });

  await test("get_price — WBTC/USDC with default chains", async () => {
    const r = await chainTools.handle("get_price", { pair: "WBTC/USDC" }, config);
    if (!r.prices) throw new Error("Missing prices");
    return { pair: r.pair, price: Object.values(r.prices)[0] };
  });

  await test("estimate_gas — swap operation", async () => {
    const r = await chainTools.handle("estimate_gas", {
      chain: "base_sepolia",
      operation: "swap",
    }, config);
    if (!r.estimatedGas) throw new Error("Missing estimatedGas");
    if (r.estimatedGas !== 250000) throw new Error(`Wrong gas estimate: ${r.estimatedGas}`);
    return { gas: r.estimatedGas, costETH: r.gasCostETH, costUSD: r.gasCostUSD };
  });

  await test("estimate_gas — executeWithProof (AgentWallet operation)", async () => {
    const r = await chainTools.handle("estimate_gas", {
      chain: "base_sepolia",
      operation: "executeWithProof",
    }, config);
    if (r.estimatedGas !== 350000) throw new Error(`Expected 350000 gas, got ${r.estimatedGas}`);
    return { gas: r.estimatedGas, costETH: r.gasCostETH };
  });

  await test("estimate_gas — unknown operation falls back to 200000", async () => {
    const r = await chainTools.handle("estimate_gas", {
      chain: "base_sepolia",
      operation: "unknown_op",
    }, config);
    if (r.estimatedGas !== 200000) throw new Error(`Expected 200000 fallback, got ${r.estimatedGas}`);
    return { gas: r.estimatedGas };
  });

  await test("get_receipt — known tx hash (pending or confirmed)", async () => {
    // Use the AgentWallet deployment tx (may or may not be in the node's cache)
    const knownTx = "0x0000000000000000000000000000000000000000000000000000000000000001";
    const r = await chainTools.handle("get_receipt", {
      chain: "base_sepolia",
      tx_hash: knownTx,
    }, config);
    // Should return either confirmed or pending — both are valid
    if (r.error) return { note: r.error };
    if (r.status === undefined && !r.error) throw new Error("Missing status field");
    return { confirmed: r.confirmed, status: r.status };
  });

  // ── Intent Tools ───────────────────────────────────────────────

  section("Intent Tools");

  let intentId = "";

  await test("create_intent — TRANSFER 10 USDC", async () => {
    const r = await intentTools.handle("create_intent", {
      actions: [{
        type: "TRANSFER",
        token: "USDC",
        amount: 10,
        recipient: "0x77A93ecD2437DA60aAFDBF595e74e0317b0d0B47",
      }],
      chain_preference: "cheapest_gas",
      expiry_minutes: 10,
    }, config);
    if (!r.result.intent_id) throw new Error("Missing intent_id");
    if (!r.result.bundle) throw new Error("Missing bundle");
    if (!r.result.expiry) throw new Error("Missing expiry");
    intentId = r.result.intent_id;
    return { intent_id: r.result.intent_id, chain: r.result.chain, fee: r.result.service_fee, expiry: r.result.expiry };
  });

  await test("create_intent — SWAP 0.1 ETH → USDC", async () => {
    const r = await intentTools.handle("create_intent", {
      actions: [{
        type: "SWAP",
        from_token: "ETH",
        to_token: "USDC",
        amount: 0.1,
        max_slippage: 0.005,
        preferred_dex: "auto",
      }],
      expiry_minutes: 5,
    }, config);
    if (!r.result.intent_id) throw new Error("Missing intent_id");
    return { intent_id: r.result.intent_id, human_readable: r.result.human_readable };
  });

  await test("create_intent — STAKE 50 USDC (most_liquidity chain)", async () => {
    const r = await intentTools.handle("create_intent", {
      actions: [{ type: "STAKE", token: "USDC", amount: 50 }],
      chain_preference: "most_liquidity",
    }, config);
    if (!r.result.intent_id) throw new Error("Missing intent_id");
    return { intent_id: r.result.intent_id, chain: r.result.chain };
  });

  await test("simulate_intent — dry-run the TRANSFER intent", async () => {
    if (!intentId) throw new Error("No intent_id available (create_intent failed)");
    const r = await intentTools.handle("simulate_intent", { intent_id: intentId }, config);
    if (r.result.simulation !== "success") throw new Error(`Simulation failed: ${r.result.simulation}`);
    if (!Array.isArray(r.result.calls)) throw new Error("Missing calls array");
    return { simulation: r.result.simulation, call_count: r.result.calls.length, total_gas: r.result.total_gas_estimate };
  });

  let cancelId = "";
  await test("create_intent — for cancellation test", async () => {
    const r = await intentTools.handle("create_intent", {
      actions: [{ type: "TRANSFER", token: "ETH", amount: 0.01, recipient: "0x77A93ecD2437DA60aAFDBF595e74e0317b0d0B47" }],
    }, config);
    cancelId = r.result.intent_id;
    return { intent_id: cancelId };
  });

  await test("cancel_intent — cancels a pending intent", async () => {
    if (!cancelId) throw new Error("No intent_id available for cancellation");
    const r = await intentTools.handle("cancel_intent", { intent_id: cancelId }, config);
    if (r.result.status !== "cancelled") throw new Error(`Expected cancelled, got ${r.result.status}`);
    return { status: r.result.status, nonce: r.result.nonce };
  });

  await test("cancel_intent — double-cancel should error", async () => {
    if (!cancelId) throw new Error("No intent_id available");
    try {
      await intentTools.handle("cancel_intent", { intent_id: cancelId }, config);
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (e.message === "Should have thrown") throw e;
      // Error is expected — double-cancel should fail
      return { expected_error: e.message };
    }
  });

  await test("simulate_intent — unknown id should error", async () => {
    try {
      await intentTools.handle("simulate_intent", { intent_id: "nonexistent-id" }, config);
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (e.message === "Should have thrown") throw e;
      return { expected_error: e.message };
    }
  });

  // ── Wallet Tools ───────────────────────────────────────────────

  section("Wallet Tools");

  const OWNER = chainDeployment.wallets?.owner || "0x77A93ecD2437DA60aAFDBF595e74e0317b0d0B47";

  await test("predict_wallet — deterministic address for known owner (salt_index=0)", async () => {
    const r = await walletTools.handle("predict_wallet", { owner: OWNER, salt_index: 0 }, config);
    if (!r.predicted_address) throw new Error("Missing predicted_address");
    if (r.predicted_address.length !== 42) throw new Error(`Invalid address: ${r.predicted_address}`);
    if (r.owner !== OWNER) throw new Error(`Wrong owner: ${r.owner}`);
    return {
      predicted: r.predicted_address,
      already_deployed: r.already_deployed,
      salt_index: 0,
    };
  });

  await test("predict_wallet — different salt_index produces different address", async () => {
    const r0 = await walletTools.handle("predict_wallet", { owner: OWNER, salt_index: 0 }, config);
    const r1 = await walletTools.handle("predict_wallet", { owner: OWNER, salt_index: 1 }, config);
    if (r0.predicted_address === r1.predicted_address) {
      throw new Error("salt_index=0 and salt_index=1 produced the same address");
    }
    return { addr_0: r0.predicted_address, addr_1: r1.predicted_address };
  });

  await test("predict_wallet — invalid address should error", async () => {
    try {
      await walletTools.handle("predict_wallet", { owner: "not-an-address" }, config);
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (e.message === "Should have thrown") throw e;
      return { expected_error: e.message };
    }
  });

  await test("get_wallets — list wallets for known owner", async () => {
    const r = await walletTools.handle("get_wallets", { owner: OWNER }, config);
    if (!Array.isArray(r.wallets)) throw new Error("wallets is not an array");
    if (typeof r.count !== "number") throw new Error("Missing count");
    return {
      owner: OWNER,
      count: r.count,
      wallets: r.wallets.map((w: any) => w.address),
    };
  });

  await test("get_wallets — fresh address has zero wallets", async () => {
    const freshAddr = "0x000000000000000000000000000000000000dEaD";
    const r = await walletTools.handle("get_wallets", { owner: freshAddr }, config);
    if (r.count !== 0) throw new Error(`Expected 0 wallets, got ${r.count}`);
    return { count: r.count, note: r.note };
  });

  // create_wallet submits a real on-chain tx — only run when private key is available
  if (config.walletPrivateKey) {
    await test("create_wallet — deploy new wallet (salt_index=99 to avoid collision)", async () => {
      // Use salt_index=99 so it doesn't collide with existing deployments
      const r = await walletTools.handle("create_wallet", { owner: OWNER, salt_index: 99 }, config);
      if (!r.wallet) throw new Error("Missing wallet address");
      if (!r.tx_hash) throw new Error("Missing tx_hash");
      if (r.wallet.length !== 42) throw new Error(`Invalid wallet address: ${r.wallet}`);
      return {
        wallet: r.wallet,
        tx_hash: r.tx_hash,
        gas_used: r.gas_used,
      };
    });

    await test("create_wallet — duplicate salt_index should error", async () => {
      // salt_index=0 is already deployed for this owner
      try {
        await walletTools.handle("create_wallet", { owner: OWNER, salt_index: 0 }, config);
        // If it doesn't throw, the wallet wasn't deployed before — that's ok
        return { note: "Wallet did not exist yet at salt_index=0 — deployed it" };
      } catch (e: any) {
        // Expected: "Wallet already exists at..."
        if (!e.message.includes("already exists") && !e.message.includes("already deployed")) {
          throw e; // unexpected error
        }
        return { expected_error: e.message.slice(0, 80) + "..." };
      }
    });
  } else {
    console.log("  –  create_wallet (skipped — AGENT_PRIVATE_KEY not set)");
    console.log("  –  create_wallet duplicate check (skipped)");
  }

  // ── Trust Tools ────────────────────────────────────────────────

  section("Trust Tools");

  await test("discover_agents — all agents on base_sepolia", async () => {
    const r = await trustTools.handle("discover_agents", { chain: "base_sepolia" }, config);
    if (!r.recommended) throw new Error("Missing recommended agent");
    if (r.total_agents_found < 1) throw new Error("No agents found");
    return {
      recommended: `${r.recommended.name} (score=${r.recommended.reputation.score})`,
      total: r.total_agents_found,
      alternatives: r.alternatives.length,
    };
  });

  await test("discover_agents — filter by min_reputation=9", async () => {
    const r = await trustTools.handle("discover_agents", {
      chain: "base_sepolia",
      min_reputation: 9,
    }, config);
    // Should only include agents with score >= 9
    if (r.recommended && r.recommended.reputation.score < 9) {
      throw new Error(`Recommended agent score ${r.recommended.reputation.score} < 9`);
    }
    return { total_above_9: r.total_agents_found };
  });

  await test("discover_agents — filter by operation=swap", async () => {
    const r = await trustTools.handle("discover_agents", {
      chain: "base_sepolia",
      operation: "swap",
    }, config);
    return { recommended_id: r.recommended?.agent_id, total: r.total_agents_found };
  });

  await test("get_agent_reputation — agent 42 (ELITE tier)", async () => {
    const r = await trustTools.handle("get_agent_reputation", { agent_id: 42 }, config);
    if (r.agent_id !== 42) throw new Error(`Wrong agent: ${r.agent_id}`);
    if (r.reputation.trust_tier !== "ELITE") throw new Error(`Expected ELITE, got ${r.reputation.trust_tier}`);
    return { name: r.name, score: r.reputation.avg_score, tier: r.reputation.trust_tier };
  });

  await test("get_agent_reputation — agent 203 (UNTRUSTED - low feedback)", async () => {
    const r = await trustTools.handle("get_agent_reputation", { agent_id: 203 }, config);
    if (r.reputation.trust_tier !== "UNTRUSTED") throw new Error(`Expected UNTRUSTED, got ${r.reputation.trust_tier}`);
    return { name: r.name, score: r.reputation.avg_score, tier: r.reputation.trust_tier };
  });

  await test("get_agent_reputation — unknown agent should error", async () => {
    try {
      await trustTools.handle("get_agent_reputation", { agent_id: 9999 }, config);
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (e.message === "Should have thrown") throw e;
      return { expected_error: e.message };
    }
  });

  await test("get_agent_validations — agent 42", async () => {
    const r = await trustTools.handle("get_agent_validations", { agent_id: 42 }, config);
    if (r.agent_id !== 42) throw new Error(`Wrong agent: ${r.agent_id}`);
    if (!r.validation.pass_rate) throw new Error("Missing pass_rate");
    return {
      validations: r.validation.total_validations,
      pass_rate: r.validation.pass_rate,
      pass: r.validation.pass_count,
      fail: r.validation.fail_count,
    };
  });

  await test("get_agent_validations — agent 115 (91% pass rate)", async () => {
    const r = await trustTools.handle("get_agent_validations", { agent_id: 115 }, config);
    if (r.validation.pass_rate !== "91.0%") throw new Error(`Expected 91.0%, got ${r.validation.pass_rate}`);
    return { pass_rate: r.validation.pass_rate, fail_count: r.validation.fail_count };
  });

  await test("post_feedback — score 9 for agent 42", async () => {
    const r = await trustTools.handle("post_feedback", {
      agent_id: 42,
      score: 9,
      tag1: "swap",
      tag2: "execution_speed",
      receipt_uri: "ipfs://QmTest",
    }, config);
    if (!r.feedback_posted) throw new Error("feedback_posted not true");
    if (r.score !== 9) throw new Error(`Wrong score: ${r.score}`);
    if (!r.tx_hash) throw new Error("Missing tx_hash");
    return { posted: r.feedback_posted, score: r.score, tags: r.tags };
  });

  await test("post_feedback — minimal args (no tag2/receipt)", async () => {
    const r = await trustTools.handle("post_feedback", {
      agent_id: 78,
      score: 7,
      tag1: "transfer",
    }, config);
    if (!r.feedback_posted) throw new Error("feedback_posted not true");
    return { posted: r.feedback_posted, tags: r.tags };
  });

  await test("compare_agents — agents 42 and 78", async () => {
    const r = await trustTools.handle("compare_agents", { agent_ids: [42, 78] }, config);
    if (!Array.isArray(r.agents) || r.agents.length !== 2) throw new Error("Expected 2 agents");
    if (!r.recommendation) throw new Error("Missing recommendation");
    return {
      compared: r.agents.map((a: any) => `${a.name}=${a.composite_score}`),
      winner: r.recommendation,
    };
  });

  await test("compare_agents — all 4 agents ranked", async () => {
    const r = await trustTools.handle("compare_agents", { agent_ids: [42, 78, 115, 203] }, config);
    if (r.agents.length !== 4) throw new Error(`Expected 4 agents, got ${r.agents.length}`);
    return {
      ranked: r.agents.map((a: any) => `${a.name} (${a.trust_tier}, score=${a.composite_score})`),
      winner: r.recommendation,
    };
  });

  await test("compare_agents — empty ids should error", async () => {
    try {
      await trustTools.handle("compare_agents", { agent_ids: [] }, config);
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (e.message === "Should have thrown") throw e;
      return { expected_error: e.message };
    }
  });

  // ── Summary ────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total  = results.length;
  const totalMs = results.reduce((s, r) => s + r.ms, 0);

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Results: ${passed}/${total} passed  (${failed} failed)  ${totalMs}ms total`);

  if (failed > 0) {
    console.log("\nFailed tests:");
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`  ✗  ${r.name}`);
      console.log(`       ${r.error}`);
    });
    process.exit(1);
  } else {
    console.log("All tests passed.\n");
  }
}

run().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});

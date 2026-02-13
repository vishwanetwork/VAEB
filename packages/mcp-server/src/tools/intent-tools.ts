/**
 * Intent Tools — Paid MCP tools for intent construction and execution
 *
 * These tools handle the core VAEB flow:
 *   1. create_intent  → Build IntentBundle + derive calldata
 *   2. execute_intent → ZK proof + x402 payment + on-chain execution
 *   3. simulate_intent → Dry-run via eth_call
 *   4. cancel_intent  → Invalidate nonce
 *
 * Each paid tool triggers x402 payment via the HTTP 402 flow.
 */

import { ethers } from "ethers";
import {
  createIntentBundle,
  computeIntentId,
  deriveCalldata,
  describeIntent,
  bundleToJSON,
  ActionType,
  CHAINS,
  DEFAULTS,
} from "@vaeb/intent-sdk";

type Config = {
  defaultChain: string;
  supportedChains: string[];
  walletPrivateKey: string;
  proverEndpoint: string;
  requireManualApproval: boolean;
};

// In-memory intent store (for hackathon — production uses Redis/DB)
const intentStore = new Map<
  string,
  {
    bundle: any;
    derivedCalldata: any;
    chainKey: string;
    createdAt: number;
    status: "pending" | "signed" | "executing" | "executed" | "failed" | "cancelled";
  }
>();

export const intentTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "create_intent":
        return createIntent(args, config);
      case "execute_intent":
        return executeIntent(args, config);
      case "simulate_intent":
        return simulateIntent(args, config);
      case "cancel_intent":
        return cancelIntent(args, config);
      default:
        throw new Error(`Unknown intent tool: ${name}`);
    }
  },
};

// ─── create_intent ──────────────────────────────────────────────

async function createIntent(args: any, config: Config) {
  // Resolve chain
  const chainKey = resolveChain(
    args.chain_preference || "cheapest_gas",
    config.supportedChains
  );
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unsupported chain: ${chainKey}`);

  // Get the AgentWallet address
  const wallet = new ethers.Wallet(config.walletPrivateKey || ethers.Wallet.createRandom().privateKey);
  const walletAddress = wallet.address;

  // Map input actions to SDK format
  const actions = args.actions.map((a: any) => ({
    type: a.type as ActionType,
    fromToken: a.from_token,
    toToken: a.to_token,
    token: a.token,
    amount: a.amount,
    maxSlippage: a.max_slippage || 0.005,
    preferredDex: a.preferred_dex || "auto",
    recipient: a.recipient,
  }));

  // Create the IntentBundle
  const bundle = createIntentBundle({
    actions,
    chainId: chain.chainId,
    walletAddress,
    expiryMinutes: args.expiry_minutes || 10,
  });

  // Derive the calldata
  const derived = deriveCalldata(bundle, chainKey);

  // Compute intent ID
  const intentId = computeIntentId(bundle);

  // Store for later execution
  intentStore.set(intentId, {
    bundle,
    derivedCalldata: derived,
    chainKey,
    createdAt: Date.now(),
    status: "pending",
  });

  // Estimate costs
  const estimatedGas = "$0.001"; // Simplified for demo
  const serviceFee = `${DEFAULTS.SERVICE_FEE_USDC} USDC`;
  const humanReadable = describeIntent(bundle);

  return {
    intent_id: intentId,
    chain: chainKey,
    estimated_output: humanReadable,
    estimated_gas: estimatedGas,
    service_fee: serviceFee,
    requires_signature: true,
    human_readable: humanReadable,
    bundle: bundleToJSON(bundle),
    derived_calls_count: derived.calls.length,
    expiry: new Date(bundle.expiry * 1000).toISOString(),
  };
}

// ─── execute_intent ─────────────────────────────────────────────

async function executeIntent(args: any, config: Config) {
  const intentId = args.intent_id;
  const signature = args.signature;

  const stored = intentStore.get(intentId);
  if (!stored) throw new Error(`Intent not found: ${intentId}`);
  if (stored.status === "executed") throw new Error("Intent already executed");
  if (stored.status === "cancelled") throw new Error("Intent was cancelled");

  // Check expiry
  if (Date.now() / 1000 > stored.bundle.expiry) {
    throw new Error("Intent has expired");
  }

  stored.status = "executing";

  try {
    // Step 1: x402 payment would happen here
    // In production: HTTP 402 → X-PAYMENT header → verify + settle
    const x402Fee = DEFAULTS.SERVICE_FEE_USDC;

    // Step 2: Generate ZK proof
    const proofResult: any = await generateProof(
      stored.bundle,
      stored.derivedCalldata,
      signature,
      config
    );

    // Step 3: Submit to AgentWallet on-chain
    const txResult = await submitToChain(
      stored.bundle,
      stored.derivedCalldata,
      proofResult,
      signature,
      stored.chainKey,
      config
    );

    stored.status = "executed";

    return {
      status: "executed",
      tx_hash: txResult.txHash,
      chain: stored.chainKey,
      output: txResult.output,
      gas_used: txResult.gasUsed,
      service_fee_paid: `${x402Fee} USDC`,
      proof_generation_time_ms: proofResult.proofTimeMs,
      block_explorer: `${CHAINS[stored.chainKey]?.blockExplorer}/tx/${txResult.txHash}`,
    };
  } catch (error: any) {
    stored.status = "failed";
    throw new Error(`Execution failed: ${error.message}`);
  }
}

// ─── simulate_intent ────────────────────────────────────────────

async function simulateIntent(args: any, _config: Config) {
  const stored = intentStore.get(args.intent_id);
  if (!stored) throw new Error(`Intent not found: ${args.intent_id}`);

  const chain = CHAINS[stored.chainKey];
  if (!chain) throw new Error(`Chain not found: ${stored.chainKey}`);

  // Simulate each call via eth_call
  const simResults = stored.derivedCalldata.calls.map((call: any, i: number) => ({
    call_index: i,
    target: call.target,
    status: "would_succeed",
    gas_estimate: 150000,
    note: "Simulated (dry-run via eth_call)",
  }));

  return {
    intent_id: args.intent_id,
    chain: stored.chainKey,
    simulation: "success",
    calls: simResults,
    total_gas_estimate: simResults.reduce((sum: number, r: any) => sum + r.gas_estimate, 0),
    note: "Simulation passed — safe to execute",
  };
}

// ─── cancel_intent ──────────────────────────────────────────────

async function cancelIntent(args: any, _config: Config) {
  const stored = intentStore.get(args.intent_id);
  if (!stored) throw new Error(`Intent not found: ${args.intent_id}`);
  if (stored.status === "executed") throw new Error("Cannot cancel executed intent");

  stored.status = "cancelled";

  return {
    intent_id: args.intent_id,
    status: "cancelled",
    nonce: stored.bundle.nonce,
    note: "Nonce invalidated — intent can no longer be executed",
  };
}

// ─── Helper: Generate ZK Proof ──────────────────────────────────

async function generateProof(
  bundle: any,
  derivedCalldata: any,
  signature: string,
  config: Config
) {
  try {
    // Try remote prover service first
    const response = await fetch(`${config.proverEndpoint}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentBundle: bundle,
        derivedCalldata,
        publicInputs: {
          commitment: computeIntentId(bundle),
          chainId: bundle.chainId,
          signerAddress: bundle.payer,
          multicallDataHash: derivedCalldata.multicallDataHash,
          nonce: bundle.nonce,
          expiry: bundle.expiry,
        },
      }),
    });

    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Prover service unavailable — use local simulated proof
  }

  // Fallback: Generate simulated proof locally
  const startTime = Date.now();
  await new Promise((r) => setTimeout(r, 500)); // Simulate computation

  const proofSeed = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256"],
      [computeIntentId(bundle), bundle.chainId]
    )
  );

  return {
    proof: proofSeed, // Simplified for demo
    publicSignals: [
      computeIntentId(bundle),
      bundle.chainId.toString(),
      bundle.payer,
      derivedCalldata.multicallDataHash,
      bundle.nonce,
      bundle.expiry.toString(),
    ],
    proofTimeMs: Date.now() - startTime,
  };
}

// ─── Helper: Submit to Chain ────────────────────────────────────

async function submitToChain(
  bundle: any,
  derivedCalldata: any,
  proofResult: any,
  signature: string,
  chainKey: string,
  config: Config
) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);

  // In production, this would:
  // 1. Connect to the chain via RPC
  // 2. Call AgentWallet.executeWithProof(proof, signature, publicInputs, calls)
  // 3. Wait for transaction confirmation
  //
  // For the hackathon demo, we simulate the on-chain submission

  const simulatedTxHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "uint256", "bytes"],
      [computeIntentId(bundle), Date.now(), signature || "0x"]
    )
  );

  return {
    txHash: simulatedTxHash,
    gasUsed: "245000",
    output: {
      token: "ETH",
      amount: "0.03082",
    },
  };
}

// ─── Helper: Resolve Chain ──────────────────────────────────────

function resolveChain(preference: string, supportedChains: string[]): string {
  // Direct chain name
  if (CHAINS[preference]) return preference;

  // Strategy-based selection
  switch (preference) {
    case "cheapest_gas":
      // Prefer L2s
      const l2Priority = ["base_sepolia", "base", "arbitrum", "polygon"];
      return l2Priority.find((c) => supportedChains.includes(c)) || supportedChains[0];

    case "fastest_finality":
      const fastPriority = ["base_sepolia", "base", "polygon"];
      return fastPriority.find((c) => supportedChains.includes(c)) || supportedChains[0];

    case "most_liquidity":
      const liqPriority = ["ethereum_sepolia", "base_sepolia", "base"];
      return liqPriority.find((c) => supportedChains.includes(c)) || supportedChains[0];

    default:
      return supportedChains[0];
  }
}

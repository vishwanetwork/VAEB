/**
 * Marketplace Tools — "Rent a Human" marketplace for VAEB MCP
 *
 * These tools let any AI agent (via MCP) search for available humans
 * and create payment intents to hire them. Payments route through the
 * VAEB MCP create_intent pipeline (ERC-8150 ZK-verified execution).
 */

import { ethers } from "ethers";
import type { MCPConfig } from "../handlers";
import { intentTools } from "./intent-tools";

// ─── Marketplace Data ────────────────────────────────────────

interface Human {
  id: string;
  name: string;
  rating: number;
  reviews: number;
  rate: number;
  skills: string[];
  distance: string;
  address: string;
  bio: string;
  available: boolean;
}

const HUMANS: Human[] = [
  {
    id: "alice",
    name: "Alice",
    rating: 4.8,
    reviews: 127,
    rate: 25,
    skills: ["grocery shopping", "errands", "delivery", "pet care"],
    distance: "0.3 mi",
    address: "0x000000000000000000000000000000000000dEaD",
    bio: "Reliable errand runner. Fast grocery shopper. Have car.",
    available: true,
  },
  {
    id: "bob",
    name: "Bob",
    rating: 4.2,
    reviews: 83,
    rate: 20,
    skills: ["delivery", "pickup", "moving", "dry cleaning"],
    distance: "1.1 mi",
    address: "0x0000000000000000000000000000000000000002",
    bio: "Quick pickups and deliveries. Truck available for moves.",
    available: true,
  },
  {
    id: "carol",
    name: "Carol",
    rating: 4.9,
    reviews: 214,
    rate: 35,
    skills: ["personal assistant", "errands", "organizing", "scheduling"],
    distance: "0.5 mi",
    address: "0x0000000000000000000000000000000000000003",
    bio: "Former EA. Can handle complex multi-step errands.",
    available: true,
  },
  {
    id: "dave",
    name: "Dave",
    rating: 4.5,
    reviews: 56,
    rate: 15,
    skills: ["dog walking", "pet care", "house sitting"],
    distance: "0.8 mi",
    address: "0x0000000000000000000000000000000000000004",
    bio: "Animal lover. Certified pet first aid. Flexible schedule.",
    available: true,
  },
];

function searchHumans(query: string): Human[] {
  const q = query.toLowerCase();
  return HUMANS.filter(
    (h) =>
      h.available &&
      (h.skills.some((s) => s.includes(q)) ||
        h.name.toLowerCase().includes(q) ||
        h.bio.toLowerCase().includes(q))
  );
}

function getHuman(id: string): Human | undefined {
  return HUMANS.find((h) => h.id === id);
}

// ─── Shared Intent Store ─────────────────────────────────────
// Exported so the Express /chat/execute endpoint can look up intents

export interface StoredIntent {
  nonce: string;
  expiry: number;
  calls: Array<{ target: string; value: bigint; data: string }>;
  callsHash: string;
  humanId: string;
  humanName: string;
  amount: string;
  task: string;
  recipient: string;
}

export const intentStore = new Map<string, StoredIntent>();

// ─── Tool Handlers ───────────────────────────────────────────

export const marketplaceTools = {
  async handle(
    name: string,
    args: any,
    config: MCPConfig
  ): Promise<{ result: any; intent?: any }> {
    switch (name) {
      case "search_marketplace":
        return { result: handleSearchMarketplace(args) };
      case "hire_human":
        return handleHireHuman(args, config);
      case "get_wallet_balance":
        return { result: await handleGetWalletBalance(config) };
      case "execute_payment":
        return await handleExecutePayment(args, config);
      default:
        throw new Error(`Unknown marketplace tool: ${name}`);
    }
  },
};

// ─── search_marketplace ──────────────────────────────────────

function handleSearchMarketplace(args: { query: string }) {
  const results = searchHumans(args.query);
  if (results.length === 0) {
    return {
      found: 0,
      message: `No humans found matching "${args.query}". Try a broader search term.`,
    };
  }

  const formatted = results
    .map(
      (h) =>
        `- **${h.name}** (${h.id}) — ${h.rating}★ (${h.reviews} reviews) — $${h.rate} USDC — ${h.distance} away\n  Skills: ${h.skills.join(", ")}\n  "${h.bio}"`
    )
    .join("\n");

  return {
    found: results.length,
    humans: results.map((h) => ({
      id: h.id,
      name: h.name,
      rating: h.rating,
      reviews: h.reviews,
      rate_usdc: h.rate,
      skills: h.skills,
      distance: h.distance,
      bio: h.bio,
    })),
    formatted: `Found ${results.length} available humans:\n${formatted}`,
  };
}

// ─── hire_human ──────────────────────────────────────────────
// Routes through VAEB MCP create_intent to produce a standard
// ERC-8150 intent bundle — same ZK pipeline as DeFi actions.

async function handleHireHuman(
  args: { human_id: string; task_description: string; amount: string },
  config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const human = getHuman(args.human_id);
  if (!human) {
    return { result: `Human "${args.human_id}" not found.` };
  }

  // Create a TRANSFER intent through the VAEB MCP intent pipeline
  const intentResult = await intentTools.handle("create_intent", {
    actions: [{
      type: "TRANSFER",
      token: config.contracts?.MockUSDC || "USDC",
      amount: parseFloat(args.amount),
      recipient: human.address,
    }],
    chain_preference: config.defaultChain || "base_sepolia",
    expiry_minutes: 10,
  }, config as any);

  return {
    result: `Payment intent created via VAEB MCP. The user needs to sign to approve paying ${args.amount} USDC to ${human.name}. Intent ID: ${intentResult.intent_id}`,
    intent: {
      intentId: intentResult.intent_id,
      humanName: human.name,
      humanId: human.id,
      humanRating: human.rating,
      task: args.task_description,
      amount: args.amount,
      recipient: human.address,
      chain: intentResult.chain,
      expiry: intentResult.expiry,
      bundle: intentResult.bundle,
      requires_signature: true,
    },
  };
}

// ─── execute_payment ─────────────────────────────────────────
// Full ERC-8150 pipeline: check_nonce → prove → executeWithProof

const WALLET_ABI = [
  "function isNonceUsed(bytes32 nonce) view returns (bool)",
  "function executeDirectly(bytes signature, bytes32 nonce, uint256 expiry, tuple(address target, uint256 value, bytes data)[] calls)",
  "function executeWithProof(bytes proof, bytes signature, tuple(bytes32 commitment, uint256 chainId, address signerAddress, bytes32 multicallDataHash, bytes32 nonce, uint256 expiry) publicInputs, tuple(address target, uint256 value, bytes data)[] calls)",
  "event IntentExecuted(bytes32 indexed intentId, address indexed signer, bytes32 nonce, uint256 callCount, uint256 gasUsed)",
];

const ERC20_BALANCE_ABI = [
  "function balanceOf(address) view returns (uint256)",
];

interface ExecutionStep {
  step: string;
  status: "success" | "skipped" | "fallback";
  durationMs: number;
  detail?: string;
}

async function handleExecutePayment(
  args: { review_id: string; signature: string },
  config: MCPConfig
): Promise<{ result: any; intent?: any }> {
  const { review_id, signature } = args;
  const steps: ExecutionStep[] = [];

  const intent = intentStore.get(review_id);
  if (!intent) {
    throw new Error("Intent not found or expired");
  }

  if (Math.floor(Date.now() / 1000) > intent.expiry) {
    intentStore.delete(review_id);
    throw new Error("Intent has expired");
  }

  if (!config.rpcUrl || !config.walletPrivateKey || !config.contracts?.AgentWallet) {
    throw new Error("Missing RPC URL, wallet key, or contract addresses");
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const agentSigner = new ethers.Wallet(config.walletPrivateKey, provider);
  const walletContract = new ethers.Contract(
    config.contracts.AgentWallet,
    WALLET_ABI,
    agentSigner
  );

  // ── Step 1: Check nonce on-chain ──────────────────────────
  let stepStart = Date.now();
  const nonceUsed = await walletContract.isNonceUsed(intent.nonce);
  steps.push({
    step: "check_nonce",
    status: "success",
    durationMs: Date.now() - stepStart,
    detail: nonceUsed ? "NONCE ALREADY USED" : "nonce available",
  });
  if (nonceUsed) {
    throw new Error("Nonce already used — this intent was already executed");
  }

  // ── Step 2: Get before-balance ────────────────────────────
  stepStart = Date.now();
  let balanceBefore = "0";
  if (config.contracts.MockUSDC) {
    const usdc = new ethers.Contract(config.contracts.MockUSDC, ERC20_BALANCE_ABI, provider);
    const bal = await usdc.balanceOf(config.contracts.AgentWallet);
    balanceBefore = ethers.formatUnits(bal, 6);
  }
  steps.push({
    step: "get_wallet_balance",
    status: "success",
    durationMs: Date.now() - stepStart,
    detail: `${balanceBefore} USDC`,
  });

  // ── Step 3: Generate ZK proof via prover service ──────────
  stepStart = Date.now();
  let proofResult: { proof: string; publicSignals: string[]; mode: string } | null = null;
  let useZkPath = false;

  const proverEndpoint = config.proverEndpoint || "http://localhost:3001";
  try {
    // Build public inputs for the prover
    const commitment = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "bytes32"],
        [intent.nonce, intent.expiry, config.contracts.AgentWallet, intent.callsHash]
      )
    );

    const response = await fetch(`${proverEndpoint}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intentBundle: {
          payer: config.contracts.AgentWallet,
          actions: [{
            actionType: "TRANSFER",
            token: config.contracts.MockUSDC,
            to: intent.recipient,
            amount: ethers.parseUnits(intent.amount, 6).toString(),
          }],
        },
        derivedCalldata: {
          calls: intent.calls.map(c => ({
            target: c.target,
            value: c.value.toString(),
            data: c.data,
          })),
        },
        publicInputs: {
          commitment,
          chainId: config.chainId || 84532,
          signerAddress: config.contracts.AgentWallet,
          multicallDataHash: intent.callsHash,
          nonce: intent.nonce,
          expiry: intent.expiry,
        },
      }),
    });

    if (response.ok) {
      proofResult = await response.json() as { proof: string; publicSignals: string[]; mode: string };
      useZkPath = true;
      steps.push({
        step: "prove_intent",
        status: "success",
        durationMs: Date.now() - stepStart,
        detail: `Groth16 proof generated (${proofResult!.mode} mode, ${Date.now() - stepStart}ms)`,
      });
    } else {
      steps.push({
        step: "prove_intent",
        status: "fallback",
        durationMs: Date.now() - stepStart,
        detail: `Prover returned ${response.status}, falling back to executeDirectly`,
      });
    }
  } catch {
    steps.push({
      step: "prove_intent",
      status: "fallback",
      durationMs: Date.now() - stepStart,
      detail: "Prover service unavailable, falling back to executeDirectly",
    });
  }

  // ── Step 4: Execute on-chain ──────────────────────────────
  stepStart = Date.now();
  let tx: any;

  if (useZkPath && proofResult) {
    // Full ERC-8150 path: executeWithProof()
    const publicInputsStruct = {
      commitment: ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "uint256", "address", "bytes32"],
          [intent.nonce, intent.expiry, config.contracts.AgentWallet, intent.callsHash]
        )
      ),
      chainId: config.chainId || 84532,
      signerAddress: config.contracts.AgentWallet,
      multicallDataHash: intent.callsHash,
      nonce: intent.nonce,
      expiry: intent.expiry,
    };

    tx = await walletContract.executeWithProof(
      proofResult.proof,
      signature,
      publicInputsStruct,
      intent.calls,
      { gasLimit: 500000 }
    );

    steps.push({
      step: "executeWithProof",
      status: "success",
      durationMs: Date.now() - stepStart,
      detail: `AgentWallet.executeWithProof() — ZK verified on-chain`,
    });
  } else {
    // Fallback: executeDirectly (signature only, no ZK proof)
    tx = await walletContract.executeDirectly(
      signature,
      intent.nonce,
      intent.expiry,
      intent.calls,
      { gasLimit: 300000 }
    );

    steps.push({
      step: "executeDirectly",
      status: "fallback",
      durationMs: Date.now() - stepStart,
      detail: "AgentWallet.executeDirectly() — signature verified",
    });
  }

  // ── Step 5: Wait for confirmation + after-balance ─────────
  stepStart = Date.now();
  const receipt = await tx.wait();

  let balanceAfter = "0";
  if (config.contracts.MockUSDC) {
    const usdc = new ethers.Contract(config.contracts.MockUSDC, ERC20_BALANCE_ABI, provider);
    const bal = await usdc.balanceOf(config.contracts.AgentWallet);
    balanceAfter = ethers.formatUnits(bal, 6);
  }

  steps.push({
    step: "confirm_tx",
    status: "success",
    durationMs: Date.now() - stepStart,
    detail: `Block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`,
  });

  const explorer = "https://sepolia.basescan.org";
  intentStore.delete(review_id);

  return {
    result: {
      status: "executed",
      executionPath: useZkPath ? "executeWithProof" : "executeDirectly",
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      explorerUrl: `${explorer}/tx/${tx.hash}`,
      balanceBefore,
      balanceAfter,
      humanName: intent.humanName,
      amount: intent.amount,
      task: intent.task,
      steps,
    },
  };
}

// ─── get_wallet_balance ──────────────────────────────────────

async function handleGetWalletBalance(config: MCPConfig) {
  if (!config.rpcUrl || !config.contracts?.AgentWallet) {
    return { error: "RPC URL or AgentWallet address not configured." };
  }

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
  ];

  try {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl);

    const [eth] = await Promise.all([
      provider.getBalance(config.contracts.AgentWallet),
    ]);

    let usdcBal = "0";
    if (config.contracts.MockUSDC) {
      const usdc = new ethers.Contract(
        config.contracts.MockUSDC,
        ERC20_ABI,
        provider
      );
      const bal = await usdc.balanceOf(config.contracts.AgentWallet);
      usdcBal = ethers.formatUnits(bal, 6);
    }

    return {
      wallet: config.contracts.AgentWallet,
      eth: ethers.formatEther(eth),
      usdc: usdcBal,
      formatted: `AgentWallet balance:\n- ${ethers.formatEther(eth)} ETH\n- ${usdcBal} USDC`,
    };
  } catch (err: any) {
    return { error: `Failed to check balance: ${err.message}` };
  }
}

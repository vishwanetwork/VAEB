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
import { bundleFromJSON, deriveCalldata, getZKIntentTypedData } from "@vaeb/intent-sdk";
import { getContract, getProvider } from "./deps";

// ─── Poseidon helper (matches IntentVerifier.circom exactly) ─────────────────

let _poseidonFn: any = null;
async function getPoseidon(): Promise<any> {
  if (_poseidonFn) return _poseidonFn;
  const { buildPoseidon } = await import("circomlibjs");
  _poseidonFn = await buildPoseidon();
  return _poseidonFn;
}

// (Old IntentBundle EIP-712 type hashes removed — replaced by ZKIntent typed struct)

// ─── Poseidon helpers (matches IntentVerifier.circom + demo-zkproof.js) ──────
//
// From demo-zkproof.js:
//   actionAmounts[0] = tokenAmount  (actual ERC20 amount, not ETH call value)
//   derivedValues[0] = tokenAmount  (circuit constraint: derivedValues[i*2] == actionAmounts[i])

async function computePoseidonCommitment(
  chainId: number,
  nonce: string,
  expiry: number,
  payer: string,    // AgentWallet address
  token: string,
  recipient: string,
  amountBaseUnits: bigint,  // actual token amount (e.g. 25_000_000n for 25 USDC)
): Promise<bigint> {
  const P = await getPoseidon();
  const F = P.F;

  const bundleHash = P([
    1n,
    BigInt(chainId),
    BigInt(nonce),
    BigInt(expiry),
    BigInt(payer),
    1n,  // numActions = 1
  ]);

  const actionHash0 = P([
    1n,                  // actionType = TRANSFER
    BigInt(token),
    BigInt(recipient),
    amountBaseUnits,     // actual token amount (matches circuit's actionAmounts[0])
  ]);

  const paddingHash = P([0n, 0n, 0n, 0n]);
  const commitment = P([bundleHash, actionHash0, paddingHash, paddingHash, paddingHash]);
  return BigInt(F.toString(commitment));
}

async function computePoseidonMulticallHash(
  calls: Array<{ target: string; value: bigint; data: string }>,
  derivedValues: bigint[],  // per-slot values for the circuit (not ETH call value)
): Promise<bigint> {
  const P = await getPoseidon();
  const F = P.F;
  const MAX_CALL_SLOTS = 8; // MAX_ACTIONS * 2

  const paddingCallHash = P([0n, 0n, 0n]);
  const singleHashes: any[] = [];

  for (let i = 0; i < MAX_CALL_SLOTS; i++) {
    if (i < calls.length) {
      const c = calls[i];
      const dataHash = BigInt(ethers.keccak256(c.data));
      const dv = i < derivedValues.length ? derivedValues[i] : 0n;
      singleHashes.push(P([BigInt(c.target), dv, dataHash]));
    } else {
      singleHashes.push(paddingCallHash);
    }
  }

  const result = P(singleHashes);
  return BigInt(F.toString(result));
}

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

function fuzzyMatch(text: string, query: string): boolean {
  // Direct substring match (either direction)
  if (text.includes(query) || query.includes(text)) return true;
  // Word-level overlap: any query word shares a 3+ char prefix with any text word
  const textWords = text.split(/\s+/);
  const queryWords = query.split(/\s+/);
  for (const qw of queryWords) {
    if (qw.length < 3) continue;
    const prefix = qw.slice(0, Math.max(3, qw.length - 3)); // e.g. "groceries" → "grocer"
    if (textWords.some((tw) => tw.startsWith(prefix) || prefix.startsWith(tw.slice(0, 3)))) return true;
  }
  return false;
}

function searchHumans(query: string): Human[] {
  const q = query.toLowerCase();
  return HUMANS.filter(
    (h) =>
      h.available &&
      (h.skills.some((s) => fuzzyMatch(s, q)) ||
        fuzzyMatch(h.name.toLowerCase(), q) ||
        fuzzyMatch(h.bio.toLowerCase(), q))
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
  humanId: string;
  humanName: string;
  amount: string;
  task: string;
  recipient: string;
  payer: string;        // AgentWallet address
  token: string;        // ERC20 address
  commitmentHex: string; // Poseidon commitment (hex) — used as publicInputs.commitment
  userAddress: string;   // Owner EOA — holds funds, signed the ZKIntent
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

  // Create a TRANSFER intent to obtain a nonce and expiry from the bundle
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

  const bundle = bundleFromJSON(intentResult.result.bundle);
  const amountInBaseUnits = ethers.parseUnits(args.amount.toString(), 6);

  // Get USDC address from config or derive it
  let usdcAddress = config.contracts?.MockUSDC;
  if (!usdcAddress) {
    const derived = await deriveCalldata(bundle, intentResult.result.chain);
    usdcAddress = derived.calls[0]?.target;
  }

  const payerAddr = config.contracts?.AgentWallet ?? "";
  const chainId = config.chainId || bundle.chainId;
  const userAddress = config.ownerAddress || "";

  // ERC-8150 non-custodial: user holds funds, AgentWallet calls transferFrom(user, recipient, amount)
  const erc20Iface = new ethers.Interface([
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  ]);
  const calls = [{
    target: usdcAddress,
    value: 0n,
    data: erc20Iface.encodeFunctionData("transferFrom", [userAddress, human.address, amountInBaseUnits]),
  }];

  // Compute Poseidon commitment (matches IntentVerifier.circom exactly)
  const poseidonCommitment = await computePoseidonCommitment(
    chainId,
    bundle.nonce,
    bundle.expiry,
    payerAddr,
    usdcAddress,
    human.address,
    amountInBaseUnits,
  );
  const commitmentHex = ethers.toBeHex(poseidonCommitment, 32);

  const reviewId = ethers.hexlify(ethers.randomBytes(16));

  // Build ZKIntent EIP-712 typed data for user to sign
  // User signs ZKIntent(nonce, expiry, commitment) where commitment = Poseidon hash
  const eip712 = getZKIntentTypedData(
    bundle.nonce,
    bundle.expiry,
    commitmentHex,
    payerAddr,
    chainId,
  );

  intentStore.set(reviewId, {
    nonce: bundle.nonce,
    expiry: bundle.expiry,
    calls,
    humanId: human.id,
    humanName: human.name,
    amount: args.amount,
    task: args.task_description,
    recipient: human.address,
    payer: payerAddr,
    token: usdcAddress,
    commitmentHex,
    userAddress,
  });

  return {
    result: `Payment intent created via VAEB MCP. The user needs to approve USDC spending and sign to approve paying ${args.amount} USDC to ${human.name}. Intent ID: ${intentResult.result.intent_id}`,
    intent: {
      reviewId,
      nonce: bundle.nonce,
      expiry: bundle.expiry,
      expiryFormatted: new Date(bundle.expiry * 1000).toISOString(),
      eip712,
      humanName: human.name,
      humanId: human.id,
      humanRating: human.rating,
      task: args.task_description,
      amount: args.amount,
      recipient: human.address,
      chain: intentResult.result.chain,
      expiry_iso: intentResult.result.expiry,
      bundle: intentResult.result.bundle,
      requires_approval: true,
      requires_signature: true,
      approvalTarget: payerAddr,
      approvalToken: usdcAddress,
      approvalAmount: amountInBaseUnits.toString(),
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

  const provider = getProvider(
    config.defaultChain || "base_sepolia",
    config.rpcUrl,
    config.providerFactory
  );
  const agentSigner = new ethers.Wallet(config.walletPrivateKey, provider);
  const walletContract = getContract(
    config.contracts.AgentWallet,
    WALLET_ABI,
    agentSigner,
    config.contractFactory
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

  // ── Step 2: Get before-balance (non-custodial: check user's EOA) ──
  stepStart = Date.now();
  const userAddress = intent.userAddress || config.ownerAddress || "";
  let balanceBefore = "0";
  if (config.contracts.MockUSDC && userAddress) {
    const usdc = getContract(
      config.contracts.MockUSDC,
      ERC20_BALANCE_ABI,
      provider,
      config.contractFactory
    );
    const bal = await usdc.balanceOf(userAddress);
    balanceBefore = ethers.formatUnits(bal, 6);
  }
  steps.push({
    step: "get_user_balance",
    status: "success",
    durationMs: Date.now() - stepStart,
    detail: `${balanceBefore} USDC (user EOA: ${userAddress.slice(0, 10)}...)`,
  });

  // ── Step 3: Build commitment + Poseidon inputs ────────────
  stepStart = Date.now();
  const proverEndpoint = config.proverEndpoint || "http://localhost:3001";
  const fetchFn = config.fetchFn || fetch;
  const chainId = config.chainId || 84532;
  const signerAddress = userAddress || config.contracts.AgentWallet;
  const tokenAddress = intent.token || config.contracts?.MockUSDC || intent.calls[0].target;
  const amountBaseUnits = ethers.parseUnits(intent.amount, 6);

  // Use stored Poseidon commitment from handleHireHuman (matches what user signed via ZKIntent)
  const commitment = intent.commitmentHex;

  // Poseidon multicall hash for the ZK circuit
  const poseidonMulticallHash = await computePoseidonMulticallHash(
    intent.calls,
    [amountBaseUnits],  // derivedValues[0] = token amount
  );

  const publicInputsStruct = {
    commitment,                                         // Poseidon commitment (ZKIntent)
    chainId,
    signerAddress,
    multicallDataHash: ethers.toBeHex(poseidonMulticallHash, 32),
    nonce: intent.nonce,
    expiry: intent.expiry,
  };

  // ── Step 3b: Generate ZK proof via prover service ──────────
  const proverResponse = await fetchFn(`${proverEndpoint}/prove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intentBundle: {
        payer: intent.payer,
        actions: [{
          actionType: "TRANSFER",
          token: tokenAddress,
          to: intent.recipient,
          amount: amountBaseUnits.toString(),
        }],
      },
      derivedCalldata: {
        // Pass amountBaseUnits as value so derivedValues[0] == actionAmounts[0] in circuit
        calls: intent.calls.map((c, i) => ({
          target: c.target,
          value: i === 0 ? amountBaseUnits.toString() : "0",
          data: c.data,
        })),
      },
      publicInputs: {
        commitment,
        chainId,
        signerAddress,
        multicallDataHash: ethers.toBeHex(poseidonMulticallHash, 32),
        nonce: intent.nonce,
        expiry: intent.expiry,
      },
    }),
  });

  let executionPath: "executeWithProof" | "executeDirectly" = "executeWithProof";
  let tx: any;

  if (!proverResponse.ok) {
    // Prover unavailable — fall back to signature-only execution
    steps.push({
      step: "prove_intent",
      status: "fallback",
      durationMs: Date.now() - stepStart,
      detail: `Prover returned ${proverResponse.status} — falling back to executeDirectly`,
    });

    stepStart = Date.now();
    executionPath = "executeDirectly";
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
      detail: "AgentWallet.executeDirectly() — signature-only fallback",
    });
  } else {
    const proofResult = await proverResponse.json() as { proof: string; publicSignals: string[]; mode: string };
    const proofBytes = proofResult.proof;
    const proofMode = proofResult.mode;

    steps.push({
      step: "prove_intent",
      status: "success",
      durationMs: Date.now() - stepStart,
      detail: `Groth16 proof generated (${proofMode} mode, ${Date.now() - stepStart}ms)`,
    });

    // ── Step 4: Execute on-chain via executeWithProof ─────────
    stepStart = Date.now();

    tx = await walletContract.executeWithProof(
      proofBytes,
      signature,
      publicInputsStruct,
      intent.calls,
      { gasLimit: 500000 }
    );

    steps.push({
      step: "executeWithProof",
      status: "success",
      durationMs: Date.now() - stepStart,
      detail: `AgentWallet.executeWithProof() — ${proofMode === "groth16" ? "real ZK proof" : "MockZKVerifier"}`,
    });
  }

  // ── Step 5: Wait for confirmation + after-balance ─────────
  stepStart = Date.now();
  const receipt = await tx.wait();

  let balanceAfter = "0";
  if (config.contracts.MockUSDC && userAddress) {
    const usdc = getContract(
      config.contracts.MockUSDC,
      ERC20_BALANCE_ABI,
      provider,
      config.contractFactory
    );
    const bal = await usdc.balanceOf(userAddress);
    balanceAfter = ethers.formatUnits(bal, 6);
  }

  steps.push({
    step: "confirm_tx",
    status: "success",
    durationMs: Date.now() - stepStart,
    detail: `Block ${receipt.blockNumber}, gas ${receipt.gasUsed.toString()}`,
  });

  const explorer = config.explorer || "https://sepolia.basescan.org";
  intentStore.delete(review_id);

  return {
    result: {
      status: "executed",
      executionPath,
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
    const provider = getProvider(
      config.defaultChain || "base_sepolia",
      config.rpcUrl,
      config.providerFactory
    );

    // Non-custodial: show user's EOA balance (where funds are held)
    const userAddress = config.ownerAddress || "";
    const walletAddress = config.contracts.AgentWallet;

    const [walletEth, userEth] = await Promise.all([
      provider.getBalance(walletAddress),
      userAddress ? provider.getBalance(userAddress) : Promise.resolve(0n),
    ]);

    let userUsdcBal = "0";
    let walletUsdcBal = "0";
    if (config.contracts.MockUSDC) {
      const usdc = getContract(
        config.contracts.MockUSDC,
        ERC20_ABI,
        provider,
        config.contractFactory
      );
      const [uBal, wBal] = await Promise.all([
        userAddress ? usdc.balanceOf(userAddress) : Promise.resolve(0n),
        usdc.balanceOf(walletAddress),
      ]);
      userUsdcBal = ethers.formatUnits(uBal, 6);
      walletUsdcBal = ethers.formatUnits(wBal, 6);
    }

    return {
      wallet: walletAddress,
      userAddress,
      walletEth: ethers.formatEther(walletEth),
      userEth: userAddress ? ethers.formatEther(userEth) : "N/A",
      userUsdc: userUsdcBal,
      walletUsdc: walletUsdcBal,
      formatted: userAddress
        ? `User EOA (${userAddress.slice(0, 10)}...):\n- ${ethers.formatEther(userEth)} ETH\n- ${userUsdcBal} USDC\n\nAgentWallet (${walletAddress.slice(0, 10)}...):\n- ${ethers.formatEther(walletEth)} ETH (gas)\n- ${walletUsdcBal} USDC`
        : `AgentWallet balance:\n- ${ethers.formatEther(walletEth)} ETH\n- ${walletUsdcBal} USDC`,
    };
  } catch (err: any) {
    return { error: `Failed to check balance: ${err.message}` };
  }
}

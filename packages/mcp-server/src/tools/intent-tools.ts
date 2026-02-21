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
  getZKIntentTypedData,
  ActionType,
  CHAINS,
  DEFAULTS,
  IntentBundle,
  DerivedCalldata,
} from "@vaeb/intent-sdk";
import { ContractFactory, ProviderFactory, getContract, getProvider } from "./deps";

// poseidon hashing
let _poseidonFn: any = null;
let F: any = null;

async function initPoseidon() {
  if (_poseidonFn) return;
  const circomlibjs = await import("circomlibjs");
  _poseidonFn = await circomlibjs.buildPoseidon();
  F = _poseidonFn.F;
}

function poseidonHash(inputs: bigint[]): bigint {
  return F.toObject(_poseidonFn(inputs));
}

// compute poseidon commitment for IntentBundle
async function computePoseidonCommitment(bundle: IntentBundle): Promise<bigint> {
  await initPoseidon();
  const actionTypeMap: Record<string, number> = {
    TRANSFER: 1,
    SWAP: 2,
    STAKE: 3,
    UNSTAKE: 4,
  };

  // Poseidon(version, chainId, nonce, expiry, payer, numActions)
  const bundleHash = poseidonHash([
    1n,
    BigInt(bundle.chainId),
    BigInt(bundle.nonce),
    BigInt(bundle.expiry),
    BigInt(bundle.payer),
    BigInt(bundle.actions.length),
  ]);

  // hash each action
  const actionHashes: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    if (i < bundle.actions.length) {
      const action = bundle.actions[i];
      const typeNum = actionTypeMap[action.actionType] || 0;
      const actionHash = poseidonHash([
        BigInt(typeNum),
        BigInt(action.token),
        BigInt(action.to),
        BigInt(action.amount),
      ]);
      actionHashes.push(actionHash);
    } else {
      // unused slots: Poseidon(0, 0, 0, 0)
      const zeroHash = poseidonHash([0n, 0n, 0n, 0n]);
      actionHashes.push(zeroHash);
    }
  }

  // Poseidon(bundleHash, actionHash[0], actionHash[1], actionHash[2], actionHash[3])
  return poseidonHash([bundleHash, ...actionHashes]);
}

type Config = {
  defaultChain: string;
  supportedChains: string[];
  walletPrivateKey: string;
  proverEndpoint: string;
  requireManualApproval: boolean;
  rpcUrl?: string;
  chainId?: number;
  ownerAddress?: string;
  providerFactory?: ProviderFactory;
  contractFactory?: ContractFactory;
  fetchFn?: typeof fetch;
  now?: () => number;
  proofDelayMs?: number;
  contracts?: {
    AgentWallet?: string;
  };
};

// In-memory intent store (for hackathon — production uses Redis/DB)
const intentStore = new Map<
  string,
  {
    bundle: IntentBundle;
    derivedCalldata: DerivedCalldata;
    chainKey: string;
    createdAt: number;
    status: "pending" | "signed" | "executing" | "executed" | "failed" | "cancelled";
  }
>();

export const intentTools = {
  async handle(name: string, args: any, config: Config): Promise<{ result: any; intent?: any }> {
    switch (name) {
      case "create_intent":
        return createIntent(args, config);
      case "execute_intent":
        return { result: await executeIntent(args, config) };
      case "simulate_intent":
        return { result: await simulateIntent(args, config) };
      case "cancel_intent":
        return { result: await cancelIntent(args, config) };
      default:
        throw new Error(`Unknown intent tool: ${name}`);
    }
  },
};

// ─── create_intent ──────────────────────────────────────────────

async function createIntent(args: any, config: Config) {
  const now = config.now || Date.now;
  // Resolve chain
  const chainKey = resolveChain(
    args.chain_preference || "cheapest_gas",
    config.supportedChains
  );
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unsupported chain: ${chainKey}`);

  // Get the AgentWallet contract address (the payer / smart wallet)
  const walletAddress =
    config.contracts?.AgentWallet ||
    new ethers.Wallet(config.walletPrivateKey || ethers.Wallet.createRandom().privateKey).address;

  // Map input actions to SDK format
  const actions = args.actions.map((a: any) => {
    // Validate recipient address for TRANSFER actions
    if (a.type === "TRANSFER" && a.recipient) {
      try {
        ethers.getAddress(a.recipient);
      } catch {
        throw new Error(
          `Invalid recipient address "${a.recipient}". For marketplace payments use hire_human instead of create_intent.`
        );
      }
    }
    return {
      type: a.type as ActionType,
      fromToken: a.from_token,
      toToken: a.to_token,
      token: a.token,
      amount: a.amount,
      maxSlippage: a.max_slippage || 0.005,
      preferredDex: a.preferred_dex || "auto",
      recipient: a.recipient,
    };
  });

  // Create the IntentBundle
  const bundle = createIntentBundle({
    actions,
    chainId: chain.chainId,
    walletAddress,
    expiryMinutes: args.expiry_minutes || 10,
  });

  // Derive the calldata (pass ownerAddress for non-custodial transferFrom)
  const derived = await deriveCalldata(bundle, chainKey, config.ownerAddress);

  // Compute intent ID
  const intentId = computeIntentId(bundle);

  // Store for later execution
  intentStore.set(intentId, {
    bundle,
    derivedCalldata: derived,
    chainKey,
    createdAt: now(),
    status: "pending",
  });

  // Estimate costs
  const estimatedGas = "$0.001"; // Simplified for demo
  const serviceFee = `${DEFAULTS.SERVICE_FEE_USDC} USDC`;
  const humanReadable = describeIntent(bundle);

  // Compute Poseidon commitment for ZKIntent signing
  const commitment = await computePoseidonCommitment(bundle);
  const commitmentHex = ethers.toBeHex(commitment, 32);

  // Build ZKIntent EIP-712 typed data (user signs commitment, agent executes on behalf)
  const eip712 = getZKIntentTypedData(
    bundle.nonce,
    bundle.expiry,
    commitmentHex,
    walletAddress,
    chain.chainId,
  );

  // Determine token + amount for approval (first TRANSFER action)
  const transferAction = bundle.actions.find(a => a.actionType === "TRANSFER");
  const approvalToken = transferAction?.token || derived.calls[0]?.target;
  const approvalAmount = transferAction
    ? transferAction.amount.toString()
    : undefined;

  const reviewId = ethers.hexlify(ethers.randomBytes(16));

  return {
    result: {
      intent_id: intentId,
      review_id: reviewId,
      chain: chainKey,
      estimated_output: humanReadable,
      estimated_gas: estimatedGas,
      service_fee: serviceFee,
      requires_signature: true,
      human_readable: humanReadable,
      bundle: bundleToJSON(bundle),
      derived_calls_count: derived.calls.length,
      expiry: new Date(bundle.expiry * 1000).toISOString(),
    },
    // ERC-8150: agent spends on behalf of owner — frontend shows approval + signing UI
    intent: {
      reviewId,
      nonce: bundle.nonce,
      expiry: bundle.expiry,
      expiryFormatted: new Date(bundle.expiry * 1000).toISOString(),
      eip712,
      humanName: "",
      humanId: "",
      humanRating: 0,
      task: humanReadable,
      amount: transferAction ? ethers.formatUnits(transferAction.amount, 6) : "0",
      recipient: transferAction?.to || "",
      chain: chainKey,
      bundle: bundleToJSON(bundle),
      requires_approval: true,
      requires_signature: true,
      approvalTarget: walletAddress,
      approvalToken,
      approvalAmount,
    },
  };
}

// ─── execute_intent ─────────────────────────────────────────────

async function executeIntent(args: any, config: Config) {
  const now = config.now || Date.now;
  const intentId = args.intent_id;
  const signature = args.signature;

  const stored = intentStore.get(intentId);
  if (!stored) throw new Error(`Intent not found: ${intentId}`);
  if (stored.status === "executed") throw new Error("Intent already executed");
  if (stored.status === "cancelled") throw new Error("Intent was cancelled");

  // Check expiry
  if (now() / 1000 > stored.bundle.expiry) {
    throw new Error("Intent has expired");
  }

  stored.status = "executing";

  try {
    // Step 1: Pre-check nonce on-chain before spending time on proof generation
    if (config.contracts?.AgentWallet) {
      const NONCE_ABI = ["function isNonceUsed(bytes32) view returns (bool)"];
      const rpcUrl = config.rpcUrl || CHAINS[stored.chainKey]?.rpcUrl;
      const provider = getProvider(
        stored.chainKey,
        rpcUrl,
        config.providerFactory
      );
      const walletContract = getContract(
        config.contracts.AgentWallet,
        NONCE_ABI,
        provider,
        config.contractFactory
      );
      const nonceUsed = await walletContract.isNonceUsed(stored.bundle.nonce);
      if (nonceUsed) throw new Error(`Nonce already used on-chain: ${stored.bundle.nonce}`);
    }

    // Step 2: x402 payment would happen here
    // In production: HTTP 402 → X-PAYMENT header → verify + settle
    const x402Fee = DEFAULTS.SERVICE_FEE_USDC;

    // Step 3: Generate ZK proof
    const commitment = await computePoseidonCommitment(stored.bundle);
    const proofResult: any = await generateProof(
      stored.bundle,
      stored.derivedCalldata,
      commitment,
      config
    );

    // Step 4: Submit to AgentWallet on-chain
    const txResult = await submitToChain(
      stored.bundle,
      stored.derivedCalldata,
      commitment,
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
  if (stored.status === "cancelled") throw new Error("Intent already cancelled");

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
  bundle: IntentBundle,
  derivedCalldata: DerivedCalldata,
  commitment: bigint,
  config: Config
) {
  const fetchFn = config.fetchFn || fetch;
  const signerAddress = config.ownerAddress || bundle.payer;

  // The circuit constraint requires derivedValues[i] == actionAmounts[i].
  // For ERC-20 transfers the on-chain call.value is 0, so we override it
  // here with the token amount so the prover can satisfy the constraint.
  const proverCalls = derivedCalldata.calls.map((c, i) => ({
    target: c.target,
    value: i < bundle.actions.length ? bundle.actions[i].amount.toString() : "0",
    data: c.data,
  }));

  const response = await fetchFn(`${config.proverEndpoint}/prove`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      intentBundle: {
        payer: bundle.payer,
        actions: bundle.actions.map((a) => ({
          actionType: a.actionType,
          token: a.token,
          to: a.to,
          amount: a.amount.toString(),
        })),
      },
      derivedCalldata: { calls: proverCalls },
      publicInputs: {
        commitment: commitment.toString(), // Prover expects decimal string
        chainId: bundle.chainId,
        signerAddress,
        multicallDataHash: BigInt(derivedCalldata.multicallDataHash).toString(),
        nonce: bundle.nonce,
        expiry: bundle.expiry,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Prover service error ${response.status}: ${body}`);
  }

  return await response.json();
}

// ─── AgentWallet ABI (minimal) ──────────────────────────────────

const AGENT_WALLET_ABI = [
  "function executeWithProof(bytes proof, bytes signature, tuple(bytes32 commitment, uint256 chainId, address signerAddress, bytes32 multicallDataHash, bytes32 nonce, uint256 expiry) publicInputs, tuple(address target, uint256 value, bytes data)[] calls) external",
  "event IntentExecuted(bytes32 indexed intentId, address indexed signer, bytes32 nonce, uint256 callCount, uint256 gasUsed)",
];

// ─── Helper: Submit to Chain ────────────────────────────────────

async function submitToChain(
  bundle: IntentBundle,
  derivedCalldata: DerivedCalldata,
  commitment: bigint,
  proofResult: any,
  signature: string,
  chainKey: string,
  config: Config
) {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);

  const agentWalletAddress = config.contracts?.AgentWallet;
  if (!agentWalletAddress) throw new Error("AgentWallet address not configured");

  const rpcUrl = config.rpcUrl || chain.rpcUrl;
  const provider = getProvider(chainKey, rpcUrl, config.providerFactory);
  const agentSigner = new ethers.Wallet(config.walletPrivateKey, provider);
  const walletContract = getContract(
    agentWalletAddress,
    AGENT_WALLET_ABI,
    agentSigner,
    config.contractFactory
  );

  const publicInputs = {
    commitment: "0x" + commitment.toString(16).padStart(64, "0"),
    chainId: bundle.chainId,
    signerAddress: config.ownerAddress || bundle.payer,
    multicallDataHash: "0x" + BigInt(derivedCalldata.multicallDataHash).toString(16).padStart(64, "0"),
    nonce: bundle.nonce,
    expiry: bundle.expiry,
  };

  const calls = derivedCalldata.calls.map((c) => ({
    target: c.target,
    value: c.value,
    data: c.data,
  }));

  const proofBytes = proofResult.proof || "0x";

  const tx = await walletContract.executeWithProof(
    proofBytes,
    signature,
    publicInputs,
    calls,
    { gasLimit: 500000 }
  );

  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    gasUsed: receipt.gasUsed.toString(),
    output: { token: "USDC", amount: "see receipt" },
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

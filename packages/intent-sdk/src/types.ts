/**
 * VAEB Intent SDK — Core Type Definitions
 * Matches ERC-8150 IntentBundle specification
 */

// ─── Action Types ───────────────────────────────────────────────

export enum ActionType {
  SWAP = "SWAP",
  TRANSFER = "TRANSFER",
  STAKE = "STAKE",
  UNSTAKE = "UNSTAKE",
  APPROVE = "APPROVE",
  BRIDGE = "BRIDGE",
  LEND = "LEND",
  BORROW = "BORROW",
  CUSTOM = "CUSTOM",
}

export interface Action {
  actionType: ActionType;
  token: string;           // Token address (or symbol for high-level API)
  to: string;              // Target contract address
  amount: bigint;          // Amount in smallest unit
  data?: string;           // Optional: raw calldata for CUSTOM actions
}

// ─── IntentBundle (ERC-8150) ────────────────────────────────────

export interface IntentBundle {
  version: string;         // "1.0"
  chainId: number;         // e.g., 8453 for Base, 84532 for Base Sepolia
  nonce: string;           // bytes32 hex string — unique per intent
  expiry: number;          // Unix timestamp — intent expires after this
  payer: string;           // AgentWallet address (checksummed)
  actions: ActionEntry[];  // Ordered list of actions to execute
}

export interface ActionEntry {
  actionType: ActionType;
  token: string;           // Token contract address
  to: string;              // Target contract address
  amount: bigint;          // Amount in token's smallest unit
}

// ─── Derived Calldata ───────────────────────────────────────────

export interface DerivedCall {
  target: string;          // Contract to call
  value: bigint;           // ETH value to send
  data: string;            // Encoded calldata
}

export interface DerivedCalldata {
  intentId: string;        // keccak256(serialized IntentBundle)
  chainId: number;
  calls: DerivedCall[];
  multicallDataHash: bigint; // Poseidon hash of derived calls
}

// ─── Intent Creation Params (high-level API) ────────────────────

export interface CreateIntentParams {
  actions: ActionInput[];
  chainPreference?: "cheapest_gas" | "fastest_finality" | "most_liquidity" | string;
  expiryMinutes?: number;  // Default: 10
  walletAddress: string;   // AgentWallet address
  chainId: number;
}

export interface ActionInput {
  type: ActionType;
  fromToken?: string;      // For SWAP
  toToken?: string;        // For SWAP
  token?: string;          // For TRANSFER, STAKE, etc.
  amount: number | string; // Human-readable amount
  maxSlippage?: number;    // e.g., 0.005 for 0.5%
  preferredDex?: string;   // e.g., "uniswap", "auto"
  recipient?: string;      // For TRANSFER
  protocol?: string;       // For STAKE, LEND, BORROW
}

// ─── Intent Response ────────────────────────────────────────────

export interface IntentResponse {
  intentId: string;
  chain: string;
  estimatedOutput: string;
  estimatedGas: string;
  serviceFee: string;
  requiresSignature: boolean;
  humanReadable: string;
  bundle: IntentBundle;
  derivedCalldata: DerivedCalldata;
}

// ─── Execution Result ───────────────────────────────────────────

export interface ExecutionResult {
  status: "executed" | "failed" | "pending";
  txHash: string;
  chain: string;
  output?: { token: string; amount: string };
  gasUsed: string;
  serviceFeePaid: string;
  proofValid: boolean;
}

// ─── EIP-712 Domain ─────────────────────────────────────────────

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;  // AgentWallet address
}

// ─── x402 Payment ───────────────────────────────────────────────

export type X402Scheme = "exact" | "upto" | "stream" | "deferred";

export interface X402PaymentRequest {
  scheme: X402Scheme;
  amount: number;          // In smallest token unit
  token: string;           // Token address (e.g., USDC)
  network: string;         // Chain name
  recipient: string;       // VAEB treasury address
}

// ─── ERC-8004 Trust Types ───────────────────────────────────────

export interface AgentIdentity {
  agentId: number;         // ERC-721 token ID
  tokenUri: string;        // IPFS URI to agent card
  metadata: AgentMetadata;
}

export interface AgentMetadata {
  agentName: string;
  supportedChains: string[];
  proofType: string;       // e.g., "groth16"
  avgProofTime: string;    // e.g., "3200ms"
  x402Pricing: string;     // e.g., "0.02 USDC per proof"
}

export interface ReputationSummary {
  agentId: number;
  avgScore: number;        // 0-10
  feedbackCount: number;
  tags: Record<string, number>; // tag -> count
}

export interface ValidationSummary {
  agentId: number;
  validationCount: number;
  passRate: number;        // 0-1
}

export interface AgentRecommendation {
  recommended: {
    agentId: number;
    name: string;
    reputation: ReputationSummary;
    validation: ValidationSummary;
    pricing: string;
    avgProofTime: string;
  };
  alternatives: Array<{
    agentId: number;
    name: string;
    reputation: ReputationSummary;
  }>;
}

// ─── Pre-Authorization Policy ───────────────────────────────────

export interface PreAuthPolicy {
  autoApprove: Record<string, PolicyRule>;
}

export interface PolicyRule {
  maxAmountPerTx: number;
  maxDailyAmount?: number;
  allowedTokens?: string[];
  allowedDexes?: string[];
  allowedProtocols?: string[];
  maxSlippage?: number;
  minAgentReputation?: number;
  minAgentValidations?: number;
  minAgentValidationRate?: number;
}

// ─── Trust Tiers ────────────────────────────────────────────────

export enum TrustTier {
  UNTRUSTED = "UNTRUSTED",     // 0-5, <50 feedbacks
  EMERGING = "EMERGING",       // 5-7, 50-500 feedbacks
  ESTABLISHED = "ESTABLISHED", // 7-9, 500+ feedbacks
  ELITE = "ELITE",             // 9+, 1000+ feedbacks, 99%+ validation
}

/**
 * Canton Settlement Types
 *
 * Shared types for Canton coordination layer integration.
 * Canton is a privacy-preserving coordination layer — it never holds funds.
 * Assets live on EVM (Base). Canton records agreements and ZK attestations.
 */

// ── Canton API Types ────────────────────────────────────────

export interface CantonConfig {
  /** Canton participant JSON API URL (e.g. http://localhost:7575) */
  participantUrl: string;
  /** JWT bearer token for authenticated requests */
  authToken?: string;
  /** v2 user ID for command submission */
  userId: string;
  /** Parties this client acts as */
  actAs: string[];
  /** Additional read-only parties */
  readAs: string[];
  /** Ledger ID for v1 API (defaults to userId) */
  ledgerId?: string;
  /** Application ID for v1 API (defaults to "vaeb-canton") */
  applicationId?: string;
}

export interface ContractRef {
  contractId: string;
  templateId: string;
  payload: Record<string, any>;
}

// ── Domain Types ────────────────────────────────────────────

export type ChainId = "EVM";
export type ClaimType = "BalanceAbove" | "StakingActive";

export interface CustodyAttestation {
  contractId: string;
  custodian: string;
  assetHolder: string;
  observers: string[];
  chain: ChainId;
  claimType: ClaimType;
  claimDigest: string;
  proofHash: string;
  verifiedAt: string;
  expiresAt: string;
}

export interface Settlement {
  contractId: string;
  buyer: string;
  seller: string;
  custodian: string;
  requiredChain: ChainId;
  requiredClaimType: string;
  settlementAsset: { issuer: string; label: string };
  amount: number;
}

export interface ExecutionReceipt {
  settlementId: string;
  txHash: string;
  chain: ChainId;
  proofHash: string;
  executedAt: string;
}

// ── Settlement Bridge Types ─────────────────────────────────

export interface SettlementIntent {
  /** Canton settlement contract ID */
  settlementId: string;
  /** Canton attestation contract ID */
  attestationId: string;
  /** EVM recipient address (seller) */
  recipient: string;
  /** Token address on EVM (e.g. USDC) */
  token: string;
  /** Amount in human-readable units */
  amount: number;
  /** Chain (always Base for now) */
  chain: string;
}

export interface SettlementResult {
  success: boolean;
  txHash?: string;
  proofHash?: string;
  error?: string;
}

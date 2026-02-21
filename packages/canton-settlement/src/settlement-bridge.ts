/**
 * Settlement Bridge — Canton → VAEB Execution
 *
 * Reads pending settlement contracts from Canton, constructs VAEB IntentBundles,
 * and executes verified transfers on EVM (Base) via AgentWallet.
 *
 * Flow:
 *   1. Query Canton for pending CrossChainSettlement contracts
 *   2. Verify the linked CustodyAttestation is still valid
 *   3. Build a VAEB IntentBundle matching the settlement terms
 *   4. Execute via AgentWallet.executeWithProof() (Groth16-verified)
 *   5. Record the tx hash back on Canton as settlement execution
 *
 * Canton never holds funds — it only records agreements and proofs.
 * All fund movement happens on EVM via VAEB's AgentWallet.
 */

import { CantonClient } from "./canton-client";
import type {
  CantonConfig,
  Settlement,
  CustodyAttestation,
  SettlementIntent,
} from "./types";

export interface BridgeConfig {
  canton: CantonConfig;
  /** EVM address → Canton party mapping (e.g. { "0xABC": "Buyer::namespace" }) */
  addressToParty: Record<string, string>;
  /** Canton party → EVM address mapping */
  partyToAddress: Record<string, string>;
  /** Token label → EVM contract address (e.g. { "USDC": "0x..." }) */
  tokenAddresses: Record<string, string>;
  /** Default EVM chain key for VAEB (e.g. "base_sepolia") */
  chain: string;
}

export class SettlementBridge {
  private canton: CantonClient;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.canton = new CantonClient(config.canton);
  }

  /**
   * Check if Canton participant is reachable.
   */
  async isCantonHealthy(): Promise<boolean> {
    return this.canton.health();
  }

  /**
   * Get all pending settlements from Canton.
   */
  async getPendingSettlements(): Promise<Settlement[]> {
    return this.canton.querySettlements();
  }

  /**
   * Get all active attestations from Canton.
   */
  async getAttestations(): Promise<CustodyAttestation[]> {
    return this.canton.queryAttestations();
  }

  /**
   * Find a valid attestation for a given settlement.
   * Checks chain match, claim type match, and expiry.
   */
  findMatchingAttestation(
    settlement: Settlement,
    attestations: CustodyAttestation[]
  ): CustodyAttestation | null {
    const now = new Date().toISOString();
    return (
      attestations.find(
        (a) =>
          a.chain === settlement.requiredChain &&
          a.claimType === settlement.requiredClaimType &&
          a.expiresAt > now
      ) ?? null
    );
  }

  /**
   * Convert a Canton settlement into a VAEB-compatible SettlementIntent.
   * Maps Canton parties to EVM addresses and token labels to contract addresses.
   */
  toSettlementIntent(
    settlement: Settlement,
    attestation: CustodyAttestation
  ): SettlementIntent {
    const recipient = this.config.partyToAddress[settlement.seller];
    if (!recipient) {
      throw new Error(
        `No EVM address mapped for Canton party: ${settlement.seller}`
      );
    }

    const tokenAddress =
      this.config.tokenAddresses[settlement.settlementAsset.label];
    if (!tokenAddress) {
      throw new Error(
        `No EVM token address for: ${settlement.settlementAsset.label}`
      );
    }

    return {
      settlementId: settlement.contractId,
      attestationId: attestation.contractId,
      recipient,
      token: tokenAddress,
      amount: settlement.amount,
      chain: this.config.chain,
    };
  }

  /**
   * Build a VAEB-compatible action descriptor from a SettlementIntent.
   * Returns the action array that can be passed to VAEB's create_intent tool.
   */
  toVAEBActions(intent: SettlementIntent) {
    return [
      {
        type: "TRANSFER" as const,
        token: intent.token,
        amount: intent.amount,
        recipient: intent.recipient,
      },
    ];
  }

  /**
   * Record a successful execution back on Canton by exercising the
   * settlement's Execute choice with the attestation CID.
   */
  async recordExecution(
    settlementId: string,
    attestationId: string
  ): Promise<any> {
    return this.canton.executeSettlement(settlementId, attestationId);
  }

  /**
   * Full pipeline: find settlement → verify attestation → prepare VAEB actions.
   *
   * Returns the SettlementIntent and VAEB actions ready for create_intent + execute_intent.
   * The actual VAEB execution (proof generation, on-chain tx) is handled by the MCP tools.
   */
  async prepareSettlement(settlementId: string): Promise<{
    intent: SettlementIntent;
    vaebActions: { type: "TRANSFER"; token: string; amount: number; recipient: string }[];
  }> {
    const [settlements, attestations] = await Promise.all([
      this.getPendingSettlements(),
      this.getAttestations(),
    ]);

    const settlement = settlements.find((s) => s.contractId === settlementId);
    if (!settlement) {
      throw new Error(`Settlement not found: ${settlementId}`);
    }

    const attestation = this.findMatchingAttestation(settlement, attestations);
    if (!attestation) {
      throw new Error(
        `No valid attestation for settlement ${settlementId} ` +
          `(need ${settlement.requiredChain}/${settlement.requiredClaimType})`
      );
    }

    const intent = this.toSettlementIntent(settlement, attestation);
    const vaebActions = this.toVAEBActions(intent);

    return { intent, vaebActions };
  }
}

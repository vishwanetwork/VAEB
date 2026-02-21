/**
 * Canton Tools — MCP tools for Canton coordination layer
 *
 * These tools let AI agents query Canton's Daml ledger for
 * attestations and settlements, and execute the full Canton→VAEB
 * settlement pipeline.
 *
 * Canton is a privacy-preserving coordination layer — it never holds funds.
 * All fund movement happens on EVM via VAEB's AgentWallet.
 */

import {
  CantonClient,
  SettlementBridge,
  type CantonConfig,
  type BridgeConfig,
} from "@vaeb/canton-settlement";

type Config = {
  cantonParticipantUrl?: string;
  cantonAuthToken?: string;
  cantonUserId?: string;
  cantonActAs?: string[];
  cantonReadAs?: string[];
  cantonLedgerId?: string;
  cantonApplicationId?: string;
  cantonPartyToAddress?: Record<string, string>;
  cantonTokenAddresses?: Record<string, string>;
  defaultChain: string;
};

function getCantonConfig(config: Config): CantonConfig {
  return {
    participantUrl: config.cantonParticipantUrl || "http://localhost:7575",
    authToken: config.cantonAuthToken,
    userId: config.cantonUserId || "canton-zk-custody",
    actAs: config.cantonActAs || [],
    readAs: config.cantonReadAs || [],
    ledgerId: config.cantonLedgerId || "vaeb_participant",
    applicationId: config.cantonApplicationId || "vaeb-canton",
  };
}

function getBridgeConfig(config: Config): BridgeConfig {
  const cantonConfig = getCantonConfig(config);
  const partyToAddress = config.cantonPartyToAddress || {};
  const addressToParty: Record<string, string> = {};
  for (const [party, addr] of Object.entries(partyToAddress)) {
    addressToParty[addr] = party;
  }
  return {
    canton: cantonConfig,
    partyToAddress,
    addressToParty,
    tokenAddresses: config.cantonTokenAddresses || {},
    chain: config.defaultChain,
  };
}

export const cantonTools = {
  async handle(name: string, args: any, config: Config): Promise<any> {
    switch (name) {
      case "canton_health":
        return cantonHealth(config);
      case "query_attestations":
        return queryAttestations(config);
      case "query_settlements":
        return querySettlements(config);
      case "prepare_settlement":
        return prepareSettlement(args, config);
      default:
        throw new Error(`Unknown Canton tool: ${name}`);
    }
  },
};

// ── Tool Implementations ──────────────────────────────────────

async function cantonHealth(config: Config) {
  const client = new CantonClient(getCantonConfig(config));
  const healthy = await client.health();
  return {
    healthy,
    participantUrl: config.cantonParticipantUrl || "http://localhost:3975",
    message: healthy
      ? "Canton participant is reachable"
      : "Cannot reach Canton participant — is it running?",
  };
}

async function queryAttestations(config: Config) {
  const client = new CantonClient(getCantonConfig(config));
  const attestations = await client.queryAttestations();
  return {
    count: attestations.length,
    attestations: attestations.map((a) => ({
      contractId: a.contractId,
      chain: a.chain,
      claimType: a.claimType,
      custodian: a.custodian,
      assetHolder: a.assetHolder,
      proofHash: a.proofHash,
      expiresAt: a.expiresAt,
      valid: new Date(a.expiresAt) > new Date(),
    })),
  };
}

async function querySettlements(config: Config) {
  const client = new CantonClient(getCantonConfig(config));
  const settlements = await client.querySettlements();
  return {
    count: settlements.length,
    settlements: settlements.map((s) => ({
      contractId: s.contractId,
      buyer: s.buyer,
      seller: s.seller,
      custodian: s.custodian,
      chain: s.requiredChain,
      claimType: s.requiredClaimType,
      asset: s.settlementAsset.label,
      amount: s.amount,
    })),
  };
}

async function prepareSettlement(
  args: { settlement_id: string },
  config: Config
) {
  const bridge = new SettlementBridge(getBridgeConfig(config));
  const { intent, vaebActions } = await bridge.prepareSettlement(
    args.settlement_id
  );

  return {
    message: `Settlement ${intent.settlementId} ready for execution`,
    intent: {
      settlementId: intent.settlementId,
      attestationId: intent.attestationId,
      recipient: intent.recipient,
      token: intent.token,
      amount: intent.amount,
      chain: intent.chain,
    },
    vaebActions,
    nextStep:
      "Call create_intent with the vaebActions above, then execute_intent after user signs",
  };
}

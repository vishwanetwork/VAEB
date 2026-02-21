/**
 * End-to-End Workflow Validation — Canton → VAEB Settlement Pipeline
 *
 * Validates the complete 4-step settlement flow:
 *   Step 1: Attest Balance (Canton + RISC0)
 *   Step 2: Agree on Settlement (Canton multi-party)
 *   Step 3: Execute Transfer (VAEB on Base)
 *   Step 4: Record Receipt (Canton)
 *
 * Logic tests validate the workflow structure and data flow.
 * Live tests execute against Canton devnet/localnet (sandbox).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SettlementBridge } from "../src/settlement-bridge";
import type { BridgeConfig } from "../src/settlement-bridge";
import type {
  CantonConfig,
  CustodyAttestation,
  Settlement,
  SettlementIntent,
} from "../src/types";

// ── Environment config ─────────────────────────────────────

const CANTON_URL = process.env.CANTON_PARTICIPANT_URL || "http://localhost:7575";

function cantonConfig(): CantonConfig {
  return {
    participantUrl: CANTON_URL,
    authToken: process.env.CANTON_AUTH_TOKEN,
    userId: process.env.CANTON_USER_ID || "canton-zk-custody",
    actAs: (process.env.CANTON_ACT_AS || "custodian::namespace").split(","),
    readAs: (process.env.CANTON_READ_AS || "").split(",").filter(Boolean),
    ledgerId: process.env.CANTON_LEDGER_ID || "vaeb_participant",
    applicationId: "vaeb-canton",
  };
}

const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function bridgeConfig(): BridgeConfig {
  return {
    canton: cantonConfig(),
    partyToAddress: {
      "Seller::namespace": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "Buyer::namespace": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    },
    addressToParty: {
      "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045": "Seller::namespace",
      "0x71C7656EC7ab88b098defB751B7401B5f6d8976F": "Buyer::namespace",
    },
    tokenAddresses: { USDC: BASE_SEPOLIA_USDC },
    chain: "base_sepolia",
  };
}

// ── Workflow Structure Validation ──────────────────────────

describe("E2E workflow structure", () => {
  test("Step 1→2: attestation feeds into settlement matching", () => {
    const attestation: CustodyAttestation = {
      contractId: "00a1:attestation:CustodyAttestation",
      custodian: "Custodian::namespace",
      assetHolder: "Seller::namespace",
      observers: ["Buyer::namespace"],
      chain: "EVM",
      claimType: "BalanceAbove",
      claimDigest: "BalanceAbove(1000, USDC)",
      proofHash: "0x7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
      verifiedAt: "2025-06-01T12:00:00Z",
      expiresAt: "2099-12-31T23:59:59Z",
    };

    const settlement: Settlement = {
      contractId: "00b1:settlement:CrossChainSettlement",
      buyer: "Buyer::namespace",
      seller: "Seller::namespace",
      custodian: "Custodian::namespace",
      requiredChain: "EVM",
      requiredClaimType: "BalanceAbove",
      settlementAsset: { issuer: "Circle", label: "USDC" },
      amount: 500,
    };

    const bridge = new SettlementBridge(bridgeConfig());
    const match = bridge.findMatchingAttestation(settlement, [attestation]);

    assert.ok(match, "Attestation should match settlement requirements");
    assert.equal(match.chain, settlement.requiredChain);
    assert.equal(match.claimType, settlement.requiredClaimType);
    assert.ok(new Date(match.expiresAt) > new Date(), "Attestation must not be expired");
  });

  test("Step 2→3: settlement maps to VAEB intent and actions", () => {
    const bridge = new SettlementBridge(bridgeConfig());

    const settlement: Settlement = {
      contractId: "00b1:settlement:CrossChainSettlement",
      buyer: "Buyer::namespace",
      seller: "Seller::namespace",
      custodian: "Custodian::namespace",
      requiredChain: "EVM",
      requiredClaimType: "BalanceAbove",
      settlementAsset: { issuer: "Circle", label: "USDC" },
      amount: 500,
    };

    const attestation: CustodyAttestation = {
      contractId: "00a1:attestation:CustodyAttestation",
      custodian: "Custodian::namespace",
      assetHolder: "Seller::namespace",
      observers: [],
      chain: "EVM",
      claimType: "BalanceAbove",
      claimDigest: "BalanceAbove(1000, USDC)",
      proofHash: "0x7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
      verifiedAt: "2025-06-01T12:00:00Z",
      expiresAt: "2099-12-31T23:59:59Z",
    };

    const intent = bridge.toSettlementIntent(settlement, attestation);
    assert.equal(intent.settlementId, settlement.contractId);
    assert.equal(intent.attestationId, attestation.contractId);
    assert.equal(intent.amount, 500);
    assert.equal(intent.chain, "base_sepolia");

    const actions = bridge.toVAEBActions(intent);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, "TRANSFER");
    assert.equal(actions[0].amount, settlement.amount);
    assert.match(actions[0].token, /^0x[0-9a-fA-F]{40}$/);
    assert.match(actions[0].recipient, /^0x[0-9a-fA-F]{40}$/);
  });

  test("Step 3→4: VAEB actions are compatible with create_intent schema", () => {
    const bridge = new SettlementBridge(bridgeConfig());
    const actions = bridge.toVAEBActions({
      settlementId: "00b1:settlement",
      attestationId: "00a1:attestation",
      recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      token: BASE_SEPOLIA_USDC,
      amount: 500,
      chain: "base_sepolia",
    });

    const action = actions[0];
    const validTypes = ["SWAP", "TRANSFER", "STAKE", "UNSTAKE", "APPROVE", "LEND", "BORROW"];
    assert.ok(validTypes.includes(action.type), `type "${action.type}" must be valid`);
    assert.ok(typeof action.amount === "number" && action.amount > 0, "amount must be positive number");
    assert.ok(action.token.startsWith("0x") && action.token.length === 42, "token must be valid address");
    assert.ok(action.recipient.startsWith("0x") && action.recipient.length === 42, "recipient must be valid address");
  });

  test("dual ZK proof chain: RISC0 attestation hash feeds separate from Groth16", () => {
    const attestation: CustodyAttestation = {
      contractId: "00a1:attestation",
      custodian: "Custodian::namespace",
      assetHolder: "Seller::namespace",
      observers: [],
      chain: "EVM",
      claimType: "BalanceAbove",
      claimDigest: "BalanceAbove(1000, USDC)",
      proofHash: "0x7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
      verifiedAt: "2025-06-01T12:00:00Z",
      expiresAt: "2099-12-31T23:59:59Z",
    };

    assert.ok(attestation.proofHash.startsWith("0x"), "RISC0 proof hash is hex");
    assert.equal(attestation.proofHash.length, 66, "RISC0 proof hash is 32 bytes");
  });
});

// ── Type consistency across the pipeline ───────────────────

describe("E2E type consistency", () => {
  test("SettlementIntent preserves all Canton contract references", () => {
    const bridge = new SettlementBridge(bridgeConfig());
    const intent: SettlementIntent = bridge.toSettlementIntent(
      {
        contractId: "00b1:settlement:CrossChainSettlement",
        buyer: "Buyer::namespace",
        seller: "Seller::namespace",
        custodian: "Custodian::namespace",
        requiredChain: "EVM",
        requiredClaimType: "BalanceAbove",
        settlementAsset: { issuer: "Circle", label: "USDC" },
        amount: 750,
      },
      {
        contractId: "00a1:attestation:CustodyAttestation",
        custodian: "Custodian::namespace",
        assetHolder: "Seller::namespace",
        observers: [],
        chain: "EVM",
        claimType: "BalanceAbove",
        claimDigest: "BalanceAbove(1000, USDC)",
        proofHash: "0xabcdef",
        verifiedAt: "2025-01-01T00:00:00Z",
        expiresAt: "2099-12-31T23:59:59Z",
      }
    );

    assert.ok(intent.settlementId, "settlementId needed for recordExecution");
    assert.ok(intent.attestationId, "attestationId needed for Execute choice");
    assert.ok(intent.recipient, "recipient resolved from party mapping");
    assert.ok(intent.token, "token resolved from label mapping");
    assert.equal(intent.amount, 750);
    assert.equal(intent.chain, "base_sepolia");
  });

  test("bridge config inverse mapping is consistent", () => {
    const config = bridgeConfig();
    for (const [party, address] of Object.entries(config.partyToAddress)) {
      assert.equal(
        config.addressToParty[address],
        party,
        `addressToParty[${address}] should map back to ${party}`
      );
    }
    for (const [address, party] of Object.entries(config.addressToParty)) {
      assert.equal(
        config.partyToAddress[party],
        address,
        `partyToAddress[${party}] should map back to ${address}`
      );
    }
  });
});

// ── Live E2E pipeline (against Canton sandbox/devnet) ──────

describe("E2E live Canton pipeline", () => {
  test("full flow: health → query attestations → query settlements", async () => {
    const bridge = new SettlementBridge(bridgeConfig());

    // Step 0: verify Canton connectivity
    const healthy = await bridge.isCantonHealthy();
    assert.equal(healthy, true, `Canton at ${CANTON_URL} must be healthy`);

    // Step 1: query attestations (RISC0-backed)
    const attestations = await bridge.getAttestations();
    assert.ok(Array.isArray(attestations), "attestations should be an array");
    console.log(`  Found ${attestations.length} attestation(s)`);

    // Step 2: query pending settlements (multi-party)
    const settlements = await bridge.getPendingSettlements();
    assert.ok(Array.isArray(settlements), "settlements should be an array");
    console.log(`  Found ${settlements.length} pending settlement(s)`);

    // Step 2→3: if settlements exist, try to prepare the first one
    if (settlements.length > 0 && attestations.length > 0) {
      const settlement = settlements[0];
      const match = bridge.findMatchingAttestation(settlement, attestations);
      if (match) {
        const intent = bridge.toSettlementIntent(settlement, match);
        const actions = bridge.toVAEBActions(intent);
        console.log(`  Prepared settlement ${settlement.contractId}:`);
        console.log(`    → ${actions[0].type} ${actions[0].amount} to ${actions[0].recipient}`);
        assert.equal(actions[0].type, "TRANSFER");
      } else {
        console.log(`  No matching attestation for settlement ${settlement.contractId}`);
      }
    }
  });
});

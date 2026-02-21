/**
 * SettlementBridge — Logic validation + live Canton tests
 *
 * Tests the Canton → VAEB bridge logic:
 *   - Attestation matching (chain, claimType, expiry)
 *   - Settlement → VAEB intent mapping
 *   - VAEB action generation
 *   - Full prepareSettlement pipeline
 *
 * Logic tests exercise the pure functions directly.
 * Live tests connect to Canton devnet/localnet (sandbox).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SettlementBridge } from "../src/settlement-bridge";
import type { BridgeConfig } from "../src/settlement-bridge";
import type { CustodyAttestation, Settlement, CantonConfig } from "../src/types";

// ── Environment-driven config ──────────────────────────────

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

// Real Base Sepolia USDC address
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function bridgeConfig(overrides?: Partial<BridgeConfig>): BridgeConfig {
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
    tokenAddresses: {
      USDC: BASE_SEPOLIA_USDC,
    },
    chain: "base_sepolia",
    ...overrides,
  };
}

// ── Attestation matching logic ─────────────────────────────

describe("SettlementBridge.findMatchingAttestation", () => {
  const bridge = new SettlementBridge(bridgeConfig());

  const validAttestation: CustodyAttestation = {
    contractId: "00a1b2c3d4e5f6:attestation:CustodyAttestation",
    custodian: "Custodian::namespace",
    assetHolder: "Seller::namespace",
    observers: ["Buyer::namespace"],
    chain: "EVM",
    claimType: "BalanceAbove",
    claimDigest: "BalanceAbove(1000, USDC, 0xd8dA...)",
    proofHash: "0x7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    verifiedAt: "2025-06-01T12:00:00Z",
    expiresAt: "2099-12-31T23:59:59Z",
  };

  const expiredAttestation: CustodyAttestation = {
    ...validAttestation,
    contractId: "00e1f2a3b4c5d6:attestation:expired",
    expiresAt: "2024-01-01T00:00:00Z",
  };

  const stakingAttestation: CustodyAttestation = {
    ...validAttestation,
    contractId: "00f1a2b3c4d5e6:attestation:staking",
    claimType: "StakingActive",
  };

  const settlement: Settlement = {
    contractId: "00b1c2d3e4f5a6:settlement:CrossChainSettlement",
    buyer: "Buyer::namespace",
    seller: "Seller::namespace",
    custodian: "Custodian::namespace",
    requiredChain: "EVM",
    requiredClaimType: "BalanceAbove",
    settlementAsset: { issuer: "Circle", label: "USDC" },
    amount: 500,
  };

  test("matches attestation with correct chain and claimType", () => {
    const match = bridge.findMatchingAttestation(settlement, [validAttestation]);
    assert.ok(match);
    assert.equal(match.contractId, validAttestation.contractId);
  });

  test("rejects expired attestation", () => {
    const match = bridge.findMatchingAttestation(settlement, [expiredAttestation]);
    assert.equal(match, null);
  });

  test("rejects mismatched claimType", () => {
    const match = bridge.findMatchingAttestation(settlement, [stakingAttestation]);
    assert.equal(match, null);
  });

  test("selects first valid match from multiple attestations", () => {
    const match = bridge.findMatchingAttestation(settlement, [
      expiredAttestation,
      stakingAttestation,
      validAttestation,
    ]);
    assert.ok(match);
    assert.equal(match.contractId, validAttestation.contractId);
  });

  test("returns null when no attestations exist", () => {
    const match = bridge.findMatchingAttestation(settlement, []);
    assert.equal(match, null);
  });

  test("matches StakingActive when settlement requires it", () => {
    const stakingSettlement: Settlement = {
      ...settlement,
      requiredClaimType: "StakingActive",
    };
    const match = bridge.findMatchingAttestation(stakingSettlement, [stakingAttestation]);
    assert.ok(match);
    assert.equal(match.claimType, "StakingActive");
  });
});

// ── Settlement → VAEB intent mapping ───────────────────────

describe("SettlementBridge.toSettlementIntent", () => {
  const bridge = new SettlementBridge(bridgeConfig());

  const attestation: CustodyAttestation = {
    contractId: "00a1b2c3d4e5f6:attestation:CustodyAttestation",
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

  const settlement: Settlement = {
    contractId: "00b1c2d3e4f5a6:settlement:CrossChainSettlement",
    buyer: "Buyer::namespace",
    seller: "Seller::namespace",
    custodian: "Custodian::namespace",
    requiredChain: "EVM",
    requiredClaimType: "BalanceAbove",
    settlementAsset: { issuer: "Circle", label: "USDC" },
    amount: 500,
  };

  test("maps Canton settlement to VAEB SettlementIntent", () => {
    const intent = bridge.toSettlementIntent(settlement, attestation);

    assert.equal(intent.settlementId, settlement.contractId);
    assert.equal(intent.attestationId, attestation.contractId);
    assert.equal(intent.recipient, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
    assert.equal(intent.token, BASE_SEPOLIA_USDC);
    assert.equal(intent.amount, 500);
    assert.equal(intent.chain, "base_sepolia");
  });

  test("throws for unmapped seller party", () => {
    const unmappedSettlement: Settlement = {
      ...settlement,
      seller: "Unknown::party",
    };
    assert.throws(
      () => bridge.toSettlementIntent(unmappedSettlement, attestation),
      /No EVM address mapped for Canton party: Unknown::party/
    );
  });

  test("throws for unmapped token label", () => {
    const unknownTokenSettlement: Settlement = {
      ...settlement,
      settlementAsset: { issuer: "Unknown", label: "WBTC" },
    };
    assert.throws(
      () => bridge.toSettlementIntent(unknownTokenSettlement, attestation),
      /No EVM token address for: WBTC/
    );
  });
});

// ── VAEB action generation ─────────────────────────────────

describe("SettlementBridge.toVAEBActions", () => {
  const bridge = new SettlementBridge(bridgeConfig());

  test("generates TRANSFER action from SettlementIntent", () => {
    const actions = bridge.toVAEBActions({
      settlementId: "00b1c2d3e4f5a6:settlement:CrossChainSettlement",
      attestationId: "00a1b2c3d4e5f6:attestation:CustodyAttestation",
      recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      token: BASE_SEPOLIA_USDC,
      amount: 500,
      chain: "base_sepolia",
    });

    assert.equal(actions.length, 1);
    assert.equal(actions[0].type, "TRANSFER");
    assert.equal(actions[0].token, BASE_SEPOLIA_USDC);
    assert.equal(actions[0].amount, 500);
    assert.equal(actions[0].recipient, "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
  });

  test("action shape is compatible with VAEB create_intent", () => {
    const actions = bridge.toVAEBActions({
      settlementId: "test",
      attestationId: "test",
      recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      token: BASE_SEPOLIA_USDC,
      amount: 1000,
      chain: "base_sepolia",
    });

    const action = actions[0];
    assert.ok(["SWAP", "TRANSFER", "STAKE", "UNSTAKE", "APPROVE", "LEND", "BORROW"].includes(action.type));
    assert.ok(typeof action.amount === "number");
    assert.ok(typeof action.token === "string");
    assert.ok(typeof action.recipient === "string");
    assert.match(action.recipient, /^0x[0-9a-fA-F]{40}$/);
    assert.match(action.token, /^0x[0-9a-fA-F]{40}$/);
  });
});

// ── Canton health via bridge (live) ────────────────────────

describe("SettlementBridge.isCantonHealthy", () => {
  test("returns false when Canton is unreachable", async () => {
    const bridge = new SettlementBridge(
      bridgeConfig({ canton: { ...cantonConfig(), participantUrl: "http://localhost:1" } })
    );
    const healthy = await bridge.isCantonHealthy();
    assert.equal(healthy, false);
  });

  test("returns true for running Canton", async () => {
    const bridge = new SettlementBridge(bridgeConfig());
    const healthy = await bridge.isCantonHealthy();
    assert.equal(healthy, true, `Canton at ${CANTON_URL} should be healthy`);
  });
});

// ── Live pipeline tests (against Canton sandbox) ───────────

describe("SettlementBridge live pipeline", () => {
  test("getPendingSettlements returns array from Canton", async () => {
    const bridge = new SettlementBridge(bridgeConfig());
    const settlements = await bridge.getPendingSettlements();
    assert.ok(Array.isArray(settlements));
    console.log(`  Found ${settlements.length} pending settlement(s)`);
  });

  test("getAttestations returns array from Canton", async () => {
    const bridge = new SettlementBridge(bridgeConfig());
    const attestations = await bridge.getAttestations();
    assert.ok(Array.isArray(attestations));
    console.log(`  Found ${attestations.length} attestation(s)`);
  });

  test("prepareSettlement fails for nonexistent settlement", async () => {
    const bridge = new SettlementBridge(bridgeConfig());
    await assert.rejects(
      () => bridge.prepareSettlement("nonexistent-settlement-id"),
      /Settlement not found/
    );
  });
});

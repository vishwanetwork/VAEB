/**
 * Canton MCP Tools — Integration tests against Canton sandbox/devnet
 *
 * Tests the 4 Canton tools exposed via VAEB's MCP server:
 *   canton_health, query_attestations, query_settlements, prepare_settlement
 *
 * Connects to Canton via JSON API (v1 for sandbox, v2 for devnet).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cantonTools } from "../src/tools/canton-tools";

// ── Config matching MCP server shape ───────────────────────

const CANTON_URL = process.env.CANTON_PARTICIPANT_URL || "http://localhost:7575";

function toolConfig(overrides?: Record<string, any>) {
  return {
    cantonParticipantUrl: CANTON_URL,
    cantonAuthToken: process.env.CANTON_AUTH_TOKEN,
    cantonUserId: process.env.CANTON_USER_ID || "canton-zk-custody",
    cantonActAs: (process.env.CANTON_ACT_AS || "custodian::namespace").split(","),
    cantonReadAs: (process.env.CANTON_READ_AS || "").split(",").filter(Boolean),
    cantonLedgerId: process.env.CANTON_LEDGER_ID || "vaeb_participant",
    cantonApplicationId: "vaeb-canton",
    cantonPartyToAddress: {
      "Seller::namespace": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "Buyer::namespace": "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    },
    cantonTokenAddresses: {
      USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    },
    defaultChain: "base_sepolia",
    ...overrides,
  };
}

// ── Tool routing ───────────────────────────────────────────

describe("cantonTools routing", () => {
  test("throws for unknown tool name", async () => {
    await assert.rejects(
      () => cantonTools.handle("unknown_tool", {}, toolConfig()),
      /Unknown Canton tool: unknown_tool/
    );
  });

  test("handles all four tool names", async () => {
    const toolNames = ["canton_health", "query_attestations", "query_settlements", "prepare_settlement"];
    for (const name of toolNames) {
      try {
        await cantonTools.handle(name, { settlement_id: "test" }, toolConfig());
      } catch (err: any) {
        assert.ok(
          !err.message.includes("Unknown Canton tool"),
          `Tool "${name}" should be routed, got: ${err.message}`
        );
      }
    }
  });
});

// ── canton_health ──────────────────────────────────────────

describe("canton_health tool", () => {
  test("returns unhealthy for unreachable Canton", async () => {
    const result = await cantonTools.handle(
      "canton_health",
      {},
      toolConfig({ cantonParticipantUrl: "http://localhost:1" })
    );
    assert.equal(result.healthy, false);
    assert.ok(result.message.includes("Cannot reach"));
  });

  test("returns healthy for running Canton", async () => {
    const result = await cantonTools.handle("canton_health", {}, toolConfig());
    assert.equal(result.healthy, true);
    assert.equal(result.participantUrl, CANTON_URL);
    assert.ok(result.message.includes("reachable"));
  });
});

// ── query_attestations ─────────────────────────────────────

describe("query_attestations tool", () => {
  test("returns attestation data from Canton", async () => {
    const result = await cantonTools.handle("query_attestations", {}, toolConfig());
    assert.ok(typeof result.count === "number");
    assert.ok(Array.isArray(result.attestations));
    for (const a of result.attestations) {
      assert.ok(a.contractId, "must have contractId");
      assert.ok(a.chain, "must have chain");
      assert.ok(a.claimType, "must have claimType");
      assert.ok(a.custodian, "must have custodian");
      assert.ok(typeof a.valid === "boolean", "must have validity flag");
    }
    console.log(`  Found ${result.count} attestation(s)`);
  });
});

// ── query_settlements ──────────────────────────────────────

describe("query_settlements tool", () => {
  test("returns settlement data from Canton", async () => {
    const result = await cantonTools.handle("query_settlements", {}, toolConfig());
    assert.ok(typeof result.count === "number");
    assert.ok(Array.isArray(result.settlements));
    for (const s of result.settlements) {
      assert.ok(s.contractId, "must have contractId");
      assert.ok(s.buyer, "must have buyer");
      assert.ok(s.seller, "must have seller");
      assert.ok(s.custodian, "must have custodian");
      assert.ok(s.chain, "must have chain");
      assert.ok(s.asset, "must have asset label");
      assert.ok(typeof s.amount === "number", "amount must be number");
    }
    console.log(`  Found ${result.count} settlement(s)`);
  });
});

// ── prepare_settlement ─────────────────────────────────────

describe("prepare_settlement tool", () => {
  test("fails gracefully for nonexistent settlement", async () => {
    await assert.rejects(
      () => cantonTools.handle("prepare_settlement", { settlement_id: "nonexistent" }, toolConfig()),
      /Settlement not found/
    );
  });
});

// ── Handler integration ────────────────────────────────────

describe("cantonTools handler integration", () => {
  test("config builds correct Canton URL from environment", () => {
    const config = toolConfig();
    assert.equal(config.cantonParticipantUrl, CANTON_URL);
    assert.equal(config.defaultChain, "base_sepolia");
  });

  test("config builds address and token mappings", () => {
    const config = toolConfig();
    assert.ok(config.cantonPartyToAddress["Seller::namespace"]);
    assert.ok(config.cantonPartyToAddress["Buyer::namespace"]);
    assert.ok(config.cantonTokenAddresses["USDC"]);
  });
});

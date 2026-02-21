/**
 * CantonClient — Tests against Canton devnet or localnet (sandbox)
 *
 * Connects to a real Canton participant node. Supports both:
 *   - Canton 2.x (open-source sandbox, JSON API v1 on port 7575)
 *   - Canton 3.x (devnet/enterprise, JSON API v2 on port 3975)
 *
 * Auto-detects API version. Start Canton sandbox with:
 *   docker run --rm -d --name canton-sandbox \
 *     -p 7575:7575 -v ./canton-sandbox.conf:/canton/config/sandbox.conf \
 *     digitalasset/canton-open-source:latest \
 *     daemon -c /canton/config/sandbox.conf --auto-connect-local --no-tty
 *
 * Environment variables:
 *   CANTON_PARTICIPANT_URL  — default http://localhost:7575
 *   CANTON_AUTH_TOKEN       — JWT bearer token (if auth enabled)
 *   CANTON_USER_ID          — default "canton-zk-custody"
 *   CANTON_ACT_AS           — comma-separated parties
 *   CANTON_LEDGER_ID        — ledger ID for v1 API (default "vaeb_participant")
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CantonClient } from "../src/canton-client";
import type { CantonConfig } from "../src/types";

// ── Config from environment (devnet / localnet) ────────────

const CANTON_URL = process.env.CANTON_PARTICIPANT_URL || "http://localhost:7575";

function getConfig(): CantonConfig {
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

// ── Construction tests (no network required) ───────────────

describe("CantonClient construction", () => {
  test("normalizes trailing slash from participantUrl", () => {
    const client = new CantonClient({
      ...getConfig(),
      participantUrl: "http://localhost:7575/",
    });
    assert.ok(client instanceof CantonClient);
  });

  test("works without authToken (localnet sandbox)", () => {
    const client = new CantonClient({
      participantUrl: "http://localhost:7575",
      userId: "canton-zk-custody",
      actAs: ["custodian::namespace"],
      readAs: [],
      ledgerId: "vaeb_participant",
    });
    assert.ok(client instanceof CantonClient);
  });

  test("works with authToken (devnet)", () => {
    const client = new CantonClient({
      participantUrl: "https://canton-devnet.vishwa.network:3975",
      authToken: "eyJhbGciOiJSUzI1NiJ9.devnet-token",
      userId: "canton-zk-custody",
      actAs: ["Custodian::namespace", "Admin::namespace"],
      readAs: ["Observer::namespace"],
    });
    assert.ok(client instanceof CantonClient);
  });

  test("supports multiple actAs/readAs parties", () => {
    const client = new CantonClient({
      participantUrl: CANTON_URL,
      userId: "multi-party-user",
      actAs: ["Custodian::ns1", "Operator::ns2"],
      readAs: ["Auditor::ns1", "Observer::ns2"],
    });
    assert.ok(client instanceof CantonClient);
  });
});

// ── Health check ───────────────────────────────────────────

describe("CantonClient health", () => {
  test("returns false for unreachable participant", async () => {
    const client = new CantonClient({
      ...getConfig(),
      participantUrl: "http://localhost:1",
    });
    const healthy = await client.health();
    assert.equal(healthy, false);
  });

  test("returns true for running Canton (sandbox or devnet)", async () => {
    const client = new CantonClient(getConfig());
    const healthy = await client.health();
    assert.equal(healthy, true, `Canton at ${CANTON_URL} should be healthy`);
  });

  test("auto-detects API version (v1 for sandbox, v2 for devnet)", async () => {
    const client = new CantonClient(getConfig());
    await client.health();
    const version = client.getApiVersion();
    assert.ok(version === "v1" || version === "v2", `Expected v1 or v2, got ${version}`);
    console.log(`  Detected Canton API version: ${version}`);
  });
});

// ── Contract queries (against live Canton) ─────────────────

describe("CantonClient query attestations", () => {
  test("throws on unreachable participant", async () => {
    const client = new CantonClient({
      ...getConfig(),
      participantUrl: "http://localhost:1",
    });
    await assert.rejects(() => client.queryAttestations());
  });

  test("returns attestation array from Canton (empty if no DAR uploaded)", async () => {
    const client = new CantonClient(getConfig());
    const attestations = await client.queryAttestations();
    assert.ok(Array.isArray(attestations), "Should return an array");
    // With canton-zk-custody DAR deployed, attestations will have full shape
    for (const a of attestations) {
      assert.ok(a.contractId, "must have contractId");
      assert.ok(a.custodian, "must have custodian party");
      assert.ok(["EVM"].includes(a.chain), `chain must be EVM, got ${a.chain}`);
      assert.ok(
        ["BalanceAbove", "StakingActive"].includes(a.claimType),
        `unexpected claimType: ${a.claimType}`
      );
    }
    console.log(`  Found ${attestations.length} attestation(s)`);
  });
});

describe("CantonClient query settlements", () => {
  test("throws on unreachable participant", async () => {
    const client = new CantonClient({
      ...getConfig(),
      participantUrl: "http://localhost:1",
    });
    await assert.rejects(() => client.querySettlements());
  });

  test("returns settlement array from Canton (empty if no DAR uploaded)", async () => {
    const client = new CantonClient(getConfig());
    const settlements = await client.querySettlements();
    assert.ok(Array.isArray(settlements), "Should return an array");
    for (const s of settlements) {
      assert.ok(s.contractId, "must have contractId");
      assert.ok(s.buyer, "must have buyer party");
      assert.ok(s.seller, "must have seller party");
      assert.ok(typeof s.amount === "number", "amount must be number");
    }
    console.log(`  Found ${settlements.length} pending settlement(s)`);
  });
});

// ── Exercise choice ────────────────────────────────────────

describe("CantonClient exercise", () => {
  test("exerciseChoice throws on unreachable participant", async () => {
    const client = new CantonClient({
      ...getConfig(),
      participantUrl: "http://localhost:1",
    });
    await assert.rejects(() =>
      client.exerciseChoice(
        "#canton-zk-custody:CrossChainSettlement:CrossChainSettlement",
        "nonexistent-contract-id",
        "Execute",
        { attestationCid: "attest-001" }
      )
    );
  });
});

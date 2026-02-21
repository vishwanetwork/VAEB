import { test } from "node:test";
import assert from "node:assert/strict";
import { intentTools } from "../src/tools/intent-tools";
import { baseConfig, makeContractFactory, FakeProvider, TEST_ADDRESSES } from "./helpers";

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ proof: "0x", publicSignals: [], mode: "mock" }),
  json: async () => ({ proof: "0x", publicSignals: [], mode: "mock" }),
}) as any;

test("intentTools.create_intent stores bundle and returns id", async () => {
  const config = baseConfig();
  const result = await intentTools.handle("create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "USDC",
      amount: 10,
      recipient: TEST_ADDRESSES.owner,
    }],
    chain_preference: "cheapest_gas",
    expiry_minutes: 5,
  }, config);

  assert.ok(result.intent_id);
  assert.equal(result.chain, "base_sepolia");
  assert.equal(result.requires_signature, true);
  assert.equal(result.derived_calls_count, 1);
});

test("intentTools.simulate_intent returns success for stored intent", async () => {
  const config = baseConfig();
  const created = await intentTools.handle("create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "USDC",
      amount: 1,
      recipient: TEST_ADDRESSES.owner,
    }],
    chain_preference: "cheapest_gas",
    expiry_minutes: 5,
  }, config);

  const result = await intentTools.handle("simulate_intent", { intent_id: created.intent_id }, config);
  assert.equal(result.simulation, "success");
  assert.equal(result.intent_id, created.intent_id);
});

test("intentTools.execute_intent executes and marks intent as executed", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    usedNonces: new Set(),
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
    fetchFn: fakeFetch,
    proofDelayMs: 0,
    now: () => Date.now(),
  });

  const created = await intentTools.handle("create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "USDC",
      amount: 2,
      recipient: TEST_ADDRESSES.owner,
    }],
    chain_preference: "cheapest_gas",
    expiry_minutes: 5,
  }, config);

  const executed = await intentTools.handle("execute_intent", {
    intent_id: created.intent_id,
    signature: "0x" + "11".repeat(65),
  }, config);

  assert.equal(executed.status, "executed");
  assert.ok(executed.tx_hash);

  await assert.rejects(
    () => intentTools.handle("execute_intent", { intent_id: created.intent_id, signature: "0x" }, config),
    /Intent already executed/
  );
});

test("intentTools.cancel_intent prevents execution", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory();
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
    fetchFn: fakeFetch,
    proofDelayMs: 0,
  });

  const created = await intentTools.handle("create_intent", {
    actions: [{
      type: "TRANSFER",
      token: "USDC",
      amount: 3,
      recipient: TEST_ADDRESSES.owner,
    }],
    chain_preference: "cheapest_gas",
    expiry_minutes: 5,
  }, config);

  const cancelled = await intentTools.handle("cancel_intent", { intent_id: created.intent_id }, config);
  assert.equal(cancelled.status, "cancelled");

  await assert.rejects(
    () => intentTools.handle("execute_intent", { intent_id: created.intent_id, signature: "0x" }, config),
    /Intent was cancelled/
  );
});

test("intentTools.execute_intent errors on missing intent", async () => {
  const config = baseConfig({ fetchFn: fakeFetch, proofDelayMs: 0 });
  await assert.rejects(
    () => intentTools.handle("execute_intent", { intent_id: "0xdead", signature: "0x" }, config),
    /Intent not found/
  );
});

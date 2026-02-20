import { test } from "node:test";
import assert from "node:assert/strict";
import { marketplaceTools, intentStore } from "../src/tools/marketplace-tools";
import { baseConfig, makeContractFactory, FakeProvider, TEST_ADDRESSES } from "./helpers";

test("marketplaceTools.search_marketplace returns results", async () => {
  const config = baseConfig();
  const result = await marketplaceTools.handle("search_marketplace", { query: "grocery" }, config);
  assert.ok(result.result.found > 0);
  assert.ok(result.result.formatted.includes("Found"));
});

test("marketplaceTools.hire_human creates intent", async () => {
  const config = baseConfig();
  const result = await marketplaceTools.handle("hire_human", {
    human_id: "alice",
    task_description: "Buy groceries",
    amount: "10",
  }, config);

  assert.ok(result.intent?.reviewId);
  assert.ok(result.intent?.eip712);
  assert.equal(result.intent?.humanName, "Alice");
});

test("marketplaceTools.execute_payment falls back to executeDirectly", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    usedNonces: new Set(),
    usdcBalance: 1_000_000n,
  });
  const fetchFn = async () => ({
    ok: false,
    status: 503,
    text: async () => "unavailable",
  }) as any;

  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
    fetchFn,
  });

  intentStore.set("review-1", {
    nonce: "0x" + "22".repeat(32),
    expiry: Math.floor(Date.now() / 1000) + 3600,
    calls: [{
      target: TEST_ADDRESSES.usdc,
      value: 0n,
      data: "0x",
    }],
    callsHash: "0x" + "33".repeat(32),
    humanId: "alice",
    humanName: "Alice",
    amount: "10",
    task: "Buy groceries",
    recipient: TEST_ADDRESSES.owner,
  });

  const result = await marketplaceTools.handle("execute_payment", {
    review_id: "review-1",
    signature: "0x" + "11".repeat(65),
  }, config);

  assert.equal(result.result.executionPath, "executeDirectly");
  assert.ok(result.result.txHash);
});

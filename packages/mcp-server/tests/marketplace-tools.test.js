"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const marketplace_tools_1 = require("../src/tools/marketplace-tools");
const helpers_1 = require("./helpers");
(0, node_test_1.test)("marketplaceTools.search_marketplace returns results", async () => {
    const config = (0, helpers_1.baseConfig)();
    const result = await marketplace_tools_1.marketplaceTools.handle("search_marketplace", { query: "grocery" }, config);
    strict_1.default.ok(result.result.found > 0);
    strict_1.default.ok(result.result.formatted.includes("Found"));
});
(0, node_test_1.test)("marketplaceTools.hire_human creates intent", async () => {
    const config = (0, helpers_1.baseConfig)();
    const result = await marketplace_tools_1.marketplaceTools.handle("hire_human", {
        human_id: "alice",
        task_description: "Buy groceries",
        amount: "10",
    }, config);
    strict_1.default.ok(result.intent?.reviewId);
    strict_1.default.ok(result.intent?.eip712);
    strict_1.default.equal(result.intent?.humanName, "Alice");
});
(0, node_test_1.test)("marketplaceTools.execute_payment falls back to executeDirectly", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        usedNonces: new Set(),
        usdcBalance: 1000000n,
    });
    const fetchFn = async () => ({
        ok: false,
        status: 503,
        text: async () => "unavailable",
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
        fetchFn,
    });
    marketplace_tools_1.intentStore.set("review-1", {
        nonce: "0x" + "22".repeat(32),
        expiry: Math.floor(Date.now() / 1000) + 3600,
        calls: [{
                target: helpers_1.TEST_ADDRESSES.usdc,
                value: 0n,
                data: "0x",
            }],
        callsHash: "0x" + "33".repeat(32),
        humanId: "alice",
        humanName: "Alice",
        amount: "10",
        task: "Buy groceries",
        recipient: helpers_1.TEST_ADDRESSES.owner,
    });
    const result = await marketplace_tools_1.marketplaceTools.handle("execute_payment", {
        review_id: "review-1",
        signature: "0x" + "11".repeat(65),
    }, config);
    strict_1.default.equal(result.result.executionPath, "executeDirectly");
    strict_1.default.ok(result.result.txHash);
});
//# sourceMappingURL=marketplace-tools.test.js.map
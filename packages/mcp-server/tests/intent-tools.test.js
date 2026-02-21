"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const intent_tools_1 = require("../src/tools/intent-tools");
const helpers_1 = require("./helpers");
const fakeFetch = async () => ({
    ok: false,
    status: 503,
    text: async () => "unavailable",
    json: async () => ({}),
});
(0, node_test_1.test)("intentTools.create_intent stores bundle and returns id", async () => {
    const config = (0, helpers_1.baseConfig)();
    const result = await intent_tools_1.intentTools.handle("create_intent", {
        actions: [{
                type: "TRANSFER",
                token: "USDC",
                amount: 10,
                recipient: helpers_1.TEST_ADDRESSES.owner,
            }],
        chain_preference: "cheapest_gas",
        expiry_minutes: 5,
    }, config);
    strict_1.default.ok(result.intent_id);
    strict_1.default.equal(result.chain, "base_sepolia");
    strict_1.default.equal(result.requires_signature, true);
    strict_1.default.equal(result.derived_calls_count, 1);
});
(0, node_test_1.test)("intentTools.simulate_intent returns success for stored intent", async () => {
    const config = (0, helpers_1.baseConfig)();
    const created = await intent_tools_1.intentTools.handle("create_intent", {
        actions: [{
                type: "TRANSFER",
                token: "USDC",
                amount: 1,
                recipient: helpers_1.TEST_ADDRESSES.owner,
            }],
        chain_preference: "cheapest_gas",
        expiry_minutes: 5,
    }, config);
    const result = await intent_tools_1.intentTools.handle("simulate_intent", { intent_id: created.intent_id }, config);
    strict_1.default.equal(result.simulation, "success");
    strict_1.default.equal(result.intent_id, created.intent_id);
});
(0, node_test_1.test)("intentTools.execute_intent executes and marks intent as executed", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        usedNonces: new Set(),
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
        fetchFn: fakeFetch,
        proofDelayMs: 0,
        now: () => Date.now(),
    });
    const created = await intent_tools_1.intentTools.handle("create_intent", {
        actions: [{
                type: "TRANSFER",
                token: "USDC",
                amount: 2,
                recipient: helpers_1.TEST_ADDRESSES.owner,
            }],
        chain_preference: "cheapest_gas",
        expiry_minutes: 5,
    }, config);
    const executed = await intent_tools_1.intentTools.handle("execute_intent", {
        intent_id: created.intent_id,
        signature: "0x" + "11".repeat(65),
    }, config);
    strict_1.default.equal(executed.status, "executed");
    strict_1.default.ok(executed.tx_hash);
    await strict_1.default.rejects(() => intent_tools_1.intentTools.handle("execute_intent", { intent_id: created.intent_id, signature: "0x" }, config), /Intent already executed/);
});
(0, node_test_1.test)("intentTools.cancel_intent prevents execution", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)();
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
        fetchFn: fakeFetch,
        proofDelayMs: 0,
    });
    const created = await intent_tools_1.intentTools.handle("create_intent", {
        actions: [{
                type: "TRANSFER",
                token: "USDC",
                amount: 3,
                recipient: helpers_1.TEST_ADDRESSES.owner,
            }],
        chain_preference: "cheapest_gas",
        expiry_minutes: 5,
    }, config);
    const cancelled = await intent_tools_1.intentTools.handle("cancel_intent", { intent_id: created.intent_id }, config);
    strict_1.default.equal(cancelled.status, "cancelled");
    await strict_1.default.rejects(() => intent_tools_1.intentTools.handle("execute_intent", { intent_id: created.intent_id, signature: "0x" }, config), /Intent was cancelled/);
});
(0, node_test_1.test)("intentTools.execute_intent errors on missing intent", async () => {
    const config = (0, helpers_1.baseConfig)({ fetchFn: fakeFetch, proofDelayMs: 0 });
    await strict_1.default.rejects(() => intent_tools_1.intentTools.handle("execute_intent", { intent_id: "0xdead", signature: "0x" }, config), /Intent not found/);
});
//# sourceMappingURL=intent-tools.test.js.map
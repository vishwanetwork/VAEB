"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const verify_tools_1 = require("../src/tools/verify-tools");
const helpers_1 = require("./helpers");
(0, node_test_1.test)("verifyTools.check_nonce returns used status", async () => {
    const provider = new helpers_1.FakeProvider();
    const contractFactory = (0, helpers_1.makeContractFactory)({
        usedNonces: new Set(["0x" + "11".repeat(32)]),
    });
    const config = (0, helpers_1.baseConfig)({
        providerFactory: () => provider,
        contractFactory,
    });
    const result = await verify_tools_1.verifyTools.handle("check_nonce", { nonce: "0x" + "11".repeat(32) }, config);
    strict_1.default.equal(result.used, true);
    strict_1.default.equal(result.status, "already_used");
});
(0, node_test_1.test)("verifyTools.prove_intent returns proof when prover responds", async () => {
    const fetchFn = async () => ({
        ok: true,
        json: async () => ({ proof: "0xproof", publicSignals: ["0x1"], proofTimeMs: 5, mode: "mock" }),
    });
    const config = (0, helpers_1.baseConfig)({ fetchFn });
    const result = await verify_tools_1.verifyTools.handle("prove_intent", {
        intent_bundle: {},
        derived_calldata: {},
        public_inputs: {},
    }, config);
    strict_1.default.equal(result.status, "proof_generated");
    strict_1.default.equal(result.proof, "0xproof");
});
(0, node_test_1.test)("verifyTools.verify_proof returns valid status", async () => {
    const fetchFn = async () => ({
        ok: true,
        json: async () => ({ valid: true }),
    });
    const config = (0, helpers_1.baseConfig)({ fetchFn });
    const result = await verify_tools_1.verifyTools.handle("verify_proof", {
        proof: "0xproof",
        public_signals: ["0x1"],
    }, config);
    strict_1.default.equal(result.valid, true);
    strict_1.default.equal(result.status, "proof_valid");
});
//# sourceMappingURL=verify-tools.test.js.map
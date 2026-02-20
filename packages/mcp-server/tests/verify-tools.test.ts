import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTools } from "../src/tools/verify-tools";
import { baseConfig, makeContractFactory, FakeProvider } from "./helpers";

test("verifyTools.check_nonce returns used status", async () => {
  const provider = new FakeProvider();
  const contractFactory = makeContractFactory({
    usedNonces: new Set(["0x" + "11".repeat(32)]),
  });
  const config = baseConfig({
    providerFactory: () => provider,
    contractFactory,
  });

  const result = await verifyTools.handle("check_nonce", { nonce: "0x" + "11".repeat(32) }, config);
  assert.equal(result.used, true);
  assert.equal(result.status, "already_used");
});

test("verifyTools.prove_intent returns proof when prover responds", async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ proof: "0xproof", publicSignals: ["0x1"], proofTimeMs: 5, mode: "mock" }),
  }) as any;

  const config = baseConfig({ fetchFn });
  const result = await verifyTools.handle("prove_intent", {
    intent_bundle: {},
    derived_calldata: {},
    public_inputs: {},
  }, config);

  assert.equal(result.status, "proof_generated");
  assert.equal(result.proof, "0xproof");
});

test("verifyTools.verify_proof returns valid status", async () => {
  const fetchFn = async () => ({
    ok: true,
    json: async () => ({ valid: true }),
  }) as any;

  const config = baseConfig({ fetchFn });
  const result = await verifyTools.handle("verify_proof", {
    proof: "0xproof",
    public_signals: ["0x1"],
  }, config);

  assert.equal(result.valid, true);
  assert.equal(result.status, "proof_valid");
});

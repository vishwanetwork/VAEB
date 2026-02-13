/**
 * @vaeb/prover-service
 *
 * ZK Prover Service for VAEB. Wraps snarkjs to generate Groth16 proofs
 * that verify IntentBundle → calldata derivation correctness.
 *
 * Endpoints:
 *   POST /prove     — Generate a ZK proof from IntentBundle + derived calldata
 *   GET  /health    — Health check
 *   GET  /stats     — Proof generation statistics
 */

import express from "express";
import cors from "cors";
import { ProverEngine } from "./prover";

const app = express();
app.use(cors());
app.use(express.json());

const prover = new ProverEngine();
let proofCount = 0;
let totalProofTime = 0;

// ─── Health Check ─────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", proofCount, avgProofTimeMs: proofCount > 0 ? totalProofTime / proofCount : 0 });
});

// ─── Stats ────────────────────────────────────────────────────

app.get("/stats", (_req, res) => {
  res.json({
    proofCount,
    avgProofTimeMs: proofCount > 0 ? Math.round(totalProofTime / proofCount) : 0,
    totalProofTimeMs: totalProofTime,
    proofType: "groth16",
    circuitName: "IntentVerifier",
  });
});

// ─── Generate Proof ───────────────────────────────────────────

app.post("/prove", async (req, res) => {
  try {
    const { intentBundle, derivedCalldata, publicInputs } = req.body;

    if (!intentBundle || !derivedCalldata || !publicInputs) {
      return res.status(400).json({
        error: "Missing required fields: intentBundle, derivedCalldata, publicInputs",
      });
    }

    const startTime = Date.now();

    const result = await prover.generateProof({
      intentBundle,
      derivedCalldata,
      publicInputs,
    });

    const proofTimeMs = Date.now() - startTime;
    proofCount++;
    totalProofTime += proofTimeMs;

    res.json({
      proof: result.proof,
      publicSignals: result.publicSignals,
      proofTimeMs,
      proofType: "groth16",
    });
  } catch (error: any) {
    console.error("Proof generation failed:", error);
    res.status(500).json({
      error: "Proof generation failed",
      details: error.message,
    });
  }
});

// ─── Verify Proof (off-chain, for testing) ────────────────────

app.post("/verify", async (req, res) => {
  try {
    const { proof, publicSignals } = req.body;

    const valid = await prover.verifyProof(proof, publicSignals);

    res.json({ valid });
  } catch (error: any) {
    res.status(500).json({
      error: "Verification failed",
      details: error.message,
    });
  }
});

// ─── Start Server ─────────────────────────────────────────────

const PORT = process.env.PROVER_PORT || 3001;

app.listen(PORT, () => {
  console.log(`🔐 VAEB Prover Service running on port ${PORT}`);
  console.log(`   Circuit: IntentVerifier (Groth16)`);
  console.log(`   Endpoints: POST /prove, POST /verify, GET /health`);
});

export { app };

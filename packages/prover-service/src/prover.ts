/**
 * ProverEngine — Groth16 proof generation using snarkjs
 *
 * This wraps snarkjs to generate and verify ZK proofs for the
 * IntentVerifier circuit. In production, proving keys (.zkey) and
 * verification keys (.vkey) are loaded from the file system or IPFS.
 *
 * For the hackathon demo, we also support a "simulated" mode that
 * generates deterministic mock proofs for testing the full pipeline
 * without requiring the compiled circuit.
 */

import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";

// snarkjs types
interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

interface ProverInput {
  intentBundle: any;
  derivedCalldata: any;
  publicInputs: {
    commitment: string;
    chainId: number;
    signerAddress: string;
    multicallDataHash: string;
    nonce: string;
    expiry: number;
  };
}

interface ProofResult {
  proof: any;
  publicSignals: string[];
}

export class ProverEngine {
  private wasmPath: string | null = null;
  private zkeyPath: string | null = null;
  private vkeyPath: string | null = null;
  private isCircuitLoaded: boolean = false;
  private simulatedMode: boolean = true; // Default to simulated for hackathon

  constructor(circuitDir?: string) {
    if (circuitDir) {
      this.wasmPath = path.join(circuitDir, "IntentVerifier.wasm");
      this.zkeyPath = path.join(circuitDir, "IntentVerifier_final.zkey");
      this.vkeyPath = path.join(circuitDir, "verification_key.json");

      // Check if circuit files exist
      if (
        fs.existsSync(this.wasmPath) &&
        fs.existsSync(this.zkeyPath) &&
        fs.existsSync(this.vkeyPath)
      ) {
        this.isCircuitLoaded = true;
        this.simulatedMode = false;
        console.log("✅ Circuit files loaded from:", circuitDir);
      } else {
        console.log("⚠️  Circuit files not found, using simulated mode");
      }
    } else {
      console.log("ℹ️  No circuit directory provided, using simulated mode");
    }
  }

  /**
   * Generate a Groth16 proof
   */
  async generateProof(input: ProverInput): Promise<ProofResult> {
    if (this.simulatedMode) {
      return this.generateSimulatedProof(input);
    }

    return this.generateRealProof(input);
  }

  /**
   * Generate a real Groth16 proof using snarkjs
   */
  private async generateRealProof(input: ProverInput): Promise<ProofResult> {
    // Dynamic import for snarkjs (ESM module)
    const snarkjs = await import("snarkjs");

    // Construct the circuit input signals
    const circuitInput = this.buildCircuitInput(input);

    // Generate the proof
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      this.wasmPath!,
      this.zkeyPath!
    );

    return {
      proof: this.encodeProofForSolidity(proof),
      publicSignals,
    };
  }

  /**
   * Generate a simulated proof for demo/testing
   * Produces deterministic output based on inputs
   */
  private async generateSimulatedProof(input: ProverInput): Promise<ProofResult> {
    // Simulate proof generation time (~2-5 seconds)
    const proofDelay = 1000 + Math.random() * 2000;
    await new Promise((resolve) => setTimeout(resolve, proofDelay));

    const { publicInputs } = input;

    // Generate deterministic "proof" from inputs
    const proofSeed = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "uint256", "address", "bytes32", "bytes32", "uint256"],
        [
          publicInputs.commitment,
          publicInputs.chainId,
          publicInputs.signerAddress,
          publicInputs.multicallDataHash,
          publicInputs.nonce,
          publicInputs.expiry,
        ]
      )
    );

    // Construct a mock Groth16 proof structure
    const proof = {
      // Simulated proof points (BN128 curve format)
      a: [
        ethers.keccak256(proofSeed + "a0"),
        ethers.keccak256(proofSeed + "a1"),
      ],
      b: [
        [
          ethers.keccak256(proofSeed + "b00"),
          ethers.keccak256(proofSeed + "b01"),
        ],
        [
          ethers.keccak256(proofSeed + "b10"),
          ethers.keccak256(proofSeed + "b11"),
        ],
      ],
      c: [
        ethers.keccak256(proofSeed + "c0"),
        ethers.keccak256(proofSeed + "c1"),
      ],
    };

    // ABI-encode the proof for Solidity
    const encodedProof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"],
      [
        proof.a.map((x) => BigInt(x)),
        proof.b.map((row) => row.map((x) => BigInt(x))),
        proof.c.map((x) => BigInt(x)),
      ]
    );

    const publicSignals = [
      publicInputs.commitment,
      publicInputs.chainId.toString(),
      publicInputs.signerAddress,
      publicInputs.multicallDataHash,
      publicInputs.nonce,
      publicInputs.expiry.toString(),
    ];

    return {
      proof: encodedProof,
      publicSignals,
    };
  }

  /**
   * Verify a proof (off-chain)
   */
  async verifyProof(proof: any, publicSignals: string[]): Promise<boolean> {
    if (this.simulatedMode) {
      // In simulated mode, always verify as true
      return true;
    }

    const snarkjs = await import("snarkjs");
    const vkey = JSON.parse(fs.readFileSync(this.vkeyPath!, "utf-8"));
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
  }

  /**
   * Build circuit input signals from VAEB types
   */
  private buildCircuitInput(input: ProverInput): any {
    const { intentBundle, derivedCalldata, publicInputs } = input;
    const MAX_ACTIONS = 4;

    // Pad actions to MAX_ACTIONS
    const actionTypes = new Array(MAX_ACTIONS).fill("0");
    const actionTokens = new Array(MAX_ACTIONS).fill("0");
    const actionTargets = new Array(MAX_ACTIONS).fill("0");
    const actionAmounts = new Array(MAX_ACTIONS).fill("0");

    const actions = intentBundle.actions || [];
    for (let i = 0; i < Math.min(actions.length, MAX_ACTIONS); i++) {
      const actionTypeMap: Record<string, string> = {
        SWAP: "0",
        TRANSFER: "1",
        STAKE: "2",
        UNSTAKE: "3",
        APPROVE: "4",
      };
      actionTypes[i] = actionTypeMap[actions[i].actionType] || "0";
      actionTokens[i] = BigInt(actions[i].token).toString();
      actionTargets[i] = BigInt(actions[i].to).toString();
      actionAmounts[i] = actions[i].amount.toString();
    }

    // Pad derived calls to MAX_ACTIONS * 2
    const derivedTargetsArr = new Array(MAX_ACTIONS * 2).fill("0");
    const derivedValues = new Array(MAX_ACTIONS * 2).fill("0");
    const derivedDataHashes = new Array(MAX_ACTIONS * 2).fill("0");

    const calls = derivedCalldata.calls || [];
    for (let i = 0; i < Math.min(calls.length, MAX_ACTIONS * 2); i++) {
      derivedTargetsArr[i] = BigInt(calls[i].target).toString();
      derivedValues[i] = calls[i].value.toString();
      derivedDataHashes[i] = BigInt(
        ethers.keccak256(calls[i].data)
      ).toString();
    }

    return {
      // Public inputs
      commitment: BigInt(publicInputs.commitment).toString(),
      chainId: publicInputs.chainId.toString(),
      signerAddress: BigInt(publicInputs.signerAddress).toString(),
      multicallDataHash: BigInt(publicInputs.multicallDataHash).toString(),
      nonce: BigInt(publicInputs.nonce).toString(),
      expiry: publicInputs.expiry.toString(),

      // Private witness
      version: "1",
      payer: BigInt(intentBundle.payer).toString(),
      numActions: actions.length.toString(),
      actionTypes,
      actionTokens,
      actionTargets,
      actionAmounts,
      derivedTargets: derivedTargetsArr,
      derivedValues,
      derivedDataHashes,
      numDerivedCalls: calls.length.toString(),
    };
  }

  /**
   * Encode snarkjs proof for Solidity verifier
   */
  private encodeProofForSolidity(proof: SnarkjsProof): string {
    return ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"],
      [
        [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
        [
          [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], // Note: b is transposed
          [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
        ],
        [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
      ]
    );
  }

  get isSimulated(): boolean {
    return this.simulatedMode;
  }
}

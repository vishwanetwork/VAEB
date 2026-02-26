import { ethers } from "ethers";
import * as path from "path";
import * as fs from "fs";

interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface ProverInput {
  intentBundle: {
    payer: string;
    actions: Array<{
      actionType: string; // "SWAP" or "TRANSFER"
      token: string;
      to: string;
      amount: string | bigint;
    }>;
  };
  derivedCalldata: {
    calls: Array<{
      target: string;
      value: string | bigint;
      data: string; // ABI-encoded calldata (hex)
    }>;
  };
  publicInputs: {
    commitment: string;
    chainId: number;
    signerAddress: string;
    multicallDataHash: string;
    nonce: string;
    expiry: number;
  };
}

export interface ProofResult {
  proof: string;
  publicSignals: string[];
  mode: "groth16" | "simulated";
}

export interface ProverEngineOptions {
  // explicit path to circuits/build directory
  circuitDir?: string;
  // force simulated proof mode
  forceSimulated?: boolean;
}

const MAX_ACTIONS = 4;

function findRepoRoot(): string | null {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "circuits", "build");
    if (fs.existsSync(candidate)) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

function resolveArtifactPaths(circuitDir?: string): {
  wasm: string;
  zkey: string;
  vkey: string;
} {
  let buildDir = circuitDir;

  if (!buildDir) {
    const root = findRepoRoot();
    if (root) {
      buildDir = path.join(root, "circuits", "build");
    }
  }

  if (!buildDir) {
    // last resort
    buildDir = path.resolve(__dirname, "../../../circuits/build");
  }

  return {
    wasm: path.join(buildDir, "IntentVerifier_js", "IntentVerifier.wasm"),
    zkey: path.join(buildDir, "IntentVerifier_final.zkey"),
    vkey: path.join(buildDir, "verification_key.json"),
  };
}

export class ProverEngine {
  private wasmPath: string;
  private zkeyPath: string;
  private vkeyPath: string;
  private simulatedMode: boolean;

  constructor(options: ProverEngineOptions = {}) {
    const { wasm, zkey, vkey } = resolveArtifactPaths(options.circuitDir);
    this.wasmPath = wasm;
    this.zkeyPath = zkey;
    this.vkeyPath = vkey;

    if (options.forceSimulated) {
      this.simulatedMode = true;
      console.log("simulated mode forced");
      return;
    }

    const allPresent =
      fs.existsSync(this.wasmPath) &&
      fs.existsSync(this.zkeyPath) &&
      fs.existsSync(this.vkeyPath);

    this.simulatedMode = !allPresent;

    if (!this.simulatedMode) {
      console.log(`real groth16 mode enabled`);
      console.log(`wasm: ${this.wasmPath}`);
      console.log(`zkey: ${this.zkeyPath}`);
      console.log(`vkey: ${this.vkeyPath}`);
    } else {
      console.warn("circuit artifacts missing, default to simulated mode");
    }
  }

  async generateProof(input: ProverInput): Promise<ProofResult> {
    return this.simulatedMode
      ? this.generateSimulatedProof(input)
      : this.generateRealProof(input);
  }

  async verifyProof(proof: string, publicSignals: string[]): Promise<boolean> {
    if (this.simulatedMode) return true;

    const snarkjs = await import("snarkjs") as any;
    const vkey = JSON.parse(fs.readFileSync(this.vkeyPath, "utf-8"));
    const decodedProof = decodeProofFromAbi(proof);
    return snarkjs.groth16.verify(vkey, publicSignals, decodedProof);
  }

  get isSimulated(): boolean {
    return this.simulatedMode;
  }

  private async generateRealProof(input: ProverInput): Promise<ProofResult> {
    const snarkjs = await import("snarkjs") as any;
    const circuitInput = this.buildCircuitInput(input);

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      circuitInput,
      this.wasmPath,
      this.zkeyPath
    );

    return {
      proof: encodeProofForSolidity(proof as SnarkjsProof),
      publicSignals,
      mode: "groth16",
    };
  }


  private async generateSimulatedProof(input: ProverInput): Promise<ProofResult> {
    const proofDelay = 1000 + Math.random() * 2000;
    await new Promise((resolve) => setTimeout(resolve, proofDelay));

    const { publicInputs } = input;

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

    const h = (label: string): string =>
      ethers.solidityPackedKeccak256(["bytes32", "string"], [proofSeed, label]);

    const encodedProof = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"],
      [
        [BigInt(h("a0")), BigInt(h("a1"))],
        [
          [BigInt(h("b00")), BigInt(h("b01"))],
          [BigInt(h("b10")), BigInt(h("b11"))],
        ],
        [BigInt(h("c0")), BigInt(h("c1"))],
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
      mode: "simulated",
    };
  }

  /**
   * translates VAEB types into the flat signal arrays for Circom circuit expects.
   *
   * All numeric values are passed as decimal strings.
   * Arrays are padded with "0"s
   */
  private buildCircuitInput(input: ProverInput): Record<string, string | string[]> {
    const { intentBundle, derivedCalldata, publicInputs } = input;

    // action signals (padded to MAX_ACTIONS)
    const actionTypeMap: Record<string, string> = {
      SWAP: "0",
      TRANSFER: "1",
      STAKE: "2",
      UNSTAKE: "3",
      APPROVE: "4",
    };

    const actionTypes = new Array<string>(MAX_ACTIONS).fill("0");
    const actionTokens = new Array<string>(MAX_ACTIONS).fill("0");
    const actionTargets = new Array<string>(MAX_ACTIONS).fill("0");
    const actionAmounts = new Array<string>(MAX_ACTIONS).fill("0");

    const actions = intentBundle.actions ?? [];
    for (let i = 0; i < Math.min(actions.length, MAX_ACTIONS); i++) {
      actionTypes[i] = actionTypeMap[actions[i].actionType] ?? "0";
      actionTokens[i] = BigInt(actions[i].token).toString();
      actionTargets[i] = BigInt(actions[i].to).toString();
      actionAmounts[i] = BigInt(actions[i].amount).toString();
    }

    // derived call signals (pad to MAX_ACTIONS *2)
    const derivedTargets = new Array<string>(MAX_ACTIONS * 2).fill("0");
    const derivedValues = new Array<string>(MAX_ACTIONS * 2).fill("0");
    const derivedDataHashes = new Array<string>(MAX_ACTIONS * 2).fill("0");

    const calls = derivedCalldata.calls ?? [];
    for (let i = 0; i < Math.min(calls.length, MAX_ACTIONS * 2); i++) {
      derivedTargets[i] = BigInt(calls[i].target).toString();
      derivedValues[i] = BigInt(calls[i].value).toString();
      // keccak256 of calldata, converted to a field element (mod BN254 order is implicit)
      derivedDataHashes[i] = BigInt(ethers.keccak256(calls[i].data)).toString();
    }

    return {
      // public inputs
      commitment: BigInt(publicInputs.commitment).toString(),
      chainId: publicInputs.chainId.toString(),
      signerAddress: BigInt(publicInputs.signerAddress).toString(),
      multicallDataHash: BigInt(publicInputs.multicallDataHash).toString(),
      nonce: BigInt(publicInputs.nonce).toString(),
      expiry: publicInputs.expiry.toString(),

      // private witness
      version: "1",
      payer: BigInt(intentBundle.payer).toString(),
      numActions: actions.length.toString(),
      actionTypes,
      actionTokens,
      actionTargets,
      actionAmounts,
      derivedTargets,
      derivedValues,
      derivedDataHashes,
    };
  }
}

/**
 * Encode snarkjs proof for Solidity verifier
 */
function encodeProofForSolidity(proof: SnarkjsProof): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [
      [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])], // reversed
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])], // reversed
      ],
      [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    ]
  );
}

/**
 * Decode an ABI-encoded proof blob back into a snarkjs-compatible proof
 * object (used for off-chain verification calls).
 */
function decodeProofFromAbi(encodedProof: string): SnarkjsProof {
  const [a, b, c] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    encodedProof
  );
  return {
    pi_a: [a[0].toString(), a[1].toString(), "1"],
    pi_b: [
      [b[0][1].toString(), b[0][0].toString()], // un-reverse
      [b[1][1].toString(), b[1][0].toString()],
    ],
    pi_c: [c[0].toString(), c[1].toString(), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

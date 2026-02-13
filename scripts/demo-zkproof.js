#!/usr/bin/env node
/**
 * VAEB ZK Proof Demo — Real executeWithProof() on Base Sepolia
 *
 * Unlike demo-live.js (which uses executeDirectly + MockZKVerifier),
 * this script uses the REAL ZK pipeline:
 *   1. Deploys the snarkjs-generated Groth16Verifier + Adapter
 *   2. Generates a real Groth16 proof via snarkjs
 *   3. Calls executeWithProof() with the real proof
 *   4. The on-chain verifier checks the proof cryptographically
 *
 * Prerequisites:
 *   - Circuit compiled:   circuits/build/IntentVerifier.wasm
 *   - Trusted setup done: circuits/build/IntentVerifier_final.zkey
 *   - Verification key:   circuits/build/verification_key.json
 *   - Verifier contract:  circuits/build/Groth16Verifier.sol (compiled to out/)
 *   - Owner + Agent funded on Base Sepolia
 *
 * Run:
 *   node scripts/demo-zkproof.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const snarkjs = require("snarkjs");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────────
const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const CHAIN_ID = 84532;

const circuitDir = path.join(__dirname, "..", "circuits", "build");
const outDir = path.join(__dirname, "..", "contracts", "out");

// ─── Artifact loaders ─────────────────────────────────────────
// solcjs names artifacts differently depending on the working directory:
//   from repo root:       contracts_src_AgentWallet_sol_AgentWallet.abi
//   from contracts/ dir:  src_AgentWallet_sol_AgentWallet.abi
// This function finds the right file regardless of prefix.
function loadArtifact(contractName) {
  const allFiles = fs.readdirSync(outDir);
  // Find ALL matching ABI files — there may be duplicates from different compilation runs:
  //   contracts_src_AgentWallet_sol_AgentWallet.abi  (compiled from repo root — may be STALE)
  //   src_AgentWallet_sol_AgentWallet.abi            (compiled from contracts/ dir — latest)
  // Always prefer the src_ prefixed version (shorter path = compiled from contracts/ dir).
  const candidates = allFiles.filter(f =>
    f.endsWith(".abi") && f.includes(`${contractName}_sol_${contractName}`)
  );
  if (candidates.length === 0) {
    throw new Error(`Cannot find ABI for ${contractName} in ${outDir}. Files: ${allFiles.filter(f => f.endsWith('.abi')).join(', ')}`);
  }
  // Prefer the shortest filename (src_ prefix over contracts_src_ prefix)
  candidates.sort((a, b) => a.length - b.length);
  const abiFile = candidates[0];
  if (candidates.length > 1) {
    console.log(`   ⚠️  Multiple artifacts for ${contractName}: ${candidates.join(', ')}`);
    console.log(`      Using: ${abiFile} (prefer shortest path = latest compilation)`);
  }
  const binFile = abiFile.replace(".abi", ".bin");
  const binContent = fs.readFileSync(path.join(outDir, binFile), "utf8").trim();
  if (!binContent) {
    throw new Error(`Bytecode for ${contractName} is empty (${binFile})`);
  }
  console.log(`   Loading ${contractName}: ${abiFile} (${binContent.length} hex chars)`);
  return {
    abi: JSON.parse(fs.readFileSync(path.join(outDir, abiFile), "utf8")),
    bytecode: "0x" + binContent,
  };
}

// ─── EIP-712 Constants (must match AgentWallet.sol) ───────────
const INTENT_BUNDLE_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "IntentBundle(string version,uint256 chainId,bytes32 nonce,uint256 expiry,address payer,ActionEntry[] actions)ActionEntry(string actionType,address token,address to,uint256 amount)"
  )
);

// ─── Poseidon hash (matches circuit) ──────────────────────────
// We use the circomlibjs Poseidon to compute the same hashes as the circuit
let poseidon, F;
async function initPoseidon() {
  const circomlibjs = require("circomlibjs");
  poseidon = await circomlibjs.buildPoseidon();
  F = poseidon.F;
}

function poseidonHash(inputs) {
  return F.toObject(poseidon(inputs));
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  VAEB ZK PROOF DEMO — Real Groth16 on Base Sepolia");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ─── Validate prerequisites ───────────────────────────────
  if (!OWNER_KEY || !AGENT_KEY) {
    console.error("❌ Missing keys in .env");
    process.exit(1);
  }

  const wasmPath = path.join(circuitDir, "IntentVerifier_js", "IntentVerifier.wasm");
  const zkeyPath = path.join(circuitDir, "IntentVerifier_final.zkey");
  const vkeyPath = path.join(circuitDir, "verification_key.json");

  for (const [name, fpath] of [["WASM", wasmPath], ["zkey", zkeyPath], ["vkey", vkeyPath]]) {
    if (!fs.existsSync(fpath)) {
      console.error(`❌ Missing circuit artifact: ${name}`);
      console.error(`   Expected at: ${fpath}`);
      console.error(`\n   Run the circuit compilation and trusted setup first.`);
      console.error(`   See DEPLOY_AND_TEST.md Step 7 for instructions.`);
      process.exit(1);
    }
  }

  // Check for compiled verifier contract — prefer the src_ prefixed version
  // (generated from snarkjs verifier, compiled in Step 7f)
  const allFiles = fs.readdirSync(outDir);
  const verifierAbiFile = allFiles.find(f =>
    f.includes("Groth16Verifier_sol_Groth16Verifier") && f.endsWith(".abi") && !f.includes("Adapter")
  );
  if (!verifierAbiFile) {
    console.error("❌ Missing compiled Groth16Verifier contract in contracts/out/");
    console.error("   Compile the snarkjs-generated verifier.sol first.");
    console.error("   See DEPLOY_AND_TEST.md Step 7f.");
    process.exit(1);
  }
  const verifierBinFile = verifierAbiFile.replace(".abi", ".bin");

  // Validate bytecode exists and is non-empty
  const verifierBinPath = path.join(outDir, verifierBinFile);
  const rawBin = fs.readFileSync(verifierBinPath, "utf8").trim();
  if (!rawBin || rawBin.length < 100) {
    console.error(`❌ Groth16Verifier bytecode is empty or too small (${rawBin.length} hex chars)`);
    console.error("   The snarkjs verifier may not have compiled correctly.");
    process.exit(1);
  }
  console.log(`   Verifier bytecode: ${rawBin.length} hex chars (${rawBin.length / 2} bytes)`);

  console.log("✅ All circuit artifacts found");
  console.log(`   WASM: ${wasmPath}`);
  console.log(`   zkey: ${zkeyPath}`);
  console.log(`   vkey: ${vkeyPath}\n`);

  // ─── Initialize Poseidon ──────────────────────────────────
  console.log("Initializing Poseidon hash...");
  await initPoseidon();
  console.log("✅ Poseidon ready\n");

  // ─── Connect ──────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`🔗 Connected to: ${network.name} (chainId: ${network.chainId})\n`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const agent = new ethers.Wallet(AGENT_KEY, provider);

  console.log(`👤 Owner: ${owner.address}`);
  console.log(`🤖 Agent: ${agent.address}`);

  const ownerBal = await provider.getBalance(owner.address);
  const agentBal = await provider.getBalance(agent.address);
  console.log(`💰 Owner: ${ethers.formatEther(ownerBal)} ETH`);
  console.log(`💰 Agent: ${ethers.formatEther(agentBal)} ETH\n`);

  if (ownerBal === 0n || agentBal === 0n) {
    console.error("❌ Both owner and agent need Base Sepolia ETH. Fund them first.");
    process.exit(1);
  }

  // Use "pending" to include any in-flight txs from previous runs
  let ownerNonce = await provider.getTransactionCount(owner.address, "pending");
  console.log(`🔢 Owner nonce (pending): ${ownerNonce}\n`);

  async function deploy(factory, args = [], label = "Contract") {
    const bytecodeSize = ethers.dataLength(factory.bytecode);
    console.log(`   Bytecode size: ${bytecodeSize} bytes`);
    console.log(`   Using nonce: ${ownerNonce}`);

    // Use explicit gas limit — L2 gas estimation can be unreliable for contract creation
    const gasLimit = Math.max(3_000_000, bytecodeSize * 500);

    const currentNonce = ownerNonce++;
    const contract = await factory.deploy(...args, {
      nonce: currentNonce,
      gasLimit,
    });

    // Get the deployment tx and wait for receipt
    const deployTx = contract.deploymentTransaction();
    console.log(`   Deploy tx: ${deployTx.hash}`);
    const receipt = await deployTx.wait();

    if (receipt.status === 0) {
      throw new Error(`${label} deployment tx reverted! Tx: ${deployTx.hash}`);
    }

    // Use the ACTUAL address from the receipt — more reliable than the computed address
    const computedAddr = await contract.getAddress();
    const receiptAddr = receipt.contractAddress;

    if (receiptAddr && receiptAddr.toLowerCase() !== computedAddr.toLowerCase()) {
      console.warn(`   ⚠️  Address mismatch! Computed: ${computedAddr}, Receipt: ${receiptAddr}`);
      console.warn(`   Using receipt address (authoritative).`);
    }

    const addr = receiptAddr || computedAddr;

    // On L2 load-balanced RPCs, state may not be immediately consistent.
    // Retry getCode with delays (don't use block tags — public RPCs often don't support them).
    let code = "0x";
    for (let attempt = 1; attempt <= 5; attempt++) {
      code = await provider.getCode(addr);
      if (code && code.length > 2) break;
      if (attempt < 5) {
        console.log(`   Waiting for code at ${addr} (attempt ${attempt}/5)...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (code === "0x" || !code || code.length <= 2) {
      console.error(`   ❌ ${label} at ${addr} has no runtime code after deploy`);
      console.error(`   Tx hash:       ${deployTx.hash}`);
      console.error(`   Gas used:      ${receipt.gasUsed.toString()} / ${gasLimit}`);
      console.error(`   Tx status:     ${receipt.status}`);
      console.error(`   Receipt addr:  ${receiptAddr}`);
      console.error(`   Computed addr: ${computedAddr}`);
      console.error(`   Block:         ${receipt.blockNumber}`);
      throw new Error(
        `${label} deployed to ${addr} but has no code. Gas used: ${receipt.gasUsed}/${gasLimit}. ` +
        `Check tx on BaseScan: https://sepolia.basescan.org/tx/${deployTx.hash}`
      );
    }

    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`   Code size: ${(code.length - 2) / 2} bytes`);

    // If using receipt address, rewire the contract to the correct address
    if (receiptAddr && receiptAddr.toLowerCase() !== computedAddr.toLowerCase()) {
      return new ethers.Contract(receiptAddr, factory.interface, owner);
    }
    return contract;
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 1: Deploy contracts
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 1: DEPLOY CONTRACTS ════════════════════════════════\n");

  // Deploy the snarkjs-generated Groth16Verifier
  console.log("📦 Deploying Groth16Verifier (real ZK verifier)...");
  const realVerifierArtifact = {
    abi: JSON.parse(fs.readFileSync(path.join(outDir, verifierAbiFile), "utf8")),
    bytecode: "0x" + fs.readFileSync(path.join(outDir, verifierBinFile), "utf8").trim(),
  };
  const RealVerifierFactory = new ethers.ContractFactory(realVerifierArtifact.abi, realVerifierArtifact.bytecode, owner);
  const realVerifier = await deploy(RealVerifierFactory, [], "Groth16Verifier");
  const realVerifierAddr = await realVerifier.getAddress();
  console.log(`   ✅ Groth16Verifier: ${realVerifierAddr}\n`);

  // Deploy the adapter that bridges IGroth16Verifier interface
  console.log("📦 Deploying Groth16VerifierAdapter...");
  const adapterArtifact = loadArtifact("Groth16VerifierAdapter");
  const AdapterFactory = new ethers.ContractFactory(adapterArtifact.abi, adapterArtifact.bytecode, owner);
  const adapter = await deploy(AdapterFactory, [realVerifierAddr], "VerifierAdapter");
  const adapterAddr = await adapter.getAddress();
  console.log(`   ✅ Adapter: ${adapterAddr}\n`);

  // Deploy MockERC20 (USDC)
  console.log("📦 Deploying MockERC20 (USDC)...");
  const erc20Artifact = loadArtifact("MockERC20");
  const ERC20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, owner);
  const usdc = await deploy(ERC20Factory, ["USD Coin", "USDC", 6], "MockUSDC");
  const usdcAddr = await usdc.getAddress();
  console.log(`   ✅ MockUSDC: ${usdcAddr}\n`);

  // Deploy AgentWallet pointing to the REAL verifier adapter
  console.log("📦 Deploying AgentWallet (with real ZK verifier)...");
  const walletArtifact = loadArtifact("AgentWallet");
  const WalletFactory = new ethers.ContractFactory(walletArtifact.abi, walletArtifact.bytecode, owner);
  const agentWallet = await deploy(WalletFactory, [owner.address, agent.address, adapterAddr], "AgentWallet");
  const walletAddr = await agentWallet.getAddress();
  console.log(`   ✅ AgentWallet: ${walletAddr}`);
  console.log(`      zkVerifier → Adapter(${adapterAddr}) → Verifier(${realVerifierAddr})\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 2: Fund the wallet
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 2: FUND WALLET ═════════════════════════════════════\n");

  const mintTx = await usdc.connect(owner).mint(walletAddr, ethers.parseUnits("1000", 6), { nonce: ownerNonce++ });
  await mintTx.wait();
  console.log(`   ✅ Minted 1000 USDC to AgentWallet\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 3: Build intent + derive calldata
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 3: BUILD INTENT ════════════════════════════════════\n");

  const recipient = "0x000000000000000000000000000000000000dEaD";
  const transferAmount = ethers.parseUnits("100", 6);

  // The intent: transfer 100 USDC to burn address
  // IMPORTANT: nonce must fit in the BN254 scalar field (< ~2^254).
  // Use 31 random bytes (248 bits) left-padded to 32 bytes to guarantee this.
  const intentNonce = ethers.zeroPadValue(ethers.hexlify(ethers.randomBytes(31)), 32);
  const expiry = Math.floor(Date.now() / 1000) + 600;

  // Derive calldata: ERC20.transfer(recipient, amount)
  const erc20Iface = new ethers.Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const transferCalldata = erc20Iface.encodeFunctionData("transfer", [recipient, transferAmount]);

  const calls = [{ target: usdcAddr, value: 0n, data: transferCalldata }];
  const callsHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["tuple(address target, uint256 value, bytes data)[]"], [calls])
  );

  console.log(`📋 Intent: Transfer 100 USDC → ${recipient}`);
  console.log(`   Nonce:  ${intentNonce.slice(0, 18)}...`);
  console.log(`   Expiry: ${new Date(expiry * 1000).toISOString()}\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 4: Compute Poseidon commitment (must match circuit)
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 4: COMPUTE ZK COMMITMENT ═══════════════════════════\n");

  // Action: TRANSFER = type 1
  const actionType = 1n;
  const tokenAddr = BigInt(usdcAddr);
  const targetAddr = BigInt(recipient);
  const amount = BigInt(transferAmount);

  // Bundle hash: Poseidon(version, chainId, nonce, expiry, payer, numActions)
  const bundleHash = poseidonHash([
    1n,                        // version
    BigInt(CHAIN_ID),          // chainId
    BigInt(intentNonce),       // nonce
    BigInt(expiry),            // expiry
    BigInt(walletAddr),        // payer (AgentWallet)
    1n,                        // numActions
  ]);

  // Action hash: Poseidon(type, token, target, amount)
  const actionHash = poseidonHash([actionType, tokenAddr, targetAddr, amount]);

  // Pad to MAX_ACTIONS = 4 (remaining actions hash to Poseidon(0,0,0,0))
  const zeroActionHash = poseidonHash([0n, 0n, 0n, 0n]);

  // Commitment: Poseidon(bundleHash, action0, action1, action2, action3)
  const commitment = poseidonHash([bundleHash, actionHash, zeroActionHash, zeroActionHash, zeroActionHash]);

  // Derived call hashes (1 real call + 7 zero-padded)
  const callDataHash = BigInt(ethers.keccak256(transferCalldata));
  const singleCallHashes = [];
  // Call 0: real transfer
  singleCallHashes.push(poseidonHash([tokenAddr, 0n, callDataHash]));
  // Calls 1-7: zero-padded
  for (let i = 1; i < 8; i++) {
    singleCallHashes.push(poseidonHash([0n, 0n, 0n]));
  }
  const multicallDataHash = poseidonHash(singleCallHashes);

  console.log(`   Commitment:       ${commitment.toString().slice(0, 20)}...`);
  console.log(`   MulticallDataHash: ${multicallDataHash.toString().slice(0, 20)}...\n`);

  // ═══════════════════════════════════════════════════════════
  // STEP 5: Generate REAL Groth16 proof
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 5: GENERATE ZK PROOF ═══════════════════════════════\n");

  const circuitInput = {
    // Public inputs
    commitment: commitment.toString(),
    chainId: CHAIN_ID.toString(),
    signerAddress: BigInt(owner.address).toString(),
    multicallDataHash: multicallDataHash.toString(),
    nonce: BigInt(intentNonce).toString(),
    expiry: expiry.toString(),
    // Private witness
    version: "1",
    payer: BigInt(walletAddr).toString(),
    numActions: "1",
    actionTypes: [actionType.toString(), "0", "0", "0"],
    actionTokens: [tokenAddr.toString(), "0", "0", "0"],
    actionTargets: [targetAddr.toString(), "0", "0", "0"],
    actionAmounts: [amount.toString(), "0", "0", "0"],
    derivedTargets: [tokenAddr.toString(), "0", "0", "0", "0", "0", "0", "0"],
    derivedValues: ["0", "0", "0", "0", "0", "0", "0", "0"],
    derivedDataHashes: [callDataHash.toString(), "0", "0", "0", "0", "0", "0", "0"],
    numDerivedCalls: "1",
  };

  console.log("⏳ Generating Groth16 proof (this may take 10-30 seconds)...\n");
  const proofStart = Date.now();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    circuitInput,
    wasmPath,
    zkeyPath
  );

  const proofTime = ((Date.now() - proofStart) / 1000).toFixed(1);
  console.log(`   ✅ Proof generated in ${proofTime}s`);
  // snarkjs orders public signals as: [outputs, ...public_inputs]
  // So: [valid, commitment, chainId, signerAddress, multicallDataHash, nonce, expiry]
  console.log(`   Public signals (valid, commitment, chainId, signer, multicallHash, nonce, expiry):`);
  console.log(`   [${publicSignals.map(s => s.toString().slice(0, 16) + '...').join(', ')}]`);
  console.log(`   valid = ${publicSignals[0]} (expected: 1)\n`);

  // Verify off-chain first
  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf8"));
  const offchainValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(`   Off-chain verification: ${offchainValid ? '✅ VALID' : '❌ INVALID'}`);
  if (!offchainValid) {
    console.error("   Proof failed off-chain verification. Something is wrong with the witness.");
    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 5b: DIAGNOSTIC — Compare on-chain vs off-chain signals
  // ═══════════════════════════════════════════════════════════
  console.log("\n═══ STEP 5b: DIAGNOSTIC — SIGNAL COMPARISON ═════════════════\n");

  // The proof points (same encoding for both direct and adapter paths)
  const pA = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];
  const pB = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ];
  const pC = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

  // ABI-encode proof for Solidity (used by adapter and executeWithProof)
  const encodedProof = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [pA, pB, pC]
  );

  // What snarkjs produced (and off-chain verification used):
  const snarkjsSignals = publicSignals.map(s => BigInt(s));
  console.log("   snarkjs publicSignals (used for off-chain verify):");
  const sigLabels = ["valid(out)", "commitment", "chainId", "signerAddr", "multicallHash", "nonce", "expiry"];
  for (let i = 0; i < 7; i++) {
    console.log(`     [${i}] ${sigLabels[i].padEnd(14)} = ${snarkjsSignals[i].toString()}`);
  }

  // TEST 1: Call the real verifier DIRECTLY with the exact snarkjs signals
  console.log("\n   TEST 1: Direct call to Groth16Verifier (exact snarkjs signals)...");
  try {
    const directVerifier = new ethers.Contract(realVerifierAddr, realVerifierArtifact.abi, provider);
    const directResult = await directVerifier.verifyProof.staticCall(pA, pB, pC, snarkjsSignals);
    console.log(`   → Result: ${directResult ? '✅ TRUE' : '❌ FALSE'}`);
  } catch (e) {
    console.log(`   → ERROR: ${e.message}`);
  }

  // Now simulate what the contract + adapter would produce:
  // _encodePublicInputs produces these 6 values from the PublicInputs struct:
  const contractPubInputs = [
    commitment,                         // uint256(bytes32 commitment)
    BigInt(CHAIN_ID),                   // chainId
    BigInt(owner.address),              // uint256(uint160(signerAddress))
    multicallDataHash,                  // uint256(bytes32 multicallDataHash)
    BigInt(intentNonce),                // uint256(bytes32 nonce)
    BigInt(expiry),                     // expiry
  ];

  // The adapter prepends output signal (1) then appends the 6 inputs:
  const adapterSignals = [1n, ...contractPubInputs];

  console.log("\n   What adapter would construct (output first, then 6 inputs):");
  for (let i = 0; i < 7; i++) {
    const match = snarkjsSignals[i] === adapterSignals[i];
    console.log(`     [${i}] ${sigLabels[i].padEnd(14)} = ${adapterSignals[i].toString().slice(0, 40)}${adapterSignals[i].toString().length > 40 ? '...' : ''} ${match ? '✅' : '❌ MISMATCH'}`);
    if (!match) {
      console.log(`          expected (snarkjs): ${snarkjsSignals[i].toString()}`);
      console.log(`          actual  (adapter):  ${adapterSignals[i].toString()}`);
    }
  }

  // TEST 2: Call the real verifier with what the adapter would produce
  console.log("\n   TEST 2: Direct call to Groth16Verifier (adapter-constructed signals)...");
  try {
    const directVerifier = new ethers.Contract(realVerifierAddr, realVerifierArtifact.abi, provider);
    const adapterResult = await directVerifier.verifyProof.staticCall(pA, pB, pC, adapterSignals);
    console.log(`   → Result: ${adapterResult ? '✅ TRUE' : '❌ FALSE'}`);
  } catch (e) {
    console.log(`   → ERROR: ${e.message}`);
  }

  // TEST 3: Call through the Adapter contract (simulates what AgentWallet does)
  console.log("\n   TEST 3: Call through VerifierAdapter (encodedProof + pubInputs)...");
  try {
    const adapterContract = new ethers.Contract(adapterAddr, adapterArtifact.abi, provider);
    const adapterThruResult = await adapterContract.verifyProof.staticCall(encodedProof, contractPubInputs);
    console.log(`   → Result: ${adapterThruResult ? '✅ TRUE' : '❌ FALSE'}`);
  } catch (e) {
    console.log(`   → ERROR: ${e.message}`);
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 6: Sign intent + submit executeWithProof()
  // ═══════════════════════════════════════════════════════════
  console.log("\n═══ STEP 6: ON-CHAIN EXECUTION (executeWithProof) ═══════════\n");

  // Build PublicInputs struct for the contract
  // snarkjs public signal order: [valid(output), commitment, chainId, signer, multicallDataHash, nonce, expiry]
  // Index:                        [0,             1,          2,       3,      4,                 5,     6    ]
  const publicInputsStruct = {
    commitment: "0x" + BigInt(publicSignals[1]).toString(16).padStart(64, "0"),
    chainId: BigInt(publicSignals[2]),
    signerAddress: owner.address,
    multicallDataHash: "0x" + BigInt(publicSignals[4]).toString(16).padStart(64, "0"),
    nonce: intentNonce,
    expiry: BigInt(publicSignals[6]),
  };

  // Owner signs the intent commitment (EIP-712)
  const EIP712_DOMAIN_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32", "uint256", "address"],
      [EIP712_DOMAIN_TYPEHASH, ethers.keccak256(ethers.toUtf8Bytes("VAEB AgentWallet")), ethers.keccak256(ethers.toUtf8Bytes("1")), CHAIN_ID, walletAddr]
    )
  );

  const digest = ethers.keccak256(
    ethers.solidityPacked(["bytes1", "bytes1", "bytes32", "bytes32"], ["0x19", "0x01", domainSeparator, publicInputsStruct.commitment])
  );
  const sig = owner.signingKey.sign(digest);
  const signature = ethers.Signature.from(sig).serialized;
  console.log(`✍️  Owner signed commitment`);
  console.log(`   Signature: ${signature.slice(0, 20)}...${signature.slice(-8)}\n`);

  // Agent submits the transaction
  const walletContract = new ethers.Contract(walletAddr, walletArtifact.abi, agent);

  console.log("⚡ Agent calling executeWithProof()...");
  try {
    const tx = await walletContract.executeWithProof(
      encodedProof,
      signature,
      publicInputsStruct,
      calls,
      { gasLimit: 500000 }
    );

    console.log(`   📡 Tx: ${tx.hash}`);
    console.log(`      https://sepolia.basescan.org/tx/${tx.hash}\n`);
    console.log("   ⏳ Waiting for confirmation...\n");

    const receipt = await tx.wait();
    console.log(`   ✅ CONFIRMED in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`   Status: ${receipt.status === 1 ? "SUCCESS ✓" : "REVERTED ✗"}`);
    console.log(`   https://sepolia.basescan.org/tx/${tx.hash}\n`);

  } catch (error) {
    console.error(`   ❌ executeWithProof FAILED`);

    // Try to decode the revert reason
    const knownErrors = {
      "0x09bde339": "InvalidProof()",
      "0x8baa579f": "InvalidSignature()",
      "0x1fb09b80": "NonceAlreadyUsed()",
      "0x408b2234": "IntentExpired()",
      "0x30cd7471": "NotOwner()",
      "0x72cb8533": "NotOwnerOrAgent()",
      "0x5c0dee5d": "CallFailed(uint256,bytes)",
      "0xf645eedf": "ECDSAInvalidSignature()",
      "0xfce698f7": "ECDSAInvalidSignatureLength(uint256)",
      "0xd78bce0c": "ECDSAInvalidSignatureS(bytes32)",
    };

    const revertData = error.data || (error.info && error.info.error && error.info.error.data);
    if (revertData) {
      const selector = typeof revertData === 'string' ? revertData.slice(0, 10) : null;
      const errorName = selector ? knownErrors[selector] : null;
      console.error(`   Revert data: ${revertData}`);
      if (errorName) {
        console.error(`   Decoded error: ${errorName}`);
      } else if (selector) {
        console.error(`   Unknown error selector: ${selector}`);
      }
    }

    // Also try a staticCall to get a cleaner error
    console.error("\n   Running staticCall to decode error...");
    try {
      await walletContract.executeWithProof.staticCall(
        encodedProof, signature, publicInputsStruct, calls,
        { from: agent.address, gasLimit: 500000 }
      );
      console.error("   staticCall succeeded?! (tx should have worked)");
    } catch (staticErr) {
      const staticData = staticErr.data || (staticErr.info && staticErr.info.error && staticErr.info.error.data);
      if (staticData) {
        const sel = typeof staticData === 'string' ? staticData.slice(0, 10) : null;
        const name = sel ? knownErrors[sel] : null;
        console.error(`   staticCall revert: ${staticData}`);
        if (name) {
          console.error(`   → Decoded: ${name}`);
          if (name === "InvalidProof()") {
            console.error("   → The ZK verifier rejected the proof. Check signal alignment in Step 5b above.");
          } else if (name === "InvalidSignature()") {
            console.error("   → EIP-712 signature recovery failed. Check domain separator & commitment.");
          } else if (name === "NotOwnerOrAgent()") {
            console.error("   → Agent address not authorized. Check agent setup.");
          }
        }
      } else {
        console.error(`   staticCall error: ${staticErr.message}`);
      }
    }

    process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════
  // STEP 7: Verify
  // ═══════════════════════════════════════════════════════════
  console.log("═══ STEP 7: VERIFY ══════════════════════════════════════════\n");

  // Base Sepolia public RPC is load-balanced — reads right after a tx may
  // hit a stale node. Retry with delays to allow state propagation.
  let finalBal, recipBal, nonceUsed;
  for (let attempt = 1; attempt <= 5; attempt++) {
    finalBal = await usdc.balanceOf(walletAddr);
    recipBal = await usdc.balanceOf(recipient);
    nonceUsed = await walletContract.isNonceUsed(intentNonce);

    if (nonceUsed && finalBal !== ethers.parseUnits("1000", 6)) {
      break; // State has propagated
    }
    if (attempt < 5) {
      console.log(`   Waiting for state propagation (attempt ${attempt}/5)...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log(`   AgentWallet USDC: ${ethers.formatUnits(finalBal, 6)} (was 1000.0)`);
  console.log(`   Recipient USDC:   ${ethers.formatUnits(recipBal, 6)} (was 0.0)`);
  console.log(`   Nonce used:       ${nonceUsed}`);

  if (finalBal === ethers.parseUnits("900", 6) && recipBal === ethers.parseUnits("100", 6) && nonceUsed) {
    console.log("\n   ✅ ALL CHECKS PASSED — real ZK proof verified on-chain!\n");
  } else if (nonceUsed) {
    // Nonce was marked but balances may still be propagating
    console.log("\n   ⚠️  Nonce marked as used but balances unexpected — may need more time to propagate");
    console.log("   Check on BaseScan for the actual token transfer events.\n");
  } else {
    console.log("\n   ⚠️  Unexpected values — inspect on BaseScan\n");
    console.log("   This may be due to Base Sepolia RPC load-balancing returning stale state.");
    console.log("   The tx status was SUCCESS, so the state changes were committed.");
    console.log("   Wait a minute and check directly on BaseScan.\n");
  }

  // Save results
  const resultsPath = path.join(__dirname, "..", "contracts", "deployments", "zkproof-demo-results.json");
  const deploymentsDir = path.dirname(resultsPath);
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  fs.writeFileSync(resultsPath, JSON.stringify({
    network: "base_sepolia", chainId: CHAIN_ID,
    timestamp: new Date().toISOString(),
    contracts: {
      Groth16Verifier: realVerifierAddr,
      VerifierAdapter: adapterAddr,
      MockUSDC: usdcAddr,
      AgentWallet: walletAddr,
    },
    proof: { generationTime: proofTime + "s", offchainValid },
  }, null, 2));
  console.log(`Results saved to contracts/deployments/zkproof-demo-results.json`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ ZK Demo failed:", err.message);
  process.exit(1);
});

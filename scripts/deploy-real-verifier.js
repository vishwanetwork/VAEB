#!/usr/bin/env node
/**
 * Deploy Real Groth16 Verifier — switches AgentWallet from MockZKVerifier
 * to the snarkjs-generated Groth16Verifier + Adapter.
 *
 * What this does:
 *   1. Deploys Groth16Verifier  (snarkjs-generated, circuit-specific)
 *   2. Deploys Groth16VerifierAdapter  (bridges snarkjs ABI → IGroth16Verifier)
 *   3. Calls AgentWallet.setZkVerifier(adapter) using the owner key
 *   4. Updates contracts/deployments/base_sepolia.json
 *
 * Prerequisites:
 *   - contracts/out/ must have compiled ABIs + bytecodes  (npm run compile in contracts/)
 *   - circuits/build/ must have Groth16Verifier.sol compiled into contracts/out/
 *   - OWNER_PRIVATE_KEY in .env  (owner calls setZkVerifier)
 *   - AGENT_PRIVATE_KEY in .env  (for gas — owner must be funded)
 *
 * Run:
 *   node scripts/deploy-real-verifier.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const RPC_URL   = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
const AGENT_WALLET_ADDRESS =
  process.env.AGENT_WALLET_ADDRESS || "0x99D238c22499e679e9d45578245083FE690C8B5f";

const outDir        = path.join(__dirname, "..", "contracts", "out");
const deploymentPath = path.join(__dirname, "..", "contracts", "deployments", "base_sepolia.json");

// ─── Artifact loader (matches solcjs naming conventions) ─────────

function loadArtifact(contractName) {
  const files = fs.readdirSync(outDir);
  const candidates = files
    .filter(f => f.endsWith(".abi") && f.includes(`${contractName}_sol_${contractName}`))
    .sort((a, b) => a.length - b.length); // prefer shortest (compiled from contracts/)

  if (candidates.length === 0) {
    throw new Error(
      `Cannot find ABI for ${contractName} in ${outDir}.\n` +
      `Available: ${files.filter(f => f.endsWith(".abi")).join(", ")}`
    );
  }

  const abiFile = candidates[0];
  const binFile = abiFile.replace(".abi", ".bin");

  return {
    abi:      JSON.parse(fs.readFileSync(path.join(outDir, abiFile), "utf8")),
    bytecode: "0x" + fs.readFileSync(path.join(outDir, binFile), "utf8").trim(),
  };
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  if (!OWNER_KEY) {
    throw new Error("OWNER_PRIVATE_KEY not set in .env");
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner    = new ethers.Wallet(OWNER_KEY, provider);

  const network = await provider.getNetwork();
  console.log(`\nNetwork:      ${network.name} (chainId ${network.chainId})`);
  console.log(`Owner:        ${owner.address}`);
  console.log(`AgentWallet:  ${AGENT_WALLET_ADDRESS}\n`);

  const balance = await provider.getBalance(owner.address);
  if (balance < ethers.parseEther("0.001")) {
    throw new Error(`Owner ETH too low (${ethers.formatEther(balance)} ETH) — fund before deploying`);
  }

  // ── 1. Deploy Groth16Verifier ────────────────────────────────
  console.log("1. Deploying Groth16Verifier...");
  const verifierArtifact = loadArtifact("Groth16Verifier");
  const VerifierFactory  = new ethers.ContractFactory(
    verifierArtifact.abi,
    verifierArtifact.bytecode,
    owner
  );
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`   ✅ Groth16Verifier:         ${verifierAddress}`);

  // ── 2. Deploy Groth16VerifierAdapter ─────────────────────────
  console.log("2. Deploying Groth16VerifierAdapter...");
  const adapterArtifact = loadArtifact("Groth16VerifierAdapter");
  const AdapterFactory  = new ethers.ContractFactory(
    adapterArtifact.abi,
    adapterArtifact.bytecode,
    owner
  );
  const adapter = await AdapterFactory.deploy(verifierAddress);
  await adapter.waitForDeployment();
  const adapterAddress = await adapter.getAddress();
  console.log(`   ✅ Groth16VerifierAdapter:  ${adapterAddress}`);

  // ── 3. Call AgentWallet.setZkVerifier ────────────────────────
  console.log(`3. Calling setZkVerifier(${adapterAddress}) on AgentWallet...`);
  const walletArtifact = loadArtifact("AgentWallet");
  const agentWallet    = new ethers.Contract(AGENT_WALLET_ADDRESS, walletArtifact.abi, owner);
  const tx = await agentWallet.setZkVerifier(adapterAddress);
  const receipt = await tx.wait();
  console.log(`   ✅ setZkVerifier tx:        ${tx.hash}`);
  console.log(`   Block:                      ${receipt.blockNumber}`);

  // ── 4. Update deployment JSON ─────────────────────────────────
  console.log("4. Updating contracts/deployments/base_sepolia.json...");
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  deployment.contracts.Groth16Verifier        = verifierAddress;
  deployment.contracts.Groth16VerifierAdapter = adapterAddress;
  deployment.timestamp = new Date().toISOString();
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log(`   ✅ Deployment JSON updated`);

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Real Groth16 verifier is now active                     ║
║                                                          ║
║  AgentWallet.zkVerifier → Groth16VerifierAdapter         ║
║    └─ realVerifier      → Groth16Verifier (snarkjs)      ║
║                                                          ║
║  The prover service must be running to generate          ║
║  real proofs for execute_intent to succeed.              ║
║  Start it: cd packages/prover && npm start               ║
╚══════════════════════════════════════════════════════════╝
`);
}

main().catch(err => {
  console.error("\n❌ Deploy failed:", err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Deploy AgentWalletFactory to Base Sepolia
 *
 * Uses the forge-compiled artifact from contracts/out_forge/.
 * Reads OWNER_PRIVATE_KEY from .env (owner = factory deployer).
 * Updates contracts/deployments/base_sepolia.json.
 *
 * Run:
 *   node scripts/deploy-factory.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

const OWNER_KEY  = process.env.OWNER_PRIVATE_KEY;
const RPC_URL    = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const ARTIFACT   = path.join(__dirname, "..", "contracts", "out_forge",
                             "AgentWalletFactory.sol", "AgentWalletFactory.json");
const DEPLOYMENTS_FILE = path.join(__dirname, "..", "contracts", "deployments", "deployments.json");

async function main() {
  if (!OWNER_KEY) throw new Error("OWNER_PRIVATE_KEY not set in .env");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const owner    = new ethers.Wallet(OWNER_KEY, provider);
  const network  = await provider.getNetwork();

  console.log(`\nNetwork:  ${network.name} (chainId ${network.chainId})`);
  console.log(`Deployer: ${owner.address}`);

  const balance = await provider.getBalance(owner.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);
  if (balance < ethers.parseEther("0.001"))
    throw new Error("Owner ETH too low — fund before deploying");

  // ── Read deployments to get defaultZkVerifier ─────────────────
  const deployments   = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const chainKey      = process.env.DEFAULT_CHAIN || "base_sepolia";
  const chainEntry    = deployments[chainKey] || { contracts: {} };
  const defaultVerifier =
    chainEntry.contracts.Groth16VerifierAdapter ||
    chainEntry.contracts.MockZKVerifier ||
    ethers.ZeroAddress;

  console.log(`\ndefaultZkVerifier: ${defaultVerifier}`);

  // ── Load forge artifact ────────────────────────────────────────
  const artifact = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const abi      = artifact.abi;
  const raw      = artifact.bytecode.object;
  const bytecode = raw.startsWith("0x") ? raw : "0x" + raw;

  // ── Deploy ────────────────────────────────────────────────────
  const overrides = {
    gasLimit: 3_000_000,
    maxFeePerGas:         ethers.parseUnits("2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
  };
  console.log(`\nDeploying AgentWalletFactory (gasLimit: ${overrides.gasLimit})...`);
  const factory  = new ethers.ContractFactory(abi, bytecode, owner);
  const contract = await factory.deploy(defaultVerifier, overrides);
  console.log(`   tx: ${contract.deploymentTransaction().hash}`);
  console.log("   Waiting for confirmation...");
  await contract.waitForDeployment();
  const address  = await contract.getAddress();

  console.log(`✅ AgentWalletFactory: ${address}`);
  console.log(`   BaseScan: https://sepolia.basescan.org/address/${address}`);

  // ── Update deployments.json ────────────────────────────────────
  chainEntry.contracts.AgentWalletFactory = address;
  chainEntry.timestamp = new Date().toISOString();
  deployments[chainKey] = chainEntry;
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(deployments, null, 2));
  console.log("\n✅ contracts/deployments/deployments.json updated");

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  AgentWalletFactory deployed                             ║
║                                                          ║
║  Factory:          ${address}  ║
║  defaultVerifier:  ${defaultVerifier}  ║
║                                                          ║
║  Users can now call createWallet(owner, agent, salt)     ║
║  to deploy their own AgentWallet via CREATE2.            ║
╚══════════════════════════════════════════════════════════╝
`);
}

main().catch(err => {
  console.error("\n❌ Deploy failed:", err.message);
  process.exit(1);
});

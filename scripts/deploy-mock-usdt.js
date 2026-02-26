#!/usr/bin/env node
/**
 * Deploy MockERC20 as fake USDT to a specified chain.
 *
 * Usage:
 *   node scripts/deploy-mock-usdt.js --chain base
 *   node scripts/deploy-mock-usdt.js --chain base_sepolia
 *   node scripts/deploy-mock-usdt.js --chain kite_testnet
 *
 * Env:
 *   OWNER_PRIVATE_KEY (required)
 *   BASE_RPC_URL | BASE_SEPOLIA_RPC_URL | KITE_TESTNET_RPC_URL (optional)
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
if (!OWNER_KEY) {
  console.error("Missing OWNER_PRIVATE_KEY in .env");
  process.exit(1);
}

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const chainKey = getArg("--chain");
if (!chainKey) {
  console.error("Usage: node scripts/deploy-mock-usdt.js --chain <base|base_sepolia|kite_testnet>");
  process.exit(1);
}

const deploymentsPath = path.join(__dirname, "..", "contracts", "deployments", "deployments.json");
const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));

const chainConfig = deployments[chainKey];
if (!chainConfig) {
  console.error(`Unknown chain key: ${chainKey}`);
  process.exit(1);
}

let rpcUrl = chainConfig.rpcUrl;
if (chainKey === "base") rpcUrl = process.env.BASE_RPC_URL || process.env.BASE_MAINNET_RPC_URL || rpcUrl;
if (chainKey === "base_sepolia") rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || rpcUrl;
if (chainKey === "kite_testnet") rpcUrl = process.env.KITE_TESTNET_RPC_URL || rpcUrl;

const outDir = path.join(__dirname, "..", "contracts", "out");
function loadArtifact(name) {
  const abiPath = path.join(outDir, name + ".abi");
  const binPath = path.join(outDir, name + ".bin");
  if (!fs.existsSync(abiPath) || !fs.existsSync(binPath)) {
    throw new Error(`Missing artifact: ${name}. Run 'forge build --extra-output-files abi bin' first.`);
  }
  return {
    abi: JSON.parse(fs.readFileSync(abiPath, "utf8")),
    bytecode: "0x" + fs.readFileSync(binPath, "utf8").trim(),
  };
}

async function main() {
  console.log(`\n  Deploying MockUSDT to ${chainKey}\n`);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  console.log(`  Chain: ${network.name} (${Number(network.chainId)})`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  console.log(`  Deployer: ${owner.address}`);

  const ownerBal = await provider.getBalance(owner.address);
  console.log(`  Balance: ${ethers.formatEther(ownerBal)}`);
  if (ownerBal < ethers.parseEther("0.0003")) {
    console.error("  Deployer needs at least 0.0003 native token for gas.");
    process.exit(1);
  }

  const artifact = loadArtifact("src_mocks_MockERC20_sol_MockERC20");
  const ERC20Factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner);
  console.log("  Deploying MockERC20 (USDT)...");
  const contract = await ERC20Factory.deploy("Tether USD", "USDT", 6);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  MockUSDT: ${addr}`);

  deployments[chainKey] = deployments[chainKey] || {};
  deployments[chainKey].contracts = deployments[chainKey].contracts || {};
  deployments[chainKey].contracts.MockUSDT = addr;
  deployments[chainKey].timestamp = new Date().toISOString();
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log(`  Updated contracts/deployments/deployments.json (${chainKey}.contracts.MockUSDT)`);

  console.log("\n  ✅ Done.\n");
}

main().catch((err) => {
  console.error("\nDeployment failed:", err.message);
  process.exit(1);
});

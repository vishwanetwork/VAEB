#!/usr/bin/env node
/**
 * Deploy VAEB contracts to Kite AI Testnet (Chain ID: 2368)
 *
 * Deploys: Groth16Verifier, Groth16VerifierAdapter, MockERC20 (USDC),
 *          AgentWallet, AgentWalletFactory
 * Connects AgentWallet to real Groth16 verifier from the start.
 * Mints 1000 USDC to AgentWallet.
 * Updates contracts/deployments/deployments.json (kite_testnet section).
 *
 * Prerequisites:
 *   - Fund owner wallet at https://faucet.gokite.ai
 *     Owner: 0x77A93ecD2437DA60aAFDBF595e74e0317b0d0B47
 *     Agent: 0x17C3771F0250b2774AA11b793Deb523d2D914E03
 *
 * Run:
 *   node scripts/deploy-kite.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env.KITE_TESTNET_RPC_URL || "https://rpc-testnet.gokite.ai";
const EXPECTED_CHAIN_ID = 2368;

const outDir = path.join(__dirname, "..", "contracts", "out");
const deploymentsPath = path.join(__dirname, "..", "contracts", "deployments", "deployments.json");

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
  console.log("\n  VAEB Contract Deployment — Kite AI Testnet\n");

  if (!OWNER_KEY || !AGENT_KEY) {
    console.error("  Missing OWNER_PRIVATE_KEY or AGENT_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);

  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`  Wrong chain: expected ${EXPECTED_CHAIN_ID}, got ${chainId}`);
    process.exit(1);
  }
  console.log(`  Chain: Kite AI Testnet (${chainId})`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const agent = new ethers.Wallet(AGENT_KEY, provider);
  console.log(`  Owner: ${owner.address}`);
  console.log(`  Agent: ${agent.address}\n`);

  const ownerBal = await provider.getBalance(owner.address);
  console.log(`  Owner KITE: ${ethers.formatEther(ownerBal)}`);
  if (ownerBal < ethers.parseEther("0.0003")) {
    console.error("\n  Owner needs at least 0.0003 KITE for gas.");
    console.error("  Fund at: https://faucet.gokite.ai");
    console.error(`  Address: ${owner.address}\n`);
    process.exit(1);
  }

  let nonce = await provider.getTransactionCount(owner.address);

  async function deploy(factory, args = []) {
    const contract = await factory.deploy(...args, { nonce });
    nonce++;
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    const code = await provider.getCode(addr);
    if (code === "0x" || code.length <= 2) {
      throw new Error(`Deployment to ${addr} failed — no code deployed`);
    }
    return { contract, address: addr };
  }

  // 1. Groth16Verifier
  console.log("  Deploying Groth16Verifier...");
  const groth16Artifact = loadArtifact("src_Groth16Verifier_sol_Groth16Verifier");
  const Groth16Factory = new ethers.ContractFactory(groth16Artifact.abi, groth16Artifact.bytecode, owner);
  const groth16 = await deploy(Groth16Factory);
  console.log(`    Groth16Verifier: ${groth16.address}`);

  // 2. Groth16VerifierAdapter
  console.log("  Deploying Groth16VerifierAdapter...");
  const adapterArtifact = loadArtifact("src_Groth16VerifierAdapter_sol_Groth16VerifierAdapter");
  const AdapterFactory = new ethers.ContractFactory(adapterArtifact.abi, adapterArtifact.bytecode, owner);
  const adapter = await deploy(AdapterFactory, [groth16.address]);
  console.log(`    Groth16VerifierAdapter: ${adapter.address}`);

  // 3. MockERC20 (USDC)
  console.log("  Deploying MockERC20 (USDC)...");
  const erc20Artifact = loadArtifact("src_mocks_MockERC20_sol_MockERC20");
  const ERC20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, owner);
  const usdc = await deploy(ERC20Factory, ["USD Coin", "USDC", 6]);
  console.log(`    MockUSDC: ${usdc.address}`);

  // 4. AgentWallet (using real Groth16VerifierAdapter)
  console.log("  Deploying AgentWallet...");
  const walletArtifact = loadArtifact("src_AgentWallet_sol_AgentWallet");
  const WalletFactory = new ethers.ContractFactory(walletArtifact.abi, walletArtifact.bytecode, owner);
  const agentWallet = await deploy(WalletFactory, [owner.address, agent.address, adapter.address]);
  console.log(`    AgentWallet: ${agentWallet.address}`);

  // 5. AgentWalletFactory (optional — artifact may not be compiled)
  let agentWalletFactory = { address: null };
  const factoryAbiPath = path.join(outDir, "src_AgentWalletFactory_sol_AgentWalletFactory.abi");
  const factoryBinPath = path.join(outDir, "src_AgentWalletFactory_sol_AgentWalletFactory.bin");
  if (fs.existsSync(factoryAbiPath) && fs.existsSync(factoryBinPath)) {
    console.log("  Deploying AgentWalletFactory...");
    const factoryArtifact = {
      abi: JSON.parse(fs.readFileSync(factoryAbiPath, "utf8")),
      bytecode: "0x" + fs.readFileSync(factoryBinPath, "utf8").trim(),
    };
    const FactoryFactory = new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode, owner);
    agentWalletFactory = await deploy(FactoryFactory, [adapter.address]);
    console.log(`    AgentWalletFactory: ${agentWalletFactory.address}`);
  } else {
    console.log("  Skipping AgentWalletFactory (artifact not compiled)");
  }

  // 6. Mint 1000 USDC to owner (non-custodial: user holds funds)
  console.log("\n  Minting 1000 USDC to owner (non-custodial)...");
  const mintTx = await usdc.contract.connect(owner).mint(
    owner.address,
    ethers.parseUnits("1000", 6),
    { nonce }
  );
  nonce++;
  await mintTx.wait();
  const bal = await usdc.contract.balanceOf(owner.address);
  console.log(`    Owner USDC balance: ${ethers.formatUnits(bal, 6)} USDC`);

  // 6b. Approve AgentWallet to spend owner's USDC (ERC-8150 non-custodial)
  console.log("  Approving AgentWallet to spend owner's USDC...");
  const approveTx = await usdc.contract.connect(owner).approve(
    agentWallet.address,
    ethers.MaxUint256,
    { nonce }
  );
  nonce++;
  await approveTx.wait();
  console.log(`    Approved: AgentWallet can transferFrom owner's USDC`);

  // 7. Fund agent with gas if needed
  const agentBal = await provider.getBalance(agent.address);
  if (agentBal < ethers.parseEther("0.00005")) {
    console.log("\n  Funding agent with 0.0001 KITE for gas...");
    const fundTx = await owner.sendTransaction({
      to: agent.address,
      value: ethers.parseEther("0.0001"),
      nonce,
    });
    nonce++;
    await fundTx.wait();
    console.log(`    Done: ${fundTx.hash}`);
  }

  // 8. Update deployments.json
  console.log("\n  Updating deployments.json...");
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  deployments.kite_testnet = {
    chainId,
    rpcUrl: RPC_URL,
    blockExplorer: "https://testnet.kitescan.ai",
    contracts: {
      AgentWallet: agentWallet.address,
      ...(agentWalletFactory.address ? { AgentWalletFactory: agentWalletFactory.address } : {}),
      MockUSDC: usdc.address,
      Groth16Verifier: groth16.address,
      Groth16VerifierAdapter: adapter.address,
    },
    wallets: {
      owner: owner.address,
      agent: agent.address,
    },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("    contracts/deployments/deployments.json updated");

  // 9. Update .env with Kite AI addresses
  const envPath = path.join(__dirname, "..", ".env");
  let envContent = fs.readFileSync(envPath, "utf8");

  function setEnvVar(content, key, value) {
    const regex = new RegExp(`^${key}=.*`, "m");
    if (regex.test(content)) return content.replace(regex, `${key}=${value}`);
    return content + `\n${key}=${value}`;
  }

  envContent = setEnvVar(envContent, "KITE_AGENT_WALLET_ADDRESS", agentWallet.address);
  envContent = setEnvVar(envContent, "KITE_MOCK_USDC_ADDRESS", usdc.address);
  fs.writeFileSync(envPath, envContent);
  console.log("    .env updated with KITE_AGENT_WALLET_ADDRESS, KITE_MOCK_USDC_ADDRESS");

  console.log("\n  ✅ Kite AI Testnet Deployment Complete!\n");
  console.log(`  AgentWallet:           ${agentWallet.address}`);
  console.log(`  Groth16Verifier:       ${groth16.address}`);
  console.log(`  Groth16VerifierAdapter: ${adapter.address}`);
  console.log(`  MockUSDC:              ${usdc.address}`);
  console.log(`  Explorer: https://testnet.kitescan.ai/address/${agentWallet.address}\n`);
}

main().catch((err) => {
  console.error("\n  Deployment failed:", err.message);
  process.exit(1);
});

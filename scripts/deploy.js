#!/usr/bin/env node
/**
 * Deploy contracts to Base Sepolia and update .env with new addresses.
 *
 * Deploys: MockZKVerifier, MockERC20 (USDC), AgentWallet
 * Mints 1000 USDC to the AgentWallet
 * Updates .env with new contract addresses
 *
 * Run: node scripts/deploy.js
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

const outDir = path.join(__dirname, "..", "contracts", "out");

function loadArtifact(name) {
  const abiPath = path.join(outDir, name + ".abi");
  const binPath = path.join(outDir, name + ".bin");
  return {
    abi: JSON.parse(fs.readFileSync(abiPath, "utf8")),
    bytecode: "0x" + fs.readFileSync(binPath, "utf8").trim(),
  };
}

async function main() {
  console.log("\n  VAEB Contract Deployment — Base Sepolia\n");

  if (!OWNER_KEY || !AGENT_KEY) {
    console.error("Missing OWNER_PRIVATE_KEY or AGENT_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`  Chain: ${network.name} (${network.chainId})`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const agent = new ethers.Wallet(AGENT_KEY, provider);
  console.log(`  Owner: ${owner.address}`);
  console.log(`  Agent: ${agent.address}\n`);

  const ownerBal = await provider.getBalance(owner.address);
  console.log(`  Owner ETH: ${ethers.formatEther(ownerBal)}`);
  if (ownerBal < ethers.parseEther("0.0003")) {
    console.error("\n  Owner needs at least 0.0003 ETH. Fund from a faucet first.");
    process.exit(1);
  }

  let ownerNonce = await provider.getTransactionCount(owner.address);

  async function deploy(factory, args = []) {
    const contract = await factory.deploy(...args, { nonce: ownerNonce });
    ownerNonce++;
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    const code = await provider.getCode(addr);
    if (code === "0x" || code.length <= 2) {
      throw new Error(`Deployment to ${addr} failed — no code`);
    }
    return { contract, address: addr };
  }

  // 1. MockZKVerifier
  console.log("  Deploying MockZKVerifier...");
  const verifierArtifact = loadArtifact("src_mocks_MockZKVerifier_sol_MockZKVerifier");
  const VerifierFactory = new ethers.ContractFactory(verifierArtifact.abi, verifierArtifact.bytecode, owner);
  const verifier = await deploy(VerifierFactory);
  console.log(`    MockZKVerifier: ${verifier.address}`);

  // 2. MockERC20 (USDC)
  console.log("  Deploying MockERC20 (USDC)...");
  const erc20Artifact = loadArtifact("src_mocks_MockERC20_sol_MockERC20");
  const ERC20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, owner);
  const usdc = await deploy(ERC20Factory, ["USD Coin", "USDC", 6]);
  console.log(`    MockUSDC:       ${usdc.address}`);

  // 3. AgentWallet
  console.log("  Deploying AgentWallet...");
  const walletArtifact = loadArtifact("src_AgentWallet_sol_AgentWallet");
  const WalletFactory = new ethers.ContractFactory(walletArtifact.abi, walletArtifact.bytecode, owner);
  const agentWallet = await deploy(WalletFactory, [owner.address, agent.address, verifier.address]);
  console.log(`    AgentWallet:    ${agentWallet.address}`);

  // 4. Mint 1000 USDC to AgentWallet
  console.log("\n  Minting 1000 USDC to AgentWallet...");
  const mintTx = await usdc.contract.connect(owner).mint(
    agentWallet.address,
    ethers.parseUnits("1000", 6),
    { nonce: ownerNonce }
  );
  ownerNonce++;
  await mintTx.wait();
  const bal = await usdc.contract.balanceOf(agentWallet.address);
  console.log(`    Balance: ${ethers.formatUnits(bal, 6)} USDC`);

  // 5. Fund agent with gas if needed
  const agentBal = await provider.getBalance(agent.address);
  if (agentBal < ethers.parseEther("0.00005")) {
    console.log("\n  Funding agent with 0.0001 ETH for gas...");
    const fundTx = await owner.sendTransaction({
      to: agent.address,
      value: ethers.parseEther("0.0001"),
      nonce: ownerNonce,
    });
    ownerNonce++;
    await fundTx.wait();
    console.log(`    Done: ${fundTx.hash}`);
  }

  // 6. Update .env
  console.log("\n  Updating .env...");
  const envPath = path.join(__dirname, "..", ".env");
  let envContent = fs.readFileSync(envPath, "utf8");

  // Update AGENT_WALLET_ADDRESS
  if (envContent.includes("AGENT_WALLET_ADDRESS=")) {
    envContent = envContent.replace(
      /AGENT_WALLET_ADDRESS=.*/,
      `AGENT_WALLET_ADDRESS=${agentWallet.address}`
    );
  } else {
    envContent += `\nAGENT_WALLET_ADDRESS=${agentWallet.address}`;
  }

  fs.writeFileSync(envPath, envContent);
  console.log(`    AGENT_WALLET_ADDRESS=${agentWallet.address}`);

  // 7. Save deployment JSON
  const deploymentsDir = path.join(__dirname, "..", "contracts", "deployments");
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });
  const deployInfo = {
    network: "base_sepolia",
    chainId: Number(network.chainId),
    timestamp: new Date().toISOString(),
    contracts: {
      MockZKVerifier: verifier.address,
      MockUSDC: usdc.address,
      AgentWallet: agentWallet.address,
    },
    wallets: { owner: owner.address, agent: agent.address },
  };
  fs.writeFileSync(
    path.join(deploymentsDir, "base_sepolia.json"),
    JSON.stringify(deployInfo, null, 2)
  );

  // 8. Update server + frontend configs
  // Server config reads from .env so it's already handled
  // Frontend config needs manual update
  const frontendConfigPath = path.join(__dirname, "..", "packages", "frontend", "src", "config.ts");
  if (fs.existsSync(frontendConfigPath)) {
    let frontendConfig = fs.readFileSync(frontendConfigPath, "utf8");
    frontendConfig = frontendConfig.replace(
      /AgentWallet: '[^']+'/,
      `AgentWallet: '${agentWallet.address}'`
    );
    frontendConfig = frontendConfig.replace(
      /MockUSDC: '[^']+'/,
      `MockUSDC: '${usdc.address}'`
    );
    fs.writeFileSync(frontendConfigPath, frontendConfig);
    console.log("    Updated packages/frontend/src/config.ts");
  }

  // Update server config MockUSDC (hardcoded)
  const serverConfigPath = path.join(__dirname, "..", "packages", "server", "src", "config.ts");
  if (fs.existsSync(serverConfigPath)) {
    let serverConfig = fs.readFileSync(serverConfigPath, "utf8");
    serverConfig = serverConfig.replace(
      /MockUSDC: '[^']+'/,
      `MockUSDC: '${usdc.address}'`
    );
    serverConfig = serverConfig.replace(
      /Verifier: '[^']+'/,
      `Verifier: '${verifier.address}'`
    );
    fs.writeFileSync(serverConfigPath, serverConfig);
    console.log("    Updated packages/server/src/config.ts");
  }

  console.log("\n  Deployment complete!\n");
  console.log(`  AgentWallet: ${agentWallet.address}`);
  console.log(`  MockUSDC:    ${usdc.address}`);
  console.log(`  Verifier:    ${verifier.address}`);
  console.log(`  Explorer:    https://sepolia.basescan.org/address/${agentWallet.address}\n`);
}

main().catch((err) => {
  console.error("Deployment failed:", err.message);
  process.exit(1);
});

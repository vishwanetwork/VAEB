#!/usr/bin/env node
/**
 * Deploy contracts and update .env with new addresses.
 *
 * Deploys: Groth16Verifier, Groth16VerifierAdapter, MockERC20 (USDC), AgentWallet
 * Mints 1000 USDC to the owner (non-custodial ERC-8150)
 * Approves AgentWallet to spend owner's USDC
 * Updates .env + deployments.json + frontend/server configs with new addresses
 *
 * Usage:
 *   DEFAULT_CHAIN=base_sepolia node scripts/deploy.js   # deploys to Base Sepolia
 *   DEFAULT_CHAIN=kite_testnet node scripts/deploy.js   # deploys to Kite AI Testnet
 */

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// ─── Chain Configuration ─────────────────────────────────────
const CHAINS = {
  base_sepolia: {
    name: "Base Sepolia",
    chainId: 84532,
    rpcEnvKey: "BASE_SEPOLIA_RPC_URL",
    rpcDefault: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcEnvKey: "BASE_RPC_URL",
    rpcDefault: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  ethereum_sepolia: {
    name: "Ethereum Sepolia",
    chainId: 11155111,
    rpcEnvKey: "ETHEREUM_SEPOLIA_RPC_URL",
    rpcDefault: "https://rpc.sepolia.org",
    explorer: "https://sepolia.etherscan.io",
  },
  kite_testnet: {
    name: "Kite AI Testnet",
    chainId: 2368,
    rpcEnvKey: "KITE_TESTNET_RPC_URL",
    rpcDefault: "https://rpc-testnet.gokite.ai",
    explorer: "https://testnet.kitescan.ai",
  },
};

const chainKey = process.env.DEFAULT_CHAIN || "base_sepolia";
const chain = CHAINS[chainKey];
if (!chain) {
  console.error(`Unknown chain: ${chainKey}`);
  console.error(`Available: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(1);
}

const OWNER_KEY = process.env.OWNER_PRIVATE_KEY;
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const RPC_URL = process.env[chain.rpcEnvKey] || chain.rpcDefault;

const outDir = path.join(__dirname, "..", "contracts", "out");
const deploymentsPath = path.join(__dirname, "..", "contracts", "deployments", "deployments.json");

// ─── Artifact Loader ─────────────────────────────────────────
function loadArtifact(name) {
  // Try exact name first, then search for matching files
  const abiDirect = path.join(outDir, name + ".abi");
  const binDirect = path.join(outDir, name + ".bin");
  if (fs.existsSync(abiDirect) && fs.existsSync(binDirect)) {
    return {
      abi: JSON.parse(fs.readFileSync(abiDirect, "utf8")),
      bytecode: "0x" + fs.readFileSync(binDirect, "utf8").trim(),
    };
  }

  // Search by contract name (e.g. "Groth16Verifier" → "..._Groth16Verifier_sol_Groth16Verifier.abi")
  const files = fs.readdirSync(outDir);
  const candidates = files
    .filter(f => f.endsWith(".abi") && f.includes(`${name}_sol_${name}`))
    .sort((a, b) => a.length - b.length);

  if (candidates.length === 0) {
    throw new Error(
      `Cannot find artifact for ${name} in ${outDir}.\n` +
      `Available: ${files.filter(f => f.endsWith(".abi")).join(", ")}`
    );
  }

  const abiFile = candidates[0];
  const binFile = abiFile.replace(".abi", ".bin");
  return {
    abi: JSON.parse(fs.readFileSync(path.join(outDir, abiFile), "utf8")),
    bytecode: "0x" + fs.readFileSync(path.join(outDir, binFile), "utf8").trim(),
  };
}

// ─── Main ────────────────────────────────────────────────────
async function main() {
  console.log(`\n  VAEB Contract Deployment — ${chain.name}\n`);

  if (!OWNER_KEY || !AGENT_KEY) {
    console.error("Missing OWNER_PRIVATE_KEY or AGENT_PRIVATE_KEY in .env");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const network = await provider.getNetwork();
  console.log(`  Chain:  ${network.name} (${network.chainId})`);
  console.log(`  RPC:    ${RPC_URL}`);

  const owner = new ethers.Wallet(OWNER_KEY, provider);
  const agent = new ethers.Wallet(AGENT_KEY, provider);
  console.log(`  Owner:  ${owner.address}`);
  console.log(`  Agent:  ${agent.address}\n`);

  const ownerBal = await provider.getBalance(owner.address);
  console.log(`  Owner ETH: ${ethers.formatEther(ownerBal)}`);
  if (ownerBal < ethers.parseEther("0.001")) {
    console.error("\n  Owner needs at least 0.001 ETH for deployment gas. Fund from a faucet first.");
    process.exit(1);
  }

  let ownerNonce = await provider.getTransactionCount(owner.address);

  async function deploy(factory, args = []) {
    const contract = await factory.deploy(...args, { nonce: ownerNonce });
    ownerNonce++;
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    // L2 load-balanced RPCs may return stale state — retry getCode
    let code = "0x";
    for (let attempt = 1; attempt <= 5; attempt++) {
      code = await provider.getCode(addr);
      if (code && code.length > 2) break;
      if (attempt < 5) {
        console.log(`    Waiting for code at ${addr} (attempt ${attempt}/5)...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (code === "0x" || code.length <= 2) {
      throw new Error(`Deployment to ${addr} failed — no code after 5 retries`);
    }
    return { contract, address: addr };
  }

  // 1. Groth16Verifier (real ZK verifier — same as deploy-kite.js)
  console.log("  Deploying Groth16Verifier...");
  const groth16Artifact = loadArtifact("Groth16Verifier");
  const Groth16Factory = new ethers.ContractFactory(groth16Artifact.abi, groth16Artifact.bytecode, owner);
  const groth16 = await deploy(Groth16Factory);
  console.log(`    Groth16Verifier:        ${groth16.address}`);

  // 2. Groth16VerifierAdapter (bridges snarkjs ABI → IGroth16Verifier)
  console.log("  Deploying Groth16VerifierAdapter...");
  const adapterArtifact = loadArtifact("Groth16VerifierAdapter");
  const AdapterFactory = new ethers.ContractFactory(adapterArtifact.abi, adapterArtifact.bytecode, owner);
  const adapter = await deploy(AdapterFactory, [groth16.address]);
  console.log(`    Groth16VerifierAdapter: ${adapter.address}`);

  // 3. MockERC20 (USDC)
  console.log("  Deploying MockERC20 (USDC)...");
  const erc20Artifact = loadArtifact("src_mocks_MockERC20_sol_MockERC20");
  const ERC20Factory = new ethers.ContractFactory(erc20Artifact.abi, erc20Artifact.bytecode, owner);
  const usdc = await deploy(ERC20Factory, ["USD Coin", "USDC", 6]);
  console.log(`    MockUSDC:               ${usdc.address}`);

  // 4. AgentWallet (using real Groth16VerifierAdapter)
  console.log("  Deploying AgentWallet...");
  const walletArtifact = loadArtifact("src_AgentWallet_sol_AgentWallet");
  const WalletFactory = new ethers.ContractFactory(walletArtifact.abi, walletArtifact.bytecode, owner);
  const agentWallet = await deploy(WalletFactory, [owner.address, agent.address, adapter.address]);
  console.log(`    AgentWallet:            ${agentWallet.address}`);

  // 5. Mint 1000 USDC to owner (non-custodial: user holds funds)
  console.log("\n  Minting 1000 USDC to owner (non-custodial)...");
  const mintTx = await usdc.contract.connect(owner).mint(
    owner.address,
    ethers.parseUnits("1000", 6),
    { nonce: ownerNonce }
  );
  ownerNonce++;
  await mintTx.wait();
  const bal = await usdc.contract.balanceOf(owner.address);
  console.log(`    Owner USDC balance: ${ethers.formatUnits(bal, 6)} USDC`);

  // 5b. Approve AgentWallet to spend owner's USDC (ERC-8150 non-custodial)
  console.log("  Approving AgentWallet to spend owner's USDC...");
  const approveTx = await usdc.contract.connect(owner).approve(
    agentWallet.address,
    ethers.parseUnits("1000", 6),
    { nonce: ownerNonce }
  );
  ownerNonce++;
  await approveTx.wait();
  console.log(`    Approved: AgentWallet can transferFrom owner up to 1000 USDC`);

  // 6. Fund agent with gas if needed
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

  // 7. Update .env
  console.log("\n  Updating .env...");
  const envPath = path.join(__dirname, "..", ".env");
  let envContent = fs.readFileSync(envPath, "utf8");

  function setEnvVar(content, key, value) {
    const regex = new RegExp(`^${key}=.*`, "m");
    if (regex.test(content)) return content.replace(regex, `${key}=${value}`);
    return content + `\n${key}=${value}`;
  }

  envContent = setEnvVar(envContent, "AGENT_WALLET_ADDRESS", agentWallet.address);
  envContent = setEnvVar(envContent, "DEFAULT_CHAIN", chainKey);

  fs.writeFileSync(envPath, envContent);
  console.log(`    AGENT_WALLET_ADDRESS=${agentWallet.address}`);
  console.log(`    DEFAULT_CHAIN=${chainKey}`);

  // 8. Update deployments.json (merge into existing file)
  console.log("  Updating deployments.json...");
  const deploymentsDir = path.dirname(deploymentsPath);
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  let deployments = {};
  if (fs.existsSync(deploymentsPath)) {
    deployments = JSON.parse(fs.readFileSync(deploymentsPath, "utf8"));
  }

  deployments[chainKey] = {
    chainId: Number(network.chainId),
    rpcUrl: RPC_URL,
    blockExplorer: chain.explorer,
    contracts: {
      AgentWallet: agentWallet.address,
      MockUSDC: usdc.address,
      Groth16Verifier: groth16.address,
      Groth16VerifierAdapter: adapter.address,
    },
    wallets: { owner: owner.address, agent: agent.address },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentsPath, JSON.stringify(deployments, null, 2));
  console.log("    deployments.json updated");

  // 9. Update server + frontend configs
  const serverConfigPath = path.join(__dirname, "..", "packages", "server", "src", "config.ts");
  if (fs.existsSync(serverConfigPath)) {
    let serverConfig = fs.readFileSync(serverConfigPath, "utf8");

    // Update the chain-specific block in CHAIN_CONFIGS
    const awRe = new RegExp(
      `(${chainKey}:\\s*\\{[\\s\\S]*?contracts:\\s*\\{[\\s\\S]*?AgentWallet:\\s*(?:process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*)?)'[^']*'`
    );
    const usdcRe = new RegExp(
      `(${chainKey}:\\s*\\{[\\s\\S]*?contracts:\\s*\\{[\\s\\S]*?MockUSDC:\\s*(?:process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*)?)'[^']*'`
    );
    const verifierRe = new RegExp(
      `(${chainKey}:\\s*\\{[\\s\\S]*?contracts:\\s*\\{[\\s\\S]*?Verifier:\\s*)'[^']*'`
    );

    if (awRe.test(serverConfig)) {
      serverConfig = serverConfig.replace(awRe, `$1'${agentWallet.address}'`);
    }
    if (usdcRe.test(serverConfig)) {
      serverConfig = serverConfig.replace(usdcRe, `$1'${usdc.address}'`);
    }
    if (verifierRe.test(serverConfig)) {
      serverConfig = serverConfig.replace(verifierRe, `$1'${adapter.address}'`);
    }
    fs.writeFileSync(serverConfigPath, serverConfig);
    console.log("    Updated packages/server/src/config.ts");
  }

  const frontendConfigPath = path.join(__dirname, "..", "packages", "frontend", "src", "config.ts");
  if (fs.existsSync(frontendConfigPath)) {
    let frontendConfig = fs.readFileSync(frontendConfigPath, "utf8");

    const awRe = new RegExp(
      `(${chainKey}:\\s*\\{[\\s\\S]*?contracts:\\s*\\{[\\s\\S]*?AgentWallet:\\s*)'[^']*'`
    );
    const usdcRe = new RegExp(
      `(${chainKey}:\\s*\\{[\\s\\S]*?contracts:\\s*\\{[\\s\\S]*?MockUSDC:\\s*)'[^']*'`
    );

    if (awRe.test(frontendConfig)) {
      frontendConfig = frontendConfig.replace(awRe, `$1'${agentWallet.address}'`);
      frontendConfig = frontendConfig.replace(usdcRe, `$1'${usdc.address}'`);
    } else {
      frontendConfig = frontendConfig.replace(/AgentWallet: '[^']+'/, `AgentWallet: '${agentWallet.address}'`);
      frontendConfig = frontendConfig.replace(/MockUSDC: '[^']+'/, `MockUSDC: '${usdc.address}'`);
    }
    fs.writeFileSync(frontendConfigPath, frontendConfig);
    console.log("    Updated packages/frontend/src/config.ts");
  }

  console.log(`\n  Deployment complete! (${chain.name})\n`);
  console.log(`  AgentWallet:              ${agentWallet.address}`);
  console.log(`  MockUSDC:                 ${usdc.address}`);
  console.log(`  Groth16Verifier:          ${groth16.address}`);
  console.log(`  Groth16VerifierAdapter:   ${adapter.address}`);
  console.log(`  Explorer:                 ${chain.explorer}/address/${agentWallet.address}\n`);
}

main().catch((err) => {
  console.error("Deployment failed:", err.message);
  process.exit(1);
});
